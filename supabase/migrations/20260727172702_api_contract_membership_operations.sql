-- Contract membership operations used by the authenticated admin API.
-- Every business mutation and its audit event happen in one transaction.

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_operation_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_operation_type_check
  CHECK (operation_type IN (
    'cancel_order',
    'refund_order',
    'cancel_item',
    'change_due_date',
    'create_charge',
    'cancel_charge',
    'resolve_renewal',
    'void_contract_sale',
    'change_contract_plan',
    'create_contract_renewal'
  ));

CREATE OR REPLACE FUNCTION public.create_assessment_contract_renewal(
  p_contract_id uuid,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_parent public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_operation public.order_operations%ROWTYPE;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_months integer;
  v_start date;
  v_target_month date;
  v_end date;
  v_due_date date;
  v_status text;
  v_parent_status text;
  v_snapshot jsonb;
  v_result jsonb;
BEGIN
  IF p_contract_id IS NULL OR p_actor_id IS NULL
     OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da renovação são inválidos';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  SELECT * INTO v_parent
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'create_contract_renewal'
    AND order_type = 'contract'
    AND order_id = p_contract_id
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.status = 'completed' AND v_operation.result IS NOT NULL THEN
      RETURN v_operation.result;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A criação desta renovação ainda está em processamento';
  END IF;

  IF v_parent.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_parent.parent_contract_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já é uma renovação';
  END IF;
  IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O estado atual do contrato não permite renovação';
  END IF;
  IF v_parent.renewal_generated THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A renovação deste contrato já foi registrada';
  END IF;
  IF NULLIF(btrim(v_parent.cancellation_reason), '') IS NOT NULL
     OR v_parent.cancellation_date IS NOT NULL
     OR COALESCE(v_parent.cancellation_fee, 0) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato possui outro registro de encerramento';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contracts child
    WHERE child.parent_contract_id = v_parent.id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Já existe uma renovação aberta para este contrato';
  END IF;

  SELECT * INTO v_plan
  FROM public.assessment_plans
  WHERE id = v_parent.plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano do contrato não encontrado';
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

  v_start := v_parent.end_date;
  v_target_month := (
    date_trunc('month', v_start)::date + make_interval(months => v_months)
  )::date;
  v_end := v_target_month + (
    LEAST(
      extract(day FROM v_start)::integer,
      extract(day FROM (v_target_month + interval '1 month - 1 day'))::integer
    ) - 1
  );
  v_status := CASE
    WHEN v_start > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'scheduled'
    ELSE 'active'
  END;
  v_due_date := GREATEST(
    v_start,
    (now() AT TIME ZONE 'America/Sao_Paulo')::date
  );
  v_parent_status := CASE WHEN v_status = 'active' THEN 'finished' ELSE v_parent.status END;
  v_snapshot := jsonb_build_object(
    'plan_id', v_plan.id,
    'name', v_plan.name,
    'modality_id', v_plan.modality_id,
    'price_total', v_plan.price_total,
    'price_monthly', v_plan.price_monthly,
    'enrollment_fee', v_plan.enrollment_fee,
    'max_installments', v_plan.max_installments,
    'period', v_plan.period,
    'period_months', v_months,
    'snapshot_at', now(),
    'snapshot_source', 'manual_renewal'
  );

  INSERT INTO public.assessment_contracts (
    customer_id, coach_id, plan_id, plan_snapshot, status,
    start_date, end_date, original_end_date, due_date, installments,
    enrollment_fee, manual_discount, discount_reason, discount_recurring,
    auto_renewal, parent_contract_id, notes, payment_status, created_by
  ) VALUES (
    v_parent.customer_id, v_parent.coach_id, v_parent.plan_id, v_snapshot, v_status,
    v_start, v_end, v_end, v_due_date, v_parent.installments,
    0,
    CASE WHEN v_parent.discount_recurring AND COALESCE(v_parent.manual_discount, 0) > 0
      THEN v_parent.manual_discount ELSE 0 END,
    CASE WHEN v_parent.discount_recurring AND COALESCE(v_parent.manual_discount, 0) > 0
      THEN v_parent.discount_reason ELSE NULL END,
    v_parent.discount_recurring AND COALESCE(v_parent.manual_discount, 0) > 0,
    v_parent.auto_renewal, v_parent.id,
    'Renovação manual de ' || COALESCE(v_parent.contract_number, v_parent.id::text),
    'pending', p_actor_id
  ) RETURNING * INTO v_renewal;

  UPDATE public.assessment_contracts
  SET renewal_generated = true,
      status = v_parent_status,
      updated_at = now()
  WHERE id = v_parent.id;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_parent.id,
    'renewed',
    jsonb_build_object(
      'new_contract_id', v_renewal.id,
      'new_contract_number', v_renewal.contract_number,
      'new_start', v_start,
      'new_end', v_end,
      'new_status', v_status,
      'plan_id', v_parent.plan_id,
      'installments', v_parent.installments,
      'had_open_payment', v_parent.payment_status NOT IN ('paid', 'refunded', 'cancelled')
    ),
    NULL,
    p_actor_id
  ), (
    v_renewal.id,
    'created',
    jsonb_build_object(
      'via', 'renewal',
      'parent_contract_id', v_parent.id,
      'parent_contract_num', v_parent.contract_number,
      'plan_id', v_parent.plan_id,
      'installments', v_parent.installments,
      'status_after', v_status
    ),
    CASE WHEN v_status = 'scheduled'
      THEN 'Renovação agendada de ' || COALESCE(v_parent.contract_number, v_parent.id::text)
      ELSE 'Renovação de ' || COALESCE(v_parent.contract_number, v_parent.id::text) END,
    p_actor_id
  );

  v_result := jsonb_build_object(
    'contract', to_jsonb(v_renewal),
    'parent_status', v_parent_status,
    'status', 'completed'
  );
  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, result
  ) VALUES (
    'create_contract_renewal', p_idempotency_key, 'contract', v_parent.id,
    'completed', p_actor_id, 'Criar renovação manual',
    jsonb_build_object(
      'expected_updated_at', p_expected_updated_at,
      'renewal_id', v_renewal.id
    ),
    v_result
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_assessment_contract_renewal(
  p_contract_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_renewal public.assessment_contracts%ROWTYPE;
  v_parent public.assessment_contracts%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v_renewal
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Renovação não encontrada';
  END IF;
  IF v_renewal.parent_contract_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não é uma renovação';
  END IF;

  SELECT * INTO v_parent
  FROM public.assessment_contracts
  WHERE id = v_renewal.parent_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato anterior não encontrado';
  END IF;
  IF v_renewal.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A renovação foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_renewal.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente um rascunho pode ser aprovado';
  END IF;
  IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato anterior não permite ativar esta renovação';
  END IF;
  IF NULLIF(btrim(v_parent.cancellation_reason), '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato anterior possui um registro de encerramento';
  END IF;

  v_status := CASE
    WHEN v_renewal.start_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date
      THEN 'scheduled'
    ELSE 'active'
  END;
  UPDATE public.assessment_contracts
  SET status = v_status,
      updated_at = now()
  WHERE id = v_renewal.id
  RETURNING * INTO v_renewal;

  IF v_status = 'active' THEN
    UPDATE public.assessment_contracts
    SET renewal_generated = true,
        status = 'finished',
        updated_at = now()
    WHERE id = v_parent.id
    RETURNING * INTO v_parent;
  END IF;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_renewal.id,
    CASE WHEN v_status = 'scheduled' THEN 'renewal_scheduled' ELSE 'renewal_activated' END,
    jsonb_build_object(
      'parent_contract_id', v_parent.id,
      'parent_contract_number', v_parent.contract_number,
      'status_after', v_status,
      'start_date', v_renewal.start_date
    ),
    CASE WHEN v_status = 'scheduled'
      THEN 'Rascunho de renovação aprovado e agendado'
      ELSE 'Rascunho de renovação aprovado e ativado' END,
    p_actor_id
  );
  RETURN jsonb_build_object(
    'contract', to_jsonb(v_renewal),
    'parent_status', v_parent.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_assessment_contract_auto_renewal(
  p_contract_id uuid,
  p_auto_renewal boolean,
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
BEGIN
  IF p_auto_renewal IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a configuração de renovação automática';
  END IF;
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.auto_renewal IS NOT DISTINCT FROM p_auto_renewal THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  UPDATE public.assessment_contracts
  SET auto_renewal = p_auto_renewal,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'auto_renewal_changed',
    jsonb_build_object('enabled', p_auto_renewal),
    CASE WHEN p_auto_renewal
      THEN 'Renovação automática ativada'
      ELSE 'Renovação automática desativada' END,
    p_actor_id
  );
  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_assessment_contract_non_renewal(
  p_contract_id uuid,
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
  v_status text;
  v_finish_now boolean;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF lower(COALESCE(v_contract.cancellation_reason, '')) IN ('não renovou', 'nao renovou') THEN
    RETURN jsonb_build_object(
      'contract', to_jsonb(v_contract),
      'should_finish_now', v_contract.status = 'finished',
      'unchanged', true
    );
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Use a resolução da renovação para esta venda';
  END IF;
  IF v_contract.status NOT IN ('active', 'overdue', 'on_leave') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O estado atual do contrato não permite registrar não renovação';
  END IF;
  IF NULLIF(btrim(v_contract.cancellation_reason), '') IS NOT NULL
     OR v_contract.cancellation_date IS NOT NULL
     OR COALESCE(v_contract.cancellation_fee, 0) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato já possui outro registro de encerramento';
  END IF;
  IF v_contract.refund_status IS NOT NULL
     OR COALESCE(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_date IS NOT NULL
     OR NULLIF(btrim(v_contract.refund_notes), '') IS NOT NULL
     OR v_contract.payment_status IN ('refunded', 'partially_refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato possui movimentação de estorno e precisa de conferência';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contracts child
    WHERE child.parent_contract_id = v_contract.id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Resolva primeiro a venda de renovação aberta';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contracts other
    WHERE other.customer_id = v_contract.customer_id
      AND other.id <> v_contract.id
      AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outro contrato de continuidade para esta atleta';
  END IF;

  v_finish_now := v_contract.end_date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_status := CASE WHEN v_finish_now THEN 'finished' ELSE v_contract.status END;
  UPDATE public.assessment_contracts
  SET renewal_generated = true,
      cancellation_date = end_date,
      cancellation_fee = 0,
      cancellation_reason = 'Não renovou',
      status = v_status,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'renewal_declined',
    jsonb_build_object(
      'discarded_draft_id', NULL,
      'discarded_draft_number', NULL,
      'effective_end_date', v_contract.end_date,
      'status_after', v_status,
      'no_financial_penalty', true
    ),
    'Aluno não vai renovar. Encerramento sem multa, estorno ou nova cobrança.',
    p_actor_id
  );
  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'should_finish_now', v_finish_now,
    'status_after', v_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_assessment_contract_enrollment(
  p_contract_id uuid,
  p_enrollment_fee numeric,
  p_manual_discount numeric,
  p_external_payment_link text,
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
  v_link text := NULLIF(btrim(p_external_payment_link), '');
  v_status text;
  v_payment_status text;
  v_now timestamptz := now();
BEGIN
  IF p_enrollment_fee IS NULL OR p_enrollment_fee < 0 OR p_enrollment_fee > 1000000
     OR p_manual_discount IS NULL OR p_manual_discount < 0 OR p_manual_discount > 1000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Os valores da adesão são inválidos';
  END IF;
  IF v_link IS NOT NULL AND (
    length(v_link) > 2048 OR v_link !~ '^https://[^[:space:][:cntrl:]]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um link HTTPS válido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Adesão não encontrada';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A adesão foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_contract.status <> 'draft' OR v_contract.parent_contract_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente uma nova adesão pendente pode ser confirmada';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge')
     OR COALESCE(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR NULLIF(v_contract.asaas_charge_id, '') IS NOT NULL
     OR COALESCE(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta adesão já possui movimentação financeira';
  END IF;

  v_status := CASE
    WHEN v_contract.start_date > (v_now AT TIME ZONE 'America/Sao_Paulo')::date
      THEN 'scheduled'
    ELSE 'active'
  END;
  v_payment_status := CASE WHEN v_link IS NOT NULL THEN 'charge_sent' ELSE 'awaiting_charge' END;
  UPDATE public.assessment_contracts
  SET status = v_status,
      enrollment_fee = p_enrollment_fee,
      manual_discount = p_manual_discount,
      payment_status = v_payment_status,
      external_payment_link = v_link,
      payment_message_sent_at = CASE WHEN v_link IS NOT NULL THEN v_now ELSE NULL END,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'enrollment_activated',
    jsonb_build_object(
      'source', 'public_enrollment',
      'payment_link_provided', v_link IS NOT NULL,
      'status_after', v_status,
      'payment_status_after', v_payment_status,
      'start_date', v_contract.start_date,
      'enrollment_fee', p_enrollment_fee,
      'manual_discount', p_manual_discount
    ),
    'Adesão via formulário público confirmada',
    p_actor_id
  );
  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.refuse_assessment_contract_enrollment(
  p_contract_id uuid,
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
  v_result jsonb;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Adesão não encontrada';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A adesão foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_contract.status <> 'draft' OR v_contract.parent_contract_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente uma nova adesão pendente pode ser recusada';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge')
     OR COALESCE(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR NULLIF(v_contract.asaas_charge_id, '') IS NOT NULL
     OR NULLIF(v_contract.asaas_payment_link, '') IS NOT NULL
     OR NULLIF(v_contract.asaas_pix_copy, '') IS NOT NULL
     OR NULLIF(v_contract.asaas_pix_qrcode, '') IS NOT NULL
     OR NULLIF(v_contract.external_payment_link, '') IS NOT NULL
     OR NULLIF(v_contract.external_invoice_number, '') IS NOT NULL
     OR COALESCE(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL
     OR v_contract.refund_date IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta adesão possui movimentação e não pode ser removida';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payout_monthly_statement_items item
    WHERE item.contract_id = v_contract.id
  ) OR EXISTS (
    SELECT 1 FROM public.payout_pending_repasse pending
    WHERE pending.contract_id = v_contract.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta adesão possui repasse e não pode ser removida';
  END IF;

  v_result := jsonb_build_object(
    'id', v_contract.id,
    'contract_number', v_contract.contract_number,
    'refused', true
  );
  DELETE FROM public.assessment_contracts WHERE id = v_contract.id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_assessment_contract_renewal(
  uuid, timestamptz, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_assessment_contract_renewal(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_assessment_contract_auto_renewal(
  uuid, boolean, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_assessment_contract_non_renewal(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_assessment_contract_enrollment(
  uuid, numeric, numeric, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refuse_assessment_contract_enrollment(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_assessment_contract_renewal(
  uuid, timestamptz, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_assessment_contract_renewal(
  uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_assessment_contract_auto_renewal(
  uuid, boolean, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_assessment_contract_non_renewal(
  uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_assessment_contract_enrollment(
  uuid, numeric, numeric, text, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.refuse_assessment_contract_enrollment(
  uuid, timestamptz, uuid
) TO service_role;
