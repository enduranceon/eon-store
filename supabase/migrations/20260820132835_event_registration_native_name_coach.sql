-- Evento publico: Nome e Treinador passam a ser campos nativos da inscricao.
-- Os demais dados do atleta continuam vindo dos campos configurados em cada
-- tipo de inscricao e, quando reconhecidos, enriquecem/vinculam o cliente.

ALTER TABLE public.event_registrations
  ADD COLUMN IF NOT EXISTS coach_id UUID
  REFERENCES public.assessment_coaches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS event_registrations_coach_id_idx
  ON public.event_registrations(coach_id);

UPDATE public.event_registrations r
SET coach_id = c.coach_id
FROM public.presale_customers c
WHERE r.customer_id = c.id
  AND r.coach_id IS NULL
  AND c.coach_id IS NOT NULL;

CREATE OR REPLACE FUNCTION eon_private.public_event_answer_text(
  p_answers JSONB,
  p_fields JSONB,
  p_aliases TEXT[]
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_field JSONB;
  v_key TEXT;
  v_norm TEXT;
  v_value JSONB;
  v_text TEXT;
  v_alias TEXT;
BEGIN
  IF jsonb_typeof(COALESCE(p_answers, '{}'::jsonb)) <> 'object' THEN
    RETURN NULL;
  END IF;

  FOR v_field IN
    SELECT *
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(COALESCE(p_fields, '[]'::jsonb)) = 'array'
          THEN COALESCE(p_fields, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    )
  LOOP
    v_key := NULLIF(v_field->>'key', '');
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    v_norm := regexp_replace(
      lower(COALESCE(v_key, '') || ' ' || COALESCE(v_field->>'label', '')),
      '[^a-z0-9]+',
      '_',
      'g'
    );

    FOREACH v_alias IN ARRAY p_aliases
    LOOP
      IF v_norm = v_alias
         OR v_norm LIKE v_alias || '\_%'
         OR v_norm LIKE '%\_' || v_alias
         OR v_norm LIKE '%\_' || v_alias || '\_%'
         OR v_norm LIKE '%' || v_alias || '%' THEN
        v_value := p_answers -> v_key;
        IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
          CONTINUE;
        END IF;

        v_text := CASE
          WHEN jsonb_typeof(v_value) = 'string' THEN trim(v_value #>> '{}')
          ELSE trim(v_value::text)
        END;

        IF v_text <> '' THEN
          RETURN v_text;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.public_event_answer_text(JSONB, JSONB, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.public_event_answer_text(JSONB, JSONB, TEXT[])
  TO service_role;

CREATE OR REPLACE FUNCTION eon_private.create_public_event_registration(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_slug TEXT := NULLIF(trim(p_payload #>> '{event_slug}'), '');
  v_type_id UUID;
  v_coach_id UUID;
  v_full_name TEXT := NULLIF(trim(p_payload #>> '{customer,full_name}'), '');
  v_whatsapp TEXT;
  v_email TEXT;
  v_cpf TEXT;
  v_answers JSONB := COALESCE(p_payload -> 'form_answers', '{}'::jsonb);
  v_event public.events%ROWTYPE;
  v_type public.event_registration_types%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_customer_id UUID;
  v_active_count INTEGER;
  v_field JSONB;
  v_key TEXT;
  v_norm TEXT;
  v_answer JSONB;
  v_phone_digits TEXT;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF v_full_name IS NULL OR char_length(v_full_name) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe seu nome';
  END IF;

  BEGIN
    v_type_id := (p_payload #>> '{registration_type_id}')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de inscrição inválido';
  END;

  IF NULLIF(trim(COALESCE(p_payload #>> '{customer,coach_id}', '')), '') IS NOT NULL THEN
    BEGIN
      v_coach_id := (p_payload #>> '{customer,coach_id}')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Treinador inválido';
    END;

    SELECT * INTO v_coach
    FROM public.assessment_coaches
    WHERE id = v_coach_id
      AND active IS TRUE
      AND public_visible IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador indisponível';
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.events
  WHERE slug = v_slug AND status = 'open'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrições encerradas ou evento não encontrado';
  END IF;

  SELECT * INTO v_type FROM public.event_registration_types
  WHERE id = v_type_id AND event_id = v_event.id AND active = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Tipo de inscrição indisponível';
  END IF;

  IF v_type.max_quantity IS NOT NULL THEN
    SELECT count(*) INTO v_active_count
    FROM public.event_registrations
    WHERE registration_type_id = v_type.id AND payment_status <> 'cancelled';
    IF v_active_count >= v_type.max_quantity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Vagas esgotadas para esta opção';
    END IF;
  END IF;

  IF jsonb_typeof(v_answers) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Respostas do formulário inválidas';
  END IF;

  -- Preenche automaticamente campos legados/duplicados que representem Nome
  -- ou Treinador, para tipos antigos que foram criados antes destes campos
  -- virarem nativos na tela pública.
  FOR v_field IN SELECT * FROM jsonb_array_elements(COALESCE(v_type.form_fields, '[]'::jsonb))
  LOOP
    v_key := NULLIF(v_field->>'key', '');
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    v_norm := regexp_replace(
      lower(COALESCE(v_key, '') || ' ' || COALESCE(v_field->>'label', '')),
      '[^a-z0-9]+',
      '_',
      'g'
    );

    IF v_norm LIKE '%nome%' OR v_norm LIKE '%full_name%' THEN
      v_answers := jsonb_set(v_answers, ARRAY[v_key], to_jsonb(v_full_name), true);
    ELSIF v_coach_id IS NOT NULL
          AND (v_norm LIKE '%treinador%' OR v_norm LIKE '%coach%' OR v_norm LIKE '%trainer%') THEN
      v_answers := jsonb_set(v_answers, ARRAY[v_key], to_jsonb(v_coach.name), true);
    END IF;
  END LOOP;

  v_whatsapp := COALESCE(
    NULLIF(trim(p_payload #>> '{customer,whatsapp}'), ''),
    eon_private.public_event_answer_text(
      v_answers, v_type.form_fields,
      ARRAY['whatsapp', 'whats', 'telefone', 'celular', 'phone']
    )
  );
  v_email := COALESCE(
    NULLIF(lower(trim(p_payload #>> '{customer,email}')), ''),
    lower(eon_private.public_event_answer_text(
      v_answers, v_type.form_fields,
      ARRAY['email', 'e_mail', 'mail']
    ))
  );
  v_cpf := COALESCE(
    NULLIF(regexp_replace(COALESCE(p_payload #>> '{customer,cpf}', ''), '\D', '', 'g'), ''),
    NULLIF(regexp_replace(COALESCE(eon_private.public_event_answer_text(
      v_answers, v_type.form_fields,
      ARRAY['cpf', 'documento']
    ), ''), '\D', '', 'g'), '')
  );
  v_whatsapp := public.normalize_phone_br_e164(v_whatsapp);
  v_phone_digits := NULLIF(regexp_replace(COALESCE(v_whatsapp, ''), '\D', '', 'g'), '');

  -- Aceita apenas chaves declaradas no formulário do tipo: impede que o
  -- payload público injete campos arbitrários no registro.
  FOR v_key IN SELECT jsonb_object_keys(v_answers)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_type.form_fields, '[]'::jsonb)) f
      WHERE f->>'key' = v_key
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Campo não permitido no formulário: ' || v_key;
    END IF;
  END LOOP;

  FOR v_field IN SELECT * FROM jsonb_array_elements(COALESCE(v_type.form_fields, '[]'::jsonb))
  LOOP
    IF COALESCE((v_field->>'required')::boolean, false) THEN
      v_key := v_field->>'key';
      v_answer := v_answers -> v_key;
      IF v_answer IS NULL
         OR jsonb_typeof(v_answer) = 'null'
         OR (jsonb_typeof(v_answer) = 'string' AND trim(v_answer #>> '{}') = '') THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Preencha o campo: ' || COALESCE(v_field->>'label', v_key);
      END IF;
    END IF;
  END LOOP;

  IF v_cpf IS NOT NULL THEN
    SELECT id INTO v_customer_id
    FROM public.presale_customers
    WHERE cpf = v_cpf
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND v_phone_digits IS NOT NULL THEN
    SELECT id INTO v_customer_id
    FROM public.presale_customers
    WHERE regexp_replace(COALESCE(whatsapp, ''), '\D', '', 'g') = v_phone_digits
    ORDER BY updated_date DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND v_email IS NOT NULL THEN
    SELECT id INTO v_customer_id
    FROM public.presale_customers
    WHERE lower(email) = v_email
    ORDER BY updated_date DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id
    FROM public.presale_customers
    WHERE lower(trim(full_name)) = lower(trim(v_full_name))
      AND coach_id IS NOT DISTINCT FROM v_coach_id
    ORDER BY updated_date DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL THEN
    INSERT INTO public.presale_customers (
      full_name, whatsapp, email, cpf, coach_id, active
    )
    VALUES (
      v_full_name, v_whatsapp, v_email, v_cpf, v_coach_id, true
    )
    RETURNING id INTO v_customer_id;
  ELSE
    UPDATE public.presale_customers
    SET whatsapp = COALESCE(NULLIF(whatsapp, ''), v_whatsapp),
        email = COALESCE(NULLIF(email, ''), v_email),
        cpf = COALESCE(NULLIF(cpf, ''), v_cpf),
        coach_id = COALESCE(coach_id, v_coach_id),
        active = true,
        updated_date = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO public.event_registrations (
    event_id, registration_type_id, customer_id, coach_id, form_answers, due_date
  ) VALUES (
    v_event.id, v_type.id, v_customer_id, v_coach_id, v_answers,
    CASE WHEN v_type.price > 0 THEN current_date ELSE NULL END
  )
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (order_type, order_id, previous_status, new_status, reason, metadata, actor_id)
  VALUES ('event', v_registration.id, NULL, 'pending', 'Inscrição pelo formulário público',
    jsonb_build_object(
      'action', 'event_registration_created',
      'via', 'public_form',
      'coach_id', v_coach_id,
      'customer_id', v_customer_id
    ),
    NULL);

  -- Devolve o mínimo para a tela de confirmação: nada de dados internos.
  RETURN jsonb_build_object(
    'registration_number', v_registration.registration_number,
    'event_name', v_event.name,
    'type_name', v_type.name,
    'price', v_type.price
  );
END;
$$;

REVOKE ALL ON FUNCTION eon_private.create_public_event_registration(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.create_public_event_registration(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.create_event_registration(
  p_event_id UUID,
  p_registration_type_id UUID,
  p_customer_id UUID,
  p_form_answers JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_type public.event_registration_types%ROWTYPE;
  v_event_status TEXT;
  v_customer_coach_id UUID;
  v_active_count INTEGER;
  v_field JSONB;
  v_key TEXT;
  v_answer JSONB;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF p_customer_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cliente e operador são obrigatórios';
  END IF;

  SELECT status INTO v_event_status FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Evento não encontrado';
  END IF;
  IF v_event_status NOT IN ('draft', 'open') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este evento não está aceitando inscrições';
  END IF;

  SELECT coach_id INTO v_customer_coach_id
  FROM public.presale_customers
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente não encontrado';
  END IF;

  SELECT * INTO v_type
  FROM public.event_registration_types
  WHERE id = p_registration_type_id AND event_id = p_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Tipo de inscrição não encontrado para este evento';
  END IF;
  IF NOT v_type.active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este tipo de inscrição não está mais disponível';
  END IF;

  IF v_type.max_quantity IS NOT NULL THEN
    SELECT count(*) INTO v_active_count
    FROM public.event_registrations
    WHERE registration_type_id = p_registration_type_id
      AND payment_status <> 'cancelled';
    IF v_active_count >= v_type.max_quantity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Vagas esgotadas para este tipo de inscrição';
    END IF;
  END IF;

  IF NOT jsonb_typeof(COALESCE(p_form_answers, '{}'::jsonb)) = 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Respostas do formulário inválidas';
  END IF;

  FOR v_field IN SELECT * FROM jsonb_array_elements(COALESCE(v_type.form_fields, '[]'::jsonb))
  LOOP
    IF COALESCE((v_field->>'required')::boolean, false) THEN
      v_key := v_field->>'key';
      v_answer := p_form_answers -> v_key;
      IF v_answer IS NULL
         OR jsonb_typeof(v_answer) = 'null'
         OR (jsonb_typeof(v_answer) = 'string' AND trim(v_answer #>> '{}') = '') THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Campo obrigatório não preenchido: ' || COALESCE(v_field->>'label', v_key);
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.event_registrations (
    event_id, registration_type_id, customer_id, coach_id, form_answers,
    due_date, created_by
  ) VALUES (
    p_event_id, p_registration_type_id, p_customer_id, v_customer_coach_id,
    COALESCE(p_form_answers, '{}'::jsonb),
    CASE WHEN v_type.price > 0 THEN current_date ELSE NULL END,
    p_actor_id
  )
  RETURNING * INTO v_registration;

  RETURN to_jsonb(v_registration);
END;
$$;

REVOKE ALL ON FUNCTION public.create_event_registration(UUID, UUID, UUID, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_event_registration(UUID, UUID, UUID, JSONB, UUID)
  TO service_role;
