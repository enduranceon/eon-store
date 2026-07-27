-- Safe, idempotent cancellation of an unpaid charge while preserving the sale.
-- The Edge Function confirms the provider state between the short prepare and
-- complete transactions. Direct clients cannot execute these RPCs.

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
    'resolve_renewal'
  ));

CREATE OR REPLACE FUNCTION public.prepare_order_charge_cancellation(
  p_order_type TEXT,
  p_order_id UUID,
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
  v_payment_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_order_number TEXT;
  v_record_status TEXT;
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
BEGIN
  IF p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de venda inválido';
  END IF;
  IF p_order_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do cancelamento são inválidos';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo de cancelamento inválido';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, external_payment_link,
           order_number, status
      INTO v_payment_status, v_charge_id, v_external_link,
           v_order_number, v_record_status
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSIF p_order_type = 'stock' THEN
    SELECT payment_status, asaas_charge_id, external_payment_link,
           order_number, NULL::TEXT
      INTO v_payment_status, v_charge_id, v_external_link,
           v_order_number, v_record_status
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, external_payment_link,
           contract_number, status
      INTO v_payment_status, v_charge_id, v_external_link,
           v_order_number, v_record_status
    FROM public.assessment_contracts
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'cancel_charge'
    AND operation_key = p_idempotency_key
    AND order_type = p_order_type
    AND order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.reason IS DISTINCT FROM trim(p_reason) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A chave de idempotência já foi usada com outro motivo';
    END IF;

    IF v_operation.status = 'prepared'
       AND COALESCE(v_payment_status, '') IN ('paid', 'refunded') THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          last_error = 'O pagamento foi concluído antes da retomada do cancelamento',
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
    END IF;

    IF v_operation.status IN ('prepared', 'failed')
       AND (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at <= now())
       AND (
         COALESCE(v_operation.external_result, '{}'::jsonb) = '{}'::jsonb
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
      'order_id', v_operation.order_id,
      'order_type', v_operation.order_type,
      'payment_status', v_operation.payload->>'payment_status',
      'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
      'had_external_link', COALESCE((v_operation.payload->>'had_external_link')::BOOLEAN, false),
      'lease_acquired', v_lease_acquired,
      'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
      'lease_expires_at', v_operation.lease_expires_at,
      'external_result', v_operation.external_result,
      'result', v_operation.result,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error
    );
  END IF;

  IF v_payment_status IS NULL
     OR v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue', 'cancelled') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Somente cobranças ainda não pagas podem ser canceladas';
  END IF;
  IF p_order_type = 'contract' AND v_record_status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Este contrato não permite cancelamento de cobrança';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_operations
    WHERE order_type = p_order_type
      AND order_id = p_order_id
      AND status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existe outra operação financeira pendente para esta venda';
  END IF;

  v_lease_token := gen_random_uuid();
  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, lease_token, lease_expires_at
  )
  VALUES (
    'cancel_charge', p_idempotency_key, p_order_type, p_order_id, 'prepared',
    p_actor_id, trim(p_reason),
    jsonb_build_object(
      'payment_status', v_payment_status,
      'asaas_charge_id', v_charge_id,
      'had_external_link', NULLIF(v_external_link, '') IS NOT NULL,
      'external_link_fingerprint', CASE
        WHEN NULLIF(v_external_link, '') IS NULL THEN NULL
        ELSE pg_catalog.md5(v_external_link)
      END,
      'order_number', v_order_number,
      'record_status', v_record_status
    ),
    v_lease_token,
    now() + INTERVAL '90 seconds'
  )
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', v_payment_status,
    'asaas_charge_id', v_charge_id,
    'had_external_link', NULLIF(v_external_link, '') IS NOT NULL,
    'lease_acquired', true,
    'lease_token', v_lease_token,
    'lease_expires_at', v_operation.lease_expires_at,
    'external_result', NULL,
    'result', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_charge_cancellation_snapshot(
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
    AND operation_type = 'cancel_charge'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cancelamento não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'external_result', v_operation.external_result
    );
  END IF;
  IF v_operation.status <> 'prepared'
     OR p_lease_token IS NULL
     OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação não possui uma execução ativa';
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

