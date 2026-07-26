-- Server-only operation ledger for integral order cancellations.
-- The ledger bridges the external Asaas request and the local transaction so
-- retries are safe and a partial failure can be reconciled explicitly.

CREATE TABLE public.order_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('cancel_order')),
  operation_key TEXT NOT NULL DEFAULT 'full'
    CHECK (char_length(operation_key) BETWEEN 1 AND 100),
  order_type TEXT NOT NULL CHECK (order_type IN ('presale', 'stock')),
  order_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'completed', 'reconciliation_required')),
  requested_by UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 500),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_result JSONB,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_operations_unique_command
    UNIQUE (operation_type, order_type, order_id, operation_key)
);

CREATE INDEX order_operations_status_created_idx
  ON public.order_operations(status, created_at);

ALTER TABLE public.order_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.order_operations TO service_role;

COMMENT ON TABLE public.order_operations IS
  'Server-only idempotency and reconciliation ledger for external order operations.';

CREATE OR REPLACE FUNCTION public.prepare_order_cancellation(
  p_order_type TEXT,
  p_order_id UUID,
  p_reason TEXT,
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
  v_operation public.order_operations%ROWTYPE;
BEGIN
  IF p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de pedido inválido';
  END IF;

  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  IF NULLIF(trim(p_reason), '') IS NULL OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo de cancelamento inválido';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, order_number
      INTO v_payment_status, v_charge_id, v_order_number
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, order_number
      INTO v_payment_status, v_charge_id, v_order_number
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  IF v_payment_status IS NULL
     OR v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'cancelled') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Somente pedidos ainda não pagos podem ser cancelados por esta operação';
  END IF;

  INSERT INTO public.order_operations (
    operation_type,
    operation_key,
    order_type,
    order_id,
    status,
    requested_by,
    reason,
    payload,
    result
  )
  VALUES (
    'cancel_order',
    'full',
    p_order_type,
    p_order_id,
    CASE WHEN v_payment_status = 'cancelled' THEN 'completed' ELSE 'prepared' END,
    p_actor_id,
    trim(p_reason),
    jsonb_build_object(
      'payment_status', v_payment_status,
      'asaas_charge_id', v_charge_id,
      'order_number', v_order_number
    ),
    CASE WHEN v_payment_status = 'cancelled' THEN
      jsonb_build_object(
        'order_id', p_order_id,
        'order_type', p_order_type,
        'payment_status', 'cancelled',
        'already_cancelled', true
      )
    ELSE NULL END
  )
  ON CONFLICT (operation_type, order_type, order_id, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'cancel_order'
    AND operation_key = 'full'
    AND order_type = p_order_type
    AND order_id = p_order_id;

  -- A legacy path or a concurrent operator may already have cancelled the
  -- order. Close a previously prepared operation without touching Asaas again.
  IF v_payment_status = 'cancelled' AND v_operation.status <> 'completed' THEN
    UPDATE public.order_operations
    SET status = 'completed',
        result = jsonb_build_object(
          'operation_id', v_operation.id,
          'order_id', v_operation.order_id,
          'order_type', v_operation.order_type,
          'payment_status', 'cancelled',
          'already_cancelled', true
        ),
        updated_at = now()
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
  END IF;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'reason', v_operation.reason,
    'payment_status', v_operation.payload->>'payment_status',
    'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
    'result', v_operation.result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_order_cancellation(
  p_operation_id UUID,
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
  v_expected_charge_id TEXT;
  v_coupon_uses INTEGER := 0;
  v_manual_payments INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  -- Read the operation first without a row lock so every mutation acquires
  -- locks in the same order: order row, then operation row.
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'cancel_order';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação não encontrada';
  END IF;

  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');

  IF v_operation.order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id
      INTO v_payment_status, v_charge_id
    FROM public.presale_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id
      INTO v_payment_status, v_charge_id
    FROM public.stock_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'cancel_order'
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

  IF v_payment_status = 'cancelled' THEN
    v_result := jsonb_build_object(
      'operation_id', v_operation.id,
      'order_id', v_operation.order_id,
      'order_type', v_operation.order_type,
      'payment_status', 'cancelled',
      'already_cancelled', true
    );

    UPDATE public.order_operations
    SET status = 'completed',
        external_result = COALESCE(p_external_result, '{}'::jsonb),
        result = v_result,
        updated_at = now()
    WHERE id = v_operation.id;

    RETURN v_result;
  END IF;

  IF v_payment_status IS NULL
     OR v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent') THEN
    v_error := 'O estado do pagamento mudou durante o cancelamento';
  ELSIF v_charge_id IS DISTINCT FROM v_expected_charge_id THEN
    v_error := 'A cobrança vinculada ao pedido mudou durante o cancelamento';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        external_result = COALESCE(p_external_result, '{}'::jsonb),
        last_error = v_error,
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
    SET payment_status = 'cancelled',
        cancellation_reason = v_operation.reason,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        external_payment_link = NULL,
        due_date = NULL,
        payment_message_sent_at = NULL,
        updated_date = now()
    WHERE id = v_operation.order_id;
  ELSE
    UPDATE public.stock_orders
    SET payment_status = 'cancelled',
        cancellation_reason = v_operation.reason,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        external_payment_link = NULL,
        due_date = NULL,
        payment_message_sent_at = NULL,
        updated_date = now()
    WHERE id = v_operation.order_id;
  END IF;

  DELETE FROM public.asaas_payments
  WHERE order_id = v_operation.order_id
    AND order_type = v_operation.order_type
    AND source = 'manual';
  GET DIAGNOSTICS v_manual_payments = ROW_COUNT;

  UPDATE public.coupon_uses
  SET cancelled = true
  WHERE order_id = v_operation.order_id
    AND order_type = v_operation.order_type
    AND cancelled IS NOT TRUE;
  GET DIAGNOSTICS v_coupon_uses = ROW_COUNT;

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
    'cancelled',
    v_operation.reason,
    jsonb_build_object(
      'action', 'order_cancelled',
      'operation_id', v_operation.id,
      'external_result', COALESCE(p_external_result, '{}'::jsonb),
      'manual_payments_removed', v_manual_payments,
      'coupon_uses_cancelled', v_coupon_uses
    ),
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', 'cancelled',
    'manual_payments_removed', v_manual_payments,
    'coupon_uses_cancelled', v_coupon_uses
  );

  UPDATE public.order_operations
  SET status = 'completed',
      external_result = COALESCE(p_external_result, '{}'::jsonb),
      result = v_result,
      last_error = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_order_cancellation(TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_cancellation(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_order_cancellation(TEXT, UUID, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_cancellation(UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.prepare_order_cancellation(TEXT, UUID, TEXT, UUID) IS
  'Creates or resumes the idempotent server-side operation for an unpaid order cancellation.';
COMMENT ON FUNCTION public.complete_order_cancellation(UUID, JSONB) IS
  'Atomically cancels an unpaid order and its local side effects after the external charge step.';
