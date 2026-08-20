-- Fase 3 da Área de Eventos: inscrição pública. O atleta abre um link,
-- escolhe o tipo de inscrição, preenche o formulário daquele tipo e se
-- inscreve — sem login.
--
-- Segurança, seguindo exatamente o que já protege a loja pública:
--   1. Leitura por RPC SECURITY DEFINER que expõe SÓ o necessário (nunca
--      SELECT direto na tabela pelo anon).
--   2. Escrita atrás de limite de taxa por IP e por telefone, com advisory
--      lock para requisições paralelas não furarem o limite.
--   3. Só eventos com status 'open' aparecem/aceitam inscrição — 'draft' fica
--      invisível ao público, permitindo montar o evento antes de divulgar.
--
-- Diferença do checkout da loja: lá o rate limit vive numa edge function
-- dedicada (public-store-checkout), cujo fonte chegou a existir só na máquina
-- do Guto. Aqui a rota pública fica na api-v1, que é deployada junto com o
-- resto — mesma proteção, sem criar outra função avulsa para se perder.

CREATE TABLE IF NOT EXISTS eon_private.public_event_registration_rate_limits (
  id BIGSERIAL PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  phone_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_event_rate_limits_ip_idx
  ON eon_private.public_event_registration_rate_limits (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS public_event_rate_limits_phone_idx
  ON eon_private.public_event_registration_rate_limits (phone_hash, created_at DESC);

-- Devolve o evento e seus tipos ativos para a página pública. Expõe apenas
-- campos que podem ser públicos: nada de notas internas, contagem de
-- inscritos individuais ou dados de outros participantes.
CREATE OR REPLACE FUNCTION eon_private.get_public_event(p_slug TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_types JSONB;
BEGIN
  SELECT * INTO v_event
  FROM public.events
  WHERE slug = NULLIF(trim(p_slug), '') AND status = 'open';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(t ORDER BY t_sort, t_name), '[]'::jsonb) INTO v_types
  FROM (
    SELECT
      jsonb_build_object(
        'id', rt.id,
        'name', rt.name,
        'price', rt.price,
        'form_fields', rt.form_fields,
        -- Vagas restantes em vez do total de inscritos: o público precisa
        -- saber se ainda dá tempo, não quantas pessoas já se inscreveram.
        'spots_left', CASE
          WHEN rt.max_quantity IS NULL THEN NULL
          ELSE GREATEST(rt.max_quantity - (
            SELECT count(*) FROM public.event_registrations r
            WHERE r.registration_type_id = rt.id AND r.payment_status <> 'cancelled'
          ), 0)
        END
      ) AS t,
      rt.sort_order AS t_sort,
      rt.name AS t_name
    FROM public.event_registration_types rt
    WHERE rt.event_id = v_event.id AND rt.active = true
  ) sub;

  RETURN jsonb_build_object(
    'id', v_event.id,
    'name', v_event.name,
    'slug', v_event.slug,
    'description', v_event.description,
    'event_date', v_event.event_date,
    'location', v_event.location,
    'registration_types', v_types
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_event(p_slug TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT eon_private.get_public_event(p_slug);
$$;

-- Cria a inscrição vinda do formulário público. Reaproveita
-- upsert_assessment_customer, o mesmo casamento de cadastro por CPF/telefone
-- usado pela adesão pública de planos — inscrição de evento não cria cliente
-- duplicado.
CREATE OR REPLACE FUNCTION eon_private.create_public_event_registration(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_slug TEXT := NULLIF(trim(p_payload #>> '{event_slug}'), '');
  v_type_id UUID;
  v_full_name TEXT := NULLIF(trim(p_payload #>> '{customer,full_name}'), '');
  v_whatsapp TEXT := NULLIF(trim(p_payload #>> '{customer,whatsapp}'), '');
  v_email TEXT := NULLIF(lower(trim(p_payload #>> '{customer,email}')), '');
  v_cpf TEXT := NULLIF(regexp_replace(COALESCE(p_payload #>> '{customer,cpf}', ''), '\D', '', 'g'), '');
  v_answers JSONB := COALESCE(p_payload -> 'form_answers', '{}'::jsonb);
  v_event public.events%ROWTYPE;
  v_type public.event_registration_types%ROWTYPE;
  v_customer_id UUID;
  v_active_count INTEGER;
  v_field JSONB;
  v_key TEXT;
  v_answer JSONB;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF v_full_name IS NULL OR char_length(v_full_name) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe seu nome completo';
  END IF;
  IF v_whatsapp IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe seu WhatsApp';
  END IF;

  BEGIN
    v_type_id := (p_payload #>> '{registration_type_id}')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de inscrição inválido';
  END;

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

  v_customer_id := public.upsert_assessment_customer(
    v_full_name, v_whatsapp, v_cpf, NULL, NULL, v_email
  );

  INSERT INTO public.event_registrations (
    event_id, registration_type_id, customer_id, form_answers, due_date
  ) VALUES (
    v_event.id, v_type.id, v_customer_id, v_answers,
    CASE WHEN v_type.price > 0 THEN current_date ELSE NULL END
  )
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (order_type, order_id, previous_status, new_status, reason, metadata, actor_id)
  VALUES ('event', v_registration.id, NULL, 'pending', 'Inscrição pelo formulário público',
    jsonb_build_object('action', 'event_registration_created', 'via', 'public_form'), NULL);

  -- Devolve o mínimo para a tela de confirmação: nada de dados internos.
  RETURN jsonb_build_object(
    'registration_number', v_registration.registration_number,
    'event_name', v_event.name,
    'type_name', v_type.name,
    'price', v_type.price
  );
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.create_rate_limited_public_event_registration(
  p_ip_hash TEXT,
  p_phone_hash TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ip_hash TEXT := NULLIF(trim(p_ip_hash), '');
  v_phone_hash TEXT := NULLIF(trim(p_phone_hash), '');
BEGIN
  IF v_ip_hash IS NULL OR v_phone_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Não foi possível validar a origem da inscrição';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('public-event-ip:' || v_ip_hash, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('public-event-phone:' || v_phone_hash, 0));

  DELETE FROM eon_private.public_event_registration_rate_limits
  WHERE created_at < now() - interval '2 days';

  IF (
    SELECT count(*) FROM eon_private.public_event_registration_rate_limits
    WHERE ip_hash = v_ip_hash AND created_at >= now() - interval '1 hour'
  ) >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Muitas tentativas. Aguarde alguns minutos e tente novamente';
  END IF;

  -- Limite por telefone mais alto que o da loja (3/dia): é comum uma pessoa
  -- inscrever familiares ou colegas de treino pelo mesmo WhatsApp.
  IF (
    SELECT count(*) FROM eon_private.public_event_registration_rate_limits
    WHERE phone_hash = v_phone_hash AND created_at >= now() - interval '1 day'
  ) >= 6 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este telefone já enviou várias inscrições hoje. Fale com a equipe';
  END IF;

  INSERT INTO eon_private.public_event_registration_rate_limits (ip_hash, phone_hash)
  VALUES (v_ip_hash, v_phone_hash);

  -- Compartilha a transação: se a inscrição falhar, o registro de limite
  -- também é desfeito e a pessoa não perde a tentativa.
  RETURN eon_private.create_public_event_registration(p_payload);
END;
$$;

REVOKE ALL ON FUNCTION eon_private.get_public_event(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.create_public_event_registration(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.create_rate_limited_public_event_registration(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_event(TEXT) FROM PUBLIC;

-- Só a leitura do evento é exposta ao anon. A escrita continua exclusiva do
-- service_role, ou seja, só passa pela api-v1 que calcula o hash de IP.
GRANT EXECUTE ON FUNCTION public.get_public_event(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.get_public_event(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.create_public_event_registration(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.create_rate_limited_public_event_registration(TEXT, TEXT, JSONB) TO service_role;;