CREATE OR REPLACE FUNCTION public.complete_order_charge_cancellation(
  p_operation_id UUID,
  p_lease_token UUID,
  p_external_result JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_payment_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_record_status TEXT;
  v_expected_charge_id TEXT;
  v_expected_external_fingerprint TEXT;
  v_had_external_link BOOLEAN;
  v_target_payment_status TEXT;
  v_deleted_payments INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'cancel_charge'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cancelamento não encontrada';
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
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');
  v_had_external_link := COALESCE((v_operation.payload->>'had_external_link')::BOOLEAN, false);
  v_expected_external_fingerprint := NULLIF(
    v_operation.payload->>'external_link_fingerprint',
    ''
  );
  v_target_payment_status := CASE
    WHEN v_operation.order_type = 'contract' THEN 'pending'
    ELSE 'awaiting_charge'
  END;

  IF v_expected_charge_id IS NOT NULL THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
       OR NOT (COALESCE(p_external_result->>'outcome', '') = ANY (
         ARRAY['deleted', 'already_missing', 'already_cancelled']
       ))
       OR p_external_result->>'payment_id' IS DISTINCT FROM v_expected_charge_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
    END IF;
  ELSIF v_had_external_link THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'external_link'
       OR p_external_result->>'outcome' IS DISTINCT FROM 'detached' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
    END IF;
  ELSIF p_external_result->>'provider' IS DISTINCT FROM 'none'
        OR p_external_result->>'outcome' IS DISTINCT FROM 'not_required' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
  END IF;

  IF v_operation.order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, external_payment_link, status
      INTO v_payment_status, v_charge_id, v_external_link, v_record_status
    FROM public.presale_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSIF v_operation.order_type = 'stock' THEN
    SELECT payment_status, asaas_charge_id, external_payment_link, NULL::TEXT
      INTO v_payment_status, v_charge_id, v_external_link, v_record_status
    FROM public.stock_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, external_payment_link, status
      INTO v_payment_status, v_charge_id, v_external_link, v_record_status
    FROM public.assessment_contracts
    WHERE id = v_operation.order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  IF v_charge_id IS NOT NULL AND v_charge_id IS DISTINCT FROM v_expected_charge_id THEN
    v_error := 'A cobrança vinculada à venda mudou durante o cancelamento';
  ELSIF NULLIF(v_external_link, '') IS NOT NULL
        AND (
          NOT v_had_external_link
          OR pg_catalog.md5(v_external_link) IS DISTINCT FROM v_expected_external_fingerprint
        ) THEN
    v_error := 'O link externo vinculado à venda mudou durante o cancelamento';
  ELSIF COALESCE(v_payment_status, '') IN ('paid', 'refunded') THEN
    v_error := 'O pagamento foi concluído durante o cancelamento';
  ELSIF v_operation.order_type = 'contract' AND v_record_status IN ('cancelled', 'voided') THEN
    v_error := 'O contrato foi encerrado durante o cancelamento da cobrança';
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

  IF v_operation.order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET payment_status = v_target_payment_status,
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        external_payment_link = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        payment_message_sent_at = NULL,
        cancellation_reason = v_operation.reason,
        updated_date = now()
    WHERE id = v_operation.order_id;
  ELSIF v_operation.order_type = 'stock' THEN
    UPDATE public.stock_orders
    SET payment_status = v_target_payment_status,
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        external_payment_link = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        payment_message_sent_at = NULL,
        cancellation_reason = v_operation.reason,
        updated_date = now()
    WHERE id = v_operation.order_id;
  ELSE
    UPDATE public.assessment_contracts
    SET payment_status = v_target_payment_status,
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        external_payment_link = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        payment_message_sent_at = NULL,
        updated_at = now()
    WHERE id = v_operation.order_id;
  END IF;

  DELETE FROM public.asaas_payments
  WHERE order_id = v_operation.order_id
    AND order_type = v_operation.order_type
    AND source = 'asaas';
  GET DIAGNOSTICS v_deleted_payments = ROW_COUNT;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status,
    reason, metadata, actor_id
  ) VALUES (
    v_operation.order_type,
    v_operation.order_id,
    v_operation.payload->>'payment_status',
    v_target_payment_status,
    v_operation.reason,
    jsonb_build_object(
      'action', 'charge_cancelled',
      'operation_id', v_operation.id,
      'had_asaas_charge', v_expected_charge_id IS NOT NULL,
      'had_external_link', v_had_external_link,
      'external_result', p_external_result
    ),
    v_operation.requested_by
  );

  IF v_operation.order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_operation.order_id,
      'charge_cancelled',
      jsonb_build_object(
        'operation_id', v_operation.id,
        'previous_payment_status', v_operation.payload->>'payment_status',
        'had_asaas_charge', v_expected_charge_id IS NOT NULL,
        'had_external_link', v_had_external_link,
        'external_result', p_external_result
      ),
      v_operation.reason,
      v_operation.requested_by
    );
  END IF;

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', v_target_payment_status,
    'asaas_cache_rows_deleted', v_deleted_payments,
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

CREATE OR REPLACE FUNCTION public.finalize_order_charge_cancellation_failure(
  p_operation_id UUID,
  p_lease_token UUID,
  p_error_code TEXT,
  p_error_message TEXT,
  p_requires_reconciliation BOOLEAN DEFAULT false,
  p_external_result JSONB DEFAULT '{}'::jsonb
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
  IF NULLIF(trim(p_error_message), '') IS NULL
     OR char_length(trim(p_error_message)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Descrição de falha inválida';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'cancel_charge'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cancelamento não encontrada';
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
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  v_status := CASE
    WHEN COALESCE(p_requires_reconciliation, false)
      THEN 'reconciliation_required'
    ELSE 'failed'
  END;
  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'error_code', p_error_code,
    'error', trim(p_error_message)
  );

  UPDATE public.order_operations
  SET status = v_status,
      external_result = COALESCE(p_external_result, '{}'::jsonb),
      result = v_result,
      last_error = trim(p_error_message),
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_order_charge_cancellation(
  TEXT, UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_charge_cancellation(
  UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_charge_cancellation_snapshot(
  UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_order_charge_cancellation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_order_charge_cancellation(
  TEXT, UUID, TEXT, TEXT, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_charge_cancellation(
  UUID, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_charge_cancellation_snapshot(
  UUID, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_order_charge_cancellation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) TO service_role;

COMMENT ON FUNCTION public.prepare_order_charge_cancellation(
  TEXT, UUID, TEXT, TEXT, UUID
) IS 'Prepares an idempotent unpaid charge cancellation for the server API.';
COMMENT ON FUNCTION public.complete_order_charge_cancellation(
  UUID, UUID, JSONB
) IS 'Atomically clears a charge only after provider cancellation is confirmed.';
COMMENT ON FUNCTION public.record_order_charge_cancellation_snapshot(
  UUID, UUID, JSONB
) IS 'Persists the provider shape before deleting a standalone charge or installment group.';
COMMENT ON FUNCTION public.finalize_order_charge_cancellation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) IS 'Records deterministic failures or ambiguous cancellations for reconciliation.';
