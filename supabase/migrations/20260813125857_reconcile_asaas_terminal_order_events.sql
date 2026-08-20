BEGIN;

-- Terminal Asaas events must be completed through the operation ledger.  A
-- direct webhook update can otherwise win the race against the local
-- cancellation/refund completion and make the existing idempotency shortcut
-- skip the stock/coupon side effects.
CREATE OR REPLACE FUNCTION public.reconcile_asaas_terminal_order_event(
  p_event TEXT,
  p_charge_id TEXT,
  p_payment JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_charge_id TEXT;
  v_operation public.order_operations%ROWTYPE;
  v_prepared_count INTEGER;
  v_unmatched_count INTEGER;
  v_unmatched_order_id UUID;
  v_unmatched_order_type TEXT;
  v_unmatched_payment_status TEXT;
  v_result JSONB;
  v_external_result JSONB;
BEGIN
  IF p_event NOT IN ('PAYMENT_DELETED', 'PAYMENT_REFUNDED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Evento terminal do Asaas inválido';
  END IF;

  v_charge_id := NULLIF(pg_catalog.btrim(p_charge_id), '');
  IF v_charge_id IS NULL OR char_length(v_charge_id) > 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Identificador de cobrança inválido';
  END IF;
  IF jsonb_typeof(p_payment) IS DISTINCT FROM 'object'
     OR p_payment->>'id' IS DISTINCT FROM v_charge_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Pagamento do webhook não pertence à cobrança informada';
  END IF;

  -- Do not lock the candidate here. The existing completion flows use more
  -- than one lock order, so this dispatcher only identifies the operation and
  -- lets its canonical completion function acquire the transactional locks.
  SELECT count(*)::INTEGER
    INTO v_prepared_count
  FROM public.order_operations operation
  WHERE operation.status = 'prepared'
    AND NULLIF(operation.payload->>'asaas_charge_id', '') = v_charge_id
    AND (
      (
        p_event = 'PAYMENT_DELETED'
        AND operation.operation_type IN ('cancel_order', 'cancel_charge')
      )
      OR (
        p_event = 'PAYMENT_REFUNDED'
        AND (
          operation.operation_type = 'refund_order'
          OR (
            operation.operation_type = 'cancel_item'
            AND COALESCE(operation.payload->>'requires_external_refund', 'false') = 'true'
          )
        )
      )
    );

  IF v_prepared_count > 1 THEN
    RETURN jsonb_build_object(
      'status', 'reconciliation_required',
      'error', 'Há mais de uma operação preparada para a mesma cobrança do Asaas'
    );
  END IF;

  IF v_prepared_count = 0 THEN
    SELECT *
      INTO v_operation
    FROM public.order_operations operation
    WHERE operation.status = 'completed'
      AND NULLIF(operation.payload->>'asaas_charge_id', '') = v_charge_id
      AND (
        (
          p_event = 'PAYMENT_DELETED'
          AND operation.operation_type IN ('cancel_order', 'cancel_charge')
        )
        OR (
          p_event = 'PAYMENT_REFUNDED'
          AND (
            operation.operation_type = 'refund_order'
            OR (
              operation.operation_type = 'cancel_item'
              AND COALESCE(operation.payload->>'requires_external_refund', 'false') = 'true'
            )
          )
        )
      )
    ORDER BY operation.updated_at DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'already_completed',
        'operation_id', v_operation.id,
        'operation_type', v_operation.operation_type,
        'order_id', v_operation.order_id,
        'order_type', v_operation.order_type
      );
    END IF;

    SELECT *
      INTO v_operation
    FROM public.order_operations operation
    WHERE operation.status IN ('reconciliation_required', 'failed')
      AND NULLIF(operation.payload->>'asaas_charge_id', '') = v_charge_id
      AND (
        (
          p_event = 'PAYMENT_DELETED'
          AND operation.operation_type IN ('cancel_order', 'cancel_charge')
        )
        OR (
          p_event = 'PAYMENT_REFUNDED'
          AND (
            operation.operation_type = 'refund_order'
            OR (
              operation.operation_type = 'cancel_item'
              AND COALESCE(operation.payload->>'requires_external_refund', 'false') = 'true'
            )
          )
        )
      )
    ORDER BY operation.updated_at DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'reconciliation_required',
        'operation_id', v_operation.id,
        'operation_type', v_operation.operation_type,
        'order_id', v_operation.order_id,
        'order_type', v_operation.order_type,
        'error', COALESCE(v_operation.last_error, 'A operação já exige conferência manual')
      );
    END IF;

    -- The webhook is deliberately not allowed to infer a full product order
    -- cancellation/refund from a provider event without its immutable local
    -- operation snapshot. Preserve the cache link and emit an auditable
    -- reconciliation marker instead of changing sale, stock, or coupon data.
    SELECT count(*)::INTEGER
      INTO v_unmatched_count
    FROM (
      SELECT id, payment_status
      FROM public.presale_orders
      WHERE asaas_charge_id = v_charge_id
      UNION ALL
      SELECT id, payment_status
      FROM public.stock_orders
      WHERE asaas_charge_id = v_charge_id
    ) product_order;

    IF v_unmatched_count > 1 THEN
      RETURN jsonb_build_object(
        'status', 'reconciliation_required',
        'error', 'A cobrança do Asaas está vinculada a mais de um pedido de produto'
      );
    END IF;

    IF v_unmatched_count = 1 THEN
      SELECT product_order.id, product_order.order_type, product_order.payment_status
        INTO v_unmatched_order_id, v_unmatched_order_type, v_unmatched_payment_status
      FROM (
        SELECT id, 'presale'::TEXT AS order_type, payment_status
        FROM public.presale_orders
        WHERE asaas_charge_id = v_charge_id
        UNION ALL
        SELECT id, 'stock'::TEXT AS order_type, payment_status
        FROM public.stock_orders
        WHERE asaas_charge_id = v_charge_id
      ) product_order;

      -- Serializing by provider charge keeps Asaas retries from creating a
      -- noisy sequence of identical manual-reconciliation markers.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('asaas-terminal:' || v_charge_id, 0)
      );

      INSERT INTO public.sales_status_events (
        order_type, order_id, previous_status, new_status, reason, metadata, actor_id
      )
      SELECT
        v_unmatched_order_type,
        v_unmatched_order_id,
        v_unmatched_payment_status,
        COALESCE(v_unmatched_payment_status, 'unknown'),
        'Evento terminal do Asaas sem operação local correspondente',
        jsonb_build_object(
          'action', 'asaas_terminal_event_unmatched',
          'asaas_event', p_event,
          'asaas_charge_id', v_charge_id,
          'provider_status', p_payment->>'status',
          'requires_manual_reconciliation', true
        ),
        NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.sales_status_events existing_event
        WHERE existing_event.order_type = v_unmatched_order_type
          AND existing_event.order_id = v_unmatched_order_id
          AND existing_event.metadata->>'action' = 'asaas_terminal_event_unmatched'
          AND existing_event.metadata->>'asaas_event' = p_event
          AND existing_event.metadata->>'asaas_charge_id' = v_charge_id
      );

      RETURN jsonb_build_object(
        'status', 'unmatched',
        'order_id', v_unmatched_order_id,
        'order_type', v_unmatched_order_type,
        'requires_manual_reconciliation', true
      );
    END IF;

    RETURN jsonb_build_object('status', 'unmatched');
  END IF;

  SELECT *
    INTO v_operation
  FROM public.order_operations operation
  WHERE operation.status = 'prepared'
    AND NULLIF(operation.payload->>'asaas_charge_id', '') = v_charge_id
    AND (
      (
        p_event = 'PAYMENT_DELETED'
        AND operation.operation_type IN ('cancel_order', 'cancel_charge')
      )
      OR (
        p_event = 'PAYMENT_REFUNDED'
        AND (
          operation.operation_type = 'refund_order'
          OR (
            operation.operation_type = 'cancel_item'
            AND COALESCE(operation.payload->>'requires_external_refund', 'false') = 'true'
          )
        )
      )
    )
  ORDER BY operation.created_at
  LIMIT 1;

  -- A simultaneous API completion may finish after the count above and before
  -- this read. Treat that normal race as an idempotent replay rather than
  -- returning a transient 500 to the provider.
  IF NOT FOUND THEN
    SELECT *
      INTO v_operation
    FROM public.order_operations operation
    WHERE operation.status = 'completed'
      AND NULLIF(operation.payload->>'asaas_charge_id', '') = v_charge_id
      AND (
        (
          p_event = 'PAYMENT_DELETED'
          AND operation.operation_type IN ('cancel_order', 'cancel_charge')
        )
        OR (
          p_event = 'PAYMENT_REFUNDED'
          AND (
            operation.operation_type = 'refund_order'
            OR (
              operation.operation_type = 'cancel_item'
              AND COALESCE(operation.payload->>'requires_external_refund', 'false') = 'true'
            )
          )
        )
      )
    ORDER BY operation.updated_at DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'already_completed',
        'operation_id', v_operation.id,
        'operation_type', v_operation.operation_type,
        'order_id', v_operation.order_id,
        'order_type', v_operation.order_type
      );
    END IF;

    RETURN jsonb_build_object('status', 'unmatched');
  END IF;

  v_external_result := jsonb_build_object(
    'provider', 'asaas',
    'outcome', CASE
      WHEN p_event = 'PAYMENT_DELETED' THEN 'deleted'
      ELSE 'refunded'
    END,
    'payment_id', v_charge_id,
    'event', p_event
  );

  IF v_operation.operation_type = 'cancel_charge' THEN
    IF v_operation.lease_token IS NULL THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          external_result = v_external_result,
          last_error = 'Webhook recebido sem execução ativa de cancelamento de cobrança',
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = v_operation.id
        AND status = 'prepared';

      RETURN jsonb_build_object(
        'status', 'reconciliation_required',
        'operation_id', v_operation.id,
        'operation_type', v_operation.operation_type,
        'order_id', v_operation.order_id,
        'order_type', v_operation.order_type,
        'error', 'Webhook recebido sem execução ativa de cancelamento de cobrança'
      );
    END IF;

    v_result := public.complete_order_charge_cancellation(
      v_operation.id,
      v_operation.lease_token,
      v_external_result
    );
  ELSIF v_operation.operation_type = 'cancel_order' THEN
    -- This is only a recovery bridge for a webhook already in flight during
    -- rollout of the guarded handler. It is conditional on the operation
    -- still being prepared, so it cannot undo a concurrent successful finish.
    IF v_operation.order_type = 'presale' THEN
      UPDATE public.presale_orders order_row
      SET payment_status = v_operation.payload->>'payment_status',
          asaas_charge_id = v_charge_id,
          updated_date = now()
      WHERE order_row.id = v_operation.order_id
        AND order_row.payment_status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM public.order_operations current_operation
          WHERE current_operation.id = v_operation.id
            AND current_operation.status = 'prepared'
        );
    ELSE
      UPDATE public.stock_orders order_row
      SET payment_status = v_operation.payload->>'payment_status',
          asaas_charge_id = v_charge_id,
          updated_date = now()
      WHERE order_row.id = v_operation.order_id
        AND order_row.payment_status = 'cancelled'
        AND EXISTS (
          SELECT 1
          FROM public.order_operations current_operation
          WHERE current_operation.id = v_operation.id
            AND current_operation.status = 'prepared'
        );
    END IF;

    v_result := public.complete_order_cancellation(
      v_operation.id,
      v_external_result
    );
  ELSIF v_operation.operation_type = 'refund_order' THEN
    IF v_operation.order_type = 'presale' THEN
      UPDATE public.presale_orders order_row
      SET payment_status = v_operation.payload->>'payment_status',
          asaas_charge_id = v_charge_id,
          updated_date = now()
      WHERE order_row.id = v_operation.order_id
        AND order_row.payment_status = 'refunded'
        AND EXISTS (
          SELECT 1
          FROM public.order_operations current_operation
          WHERE current_operation.id = v_operation.id
            AND current_operation.status = 'prepared'
        );
    ELSE
      UPDATE public.stock_orders order_row
      SET payment_status = v_operation.payload->>'payment_status',
          asaas_charge_id = v_charge_id,
          updated_date = now()
      WHERE order_row.id = v_operation.order_id
        AND order_row.payment_status = 'refunded'
        AND EXISTS (
          SELECT 1
          FROM public.order_operations current_operation
          WHERE current_operation.id = v_operation.id
            AND current_operation.status = 'prepared'
        );
    END IF;

    v_result := public.complete_order_refund(
      v_operation.id,
      v_external_result
    );
  ELSIF v_operation.operation_type = 'cancel_item' THEN
    IF v_operation.order_type = 'presale' THEN
      UPDATE public.presale_orders order_row
      SET payment_status = v_operation.payload->>'old_payment_status',
          asaas_charge_id = v_charge_id,
          updated_date = now()
      WHERE order_row.id = v_operation.order_id
        AND order_row.payment_status = 'refunded'
        AND EXISTS (
          SELECT 1
          FROM public.order_operations current_operation
          WHERE current_operation.id = v_operation.id
            AND current_operation.status = 'prepared'
        );
    ELSE
      UPDATE public.stock_orders order_row
      SET payment_status = v_operation.payload->>'old_payment_status',
          asaas_charge_id = v_charge_id,
          updated_date = now()
      WHERE order_row.id = v_operation.order_id
        AND order_row.payment_status = 'refunded'
        AND EXISTS (
          SELECT 1
          FROM public.order_operations current_operation
          WHERE current_operation.id = v_operation.id
            AND current_operation.status = 'prepared'
        );
    END IF;

    v_result := public.complete_item_cancellation(
      v_operation.id,
      v_external_result
    );
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Operação incompatível com o evento terminal do Asaas';
  END IF;

  IF v_result->>'status' = 'reconciliation_required' THEN
    RETURN jsonb_build_object(
      'status', 'reconciliation_required',
      'operation_id', v_operation.id,
      'operation_type', v_operation.operation_type,
      'order_id', v_operation.order_id,
      'order_type', v_operation.order_type,
      'error', v_result->>'error'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'handled',
    'operation_id', v_operation.id,
    'operation_type', v_operation.operation_type,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'result', v_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_asaas_terminal_order_event(TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_asaas_terminal_order_event(TEXT, TEXT, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.reconcile_asaas_terminal_order_event(TEXT, TEXT, JSONB) IS
  'Completes prepared product cancellation/refund operations from terminal Asaas webhooks without bypassing stock, coupon, return, or idempotency effects.';

COMMIT;
;
