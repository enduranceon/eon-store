-- Idempotent due-date changes for presale, stock, and assessment sales.
-- The operation ledger prevents two operators from racing while the Asaas
-- request happens outside the database transaction.

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_operation_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_operation_type_check
  CHECK (operation_type IN (
    'cancel_order',
    'refund_order',
    'cancel_item',
    'change_due_date'
  ));

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_status_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_status_check
  CHECK (status IN (
    'prepared',
    'completed',
    'reconciliation_required',
    'failed'
  ));

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_order_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_order_type_check
  CHECK (order_type IN ('presale', 'stock', 'contract'));

ALTER TABLE public.order_operations
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX order_operations_one_open_per_order_idx
  ON public.order_operations(order_type, order_id)
  WHERE status IN ('prepared', 'reconciliation_required');

CREATE OR REPLACE FUNCTION public.prepare_order_due_date_change(
  p_order_type TEXT,
  p_order_id UUID,
  p_due_date DATE,
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
  v_order_number TEXT;
  v_due_date DATE;
  v_updated_at TIMESTAMPTZ;
  v_record_status TEXT;
  v_operation_key TEXT;
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
  v_result JSONB;
BEGIN
  IF p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de venda inválido';
  END IF;
  IF p_order_id IS NULL OR p_actor_id IS NULL OR p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da alteração de vencimento são inválidos';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, order_number, due_date, updated_date, status
      INTO v_payment_status, v_charge_id, v_order_number, v_due_date, v_updated_at, v_record_status
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSIF p_order_type = 'stock' THEN
    SELECT payment_status, asaas_charge_id, order_number, due_date, updated_date, NULL::TEXT
      INTO v_payment_status, v_charge_id, v_order_number, v_due_date, v_updated_at, v_record_status
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, contract_number, due_date, updated_at, status
      INTO v_payment_status, v_charge_id, v_order_number, v_due_date, v_updated_at, v_record_status
    FROM public.assessment_contracts
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  v_operation_key := p_idempotency_key;

  -- A retry must return the stored command before validating the sale's new
  -- state. The sale may have been paid or cancelled after the first response.
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'change_due_date'
    AND operation_key = v_operation_key
    AND order_type = p_order_type
    AND order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.payload->>'target_due_date' IS DISTINCT FROM p_due_date::TEXT THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A chave de idempotência já foi usada com outro vencimento';
    END IF;

    IF v_operation.status = 'prepared'
       AND (
         COALESCE(v_payment_status, '') NOT IN (
           'pending', 'awaiting_charge', 'charge_sent', 'overdue'
         )
         OR (
           p_order_type = 'contract'
           AND v_record_status IN ('cancelled', 'draft', 'voided')
         )
       ) THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          last_error = 'O estado da venda mudou antes da retomada da operação',
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
    END IF;

    IF v_operation.status = 'prepared'
       AND (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at <= now()) THEN
      v_lease_token := gen_random_uuid();
      UPDATE public.order_operations
      SET lease_token = v_lease_token,
          lease_expires_at = now() + INTERVAL '60 seconds',
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
      'previous_due_date', v_operation.payload->>'previous_due_date',
      'target_due_date', v_operation.payload->>'target_due_date',
      'lease_acquired', v_lease_acquired,
      'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
      'lease_expires_at', v_operation.lease_expires_at,
      'result', v_operation.result,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error
    );
  END IF;

  IF v_payment_status IS NULL
     OR v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Somente vendas ainda não pagas podem ter o vencimento alterado';
  END IF;
  IF p_order_type = 'contract'
     AND v_record_status IN ('cancelled', 'draft', 'voided') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Este contrato não permite alteração de vencimento';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_operations
    WHERE order_type = p_order_type
      AND order_id = p_order_id
      AND status IN ('prepared', 'reconciliation_required')
      AND NOT (
        operation_type = 'change_due_date'
        AND operation_key = v_operation_key
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Existe outra operação financeira pendente para esta venda';
  END IF;

  v_result := CASE
    WHEN NULLIF(v_charge_id, '') IS NULL AND v_due_date IS NOT DISTINCT FROM p_due_date
      THEN jsonb_build_object(
        'order_id', p_order_id,
        'order_type', p_order_type,
        'due_date', p_due_date,
        'already_current', true,
        'external_result', jsonb_build_object(
          'provider', 'none',
          'outcome', 'not_required'
        )
      )
    ELSE NULL
  END;

  INSERT INTO public.order_operations (
    operation_type,
    operation_key,
    order_type,
    order_id,
    status,
    requested_by,
    reason,
    payload,
    external_result,
    result
  )
  VALUES (
    'change_due_date',
    v_operation_key,
    p_order_type,
    p_order_id,
    CASE WHEN v_result IS NULL THEN 'prepared' ELSE 'completed' END,
    p_actor_id,
    'Alteração de vencimento para ' || p_due_date::TEXT,
    jsonb_build_object(
      'payment_status', v_payment_status,
      'asaas_charge_id', v_charge_id,
      'order_number', v_order_number,
      'previous_due_date', v_due_date,
      'target_due_date', p_due_date,
      'row_updated_at', v_updated_at
    ),
    CASE WHEN v_result IS NULL THEN NULL ELSE v_result->'external_result' END,
    v_result
  )
  ON CONFLICT (operation_type, order_type, order_id, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'change_due_date'
    AND operation_key = v_operation_key
    AND order_type = p_order_type
    AND order_id = p_order_id
  FOR UPDATE;

  IF v_operation.payload->>'target_due_date' IS DISTINCT FROM p_due_date::TEXT THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'A chave de idempotência já foi usada com outro vencimento';
  END IF;

  IF v_operation.status = 'prepared'
     AND (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at <= now()) THEN
    v_lease_token := gen_random_uuid();
    UPDATE public.order_operations
    SET lease_token = v_lease_token,
        lease_expires_at = now() + INTERVAL '60 seconds',
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
    'previous_due_date', v_operation.payload->>'previous_due_date',
    'target_due_date', v_operation.payload->>'target_due_date',
    'lease_acquired', v_lease_acquired,
    'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
    'lease_expires_at', v_operation.lease_expires_at,
    'result', v_operation.result,
    'error_code', v_operation.result->>'error_code',
    'error', v_operation.last_error
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_order_due_date_change(
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
  v_record_status TEXT;
  v_charge_id TEXT;
  v_due_date DATE;
  v_expected_charge_id TEXT;
  v_expected_due_date DATE;
  v_target_due_date DATE;
  v_cached_payments INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'change_due_date';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de vencimento não encontrada';
  END IF;

  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');
  v_expected_due_date := NULLIF(v_operation.payload->>'previous_due_date', '')::DATE;
  v_target_due_date := NULLIF(v_operation.payload->>'target_due_date', '')::DATE;

  IF v_operation.order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, due_date, status
      INTO v_payment_status, v_charge_id, v_due_date, v_record_status
    FROM public.presale_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSIF v_operation.order_type = 'stock' THEN
    SELECT payment_status, asaas_charge_id, due_date, NULL::TEXT
      INTO v_payment_status, v_charge_id, v_due_date, v_record_status
    FROM public.stock_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, due_date, status
      INTO v_payment_status, v_charge_id, v_due_date, v_record_status
    FROM public.assessment_contracts
    WHERE id = v_operation.order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'change_due_date'
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
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  IF v_expected_charge_id IS NULL THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'none'
       OR p_external_result->>'outcome' IS DISTINCT FROM 'not_required' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
    END IF;
  ELSIF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
        OR NOT (
          COALESCE(p_external_result->>'outcome', '') = ANY (
            ARRAY['updated', 'already_current']
          )
        )
        OR p_external_result->>'payment_id' IS DISTINCT FROM v_expected_charge_id
        OR p_external_result->>'due_date' IS DISTINCT FROM v_target_due_date::TEXT
        OR NULLIF(p_external_result->>'status_after', '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
  END IF;

  IF v_charge_id IS DISTINCT FROM v_expected_charge_id THEN
    v_error := 'A cobrança vinculada à venda mudou durante a alteração de vencimento';
  ELSIF v_operation.order_type = 'contract'
        AND v_record_status IN ('cancelled', 'draft', 'voided')
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'O contrato foi encerrado durante a alteração de vencimento';
  ELSIF COALESCE(v_payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'O pagamento foi concluído durante a alteração de vencimento';
  ELSIF v_expected_charge_id IS NOT NULL
        AND p_external_result->>'status_after' NOT IN ('PENDING', 'OVERDUE')
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'A cobrança mudou para um estado não ajustável durante a alteração';
  ELSIF v_due_date IS DISTINCT FROM v_expected_due_date
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'O vencimento local mudou para uma terceira data durante a alteração';
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

  IF v_due_date IS DISTINCT FROM v_target_due_date THEN
    IF v_operation.order_type = 'presale' THEN
      UPDATE public.presale_orders
      SET due_date = v_target_due_date,
          updated_date = now()
      WHERE id = v_operation.order_id;
    ELSIF v_operation.order_type = 'stock' THEN
      UPDATE public.stock_orders
      SET due_date = v_target_due_date,
          updated_date = now()
      WHERE id = v_operation.order_id;
    ELSE
      UPDATE public.assessment_contracts
      SET due_date = v_target_due_date,
          updated_at = now()
      WHERE id = v_operation.order_id;
    END IF;
  END IF;

  IF v_expected_charge_id IS NOT NULL THEN
    UPDATE public.asaas_payments
    SET due_date = v_target_due_date,
        status = COALESCE(NULLIF(p_external_result->>'status_after', ''), status),
        last_synced_at = now(),
        updated_at = now()
    WHERE asaas_payment_id = v_expected_charge_id;
    GET DIAGNOSTICS v_cached_payments = ROW_COUNT;
  END IF;

  IF v_operation.order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event (
      contract_id,
      event_type,
      payload,
      notes,
      created_by
    )
    VALUES (
      v_operation.order_id,
      'due_date_changed',
      jsonb_build_object(
        'from', v_expected_due_date,
        'to', v_target_due_date,
        'source', 'api_v1_financial_open_sales',
        'operation_id', v_operation.id,
        'external_result', p_external_result
      ),
      'Vencimento ajustado em Vendas em aberto',
      v_operation.requested_by
    );
  ELSE
    INSERT INTO public.sales_status_events (
      order_type,
      order_id,
      previous_status,
      new_status,
      reason,
      metadata,
      actor_id
    )
    VALUES (
      v_operation.order_type,
      v_operation.order_id,
      v_payment_status,
      v_payment_status,
      'Vencimento alterado',
      jsonb_build_object(
        'action', CASE
          WHEN v_expected_due_date IS NOT DISTINCT FROM v_target_due_date
            THEN 'due_date_reconciled'
          ELSE 'due_date_changed'
        END,
        'from', v_expected_due_date,
        'to', v_target_due_date,
        'source', 'api_v1_financial_open_sales',
        'operation_id', v_operation.id,
        'external_result', p_external_result
      ),
      v_operation.requested_by
    );
  END IF;

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'due_date', v_target_due_date,
    'previous_due_date', v_expected_due_date,
    'already_converged', v_due_date IS NOT DISTINCT FROM v_target_due_date,
    'asaas_cache_rows_updated', v_cached_payments,
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

CREATE OR REPLACE FUNCTION public.finalize_order_due_date_failure(
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
    AND operation_type = 'change_due_date'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de vencimento não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'result', v_operation.result
    );
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

CREATE OR REPLACE FUNCTION public.release_order_due_date_operation(
  p_operation_id UUID,
  p_actor_id UUID,
  p_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_result JSONB;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF NULLIF(trim(p_notes), '') IS NULL OR char_length(trim(p_notes)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Notas de resolução inválidas';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'change_due_date'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de vencimento não encontrada';
  END IF;
  IF v_operation.status NOT IN ('prepared', 'reconciliation_required') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação não está aguardando recuperação manual';
  END IF;
  IF v_operation.status = 'prepared'
     AND v_operation.lease_expires_at IS NOT NULL
     AND v_operation.lease_expires_at > now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'A operação ainda está em processamento';
  END IF;

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'failed',
    'resolution', 'released_after_manual_review',
    'previous_status', v_operation.status,
    'resolved_by', p_actor_id,
    'resolution_notes', trim(p_notes),
    'previous_error', v_operation.last_error,
    'resolved_at', now()
  );

  UPDATE public.order_operations
  SET status = 'failed',
      result = v_result,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_order_due_date_change(TEXT, UUID, DATE, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_due_date_change(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_order_due_date_failure(UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_order_due_date_operation(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_order_due_date_change(TEXT, UUID, DATE, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_due_date_change(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_order_due_date_failure(UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_due_date_operation(UUID, UUID, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.prepare_order_due_date_change(TEXT, UUID, DATE, TEXT, UUID) IS
  'Prepares or resumes an idempotent due-date change and claims its external step for 60 seconds.';
COMMENT ON FUNCTION public.complete_order_due_date_change(UUID, UUID, JSONB) IS
  'Atomically stores a due-date change, refreshes the Asaas cache, and records the audit event.';
COMMENT ON FUNCTION public.finalize_order_due_date_failure(UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) IS
  'Closes deterministic due-date failures or persists an ambiguous result for reconciliation.';
COMMENT ON FUNCTION public.release_order_due_date_operation(UUID, UUID, TEXT) IS
  'Releases an expired or reconciled due-date operation after an audited manual review.';
