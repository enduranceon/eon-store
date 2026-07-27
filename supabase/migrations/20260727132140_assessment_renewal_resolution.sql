-- Resolve an approved but unpaid assessment renewal without losing the sale
-- audit trail. Provider cancellation happens in the Edge Function between the
-- prepare and complete transactions; order_operations makes that saga safe to
-- retry.

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_operation_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_operation_type_check
  CHECK (operation_type IN (
    'cancel_order',
    'refund_order',
    'cancel_item',
    'change_due_date',
    'resolve_renewal'
  ));

-- At most one unresolved decision may exist for a renewal chain. The ordinary
-- one-open-operation index already serializes this operation with charge work
-- on the child contract.
CREATE UNIQUE INDEX order_operations_one_open_renewal_parent_idx
  ON public.order_operations ((payload->>'parent_contract_id'))
  WHERE operation_type = 'resolve_renewal'
    AND status IN ('prepared', 'reconciliation_required');

CREATE OR REPLACE FUNCTION public.prepare_assessment_renewal_resolution(
  p_renewal_id UUID,
  p_resolution TEXT,
  p_reason_code TEXT,
  p_reason TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_expected_payment_status TEXT,
  p_expected_charge_id TEXT,
  p_external_cancellation_confirmed BOOLEAN,
  p_external_confirmation_note TEXT,
  p_service_started BOOLEAN,
  p_idempotency_key TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_renewal public.assessment_contracts%ROWTYPE;
  v_parent public.assessment_contracts%ROWTYPE;
  v_operation public.order_operations%ROWTYPE;
  v_parent_id UUID;
  v_expected_charge_id TEXT := NULLIF(trim(p_expected_charge_id), '');
  v_external_link TEXT;
  v_external_invoice TEXT;
  v_cached_primary BOOLEAN := false;
  v_cached_installment_id TEXT;
  v_cached_total_installments INTEGER;
  v_error TEXT;
BEGIN
  IF p_renewal_id IS NULL OR p_actor_id IS NULL
     OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da renovação são inválidos';
  END IF;
  IF p_resolution IS NULL
     OR p_resolution NOT IN ('non_renewal', 'discard') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resolução da renovação inválida';
  END IF;
  IF p_reason_code IS NULL
     OR (p_resolution = 'non_renewal'
         AND p_reason_code IS DISTINCT FROM 'customer_declined')
     OR (p_resolution = 'discard'
         AND p_reason_code NOT IN ('duplicate', 'created_in_error')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo da resolução inválido';
  END IF;
  IF trim(p_reason) IS DISTINCT FROM (CASE p_reason_code
       WHEN 'customer_declined' THEN 'Atleta decidiu não renovar'
       WHEN 'duplicate' THEN 'Renovação criada em duplicidade'
       WHEN 'created_in_error' THEN 'Renovação criada por engano'
       ELSE NULL
     END) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Descrição da resolução inválida';
  END IF;
  IF p_expected_payment_status IS NULL
     OR p_expected_payment_status NOT IN (
    'pending', 'awaiting_charge', 'charge_sent', 'overdue'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Estado financeiro esperado inválido';
  END IF;
  IF v_expected_charge_id IS NOT NULL
     AND char_length(v_expected_charge_id) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Identificador de cobrança inválido';
  END IF;
  IF p_service_started IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Uma renovação com atendimento iniciado não pode ser descartada';
  END IF;
  IF p_external_cancellation_confirmed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Confirmação externa inválida';
  END IF;
  IF p_external_confirmation_note IS NOT NULL
     AND (NULLIF(trim(p_external_confirmation_note), '') IS NULL
          OR char_length(trim(p_external_confirmation_note)) > 500) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Nota da confirmação externa inválida';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  -- Lock order for every renewal operation is child -> parent -> operation.
  SELECT parent_contract_id INTO v_parent_id
  FROM public.assessment_contracts
  WHERE id = p_renewal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Renovação não encontrada';
  END IF;
  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato informado não é uma renovação';
  END IF;

  SELECT * INTO v_renewal
  FROM public.assessment_contracts
  WHERE id = p_renewal_id
  FOR UPDATE;
  SELECT * INTO v_parent
  FROM public.assessment_contracts
  WHERE id = v_parent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato anterior não encontrado';
  END IF;
  IF v_renewal.parent_contract_id IS DISTINCT FROM v_parent.id
     OR v_renewal.customer_id IS DISTINCT FROM v_parent.customer_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A cadeia da renovação está inconsistente';
  END IF;

  -- A stable command per child prevents a second logical resolution even if a
  -- browser loses the original Idempotency-Key.
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'resolve_renewal'
    AND operation_key = 'full'
    AND order_type = 'contract'
    AND order_id = p_renewal_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.payload->>'resolution' IS DISTINCT FROM p_resolution
       OR v_operation.payload->>'reason_code' IS DISTINCT FROM p_reason_code
       OR v_operation.reason IS DISTINCT FROM trim(p_reason) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Esta renovação já possui outra resolução registrada';
    END IF;

    IF v_operation.status = 'prepared' AND (
         v_operation.requested_by IS DISTINCT FROM p_actor_id
         OR (v_operation.payload->>'renewal_updated_at')::TIMESTAMPTZ
              IS DISTINCT FROM p_expected_updated_at
         OR v_operation.payload->>'payment_status'
              IS DISTINCT FROM p_expected_payment_status
         OR NULLIF(v_operation.payload->>'asaas_charge_id', '')
              IS DISTINCT FROM v_expected_charge_id
         OR v_operation.payload->>'service_started'
              IS DISTINCT FROM p_service_started::TEXT
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Os dados desta resolução em andamento são diferentes da solicitação atual';
    END IF;

    IF v_operation.status = 'prepared' AND v_operation.external_result IS NULL THEN
      IF v_renewal.parent_contract_id IS DISTINCT FROM v_parent.id
         OR v_renewal.customer_id IS DISTINCT FROM v_parent.customer_id
         OR v_renewal.status IS DISTINCT FROM
              v_operation.payload->>'renewal_status'
         OR v_parent.status IS DISTINCT FROM
              v_operation.payload->>'parent_status'
         OR v_parent.end_date IS DISTINCT FROM
              (v_operation.payload->>'parent_end_date')::DATE
         OR v_renewal.updated_at IS DISTINCT FROM
              (v_operation.payload->>'renewal_updated_at')::TIMESTAMPTZ
         OR v_renewal.payment_status IS DISTINCT FROM
              v_operation.payload->>'payment_status'
         OR v_renewal.payment_status NOT IN (
           'pending', 'awaiting_charge', 'charge_sent', 'overdue'
         )
         OR COALESCE(v_renewal.manual_payment, false)
         OR v_renewal.payment_date IS NOT NULL
         OR COALESCE(v_renewal.refund_amount, 0) <> 0
         OR v_renewal.refund_status IS NOT NULL
         OR v_renewal.refund_date IS NOT NULL
         OR NULLIF(trim(v_renewal.refund_notes), '') IS NOT NULL
         OR v_renewal.asaas_charge_id IS DISTINCT FROM
              NULLIF(v_operation.payload->>'asaas_charge_id', '')
         OR v_renewal.external_payment_link IS DISTINCT FROM
              NULLIF(v_operation.payload->>'external_payment_link', '')
         OR v_renewal.external_invoice_number IS DISTINCT FROM
              NULLIF(v_operation.payload->>'external_invoice_number', '') THEN
        v_error := 'A renovação mudou antes da etapa externa';
      ELSIF EXISTS (
        SELECT 1 FROM public.asaas_payments payment
        WHERE payment.order_type = 'contract'
          AND payment.order_id = v_renewal.id
          AND (
            payment.source = 'manual'
            OR payment.status IN (
              'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED'
            )
          )
      ) THEN
        v_error := 'Foi identificado pagamento na renovação';
      ELSIF EXISTS (
        SELECT 1 FROM public.asaas_payments payment
        WHERE payment.order_type = 'contract'
          AND payment.order_id = v_renewal.id
          AND payment.source = 'asaas'
          AND payment.status NOT IN ('DELETED', 'CANCELLED', 'CANCELED')
          AND (
            NULLIF(v_operation.payload->>'asaas_charge_id', '') IS NULL
            OR NOT COALESCE((
              payment.asaas_payment_id =
                NULLIF(v_operation.payload->>'asaas_charge_id', '')
              OR (
                NULLIF(
                  v_operation.payload->>'asaas_installment_group_id', ''
                ) IS NOT NULL
                AND payment.installment_group_id = NULLIF(
                  v_operation.payload->>'asaas_installment_group_id', ''
                )
              )
            ), false)
          )
      ) THEN
        v_error := 'Existem cobranças Asaas não conciliadas nesta renovação';
      ELSIF EXISTS (
        SELECT 1 FROM public.payout_monthly_statement_items item
        WHERE item.contract_id = v_renewal.id
      ) OR EXISTS (
        SELECT 1 FROM public.payout_pending_repasse pending
        WHERE pending.contract_id = v_renewal.id
          AND pending.status = 'resolved'
      ) THEN
        v_error := 'A renovação já movimentou repasse';
      ELSIF v_operation.payload->>'resolution' = 'non_renewal'
            AND NULLIF(trim(v_parent.cancellation_reason), '') IS NOT NULL
            AND lower(v_parent.cancellation_reason) NOT LIKE '%não renovou%'
            AND lower(v_parent.cancellation_reason) NOT LIKE '%nao renovou%'
            AND lower(v_parent.cancellation_reason) NOT LIKE '%não vai renovar%'
            AND lower(v_parent.cancellation_reason) NOT LIKE '%nao vai renovar%' THEN
        v_error := 'O contrato anterior possui outro motivo de encerramento';
      ELSIF v_operation.payload->>'resolution' = 'non_renewal'
            AND EXISTS (
        SELECT 1
        FROM public.assessment_contracts other
        WHERE other.customer_id = v_parent.customer_id
          AND other.id NOT IN (v_parent.id, v_renewal.id)
          AND other.status IN (
            'draft', 'scheduled', 'active', 'overdue', 'on_leave'
          )
      ) THEN
        v_error := 'Existe outro contrato ou renovação de continuidade para esta atleta';
      END IF;

      IF v_error IS NOT NULL THEN
        UPDATE public.order_operations
        SET status = 'reconciliation_required',
            last_error = v_error,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = v_operation.id
        RETURNING * INTO v_operation;
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'lease_acquired', false,
      'lease_token', NULL,
      'lease_expires_at', v_operation.lease_expires_at,
      'renewal_id', v_operation.order_id,
      'parent_contract_id', v_operation.payload->>'parent_contract_id',
      'resolution', v_operation.payload->>'resolution',
      'reason_code', v_operation.payload->>'reason_code',
      'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
      'external_payment_link', v_operation.payload->>'external_payment_link',
      'external_invoice_number', v_operation.payload->>'external_invoice_number',
      'external_cancellation_confirmed',
        (v_operation.payload->>'external_cancellation_confirmed')::BOOLEAN,
      'external_confirmation_note',
        v_operation.payload->>'external_confirmation_note',
      'provider_snapshot', v_operation.payload->'asaas_provider_snapshot',
      'external_result', v_operation.external_result,
      'result', v_operation.result,
      'error', v_operation.last_error
    );
  END IF;

  IF v_renewal.updated_at IS DISTINCT FROM p_expected_updated_at
     OR v_renewal.payment_status IS DISTINCT FROM p_expected_payment_status
     OR NULLIF(v_renewal.asaas_charge_id, '') IS DISTINCT FROM v_expected_charge_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A renovação mudou; atualize a página antes de continuar';
  END IF;
  IF v_renewal.status NOT IN ('draft', 'scheduled', 'active', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O estado da renovação não permite esta resolução';
  END IF;
  IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato anterior não permite esta resolução';
  END IF;
  IF p_resolution = 'non_renewal'
     AND NULLIF(trim(v_parent.cancellation_reason), '') IS NOT NULL
     AND lower(v_parent.cancellation_reason) NOT LIKE '%não renovou%'
     AND lower(v_parent.cancellation_reason) NOT LIKE '%nao renovou%'
     AND lower(v_parent.cancellation_reason) NOT LIKE '%não vai renovar%'
     AND lower(v_parent.cancellation_reason) NOT LIKE '%nao vai renovar%' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O contrato anterior possui outro motivo de encerramento';
  END IF;
  IF v_renewal.payment_status NOT IN (
       'pending', 'awaiting_charge', 'charge_sent', 'overdue'
     )
     OR COALESCE(v_renewal.manual_payment, false)
     OR v_renewal.payment_date IS NOT NULL
     OR COALESCE(v_renewal.refund_amount, 0) <> 0
     OR v_renewal.refund_status IS NOT NULL
     OR v_renewal.refund_date IS NOT NULL
     OR NULLIF(trim(v_renewal.refund_notes), '') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Somente uma renovação nunca paga pode ser descartada';
  END IF;

  v_external_link := NULLIF(v_renewal.external_payment_link, '');
  v_external_invoice := NULLIF(v_renewal.external_invoice_number, '');
  IF v_expected_charge_id IS NULL
     AND (
       NULLIF(v_renewal.asaas_payment_link, '') IS NOT NULL
       OR NULLIF(v_renewal.asaas_pix_copy, '') IS NOT NULL
       OR NULLIF(v_renewal.asaas_pix_qrcode, '') IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A renovação possui referências Asaas sem identificador de cobrança';
  END IF;
  IF v_expected_charge_id IS NOT NULL
     AND (v_external_link IS NOT NULL OR v_external_invoice IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A renovação possui cobranças Asaas e externa simultâneas';
  END IF;
  IF v_external_link IS NOT NULL OR v_external_invoice IS NOT NULL THEN
    IF p_external_cancellation_confirmed IS DISTINCT FROM true
       OR NULLIF(trim(p_external_confirmation_note), '') IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Confirme o cancelamento da cobrança no sistema externo';
    END IF;
  ELSIF p_external_cancellation_confirmed
        OR p_external_confirmation_note IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Não existe cobrança externa para confirmar';
  END IF;

  SELECT true, NULLIF(payment.installment_group_id, ''),
         payment.total_installments
  INTO v_cached_primary, v_cached_installment_id,
       v_cached_total_installments
  FROM public.asaas_payments payment
  WHERE payment.asaas_payment_id = v_expected_charge_id
    AND payment.source = 'asaas'
    AND payment.order_type = 'contract'
    AND payment.order_id = v_renewal.id
  LIMIT 1;
  v_cached_primary := COALESCE(v_cached_primary, false);

  IF EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_renewal.id
      AND (
        payment.source = 'manual'
        OR payment.status IN (
          'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED'
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Foi identificado pagamento na renovação';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_renewal.id
      AND payment.source = 'asaas'
      AND payment.status NOT IN ('DELETED', 'CANCELLED', 'CANCELED')
      AND (
        v_expected_charge_id IS NULL
        OR NOT COALESCE((
          payment.asaas_payment_id = v_expected_charge_id
          OR (v_cached_installment_id IS NOT NULL
              AND payment.installment_group_id = v_cached_installment_id)
        ), false)
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existem cobranças Asaas não conciliadas nesta renovação';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payout_monthly_statement_items item
    WHERE item.contract_id = v_renewal.id
  ) OR EXISTS (
    SELECT 1 FROM public.payout_pending_repasse pending
    WHERE pending.contract_id = v_renewal.id
      AND pending.status = 'resolved'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A renovação já movimentou repasse';
  END IF;

  IF p_resolution = 'non_renewal' AND EXISTS (
    SELECT 1
    FROM public.assessment_contracts other
    WHERE other.customer_id = v_parent.customer_id
      AND other.id NOT IN (v_parent.id, v_renewal.id)
      AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existe outro contrato ou renovação de continuidade para esta atleta';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_operations operation
    WHERE operation.order_type = 'contract'
      AND operation.order_id = v_renewal.id
      AND operation.status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existe outra operação financeira pendente nesta renovação';
  END IF;

  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload
  )
  VALUES (
    'resolve_renewal', 'full', 'contract', v_renewal.id, 'prepared',
    p_actor_id, trim(p_reason),
    jsonb_build_object(
      'resolution', p_resolution,
      'reason_code', p_reason_code,
      'idempotency_key', p_idempotency_key,
      'parent_contract_id', v_parent.id,
      'customer_id', v_renewal.customer_id,
      'renewal_status', v_renewal.status,
      'payment_status', v_renewal.payment_status,
      'asaas_charge_id', v_expected_charge_id,
      'asaas_cached_primary', v_cached_primary,
      'asaas_installment_group_id', v_cached_installment_id,
      'asaas_total_installments', v_cached_total_installments,
      'asaas_provider_snapshot', NULL,
      'external_payment_link', v_external_link,
      'external_invoice_number', v_external_invoice,
      'external_cancellation_confirmed', p_external_cancellation_confirmed,
      'external_confirmation_note',
        CASE WHEN v_external_link IS NULL AND v_external_invoice IS NULL THEN NULL
             ELSE trim(p_external_confirmation_note) END,
      'service_started', p_service_started,
      'renewal_updated_at', v_renewal.updated_at,
      'parent_status', v_parent.status,
      'parent_end_date', v_parent.end_date
    )
  )
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'lease_acquired', false,
    'lease_token', NULL,
    'lease_expires_at', NULL,
    'renewal_id', v_renewal.id,
    'parent_contract_id', v_parent.id,
    'resolution', p_resolution,
    'reason_code', p_reason_code,
    'asaas_charge_id', v_expected_charge_id,
    'external_payment_link', v_external_link,
    'external_invoice_number', v_external_invoice,
    'external_cancellation_confirmed', p_external_cancellation_confirmed,
    'external_confirmation_note',
      CASE WHEN v_external_link IS NULL AND v_external_invoice IS NULL THEN NULL
           ELSE trim(p_external_confirmation_note) END,
    'provider_snapshot', NULL,
    'external_result', NULL,
    'result', NULL,
    'error', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_assessment_renewal_provider_snapshot(
  p_payload JSONB,
  p_provider_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_charge_id TEXT := NULLIF(p_payload->>'asaas_charge_id', '');
  v_kind TEXT;
  v_installment_id TEXT;
  v_group_id TEXT;
  v_cached_group TEXT := NULLIF(p_payload->>'asaas_installment_group_id', '');
  v_cached_total_text TEXT := NULLIF(
    p_payload->>'asaas_total_installments', ''
  );
  v_cached_total INTEGER;
BEGIN
  IF v_charge_id IS NULL
     OR jsonb_typeof(p_provider_snapshot) IS DISTINCT FROM 'object'
     OR p_provider_snapshot->>'provider' IS DISTINCT FROM 'asaas'
     OR p_provider_snapshot->>'payment_id' IS DISTINCT FROM v_charge_id THEN
    RETURN false;
  END IF;

  IF v_cached_total_text IS NOT NULL THEN
    IF v_cached_total_text !~ '^[0-9]{1,3}$' THEN
      RETURN false;
    END IF;
    v_cached_total := v_cached_total_text::INTEGER;
  END IF;

  v_kind := p_provider_snapshot->>'kind';
  v_installment_id := NULLIF(p_provider_snapshot->>'installment_id', '');
  v_group_id := NULLIF(p_provider_snapshot->>'installment_group_id', '');
  IF v_kind = 'standalone' THEN
    RETURN v_installment_id IS NULL
      AND v_group_id IS NULL
      AND v_cached_group IS NULL
      AND (v_cached_total IS NULL OR v_cached_total = 1);
  END IF;
  IF v_kind = 'installment' THEN
    RETURN v_installment_id IS NOT NULL
      AND char_length(v_installment_id) <= 100
      AND v_group_id = v_installment_id
      AND (v_cached_group IS NULL OR v_cached_group = v_installment_id)
      AND NOT (v_cached_group IS NULL AND v_cached_total = 1);
  END IF;
  RETURN false;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_renewal_resolution_external_result(
  p_payload JSONB,
  p_requested_by UUID,
  p_external_result JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_charge_id TEXT := NULLIF(p_payload->>'asaas_charge_id', '');
  v_external_link TEXT := NULLIF(p_payload->>'external_payment_link', '');
  v_external_invoice TEXT := NULLIF(p_payload->>'external_invoice_number', '');
  v_result_group TEXT;
  v_cached_group TEXT := NULLIF(p_payload->>'asaas_installment_group_id', '');
  v_provider_snapshot JSONB := p_payload->'asaas_provider_snapshot';
  v_snapshot_kind TEXT;
  v_snapshot_group TEXT;
  v_total BIGINT;
  v_distinct BIGINT;
BEGIN
  IF jsonb_typeof(p_external_result) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF COALESCE(p_payload->>'asaas_cached_primary', '') NOT IN (
    'true', 'false'
  ) THEN
    RETURN false;
  END IF;

  IF v_charge_id IS NOT NULL THEN
    IF NOT public.is_valid_assessment_renewal_provider_snapshot(
      p_payload,
      v_provider_snapshot
    ) THEN
      RETURN false;
    END IF;
    v_snapshot_kind := v_provider_snapshot->>'kind';
    v_snapshot_group := NULLIF(v_provider_snapshot->>'installment_id', '');
    IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
       OR COALESCE(p_external_result->>'outcome', '') NOT IN (
         'deleted', 'already_missing', 'already_cancelled'
       )
       OR p_external_result->>'payment_id' IS DISTINCT FROM v_charge_id
       OR jsonb_typeof(p_external_result->'payment_ids') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(p_external_result->'payment_ids') < 1 THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_external_result->'payment_ids') ids(value)
      WHERE jsonb_typeof(ids.value) IS DISTINCT FROM 'string'
         OR NULLIF(trim(ids.value #>> '{}'), '') IS NULL
         OR char_length(ids.value #>> '{}') > 100
    ) OR NOT (
      p_external_result->'payment_ids' @> jsonb_build_array(v_charge_id)
    ) THEN
      RETURN false;
    END IF;
    SELECT count(*), count(DISTINCT ids.value #>> '{}')
    INTO v_total, v_distinct
    FROM jsonb_array_elements(p_external_result->'payment_ids') ids(value);
    IF v_total IS DISTINCT FROM v_distinct THEN
      RETURN false;
    END IF;

    IF NULLIF(p_external_result->>'installment_id', '') IS NOT NULL
       AND NULLIF(p_external_result->>'installment_group_id', '') IS NOT NULL
       AND NULLIF(p_external_result->>'installment_id', '') IS DISTINCT FROM
           NULLIF(p_external_result->>'installment_group_id', '') THEN
      RETURN false;
    END IF;
    v_result_group := COALESCE(
      NULLIF(p_external_result->>'installment_id', ''),
      NULLIF(p_external_result->>'installment_group_id', '')
    );
    IF (v_snapshot_kind = 'standalone' AND v_result_group IS NOT NULL)
       OR (v_snapshot_kind = 'installment'
           AND v_result_group IS DISTINCT FROM v_snapshot_group) THEN
      RETURN false;
    END IF;
    IF v_cached_group IS NOT NULL
       AND v_result_group IS DISTINCT FROM v_cached_group THEN
      RETURN false;
    END IF;
    RETURN v_external_link IS NULL AND v_external_invoice IS NULL;
  END IF;

  IF v_external_link IS NOT NULL OR v_external_invoice IS NOT NULL THEN
    RETURN COALESCE(
      p_external_result->>'provider' = 'external'
      AND p_external_result->>'outcome' = 'operator_confirmed_cancelled'
      AND NULLIF(p_external_result->>'external_payment_link', '')
            IS NOT DISTINCT FROM v_external_link
      AND NULLIF(p_external_result->>'external_invoice_number', '')
            IS NOT DISTINCT FROM v_external_invoice
      AND p_external_result->>'confirmed_by' = p_requested_by::TEXT
      AND NULLIF(trim(p_external_result->>'confirmation_note'), '')
            IS NOT DISTINCT FROM
          NULLIF(trim(p_payload->>'external_confirmation_note'), '')
      AND p_payload->>'external_cancellation_confirmed' = 'true',
      false
    );
  END IF;

  RETURN COALESCE(
    p_external_result->>'provider' = 'none'
      AND p_external_result->>'outcome' = 'not_required',
    false
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_assessment_renewal_resolution(
  p_operation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'resolve_renewal'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação externa não encontrada';
  END IF;

  IF v_operation.status = 'prepared'
     AND (v_operation.lease_expires_at IS NULL
          OR v_operation.lease_expires_at <= now()) THEN
    v_lease_token := gen_random_uuid();
    UPDATE public.order_operations
    SET lease_token = v_lease_token,
        lease_expires_at = now() + INTERVAL '120 seconds',
        updated_at = now()
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    v_lease_acquired := true;
  END IF;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'lease_acquired', v_lease_acquired,
    'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
    'lease_expires_at', v_operation.lease_expires_at,
    'provider_snapshot', v_operation.payload->'asaas_provider_snapshot',
    'external_result', v_operation.external_result,
    'result', v_operation.result,
    'error', v_operation.last_error
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_assessment_renewal_provider_snapshot(
  p_operation_id UUID,
  p_lease_token UUID,
  p_provider_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_existing JSONB;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'resolve_renewal'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação financeira não encontrada';
  END IF;
  IF v_operation.status IS DISTINCT FROM 'prepared'
     OR p_lease_token IS NULL
     OR v_operation.lease_token IS DISTINCT FROM p_lease_token
     OR v_operation.external_result IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A conferência da cobrança está sendo processada por outra requisição';
  END IF;
  IF NOT public.is_valid_assessment_renewal_provider_snapshot(
    v_operation.payload,
    p_provider_snapshot
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Conferência da cobrança Asaas inválida';
  END IF;

  v_existing := v_operation.payload->'asaas_provider_snapshot';
  IF v_existing IS NOT NULL AND jsonb_typeof(v_existing) <> 'null' THEN
    IF v_existing IS DISTINCT FROM p_provider_snapshot THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A operação já possui outra conferência da cobrança';
    END IF;
  ELSE
    UPDATE public.order_operations
    SET payload = jsonb_set(
          payload,
          '{asaas_provider_snapshot}',
          p_provider_snapshot,
          true
        ),
        updated_at = now()
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
  END IF;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'provider_snapshot', v_operation.payload->'asaas_provider_snapshot'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_assessment_renewal_external_result(
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
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'resolve_renewal'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação financeira não encontrada';
  END IF;

  IF NOT public.is_valid_renewal_resolution_external_result(
    v_operation.payload,
    v_operation.requested_by,
    p_external_result
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Resultado externo da resolução de renovação inválido';
  END IF;

  IF v_operation.status = 'completed' OR v_operation.external_result IS NOT NULL THEN
    IF v_operation.external_result IS DISTINCT FROM p_external_result THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A operação já possui outro resultado externo';
    END IF;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'external_result', v_operation.external_result
    );
  END IF;
  IF v_operation.status IS DISTINCT FROM 'prepared'
     OR p_lease_token IS NULL
     OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação externa está sendo processada por outra requisição';
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

CREATE OR REPLACE FUNCTION public.complete_assessment_renewal_resolution(
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
  v_renewal public.assessment_contracts%ROWTYPE;
  v_parent public.assessment_contracts%ROWTYPE;
  v_parent_id UUID;
  v_provider TEXT;
  v_resolution TEXT;
  v_reason_code TEXT;
  v_expected_charge_id TEXT;
  v_expected_external_link TEXT;
  v_expected_external_invoice TEXT;
  v_installment_id TEXT;
  v_parent_next_status TEXT;
  v_parent_renewal_generated BOOLEAN;
  v_cache_rows INTEGER := 0;
  v_cancelled_open_payouts INTEGER := 0;
  v_error TEXT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'resolve_renewal';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de renovação não encontrada';
  END IF;
  v_parent_id := NULLIF(v_operation.payload->>'parent_contract_id', '')::UUID;

  -- Keep the same lock order as prepare and renewal-row guards.
  SELECT * INTO v_renewal
  FROM public.assessment_contracts
  WHERE id = v_operation.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Renovação não encontrada';
  END IF;
  SELECT * INTO v_parent
  FROM public.assessment_contracts
  WHERE id = v_parent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato anterior não encontrado';
  END IF;
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'resolve_renewal'
  FOR UPDATE;

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
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A resolução está sendo processada por outra requisição';
  END IF;
  IF v_operation.external_result IS NULL
     OR v_operation.external_result IS DISTINCT FROM p_external_result THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O resultado externo persistido diverge da resolução';
  END IF;
  IF NOT public.is_valid_renewal_resolution_external_result(
    v_operation.payload,
    v_operation.requested_by,
    p_external_result
  ) THEN
    v_error := 'O resultado externo persistido é inválido';
  END IF;

  v_provider := p_external_result->>'provider';
  v_resolution := v_operation.payload->>'resolution';
  v_reason_code := v_operation.payload->>'reason_code';
  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');
  v_expected_external_link := NULLIF(v_operation.payload->>'external_payment_link', '');
  v_expected_external_invoice := NULLIF(v_operation.payload->>'external_invoice_number', '');
  v_installment_id := COALESCE(
    NULLIF(p_external_result->>'installment_id', ''),
    NULLIF(p_external_result->>'installment_group_id', '')
  );

  IF v_error IS NULL AND (
       v_renewal.parent_contract_id IS DISTINCT FROM v_parent.id
       OR v_renewal.customer_id IS DISTINCT FROM v_parent.customer_id
       OR v_renewal.status IS DISTINCT FROM v_operation.payload->>'renewal_status'
       OR v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished')
     ) THEN
    v_error := 'A cadeia da renovação mudou durante a resolução';
  ELSIF v_error IS NULL
        AND NOT (
          v_renewal.payment_status IS NOT DISTINCT FROM
            v_operation.payload->>'payment_status'
          OR (
            v_provider = 'asaas'
            AND v_renewal.payment_status = 'cancelled'
            AND v_renewal.asaas_charge_id IS NULL
          )
        ) THEN
    v_error := 'O estado financeiro da renovação mudou durante a resolução';
  ELSIF v_error IS NULL
        AND v_provider = 'asaas'
        AND NOT (
          NULLIF(v_renewal.asaas_charge_id, '') IS NOT DISTINCT FROM
            v_expected_charge_id
          OR (
            v_renewal.asaas_charge_id IS NULL
            AND v_renewal.payment_status = 'cancelled'
          )
        ) THEN
    v_error := 'A cobrança Asaas vinculada à renovação mudou';
  ELSIF v_error IS NULL
        AND v_provider <> 'asaas'
        AND NULLIF(v_renewal.asaas_charge_id, '') IS DISTINCT FROM
            v_expected_charge_id THEN
    v_error := 'A cobrança Asaas vinculada à renovação mudou';
  ELSIF v_error IS NULL
        AND (
          NULLIF(v_renewal.external_payment_link, '') IS DISTINCT FROM
            v_expected_external_link
          OR NULLIF(v_renewal.external_invoice_number, '') IS DISTINCT FROM
            v_expected_external_invoice
        ) THEN
    v_error := 'A cobrança externa vinculada à renovação mudou';
  ELSIF v_error IS NULL AND (
       COALESCE(v_renewal.manual_payment, false)
       OR v_renewal.payment_date IS NOT NULL
       OR COALESCE(v_renewal.refund_amount, 0) <> 0
       OR v_renewal.refund_status IS NOT NULL
       OR v_renewal.refund_date IS NOT NULL
       OR NULLIF(trim(v_renewal.refund_notes), '') IS NOT NULL
     ) THEN
    v_error := 'A renovação passou a possuir movimentação financeira';
  ELSIF v_error IS NULL AND EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_renewal.id
      AND (
        payment.source = 'manual'
        OR payment.status IN (
          'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED'
        )
      )
  ) THEN
    v_error := 'Foi identificado pagamento na renovação';
  ELSIF v_error IS NULL AND EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_renewal.id
      AND payment.source = 'asaas'
      AND payment.status NOT IN ('DELETED', 'CANCELLED', 'CANCELED')
      AND NOT COALESCE((
        v_provider = 'asaas'
        AND (
          payment.asaas_payment_id = v_expected_charge_id
          OR payment.asaas_payment_id IN (
            SELECT jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(p_external_result->'payment_ids') = 'array'
                  THEN p_external_result->'payment_ids'
                ELSE '[]'::JSONB
              END
            )
          )
          OR (
            v_installment_id IS NOT NULL
            AND payment.installment_group_id = v_installment_id
          )
        )
      ), false)
  ) THEN
    v_error := 'Existem cobranças Asaas não conciliadas nesta renovação';
  ELSIF v_error IS NULL AND (
    EXISTS (
      SELECT 1 FROM public.payout_monthly_statement_items item
      WHERE item.contract_id = v_renewal.id
    )
    OR EXISTS (
      SELECT 1 FROM public.payout_pending_repasse pending
      WHERE pending.contract_id = v_renewal.id
        AND pending.status = 'resolved'
    )
  ) THEN
    v_error := 'A renovação passou a possuir repasse efetivado';
  ELSIF v_error IS NULL AND v_resolution = 'non_renewal' AND EXISTS (
    SELECT 1 FROM public.assessment_contracts other
    WHERE other.customer_id = v_parent.customer_id
      AND other.id NOT IN (v_parent.id, v_renewal.id)
      AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    v_error := 'Foi encontrado outro contrato de continuidade para esta atleta';
  ELSIF v_error IS NULL AND v_resolution = 'non_renewal'
        AND NULLIF(trim(v_parent.cancellation_reason), '') IS NOT NULL
        AND lower(v_parent.cancellation_reason) NOT LIKE '%não renovou%'
        AND lower(v_parent.cancellation_reason) NOT LIKE '%nao renovou%'
        AND lower(v_parent.cancellation_reason) NOT LIKE '%não vai renovar%'
        AND lower(v_parent.cancellation_reason) NOT LIKE '%nao vai renovar%' THEN
    v_error := 'O contrato anterior possui outro motivo de encerramento';
  ELSIF v_error IS NULL AND v_provider = 'asaas' AND EXISTS (
    SELECT 1 FROM public.asaas_payments payment
    WHERE payment.asaas_payment_id = v_expected_charge_id
      AND payment.source = 'asaas'
      AND payment.order_type = 'contract'
      AND payment.order_id = v_renewal.id
      AND NULLIF(payment.installment_group_id, '') IS DISTINCT FROM
          v_installment_id
  ) THEN
    v_error := 'O grupo da cobrança Asaas diverge do cancelamento confirmado';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
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

  UPDATE public.assessment_contracts
  SET status = 'voided',
      payment_status = 'cancelled',
      payment_method = NULL,
      payment_date = NULL,
      due_date = NULL,
      manual_payment = false,
      manual_fee = NULL,
      asaas_charge_id = NULL,
      asaas_payment_link = NULL,
      asaas_pix_qrcode = NULL,
      asaas_pix_copy = NULL,
      external_payment_link = NULL,
      external_invoice_number = NULL,
      payment_message_sent_at = NULL,
      cancellation_date = NULL,
      cancellation_fee = 0,
      cancellation_reason = CASE v_reason_code
        WHEN 'duplicate' THEN 'Venda duplicada'
        WHEN 'created_in_error' THEN 'Venda criada por engano'
        ELSE 'Renovação não concretizada (cliente não renovou)'
      END,
      refund_status = NULL,
      refund_amount = NULL,
      refund_date = NULL,
      refund_notes = NULL,
      updated_at = now()
  WHERE id = v_renewal.id;

  IF v_provider = 'asaas' THEN
    UPDATE public.asaas_payments payment
    -- DELETED is the sticky terminal cache state used by the webhook reducer.
    -- CANCELLED could make a delayed non-restore event attach the charge to
    -- the now-voided contract again.
    SET status = 'DELETED',
        raw = COALESCE(payment.raw, '{}'::JSONB) || jsonb_build_object(
          '_eon_renewal_resolution_operation_id', v_operation.id,
          '_eon_deleted_at', now()
        ),
        last_synced_at = now(),
        updated_at = now()
    WHERE payment.order_type = 'contract'
      AND payment.order_id = v_renewal.id
      AND payment.source = 'asaas'
      AND (
        payment.asaas_payment_id = v_expected_charge_id
        OR payment.asaas_payment_id IN (
          SELECT jsonb_array_elements_text(p_external_result->'payment_ids')
        )
        OR (v_installment_id IS NOT NULL
            AND payment.installment_group_id = v_installment_id)
      )
      AND payment.status IS DISTINCT FROM 'DELETED';
    GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
  END IF;

  UPDATE public.payout_pending_repasse
  SET status = 'cancelled',
      resolved_at = now()
  WHERE contract_id = v_renewal.id
    AND status = 'open';
  GET DIAGNOSTICS v_cancelled_open_payouts = ROW_COUNT;

  IF v_resolution = 'non_renewal' THEN
    v_parent_next_status := CASE
      WHEN v_parent.end_date <= timezone('America/Sao_Paulo', now())::DATE
        THEN 'finished'
      ELSE v_parent.status
    END;
    UPDATE public.assessment_contracts
    SET renewal_generated = true,
        cancellation_date = end_date,
        cancellation_fee = 0,
        cancellation_reason = 'Não renovou',
        status = v_parent_next_status,
        updated_at = now()
    WHERE id = v_parent.id;
    v_parent_renewal_generated := true;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.assessment_contracts other
      WHERE other.parent_contract_id = v_parent.id
        AND other.id <> v_renewal.id
        AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
    ) INTO v_parent_renewal_generated;
    v_parent_next_status := v_parent.status;
    UPDATE public.assessment_contracts
    SET renewal_generated = v_parent_renewal_generated,
        updated_at = now()
    WHERE id = v_parent.id;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'contract', v_renewal.id, v_operation.payload->>'payment_status',
    'cancelled', v_operation.reason,
    jsonb_build_object(
      'action', 'renewal_resolved',
      'operation_id', v_operation.id,
      'resolution', v_resolution,
      'reason_code', v_reason_code,
      'parent_contract_id', v_parent.id,
      'external_provider', v_provider,
      'asaas_charge_id', v_expected_charge_id,
      'had_external_charge',
        (v_expected_external_link IS NOT NULL
         OR v_expected_external_invoice IS NOT NULL),
      'cancelled_open_payouts', v_cancelled_open_payouts
    ),
    v_operation.requested_by
  );

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_renewal.id,
    'sale_voided',
    jsonb_build_object(
      'operation_id', v_operation.id,
      'resolution', v_resolution,
      'reason_code', v_reason_code,
      'parent_contract_id', v_parent.id,
      'previous_status', v_operation.payload->>'renewal_status',
      'previous_payment_status', v_operation.payload->>'payment_status',
      'previous_asaas_charge_id', v_expected_charge_id,
      'external_provider', v_provider,
      'external_invoice_number', v_expected_external_invoice,
      'cancelled_open_payouts', v_cancelled_open_payouts
    ),
    v_operation.reason,
    v_operation.requested_by
  );

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_parent.id,
    CASE WHEN v_resolution = 'non_renewal'
      THEN 'renewal_declined' ELSE 'renewal_discarded' END,
    jsonb_build_object(
      'operation_id', v_operation.id,
      'discarded_contract_id', v_renewal.id,
      'discarded_contract_number', v_renewal.contract_number,
      'resolution', v_resolution,
      'reason_code', v_reason_code,
      'effective_end_date',
        CASE WHEN v_resolution = 'non_renewal' THEN v_parent.end_date ELSE NULL END,
      'status_after', v_parent_next_status,
      'no_financial_penalty', true,
      'renewal_generated_after', v_parent_renewal_generated
    ),
    v_operation.reason,
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'renewal_id', v_renewal.id,
    'parent_contract_id', v_parent.id,
    'resolution', v_resolution,
    'reason_code', v_reason_code,
    'renewal_status', 'voided',
    'renewal_payment_status', 'cancelled',
    'parent_status', v_parent_next_status,
    'parent_non_renewal', v_resolution = 'non_renewal',
    'cancelled_open_payouts', v_cancelled_open_payouts,
    'cancelled_charge_id', v_expected_charge_id,
    'external_charge_removed',
      (v_expected_external_link IS NOT NULL
       OR v_expected_external_invoice IS NOT NULL),
    'cache_rows_cancelled', v_cache_rows
  );

  UPDATE public.order_operations
  SET status = 'completed',
      result = v_result,
      last_error = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

-- Prevent automatic/manual renewal creation from racing a non-renewal
-- decision. A deliberate reversal must first clear the decision through a
-- future audited backend operation.
CREATE UNIQUE INDEX assessment_contracts_one_open_child_per_parent_idx
  ON public.assessment_contracts (parent_contract_id)
  WHERE parent_contract_id IS NOT NULL
    AND status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave');

CREATE OR REPLACE FUNCTION public.guard_assessment_renewal_open_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent_reason TEXT;
  v_new_reason TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.parent_contract_id IS NOT NULL
     AND NEW.parent_contract_id IS DISTINCT FROM OLD.parent_contract_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A origem de uma venda de renovação não pode ser removida ou alterada';
  END IF;

  -- The legacy UI used to mark the parent first and delete the open draft in
  -- a second request. Reject that half-finished transition; the audited
  -- resolution voids the child before changing the parent and remains valid.
  IF TG_OP = 'UPDATE'
     AND NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason THEN
    v_new_reason := lower(COALESCE(NEW.cancellation_reason, ''));
    IF (
      v_new_reason LIKE '%não renovou%'
      OR v_new_reason LIKE '%nao renovou%'
      OR v_new_reason LIKE '%não vai renovar%'
      OR v_new_reason LIKE '%nao vai renovar%'
    ) AND EXISTS (
      SELECT 1
      FROM public.assessment_contracts child
      WHERE child.parent_contract_id = NEW.id
        AND child.status IN (
          'draft', 'scheduled', 'active', 'overdue', 'on_leave'
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Resolva a renovação aberta antes de marcar o contrato como não renovado';
    END IF;
  END IF;

  IF NEW.parent_contract_id IS NULL
     OR NEW.status NOT IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.parent_contract_id IS NOT DISTINCT FROM NEW.parent_contract_id
     AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT lower(COALESCE(cancellation_reason, ''))
  INTO v_parent_reason
  FROM public.assessment_contracts
  WHERE id = NEW.parent_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_parent_reason LIKE '%não renovou%'
     OR v_parent_reason LIKE '%nao renovou%'
     OR v_parent_reason LIKE '%não vai renovar%'
     OR v_parent_reason LIKE '%nao vai renovar%' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O contrato anterior está marcado como não renovado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_operations operation
    WHERE operation.operation_type = 'resolve_renewal'
      AND operation.status IN ('prepared', 'reconciliation_required')
      AND operation.payload->>'parent_contract_id' = NEW.parent_contract_id::TEXT
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existe uma resolução de renovação em andamento';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assessment_contracts_guard_renewal_open_state
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contracts_guard_renewal_open_state
  BEFORE INSERT OR UPDATE OF parent_contract_id, status, cancellation_reason
  ON public.assessment_contracts
  FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_renewal_open_state();

-- Renewal sales are accounting/audit records. They may be voided through the
-- resolution operation, but must never disappear through a legacy client or a
-- direct table delete.
CREATE OR REPLACE FUNCTION public.prevent_assessment_renewal_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.parent_contract_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Vendas de renovação devem ser encerradas, não excluídas';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS assessment_contracts_prevent_renewal_delete
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contracts_prevent_renewal_delete
  BEFORE DELETE ON public.assessment_contracts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_assessment_renewal_delete();

-- A monthly closing calculates candidates before inserting them. Serialize
-- that final insert/reopen with renewal resolution so a stale calculation can
-- never leave an open payout for a contract that was voided in the meantime.
CREATE OR REPLACE FUNCTION public.guard_open_payout_for_inactive_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contract_status TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT contract.status
    INTO v_contract_status
    FROM public.assessment_contracts contract
    WHERE contract.id = NEW.contract_id
    FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- payout rows are locked before BEFORE UPDATE triggers run, while renewal
    -- completion locks the contract first. Never wait in the reverse order or
    -- persist a false cancelled row that would occupy the payout unique key.
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'O contrato está sendo atualizado; refaça o fechamento mensal';
  END;

  IF FOUND AND v_contract_status IN ('voided', 'cancelled', 'draft') THEN
    NEW.status := 'cancelled';
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    NEW.resolved_in_closing_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payout_pending_repasse_guard_inactive_contract
  ON public.payout_pending_repasse;
CREATE TRIGGER payout_pending_repasse_guard_inactive_contract
  BEFORE INSERT OR UPDATE OF contract_id, status
  ON public.payout_pending_repasse
  FOR EACH ROW EXECUTE FUNCTION public.guard_open_payout_for_inactive_contract();

REVOKE ALL ON FUNCTION public.prepare_assessment_renewal_resolution(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_assessment_renewal_resolution(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_valid_renewal_resolution_external_result(JSONB, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_valid_assessment_renewal_provider_snapshot(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_assessment_renewal_resolution(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_assessment_renewal_provider_snapshot(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_assessment_renewal_external_result(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_assessment_renewal_open_state()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_assessment_renewal_delete()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_open_payout_for_inactive_contract()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_assessment_renewal_resolution(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_assessment_renewal_resolution(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_renewal_resolution_external_result(JSONB, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_assessment_renewal_provider_snapshot(JSONB, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_assessment_renewal_resolution(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_assessment_renewal_provider_snapshot(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_assessment_renewal_external_result(UUID, UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.prepare_assessment_renewal_resolution(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT, UUID
) IS 'Prepares one idempotent decision for an approved, unpaid assessment renewal.';
COMMENT ON FUNCTION public.complete_assessment_renewal_resolution(UUID, UUID, JSONB)
  IS 'Atomically voids an unpaid renewal and optionally records non-renewal on its parent after external cancellation.';
COMMENT ON FUNCTION public.is_valid_renewal_resolution_external_result(JSONB, UUID, JSONB)
  IS 'Validates the exact Asaas, external-attestation, or no-provider outcome expected by a renewal resolution.';
COMMENT ON FUNCTION public.is_valid_assessment_renewal_provider_snapshot(JSONB, JSONB)
  IS 'Validates the provider-inspected standalone or installment shape before an Asaas cancellation side effect.';
COMMENT ON FUNCTION public.claim_assessment_renewal_resolution(UUID)
  IS 'Claims the provider step of one prepared renewal resolution with a short retryable lease.';
COMMENT ON FUNCTION public.record_assessment_renewal_provider_snapshot(UUID, UUID, JSONB)
  IS 'Persists the provider-inspected Asaas charge shape before cancellation so crash retries remain safe.';
COMMENT ON FUNCTION public.record_assessment_renewal_external_result(UUID, UUID, JSONB)
  IS 'Persists the validated provider outcome for one renewal resolution before local completion.';
COMMENT ON FUNCTION public.guard_assessment_renewal_open_state()
  IS 'Serializes renewal creation with open/non-renewal decisions on the parent contract.';
COMMENT ON FUNCTION public.prevent_assessment_renewal_delete()
  IS 'Preserves renewal sales as auditable records; resolution must void rather than delete them.';
COMMENT ON FUNCTION public.guard_open_payout_for_inactive_contract()
  IS 'Prevents stale monthly-closing writes from opening payouts for inactive assessment sales.';
