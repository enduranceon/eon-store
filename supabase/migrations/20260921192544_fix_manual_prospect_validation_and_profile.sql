BEGIN;
SET LOCAL lock_timeout = '5s';

-- Extend the existing allowlist without changing operations already recorded.
ALTER TABLE public.assessment_contract_creation_operations
  DROP CONSTRAINT assessment_contract_creation_operations_operation_scope_check;
ALTER TABLE public.assessment_contract_creation_operations
  ADD CONSTRAINT assessment_contract_creation_operations_operation_scope_check
  CHECK (operation_scope IN ('admin_contract', 'public_enrollment', 'manual_prospect'));

-- Correct manual prospect validation and persist optional profile fields.
-- Keep the legacy signature for an API rollback; neither signature creates charges.
CREATE OR REPLACE FUNCTION public.create_manual_assessment_prospect(
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_cpf text,
  p_plan_id uuid,
  p_coach_id uuid,
  p_installments integer,
  p_notes text,
  p_idempotency_key text,
  p_actor_id uuid,
  p_gender text,
  p_birth_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_plan public.assessment_plans%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_customer public.presale_customers%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_previous_contract public.assessment_contracts%ROWTYPE;
  v_operation public.assessment_contract_creation_operations%ROWTYPE;
  v_months integer;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_snapshot jsonb;
  v_fingerprint text;
  v_relationship text := 'new_customer';
  v_result jsonb;
  v_identity text;
  v_customer_ids uuid[];
BEGIN
  p_full_name := NULLIF(btrim(p_full_name), '');
  p_whatsapp := regexp_replace(COALESCE(public.normalize_phone_br_e164(p_whatsapp), ''), '[^0-9]', '', 'g');
  p_email := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  p_cpf := NULLIF(regexp_replace(COALESCE(p_cpf, ''), '[^0-9]', '', 'g'), '');
  p_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
  p_gender := NULLIF(lower(btrim(COALESCE(p_gender, ''))), '');

  IF p_actor_id IS NULL OR p_full_name IS NULL
     OR length(p_full_name) < 2 OR length(p_full_name) > 200
     OR p_whatsapp !~ '^[0-9]{10,13}$'
     OR (p_email IS NOT NULL AND (length(p_email) > 320 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
     OR (p_cpf IS NOT NULL AND p_cpf !~ '^[0-9]{11}$')
     OR p_plan_id IS NULL OR p_coach_id IS NULL
     OR p_installments IS NULL OR p_installments < 1 OR p_installments > 120
     OR length(COALESCE(p_notes, '')) > 2000
     OR p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do prospect são inválidos';
  END IF;

  IF p_gender IS NOT NULL AND p_gender NOT IN ('masculino', 'feminino', 'outro') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione um gênero válido';
  END IF;
  IF p_birth_date IS NOT NULL AND (p_birth_date < DATE '1900-01-01' OR p_birth_date > v_today) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe uma data de nascimento válida, entre 1900 e hoje';
  END IF;

  v_fingerprint := md5((jsonb_build_object(
    'full_name', p_full_name,
    'whatsapp', p_whatsapp,
    'email', p_email,
    'cpf', p_cpf,
    'plan_id', p_plan_id,
    'coach_id', p_coach_id,
    'installments', p_installments,
    'notes', p_notes
  ) || jsonb_strip_nulls(jsonb_build_object('gender', p_gender, 'birth_date', p_birth_date)))::text);
  INSERT INTO public.assessment_contract_creation_operations(
    operation_scope, operation_key, request_fingerprint, requested_by
  ) VALUES (
    'manual_prospect', p_idempotency_key, v_fingerprint, p_actor_id
  ) ON CONFLICT (operation_scope, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.assessment_contract_creation_operations
  WHERE operation_scope = 'manual_prospect'
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF v_operation.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta chave de criação já foi usada com outros dados';
  END IF;
  IF v_operation.result IS NOT NULL THEN
    RETURN v_operation.result;
  END IF;

  SELECT * INTO v_coach
  FROM public.assessment_coaches
  WHERE id = p_coach_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach ativo não encontrado';
  END IF;

  SELECT * INTO v_plan
  FROM public.assessment_plans
  WHERE id = p_plan_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano ativo não encontrado';
  END IF;
  IF p_installments > v_plan.max_installments THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade de parcelas acima do limite do plano';
  END IF;

  -- Lock every supplied identity in a stable order, including retries without CPF.
  FOR v_identity IN
    SELECT DISTINCT identity FROM unnest(ARRAY[
      'manual_prospect:cpf:' || p_cpf,
      'manual_prospect:phone:' || p_whatsapp,
      'manual_prospect:email:' || p_email
    ]) AS identities(identity)
    WHERE identity IS NOT NULL ORDER BY identity
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_identity));
  END LOOP;
  SELECT array_agg(id) INTO v_customer_ids
  FROM public.presale_customers
  WHERE (p_cpf IS NOT NULL AND regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') = p_cpf)
     OR regexp_replace(COALESCE(public.normalize_phone_br_e164(whatsapp), ''), '[^0-9]', '', 'g') = p_whatsapp
     OR (p_email IS NOT NULL AND lower(btrim(email)) = p_email);
  IF cardinality(v_customer_ids) > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Os contatos informados correspondem a clientes diferentes. Revise os cadastros antes de criar o prospect';
  END IF;
  SELECT * INTO v_customer
  FROM public.presale_customers
  WHERE id = v_customer_ids[1]
  FOR UPDATE;

  IF FOUND THEN
    IF p_cpf IS NOT NULL AND NULLIF(regexp_replace(COALESCE(v_customer.cpf, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
       AND regexp_replace(v_customer.cpf, '[^0-9]', '', 'g') <> p_cpf THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contato informado já pertence a um cliente com outro CPF. Revise o cadastro';
    END IF;
    IF (p_birth_date IS NOT NULL AND v_customer.birth_date IS NOT NULL AND p_birth_date <> v_customer.birth_date)
       OR (p_gender IS NOT NULL AND NULLIF(btrim(v_customer.gender), '') IS NOT NULL AND p_gender <> v_customer.gender) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Gênero ou nascimento divergem do cliente existente. Revise o cadastro do cliente';
    END IF;
    UPDATE public.presale_customers
    SET full_name = COALESCE(NULLIF(btrim(full_name), ''), p_full_name),
        whatsapp = COALESCE(NULLIF(btrim(whatsapp), ''), '+' || p_whatsapp),
        email = COALESCE(NULLIF(btrim(email), ''), p_email),
        cpf = COALESCE(NULLIF(btrim(cpf), ''), p_cpf),
        gender = COALESCE(NULLIF(btrim(gender), ''), p_gender),
        birth_date = COALESCE(birth_date, p_birth_date),
        updated_date = now()
    WHERE id = v_customer.id
    RETURNING * INTO v_customer;
  ELSE
    INSERT INTO public.presale_customers(full_name, whatsapp, email, cpf, gender, birth_date, active)
    VALUES (p_full_name, '+' || p_whatsapp, p_email, p_cpf, p_gender, p_birth_date, true)
    RETURNING * INTO v_customer;
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND status = 'draft'
    AND parent_contract_id IS NULL
    AND prospect_stage IN ('new', 'proposal_ready', 'payment_link_sent')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este cliente já possui um prospect em negociação';
  END IF;

  SELECT * INTO v_previous_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND parent_contract_id IS NULL
    AND status IN ('active', 'scheduled', 'paused', 'cancelled', 'finished')
  ORDER BY CASE WHEN status IN ('active', 'scheduled', 'paused') THEN 0 ELSE 1 END,
           COALESCE(cancellation_date, end_date, updated_at::date, created_at::date) DESC,
           created_at DESC
  LIMIT 1;
  IF FOUND THEN
    v_relationship := CASE
      WHEN v_previous_contract.status IN ('active', 'scheduled', 'paused') THEN 'active_student'
      ELSE 'former_student'
    END;
  END IF;

  v_months := COALESCE(
    v_plan.period_months,
    CASE v_plan.period
      WHEN 'mensal' THEN 1
      WHEN 'trimestral' THEN 3
      WHEN 'semestral' THEN 6
      WHEN 'anual' THEN 12
      ELSE 1
    END
  );
  IF v_months < 1 OR v_months > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Período do plano inválido';
  END IF;
  v_snapshot := jsonb_build_object(
    'plan_id', v_plan.id,
    'name', v_plan.name,
    'modality_id', v_plan.modality_id,
    'price_total', v_plan.price_total,
    'price_monthly', v_plan.price_monthly,
    'enrollment_fee', v_plan.enrollment_fee,
    'max_installments', v_plan.max_installments,
    'period_months', v_months,
    'period', v_plan.period,
    'revenue_center_id', v_plan.revenue_center_id,
    'snapshot_at', now(),
    'snapshot_source', 'manual_prospect_api'
  );
  INSERT INTO public.assessment_contracts(
    customer_id, coach_id, plan_id, plan_snapshot,
    status, payment_status, start_date, end_date, original_end_date,
    installments, enrollment_fee, manual_discount, auto_renewal, notes,
    prospect_stage, prospect_customer_relationship, prospect_previous_contract_id,
    created_by
  ) VALUES (
    v_customer.id, v_coach.id, v_plan.id, v_snapshot,
    'draft', 'pending', v_today, v_today + make_interval(months => v_months),
    v_today + make_interval(months => v_months),
    p_installments, v_plan.enrollment_fee, 0, false, p_notes,
    'new', v_relationship,
    CASE WHEN v_relationship = 'new_customer' THEN NULL ELSE v_previous_contract.id END,
    p_actor_id
  ) RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_created_manually',
    jsonb_build_object(
      'source', 'manual_prospect_api',
      'plan_snapshot', v_snapshot,
      'coach_id', v_coach.id,
      'installments', p_installments,
      'customer_reused', v_customer.created_date < now() - interval '1 second',
      'relationship', v_relationship,
      'previous_contract_id', CASE WHEN v_relationship = 'new_customer' THEN NULL ELSE v_previous_contract.id END
    ),
    'Prospect incluído manualmente no funil comercial',
    p_actor_id
  );

  v_result := jsonb_build_object('contract', to_jsonb(v_contract));
  UPDATE public.assessment_contract_creation_operations
  SET result = v_result, updated_at = now()
  WHERE id = v_operation.id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_manual_assessment_prospect(
  text, text, text, text, uuid, uuid, integer, text, text, uuid, text, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_assessment_prospect(
  text, text, text, text, uuid, uuid, integer, text, text, uuid, text, date
) TO service_role;

-- No defaults on the new overload: PostgREST can resolve both signatures exactly.
CREATE OR REPLACE FUNCTION public.create_manual_assessment_prospect(
  p_full_name text, p_whatsapp text, p_email text, p_cpf text,
  p_plan_id uuid, p_coach_id uuid, p_installments integer, p_notes text,
  p_idempotency_key text, p_actor_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.create_manual_assessment_prospect(
    p_full_name, p_whatsapp, p_email, p_cpf, p_plan_id, p_coach_id,
    p_installments, p_notes, p_idempotency_key, p_actor_id, NULL::text, NULL::date
  );
$$;
REVOKE ALL ON FUNCTION public.create_manual_assessment_prospect(
  text, text, text, text, uuid, uuid, integer, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_assessment_prospect(
  text, text, text, text, uuid, uuid, integer, text, text, uuid
) TO service_role;

COMMIT;
