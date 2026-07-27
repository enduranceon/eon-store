-- Remaining assessment-contract writes routed through the JWT-protected API.
-- The public enrollment endpoint is intentionally public, but it also writes
-- only through the validated Edge Function and these service-role RPCs.

CREATE TABLE public.assessment_contract_creation_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_scope text NOT NULL
    CHECK (operation_scope IN ('admin_contract', 'public_enrollment')),
  operation_key text NOT NULL
    CHECK (operation_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  request_fingerprint text NOT NULL
    CHECK (request_fingerprint ~ '^[a-f0-9]{32}$'),
  requested_by uuid,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_scope, operation_key)
);

ALTER TABLE public.assessment_contract_creation_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.assessment_contract_creation_operations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.assessment_contract_creation_operations
  TO service_role;

COMMENT ON TABLE public.assessment_contract_creation_operations IS
  'Server-only idempotency ledger for assessment contract creation.';

CREATE OR REPLACE FUNCTION public.create_assessment_contract_from_admin(
  p_customer_id uuid,
  p_coach_id uuid,
  p_plan_id uuid,
  p_start_date date,
  p_installments integer,
  p_enrollment_fee numeric,
  p_manual_discount numeric,
  p_discount_reason text,
  p_auto_renewal boolean,
  p_notes text,
  p_replacement_contract_id uuid,
  p_idempotency_key text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_plan public.assessment_plans%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_replacement public.assessment_contracts%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_operation public.assessment_contract_creation_operations%ROWTYPE;
  v_months integer;
  v_end_date date;
  v_snapshot jsonb;
  v_notes text;
  v_fingerprint text;
  v_prior_contracts integer;
  v_prior_cancelled integer;
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_customer_id IS NULL OR p_coach_id IS NULL
     OR p_plan_id IS NULL OR p_start_date IS NULL OR p_auto_renewal IS NULL
     OR p_installments IS NULL OR p_installments < 1 OR p_installments > 120
     OR p_enrollment_fee IS NULL OR p_enrollment_fee < 0 OR p_enrollment_fee > 1000000
     OR p_manual_discount IS NULL OR p_manual_discount < 0 OR p_manual_discount > 1000000
     OR p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$'
     OR length(COALESCE(p_discount_reason, '')) > 500
     OR length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do contrato são inválidos';
  END IF;

  v_fingerprint := md5(jsonb_build_object(
    'customer_id', p_customer_id,
    'coach_id', p_coach_id,
    'plan_id', p_plan_id,
    'start_date', p_start_date,
    'installments', p_installments,
    'enrollment_fee', p_enrollment_fee,
    'manual_discount', p_manual_discount,
    'discount_reason', NULLIF(btrim(p_discount_reason), ''),
    'auto_renewal', p_auto_renewal,
    'notes', NULLIF(btrim(p_notes), ''),
    'replacement_contract_id', p_replacement_contract_id
  )::text);

  INSERT INTO public.assessment_contract_creation_operations(
    operation_scope, operation_key, request_fingerprint, requested_by
  ) VALUES (
    'admin_contract', p_idempotency_key, v_fingerprint, p_actor_id
  ) ON CONFLICT (operation_scope, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.assessment_contract_creation_operations
  WHERE operation_scope = 'admin_contract'
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF v_operation.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta chave de criação já foi usada com outros dados';
  END IF;
  IF v_operation.result IS NOT NULL THEN
    RETURN v_operation.result;
  END IF;

  PERFORM 1 FROM public.presale_customers
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Aluno não encontrado';
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
  IF p_manual_discount > (v_plan.price_total + p_enrollment_fee) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O desconto não pode superar o valor do contrato';
  END IF;

  IF p_replacement_contract_id IS NOT NULL THEN
    SELECT * INTO v_replacement
    FROM public.assessment_contracts
    WHERE id = p_replacement_contract_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato substituído não encontrado';
    END IF;
    IF v_replacement.customer_id <> p_customer_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato substituído pertence a outro aluno';
    END IF;
    IF NOT (
      v_replacement.status = 'voided'
      OR (
        v_replacement.status = 'cancelled'
        AND lower(COALESCE(v_replacement.cancellation_reason, '')) ~
          '(venda não concretizada|venda nao concretizada|venda substituída|venda substituida|cliente nunca pagou|descartad)'
      )
    ) OR v_replacement.payment_date IS NOT NULL
      OR COALESCE(v_replacement.refund_amount, 0) <> 0
      OR COALESCE(v_replacement.cancellation_fee, 0) <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente uma venda descartada e sem movimentação financeira pode ser substituída';
    END IF;
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
  v_end_date := p_start_date + make_interval(months => v_months);
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
    'snapshot_source', 'contract_create_api'
  );
  v_notes := concat_ws(
    ' · ',
    CASE WHEN p_replacement_contract_id IS NOT NULL
      THEN 'Substitui registro descartado ' || COALESCE(v_replacement.contract_number, v_replacement.id::text)
      ELSE NULL END,
    NULLIF(btrim(p_notes), '')
  );
  v_notes := NULLIF(v_notes, '');

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE status = 'cancelled'
             AND NOT lower(COALESCE(cancellation_reason, '')) ~
               '(venda não concretizada|venda nao concretizada|venda substituída|venda substituida|cliente nunca pagou|descartad)'
         )::integer
    INTO v_prior_contracts, v_prior_cancelled
  FROM public.assessment_contracts
  WHERE customer_id = p_customer_id
    AND id IS DISTINCT FROM p_replacement_contract_id;

  INSERT INTO public.assessment_contracts(
    customer_id, coach_id, plan_id, plan_snapshot,
    status, payment_status, start_date, end_date, original_end_date, due_date,
    installments, enrollment_fee, manual_discount, discount_reason,
    auto_renewal, notes, created_by
  ) VALUES (
    p_customer_id, p_coach_id, p_plan_id, v_snapshot,
    'active', 'pending', p_start_date, v_end_date, v_end_date,
    (now() AT TIME ZONE 'America/Sao_Paulo')::date + 3,
    p_installments, p_enrollment_fee, p_manual_discount,
    NULLIF(btrim(p_discount_reason), ''), p_auto_renewal, v_notes, p_actor_id
  ) RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'created',
    jsonb_build_object(
      'source', 'admin_api',
      'plan_snapshot', v_snapshot,
      'coach_id', p_coach_id,
      'installments', p_installments,
      'enrollment_fee', p_enrollment_fee,
      'manual_discount', p_manual_discount,
      'discount_reason', NULLIF(btrim(p_discount_reason), ''),
      'auto_renewal', p_auto_renewal,
      'total_value', v_plan.price_total + p_enrollment_fee - p_manual_discount,
      'prior_contracts', v_prior_contracts,
      'prior_cancelled', v_prior_cancelled,
      'replacement_of_contract_id', p_replacement_contract_id,
      'replacement_of_contract_number', v_replacement.contract_number
    ),
    CASE
      WHEN p_replacement_contract_id IS NOT NULL
        THEN 'Criado como substituição de ' || COALESCE(v_replacement.contract_number, v_replacement.id::text)
      WHEN v_prior_cancelled > 0
        THEN 'Aluno tem ' || v_prior_cancelled || ' contrato(s) cancelado(s) anteriormente'
      ELSE NULL
    END,
    p_actor_id
  );

  IF p_replacement_contract_id IS NOT NULL THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_replacement.id,
      'sale_replaced',
      jsonb_build_object(
        'new_contract_id', v_contract.id,
        'new_contract_number', v_contract.contract_number,
        'new_plan_id', v_plan.id,
        'new_plan_snapshot', v_snapshot
      ),
      'Substituída pelo contrato ' || COALESCE(v_contract.contract_number, v_contract.id::text),
      p_actor_id
    );
  END IF;

  v_result := jsonb_build_object('contract', to_jsonb(v_contract));
  UPDATE public.assessment_contract_creation_operations
  SET result = v_result, updated_at = now()
  WHERE id = v_operation.id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_public_assessment_enrollment(
  p_plan_id uuid,
  p_coach_id uuid,
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_cpf text,
  p_gender text,
  p_birth_date date,
  p_payment_type text,
  p_installments integer,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_plan public.assessment_plans%ROWTYPE;
  v_customer public.presale_customers%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_operation public.assessment_contract_creation_operations%ROWTYPE;
  v_months integer;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_end_date date;
  v_snapshot jsonb;
  v_fingerprint text;
  v_result jsonb;
  v_installments integer;
BEGIN
  p_full_name := NULLIF(btrim(p_full_name), '');
  p_whatsapp := regexp_replace(COALESCE(p_whatsapp, ''), '\D', '', 'g');
  p_cpf := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
  p_email := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  p_gender := NULLIF(btrim(COALESCE(p_gender, '')), '');

  IF p_plan_id IS NULL OR p_coach_id IS NULL OR p_full_name IS NULL
     OR length(p_full_name) < 2 OR length(p_full_name) > 200
     OR p_whatsapp !~ '^\d{10,13}$' OR p_cpf !~ '^\d{11}$'
     OR (p_email IS NOT NULL AND (length(p_email) > 320 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
     OR length(COALESCE(p_gender, '')) > 50
     OR p_payment_type NOT IN ('card', 'pix_boleto')
     OR p_installments IS NULL OR p_installments < 1 OR p_installments > 120
     OR p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da adesão são inválidos';
  END IF;

  v_fingerprint := md5(jsonb_build_object(
    'plan_id', p_plan_id,
    'coach_id', p_coach_id,
    'full_name', p_full_name,
    'whatsapp', p_whatsapp,
    'email', p_email,
    'cpf', p_cpf,
    'gender', p_gender,
    'birth_date', p_birth_date,
    'payment_type', p_payment_type,
    'installments', p_installments
  )::text);
  INSERT INTO public.assessment_contract_creation_operations(
    operation_scope, operation_key, request_fingerprint, requested_by
  ) VALUES (
    'public_enrollment', p_idempotency_key, v_fingerprint, NULL
  ) ON CONFLICT (operation_scope, operation_key) DO NOTHING;
  SELECT * INTO v_operation
  FROM public.assessment_contract_creation_operations
  WHERE operation_scope = 'public_enrollment'
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF v_operation.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta chave de adesão já foi usada com outros dados';
  END IF;
  IF v_operation.result IS NOT NULL THEN
    RETURN v_operation.result;
  END IF;

  SELECT * INTO v_plan
  FROM public.assessment_plans
  WHERE id = p_plan_id AND active = true AND available_online = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano público não encontrado';
  END IF;
  PERFORM 1 FROM public.assessment_coaches
  WHERE id = p_coach_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach ativo não encontrado';
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
  v_installments := CASE WHEN p_payment_type = 'card'
    THEN LEAST(p_installments, v_plan.max_installments, v_months)
    ELSE 1 END;

  SELECT * INTO v_customer
  FROM public.presale_customers
  WHERE cpf = p_cpf
  ORDER BY created_date
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    UPDATE public.presale_customers
    SET full_name = COALESCE(NULLIF(btrim(full_name), ''), p_full_name),
        whatsapp = COALESCE(NULLIF(btrim(whatsapp), ''), p_whatsapp),
        email = COALESCE(NULLIF(btrim(email), ''), p_email),
        gender = COALESCE(NULLIF(btrim(gender), ''), p_gender),
        birth_date = COALESCE(birth_date, p_birth_date),
        updated_date = now()
    WHERE id = v_customer.id
    RETURNING * INTO v_customer;
  ELSE
    INSERT INTO public.presale_customers(
      full_name, whatsapp, email, cpf, gender, birth_date, active
    ) VALUES (
      p_full_name, p_whatsapp, p_email, p_cpf, p_gender, p_birth_date, true
    ) RETURNING * INTO v_customer;
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND plan_id = v_plan.id
    AND status = 'draft'
    AND parent_contract_id IS NULL
    AND created_at >= now() - interval '15 minutes'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    v_result := jsonb_build_object(
      'contract_id', v_contract.id,
      'contract_number', v_contract.contract_number,
      'duplicate_prevented', true
    );
    UPDATE public.assessment_contract_creation_operations
    SET result = v_result, updated_at = now()
    WHERE id = v_operation.id;
    RETURN v_result;
  END IF;

  v_end_date := v_today + make_interval(months => v_months);
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
    'snapshot_source', 'public_enrollment_api'
  );
  INSERT INTO public.assessment_contracts(
    customer_id, coach_id, plan_id, plan_snapshot,
    status, payment_status, start_date, end_date, original_end_date,
    payment_method, installments, enrollment_fee, auto_renewal, notes,
    created_by
  ) VALUES (
    v_customer.id, p_coach_id, v_plan.id, v_snapshot,
    'draft', 'pending', v_today, v_end_date, v_end_date,
    p_payment_type, v_installments, v_plan.enrollment_fee, false,
    'Adesão via formulário público', NULL
  ) RETURNING * INTO v_contract;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'created',
    jsonb_build_object(
      'source', 'public_enrollment_api',
      'plan_snapshot', v_snapshot,
      'coach_id', p_coach_id,
      'payment_method', p_payment_type,
      'installments', v_installments
    ),
    'Adesão recebida pelo formulário público',
    NULL
  );
  v_result := jsonb_build_object(
    'contract_id', v_contract.id,
    'contract_number', v_contract.contract_number,
    'duplicate_prevented', false
  );
  UPDATE public.assessment_contract_creation_operations
  SET result = v_result, updated_at = now()
  WHERE id = v_operation.id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_assessment_contract_discount(
  p_contract_id uuid,
  p_manual_discount numeric,
  p_discount_reason text,
  p_discount_recurring boolean,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_total numeric;
  v_old_discount numeric;
  v_old_reason text;
  v_old_recurring boolean;
BEGIN
  IF p_contract_id IS NULL OR p_actor_id IS NULL OR p_expected_updated_at IS NULL
     OR p_manual_discount IS NULL OR p_manual_discount < 0 OR p_manual_discount > 1000000
     OR p_discount_recurring IS NULL
     OR length(COALESCE(p_discount_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do desconto são inválidos';
  END IF;
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge')
     OR v_contract.payment_date IS NOT NULL
     OR COALESCE(v_contract.manual_payment, false)
     OR NULLIF(v_contract.asaas_charge_id, '') IS NOT NULL
     OR NULLIF(v_contract.external_payment_link, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cancele ou conclua a cobrança atual antes de alterar o desconto';
  END IF;
  v_total := COALESCE((v_contract.plan_snapshot->>'price_total')::numeric, 0)
    + COALESCE(v_contract.enrollment_fee, 0)
    - COALESCE(v_contract.credit_balance, 0);
  IF p_manual_discount > GREATEST(v_total, 0) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O desconto não pode superar o saldo do contrato';
  END IF;
  v_old_discount := COALESCE(v_contract.manual_discount, 0);
  v_old_reason := v_contract.discount_reason;
  v_old_recurring := COALESCE(v_contract.discount_recurring, false);
  UPDATE public.assessment_contracts
  SET manual_discount = p_manual_discount,
      discount_reason = NULLIF(btrim(p_discount_reason), ''),
      discount_recurring = p_discount_recurring,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, created_by
  ) VALUES (
    v_contract.id,
    'discount_updated',
    jsonb_build_object(
      'manual_discount_before', v_old_discount,
      'manual_discount_after', p_manual_discount,
      'discount_reason_before', v_old_reason,
      'discount_reason_after', NULLIF(btrim(p_discount_reason), ''),
      'discount_recurring_before', v_old_recurring,
      'discount_recurring_after', p_discount_recurring
    ),
    p_actor_id
  );
  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_assessment_contract_refund(
  p_contract_id uuid,
  p_refund_date date,
  p_refund_notes text,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF p_contract_id IS NULL OR p_actor_id IS NULL OR p_expected_updated_at IS NULL
     OR p_refund_date IS NULL OR p_refund_date > v_today
     OR length(COALESCE(p_refund_notes, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do estorno são inválidos';
  END IF;
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_contract.refund_status <> 'pending'
     OR COALESCE(v_contract.refund_amount, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não possui estorno pendente';
  END IF;
  UPDATE public.assessment_contracts
  SET refund_status = 'done',
      refund_date = p_refund_date,
      refund_notes = NULLIF(btrim(p_refund_notes), ''),
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'refund_completed',
    jsonb_build_object(
      'refund_amount', v_contract.refund_amount,
      'refund_date', p_refund_date,
      'refund_status', 'done'
    ),
    NULLIF(btrim(p_refund_notes), ''),
    p_actor_id
  );
  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_assessment_contract_transitions(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_changed jsonb := '[]'::jsonb;
  v_next_status text;
  v_previous_status text;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE status = 'scheduled' AND start_date <= v_today
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.assessment_contracts
    SET status = 'active', updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object('status_before', 'scheduled', 'status_after', 'active', 'effective_date', v_today),
      'Contrato ativado automaticamente no início da vigência', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id, 'status', v_contract.status, 'updated_at', v_contract.updated_at
    ));
  END LOOP;

  FOR v_contract IN
    SELECT parent.*
    FROM public.assessment_contracts parent
    WHERE parent.status IN ('active', 'overdue', 'on_leave')
      AND EXISTS (
        SELECT 1 FROM public.assessment_contracts renewal
        WHERE renewal.parent_contract_id = parent.id
          AND renewal.status = 'active'
          AND renewal.start_date <= v_today
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    v_previous_status := v_contract.status;
    UPDATE public.assessment_contracts
    SET status = 'finished', updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object('status_before', v_previous_status, 'status_after', 'finished', 'effective_date', v_today, 'reason', 'renewal_started'),
      'Contrato concluído automaticamente pelo início da renovação', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id, 'status', 'finished', 'updated_at', v_contract.updated_at
    ));
  END LOOP;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE status = 'active' AND end_date < v_today
    FOR UPDATE SKIP LOCKED
  LOOP
    v_next_status := CASE
      WHEN lower(COALESCE(v_contract.cancellation_reason, '')) ~
        '(não renovou|nao renovou|não vai renovar|nao vai renovar)'
        THEN 'finished'
      ELSE 'overdue'
    END;
    UPDATE public.assessment_contracts
    SET status = v_next_status, updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object('status_before', 'active', 'status_after', v_next_status, 'effective_date', v_today, 'reason', 'end_date_passed'),
      'Status atualizado automaticamente após o fim da vigência', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id, 'status', v_contract.status, 'updated_at', v_contract.updated_at
    ));
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed, 'effective_date', v_today);
END;
$$;

REVOKE ALL ON FUNCTION public.create_assessment_contract_from_admin(
  uuid, uuid, uuid, date, integer, numeric, numeric, text, boolean, text,
  uuid, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_public_assessment_enrollment(
  uuid, uuid, text, text, text, text, text, date, text, integer, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_assessment_contract_discount(
  uuid, numeric, text, boolean, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_assessment_contract_refund(
  uuid, date, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_assessment_contract_transitions(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_assessment_contract_from_admin(
  uuid, uuid, uuid, date, integer, numeric, numeric, text, boolean, text,
  uuid, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_public_assessment_enrollment(
  uuid, uuid, text, text, text, text, text, date, text, integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_assessment_contract_discount(
  uuid, numeric, text, boolean, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_assessment_contract_refund(
  uuid, date, text, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_assessment_contract_transitions(uuid)
  TO service_role;
