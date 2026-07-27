-- Server-owned, idempotent mutations for unpaid assessment contracts.
-- Provider cancellation happens between the short prepare and complete
-- transactions. The browser never writes these lifecycle fields directly.

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
    'change_contract_plan'
  ));

CREATE OR REPLACE FUNCTION public.prepare_assessment_contract_mutation(
  p_operation_type TEXT,
  p_contract_id UUID,
  p_plan_id UUID,
  p_start_date DATE,
  p_installments INTEGER,
  p_enrollment_fee NUMERIC,
  p_manual_discount NUMERIC,
  p_discount_reason TEXT,
  p_reason TEXT,
  p_idempotency_key TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_operation public.order_operations%ROWTYPE;
  v_request JSONB;
  v_request_hash TEXT;
  v_months INTEGER;
  v_end_date DATE;
  v_plan_snapshot JSONB;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
BEGIN
  IF p_operation_type NOT IN ('void_contract_sale', 'change_contract_plan') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de alteração inválido';
  END IF;
  IF p_contract_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da alteração são inválidos';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo da alteração inválido';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  IF p_operation_type = 'void_contract_sale' THEN
    IF p_plan_id IS NOT NULL OR p_start_date IS NOT NULL
       OR p_installments IS NOT NULL OR p_enrollment_fee IS NOT NULL
       OR p_manual_discount IS NOT NULL OR p_discount_reason IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados de descarte inválidos';
    END IF;
  ELSE
    IF p_plan_id IS NULL OR p_start_date IS NULL OR p_installments IS NULL
       OR p_enrollment_fee IS NULL OR p_manual_discount IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do novo plano são obrigatórios';
    END IF;
    IF p_installments < 1 OR p_enrollment_fee < 0 OR p_manual_discount < 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valores do novo plano são inválidos';
    END IF;
    IF p_discount_reason IS NOT NULL
       AND char_length(trim(p_discount_reason)) > 500 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo do desconto é muito longo';
    END IF;
  END IF;

  v_request := jsonb_build_object(
    'operation_type', p_operation_type,
    'plan_id', p_plan_id,
    'start_date', p_start_date,
    'installments', p_installments,
    'enrollment_fee', p_enrollment_fee,
    'manual_discount', p_manual_discount,
    'discount_reason', NULLIF(trim(p_discount_reason), '')
  );
  v_request_hash := pg_catalog.md5(v_request::TEXT);

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = p_operation_type
    AND operation_key = p_idempotency_key
    AND order_type = 'contract'
    AND order_id = p_contract_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.payload->>'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A chave de idempotência já foi usada com outros dados';
    END IF;
    IF v_operation.status IN ('prepared', 'failed')
       AND (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at <= now())
       AND (
         COALESCE(v_operation.external_result, '{}'::JSONB) = '{}'::JSONB
         OR v_operation.external_result->>'outcome' = 'cancellation_snapshot'
       ) THEN
      v_lease_token := gen_random_uuid();
      UPDATE public.order_operations
      SET status = 'prepared',
          result = NULL,
          last_error = NULL,
          lease_token = v_lease_token,
          lease_expires_at = now() + INTERVAL '90 seconds',
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
      v_lease_acquired := true;
    END IF;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'contract_id', v_operation.order_id,
      'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
      'had_external_charge', COALESCE((v_operation.payload->>'had_external_charge')::BOOLEAN, false),
      'lease_acquired', v_lease_acquired,
      'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
      'lease_expires_at', v_operation.lease_expires_at,
      'external_result', v_operation.external_result,
      'result', v_operation.result,
      'error', v_operation.last_error
    );
  END IF;

  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
     OR COALESCE(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR v_contract.refund_status IS NOT NULL
     OR COALESCE(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_date IS NOT NULL
     OR NULLIF(trim(v_contract.refund_notes), '') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Somente contratos sem pagamento podem ser alterados por esta operação';
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já foi encerrado';
  END IF;
  IF p_operation_type = 'void_contract_sale'
     AND v_contract.parent_contract_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Renovações devem ser encerradas pelo fluxo de renovações';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.order_type = 'contract'
      AND payment.order_id = p_contract_id
      AND payment.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Foi identificado pagamento neste contrato';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payout_monthly_statement_items item
    WHERE item.contract_id = p_contract_id
  ) OR EXISTS (
    SELECT 1 FROM public.payout_pending_repasse pending
    WHERE pending.contract_id = p_contract_id
      AND pending.status = 'resolved'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já movimentou repasse';
  END IF;
  IF p_operation_type = 'change_contract_plan' AND EXISTS (
    SELECT 1 FROM public.payout_pending_repasse pending
    WHERE pending.contract_id = p_contract_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Este contrato possui repasse pendente e exige conferência antes da troca de plano';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_operations operation
    WHERE operation.order_type = 'contract'
      AND operation.order_id = p_contract_id
      AND operation.status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existe outra operação financeira pendente para este contrato';
  END IF;

  IF p_operation_type = 'change_contract_plan' THEN
    SELECT * INTO v_plan
    FROM public.assessment_plans
    WHERE id = p_plan_id AND active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Plano inválido ou inativo';
    END IF;
    IF p_installments > v_plan.max_installments THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Número de parcelas maior que o permitido pelo plano';
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
    v_end_date := (p_start_date + pg_catalog.make_interval(months => v_months))::DATE;
    v_plan_snapshot := jsonb_build_object(
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
      'snapshot_source', 'contract_adjustment_api'
    );
  END IF;

  v_lease_token := gen_random_uuid();
  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, lease_token, lease_expires_at
  ) VALUES (
    p_operation_type, p_idempotency_key, 'contract', p_contract_id, 'prepared',
    p_actor_id, trim(p_reason),
    jsonb_build_object(
      'request', v_request,
      'request_hash', v_request_hash,
      'expected_updated_at', v_contract.updated_at,
      'contract_number', v_contract.contract_number,
      'record_status', v_contract.status,
      'payment_status', v_contract.payment_status,
      'asaas_charge_id', NULLIF(v_contract.asaas_charge_id, ''),
      'had_external_charge', (
        NULLIF(v_contract.external_payment_link, '') IS NOT NULL
        OR NULLIF(v_contract.external_invoice_number, '') IS NOT NULL
      ),
      'external_link_fingerprint', CASE
        WHEN NULLIF(v_contract.external_payment_link, '') IS NULL THEN NULL
        ELSE pg_catalog.md5(v_contract.external_payment_link)
      END,
      'external_invoice_fingerprint', CASE
        WHEN NULLIF(v_contract.external_invoice_number, '') IS NULL THEN NULL
        ELSE pg_catalog.md5(v_contract.external_invoice_number)
      END,
      'from_plan_id', v_contract.plan_id,
      'from_plan_snapshot', v_contract.plan_snapshot,
      'from_start_date', v_contract.start_date,
      'from_end_date', v_contract.end_date,
      'parent_contract_id', v_contract.parent_contract_id,
      'to_plan_id', CASE WHEN p_operation_type = 'change_contract_plan' THEN v_plan.id ELSE NULL END,
      'to_plan_updated_at', CASE WHEN p_operation_type = 'change_contract_plan' THEN v_plan.updated_at ELSE NULL END,
      'to_plan_snapshot', v_plan_snapshot,
      'to_start_date', CASE WHEN p_operation_type = 'change_contract_plan' THEN p_start_date ELSE NULL END,
      'to_end_date', v_end_date,
      'installments', CASE WHEN p_operation_type = 'change_contract_plan' THEN p_installments ELSE NULL END,
      'enrollment_fee', CASE WHEN p_operation_type = 'change_contract_plan' THEN p_enrollment_fee ELSE NULL END,
      'manual_discount', CASE WHEN p_operation_type = 'change_contract_plan' THEN p_manual_discount ELSE NULL END,
      'discount_reason', CASE WHEN p_operation_type = 'change_contract_plan' THEN NULLIF(trim(p_discount_reason), '') ELSE NULL END
    ),
    v_lease_token,
    now() + INTERVAL '90 seconds'
  )
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'contract_id', p_contract_id,
    'asaas_charge_id', NULLIF(v_contract.asaas_charge_id, ''),
    'had_external_charge', (
      NULLIF(v_contract.external_payment_link, '') IS NOT NULL
      OR NULLIF(v_contract.external_invoice_number, '') IS NOT NULL
    ),
    'lease_acquired', true,
    'lease_token', v_lease_token,
    'lease_expires_at', v_operation.lease_expires_at,
    'external_result', NULL,
    'result', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_assessment_contract_mutation_snapshot(
  p_operation_id UUID,
  p_lease_token UUID,
  p_external_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_payment_id TEXT;
BEGIN
  v_payment_id := NULLIF(p_external_result->>'payment_id', '');
  IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
     OR p_external_result->>'outcome' IS DISTINCT FROM 'cancellation_snapshot'
     OR v_payment_id IS NULL
     OR p_external_result->>'kind' NOT IN ('standalone', 'installment') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Snapshot externo inválido';
  END IF;
  IF p_external_result->>'kind' = 'installment'
     AND NULLIF(p_external_result->>'installment_id', '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcelamento externo inválido';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type IN ('void_contract_sale', 'change_contract_plan')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de contrato não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status <> 'prepared'
     OR p_lease_token IS NULL
     OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação não possui uma execução ativa';
  END IF;
  IF v_payment_id IS DISTINCT FROM NULLIF(v_operation.payload->>'asaas_charge_id', '') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Snapshot não pertence à cobrança esperada';
  END IF;
  IF v_operation.external_result IS NOT NULL
     AND v_operation.external_result IS DISTINCT FROM p_external_result THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O snapshot externo mudou durante a operação';
  END IF;

  UPDATE public.order_operations
  SET external_result = p_external_result,
      updated_at = now()
  WHERE id = v_operation.id
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'external_result', v_operation.external_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_assessment_contract_mutation(
  p_operation_id UUID,
  p_lease_token UUID,
  p_external_result JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_expected_charge_id TEXT;
  v_expected_external_link_fingerprint TEXT;
  v_expected_external_invoice_fingerprint TEXT;
  v_had_external_charge BOOLEAN;
  v_error TEXT;
  v_cache_rows INTEGER := 0;
  v_manual_rows INTEGER := 0;
  v_cancelled_open_payouts INTEGER := 0;
  v_result JSONB;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type IN ('void_contract_sale', 'change_contract_plan')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de contrato não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status = 'reconciliation_required' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error', v_operation.last_error
    );
  END IF;
  IF p_lease_token IS NULL OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');
  v_had_external_charge := COALESCE((v_operation.payload->>'had_external_charge')::BOOLEAN, false);
  v_expected_external_link_fingerprint := NULLIF(v_operation.payload->>'external_link_fingerprint', '');
  v_expected_external_invoice_fingerprint := NULLIF(v_operation.payload->>'external_invoice_fingerprint', '');

  IF v_expected_charge_id IS NOT NULL THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
       OR NOT (COALESCE(p_external_result->>'outcome', '') = ANY (
         ARRAY['deleted', 'already_missing', 'already_cancelled']
       ))
       OR p_external_result->>'payment_id' IS DISTINCT FROM v_expected_charge_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
    END IF;
  ELSIF v_had_external_charge THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'external_reference'
       OR p_external_result->>'outcome' IS DISTINCT FROM 'detached' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
    END IF;
  ELSIF p_external_result->>'provider' IS DISTINCT FROM 'none'
        OR p_external_result->>'outcome' IS DISTINCT FROM 'not_required' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = v_operation.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  IF v_contract.updated_at IS DISTINCT FROM (v_operation.payload->>'expected_updated_at')::TIMESTAMPTZ THEN
    v_error := 'O contrato mudou durante a alteração';
  ELSIF v_contract.payment_status IS DISTINCT FROM v_operation.payload->>'payment_status'
        OR COALESCE(v_contract.manual_payment, false)
        OR v_contract.payment_date IS NOT NULL
        OR v_contract.refund_status IS NOT NULL
        OR COALESCE(v_contract.refund_amount, 0) <> 0
        OR v_contract.refund_date IS NOT NULL
        OR NULLIF(trim(v_contract.refund_notes), '') IS NOT NULL THEN
    v_error := 'O estado de pagamento mudou durante a alteração';
  ELSIF NULLIF(v_contract.asaas_charge_id, '') IS DISTINCT FROM v_expected_charge_id THEN
    v_error := 'A cobrança vinculada ao contrato mudou durante a alteração';
  ELSIF (CASE
      WHEN NULLIF(v_contract.external_payment_link, '') IS NULL THEN NULL
      ELSE pg_catalog.md5(v_contract.external_payment_link)
    END) IS DISTINCT FROM v_expected_external_link_fingerprint THEN
    v_error := 'O link externo mudou durante a alteração';
  ELSIF (CASE
      WHEN NULLIF(v_contract.external_invoice_number, '') IS NULL THEN NULL
      ELSE pg_catalog.md5(v_contract.external_invoice_number)
    END) IS DISTINCT FROM v_expected_external_invoice_fingerprint THEN
    v_error := 'A referência externa mudou durante a alteração';
  ELSIF EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_contract.id
      AND payment.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED')
  ) THEN
    v_error := 'Foi identificado pagamento durante a alteração';
  ELSIF EXISTS (
    SELECT 1 FROM public.payout_monthly_statement_items item
    WHERE item.contract_id = v_contract.id
  ) OR EXISTS (
    SELECT 1 FROM public.payout_pending_repasse pending
    WHERE pending.contract_id = v_contract.id
      AND pending.status = 'resolved'
  ) THEN
    v_error := 'O contrato movimentou repasse durante a alteração';
  ELSIF v_operation.operation_type = 'change_contract_plan' AND EXISTS (
    SELECT 1 FROM public.payout_pending_repasse pending
    WHERE pending.contract_id = v_contract.id
  ) THEN
    v_error := 'O contrato passou a possuir repasse pendente';
  END IF;

  IF v_error IS NULL AND v_operation.operation_type = 'change_contract_plan' THEN
    SELECT * INTO v_plan
    FROM public.assessment_plans
    WHERE id = (v_operation.payload->>'to_plan_id')::UUID
      AND active = true;
    IF NOT FOUND OR v_plan.updated_at IS DISTINCT FROM
        (v_operation.payload->>'to_plan_updated_at')::TIMESTAMPTZ THEN
      v_error := 'O plano escolhido mudou durante a alteração';
    END IF;
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        external_result = p_external_result,
        last_error = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', 'reconciliation_required',
      'error', v_error
    );
  END IF;

  IF v_operation.operation_type = 'void_contract_sale' THEN
    UPDATE public.assessment_contracts
    SET status = 'voided',
        payment_status = 'cancelled',
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        manual_payment = false,
        manual_fee = NULL,
        external_payment_link = NULL,
        external_invoice_number = NULL,
        payment_message_sent_at = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_copy = NULL,
        asaas_pix_qrcode = NULL,
        cancellation_date = NULL,
        cancellation_fee = 0,
        cancellation_reason = v_operation.reason,
        refund_status = NULL,
        refund_amount = NULL,
        refund_date = NULL,
        refund_notes = NULL,
        updated_at = now()
    WHERE id = v_contract.id;

    UPDATE public.payout_pending_repasse
    SET status = 'cancelled', resolved_at = now()
    WHERE contract_id = v_contract.id AND status = 'open';
    GET DIAGNOSTICS v_cancelled_open_payouts = ROW_COUNT;
  ELSE
    UPDATE public.assessment_contracts
    SET plan_id = (v_operation.payload->>'to_plan_id')::UUID,
        plan_snapshot = v_operation.payload->'to_plan_snapshot',
        start_date = (v_operation.payload->>'to_start_date')::DATE,
        end_date = (v_operation.payload->>'to_end_date')::DATE,
        original_end_date = (v_operation.payload->>'to_end_date')::DATE,
        installments = (v_operation.payload->>'installments')::INTEGER,
        enrollment_fee = (v_operation.payload->>'enrollment_fee')::NUMERIC,
        manual_discount = (v_operation.payload->>'manual_discount')::NUMERIC,
        discount_reason = NULLIF(v_operation.payload->>'discount_reason', ''),
        payment_status = 'pending',
        payment_date = NULL,
        payment_method = NULL,
        manual_payment = false,
        manual_fee = NULL,
        due_date = NULL,
        external_payment_link = NULL,
        external_invoice_number = NULL,
        payment_message_sent_at = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_copy = NULL,
        asaas_pix_qrcode = NULL,
        updated_at = now()
    WHERE id = v_contract.id;
  END IF;

  IF v_expected_charge_id IS NOT NULL THEN
    UPDATE public.asaas_payments payment
    SET status = 'DELETED',
        raw = COALESCE(payment.raw, '{}'::JSONB) || jsonb_build_object(
          '_eon_contract_mutation_operation_id', v_operation.id,
          '_eon_deleted_at', now()
        ),
        last_synced_at = now(),
        updated_at = now()
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_contract.id
      AND payment.source = 'asaas'
      AND (
        payment.asaas_payment_id = v_expected_charge_id
        OR payment.asaas_payment_id IN (
          SELECT jsonb_array_elements_text(COALESCE(p_external_result->'payment_ids', '[]'::JSONB))
        )
        OR (
          NULLIF(p_external_result->>'installment_id', '') IS NOT NULL
          AND payment.installment_group_id = p_external_result->>'installment_id'
        )
      )
      AND payment.status IS DISTINCT FROM 'DELETED';
    GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
  END IF;

  DELETE FROM public.asaas_payments
  WHERE order_type = 'contract'
    AND order_id = v_contract.id
    AND source = 'manual';
  GET DIAGNOSTICS v_manual_rows = ROW_COUNT;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status,
    reason, metadata, actor_id
  ) VALUES (
    'contract', v_contract.id, v_operation.payload->>'payment_status',
    CASE WHEN v_operation.operation_type = 'void_contract_sale' THEN 'cancelled' ELSE 'pending' END,
    v_operation.reason,
    jsonb_build_object(
      'action', v_operation.operation_type,
      'operation_id', v_operation.id,
      'had_asaas_charge', v_expected_charge_id IS NOT NULL,
      'had_external_charge', v_had_external_charge,
      'external_result', p_external_result,
      'from_plan_id', v_operation.payload->>'from_plan_id',
      'to_plan_id', v_operation.payload->>'to_plan_id'
    ),
    v_operation.requested_by
  );

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    CASE WHEN v_operation.operation_type = 'void_contract_sale' THEN 'sale_voided' ELSE 'plan_changed' END,
    CASE WHEN v_operation.operation_type = 'void_contract_sale' THEN
      jsonb_build_object(
        'operation_id', v_operation.id,
        'voided_at', timezone('America/Sao_Paulo', now())::DATE,
        'had_asaas_charge', v_expected_charge_id IS NOT NULL,
        'had_external_link', v_had_external_charge,
        'previous_asaas_charge_id', v_expected_charge_id,
        'previous_payment_status', v_operation.payload->>'payment_status',
        'cancelled_open_payouts', v_cancelled_open_payouts,
        'external_result', p_external_result
      )
    ELSE
      jsonb_build_object(
        'operation_id', v_operation.id,
        'from_plan_id', v_operation.payload->>'from_plan_id',
        'to_plan_id', v_operation.payload->>'to_plan_id',
        'from_plan_snapshot', v_operation.payload->'from_plan_snapshot',
        'to_plan_snapshot', v_operation.payload->'to_plan_snapshot',
        'from_start_date', v_operation.payload->>'from_start_date',
        'to_start_date', v_operation.payload->>'to_start_date',
        'from_end_date', v_operation.payload->>'from_end_date',
        'to_end_date', v_operation.payload->>'to_end_date',
        'installments', (v_operation.payload->>'installments')::INTEGER,
        'enrollment_fee', (v_operation.payload->>'enrollment_fee')::NUMERIC,
        'manual_discount', (v_operation.payload->>'manual_discount')::NUMERIC,
        'previous_payment_status', v_operation.payload->>'payment_status',
        'cancelled_asaas_charge', v_expected_charge_id IS NOT NULL,
        'had_external_charge', v_had_external_charge,
        'is_renewal', v_operation.payload->>'parent_contract_id' IS NOT NULL,
        'parent_contract_id', v_operation.payload->>'parent_contract_id',
        'external_result', p_external_result
      )
    END,
    CASE
      WHEN v_operation.operation_type = 'void_contract_sale' THEN 'Venda não concretizada'
      WHEN v_operation.payload->>'parent_contract_id' IS NOT NULL THEN 'Troca de plano na renovação antes do pagamento'
      ELSE 'Ajuste de plano antes do pagamento'
    END,
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'contract_id', v_contract.id,
    'operation_type', v_operation.operation_type,
    'contract_status', CASE WHEN v_operation.operation_type = 'void_contract_sale' THEN 'voided' ELSE v_contract.status END,
    'payment_status', CASE WHEN v_operation.operation_type = 'void_contract_sale' THEN 'cancelled' ELSE 'pending' END,
    'plan_id', CASE WHEN v_operation.operation_type = 'change_contract_plan' THEN v_operation.payload->>'to_plan_id' ELSE v_contract.plan_id::TEXT END,
    'start_date', CASE WHEN v_operation.operation_type = 'change_contract_plan' THEN v_operation.payload->>'to_start_date' ELSE v_contract.start_date::TEXT END,
    'end_date', CASE WHEN v_operation.operation_type = 'change_contract_plan' THEN v_operation.payload->>'to_end_date' ELSE v_contract.end_date::TEXT END,
    'asaas_cache_rows_deleted', v_cache_rows,
    'manual_cache_rows_deleted', v_manual_rows,
    'cancelled_open_payouts', v_cancelled_open_payouts,
    'external_result', p_external_result
  );

  UPDATE public.order_operations
  SET status = 'completed',
      external_result = p_external_result,
      result = v_result,
      last_error = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_assessment_contract_mutation_failure(
  p_operation_id UUID,
  p_lease_token UUID,
  p_error_code TEXT,
  p_error_message TEXT,
  p_requires_reconciliation BOOLEAN DEFAULT false,
  p_external_result JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_status TEXT;
  v_result JSONB;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{3,80}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Código de falha inválido';
  END IF;
  IF NULLIF(trim(p_error_message), '') IS NULL OR char_length(trim(p_error_message)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Descrição de falha inválida';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type IN ('void_contract_sale', 'change_contract_plan')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de contrato não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status IN ('failed', 'reconciliation_required') THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error,
      'result', v_operation.result
    );
  END IF;
  IF p_lease_token IS NULL OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  v_status := CASE WHEN COALESCE(p_requires_reconciliation, false)
    THEN 'reconciliation_required' ELSE 'failed' END;
  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_status,
    'contract_id', v_operation.order_id,
    'operation_type', v_operation.operation_type,
    'error_code', p_error_code,
    'error', trim(p_error_message)
  );

  UPDATE public.order_operations
  SET status = v_status,
      external_result = COALESCE(p_external_result, '{}'::JSONB),
      result = v_result,
      last_error = trim(p_error_message),
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_assessment_contract_mutation(
  TEXT, UUID, UUID, DATE, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_assessment_contract_mutation_snapshot(
  UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_assessment_contract_mutation(
  UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_assessment_contract_mutation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_assessment_contract_mutation(
  TEXT, UUID, UUID, DATE, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_assessment_contract_mutation_snapshot(
  UUID, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_assessment_contract_mutation(
  UUID, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_assessment_contract_mutation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) TO service_role;

COMMENT ON FUNCTION public.prepare_assessment_contract_mutation(
  TEXT, UUID, UUID, DATE, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, UUID
) IS 'Prepares an idempotent unpaid contract plan change or sale discard.';
COMMENT ON FUNCTION public.complete_assessment_contract_mutation(
  UUID, UUID, JSONB
) IS 'Atomically mutates an unpaid contract after external charge cancellation.';
