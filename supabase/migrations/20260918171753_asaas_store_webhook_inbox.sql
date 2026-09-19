BEGIN;

CREATE TABLE public.asaas_store_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  payment_id text,
  event_created_at timestamp,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'ignored', 'reconciliation_required')),
  reason text,
  order_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX asaas_store_webhook_payment_time_idx
  ON public.asaas_store_webhook_events(payment_id, event_created_at DESC)
  WHERE status = 'processed';
ALTER TABLE public.asaas_store_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_browser_access ON public.asaas_store_webhook_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.asaas_store_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.asaas_store_webhook_events TO service_role;

-- One transaction owns the event, order and financial projection. No HTTP
-- calls or stock/coupon mutations are inferred from payment notifications.
CREATE FUNCTION public.process_asaas_store_webhook(p_event jsonb, p_allowed_order_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_event public.asaas_store_webhook_events%ROWTYPE;
  v_order public.stock_orders%ROWTYPE;
  v_cached public.asaas_payments%ROWTYPE;
  v_primary public.asaas_payments%ROWTYPE;
  v_payment jsonb := p_event->'payment';
  v_order_id uuid;
  v_event_time timestamp;
  v_status text := 'ignored';
  v_reason text := 'outside_store_pilot';
  v_provider_status text;
  v_next_status text;
  v_paid_date date;
  v_terminal jsonb;
  v_operation_status text;
  v_group_id text;
  v_installments integer;
  v_group_valid boolean;
BEGIN
  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object'
    OR NULLIF(btrim(p_event->>'id'), '') IS NULL
    OR length(p_event->>'id') > 200
    OR NULLIF(btrim(p_event->>'event'), '') IS NULL
    OR length(p_event->>'event') > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid Asaas event';
  END IF;
  IF p_event->>'event' LIKE 'PAYMENT\_%' ESCAPE '\'
    AND (jsonb_typeof(v_payment) IS DISTINCT FROM 'object'
      OR NULLIF(btrim(v_payment->>'id'), '') IS NULL
      OR length(v_payment->>'id') > 200) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid Asaas payment';
  END IF;
  -- Keep only reconciliation data, never card numbers, CVV or reusable tokens.
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_payment
  FROM jsonb_each(CASE WHEN jsonb_typeof(v_payment) = 'object' THEN v_payment ELSE '{}'::jsonb END)
  WHERE key = ANY(ARRAY['id', 'customer', 'billingType', 'status', 'value', 'netValue',
    'dueDate', 'paymentDate', 'clientPaymentDate', 'confirmedDate', 'creditDate',
    'estimatedCreditDate', 'externalReference', 'installment', 'installmentNumber',
    'subscription', 'deleted']);
  p_event := jsonb_build_object('id', p_event->'id', 'event', p_event->'event',
    'dateCreated', p_event->'dateCreated', 'payment', v_payment);
  INSERT INTO public.asaas_store_webhook_events(event_id, event_type, payment_id, payload)
  VALUES (p_event->>'id', p_event->>'event', v_payment->>'id', p_event)
  ON CONFLICT (event_id) DO NOTHING;
  SELECT * INTO STRICT v_event FROM public.asaas_store_webhook_events
  WHERE event_id = p_event->>'id' FOR UPDATE;
  IF v_event.payload IS DISTINCT FROM p_event THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Conflicting Asaas event ID';
  END IF;
  IF v_event.status <> 'pending' THEN
    RETURN jsonb_build_object('status', v_event.status, 'duplicate', true);
  END IF;

  -- Resolve only immutable local links, never a customer name/CPF or an
  -- arbitrary external reference. Early webhooks wait for charge completion.
  SELECT id INTO v_order_id FROM public.stock_orders
  WHERE asaas_charge_id = v_event.payment_id AND id = ANY(p_allowed_order_ids);
  IF v_order_id IS NULL THEN
    SELECT orders.id INTO v_order_id FROM public.stock_orders orders
    JOIN public.asaas_payments payment ON payment.order_id = orders.id
    WHERE orders.id = ANY(p_allowed_order_ids) AND payment.order_type = 'stock'
      AND orders.asaas_charge_id IS NOT NULL
      AND payment.source = 'asaas' AND payment.asaas_payment_id = v_event.payment_id;
  END IF;
  IF v_order_id IS NULL THEN
    -- Canonical cancellation may already have cleared the order's charge ID.
    IF v_event.event_type IN ('PAYMENT_DELETED', 'PAYMENT_REFUNDED') THEN
      SELECT operation.order_id INTO v_order_id FROM public.order_operations operation
      WHERE operation.order_type = 'stock'
        AND operation.order_id = ANY(p_allowed_order_ids)
        AND operation.payload->>'asaas_charge_id' = v_event.payment_id
        AND operation.operation_type IN ('cancel_order', 'cancel_charge', 'refund_order', 'cancel_item')
      LIMIT 1;
      IF v_order_id IS NOT NULL THEN
        v_terminal := public.reconcile_asaas_terminal_order_event(
          v_event.event_type, v_event.payment_id, v_payment);
        v_status := CASE WHEN v_terminal->>'status' IN ('handled', 'already_completed')
          THEN 'processed' ELSE 'reconciliation_required' END;
        v_reason := 'terminal_' || COALESCE(v_terminal->>'status', 'unknown');
      END IF;
    END IF;
    IF v_order_id IS NULL THEN
      SELECT operation.order_id, operation.status INTO v_order_id, v_operation_status
      FROM public.order_operations operation
      WHERE operation.order_type = 'stock'
        AND operation.operation_type = 'create_charge'
        AND operation.order_id = ANY(p_allowed_order_ids)
        AND operation.payload->>'payment_external_reference' = v_payment->>'externalReference'
      LIMIT 1;
      IF v_order_id IS NOT NULL THEN
        v_status := CASE WHEN v_operation_status = 'prepared' THEN 'pending'
          ELSE 'reconciliation_required' END;
        v_reason := CASE WHEN v_operation_status = 'prepared' THEN 'charge_link_pending'
          ELSE 'charge_link_changed' END;
      END IF;
    END IF;
  ELSIF v_event.event_type IN ('PAYMENT_DELETED', 'PAYMENT_REFUNDED') THEN
    -- Let the canonical operation acquire its own locks. Terminal completion
    -- may legitimately have removed the payment cache already.
    IF EXISTS (SELECT 1 FROM public.asaas_payments
      WHERE asaas_payment_id = v_event.payment_id AND installment_group_id IS NOT NULL) THEN
      v_status := 'reconciliation_required';
      v_reason := 'installment_terminal_requires_reconciliation';
    ELSE
      v_terminal := public.reconcile_asaas_terminal_order_event(
        v_event.event_type, v_event.payment_id, v_payment);
      v_status := CASE WHEN v_terminal->>'status' IN ('handled', 'already_completed')
        THEN 'processed' ELSE 'reconciliation_required' END;
      v_reason := 'terminal_' || COALESCE(v_terminal->>'status', 'unknown');
    END IF;
  ELSE
    -- Same order-before-cache lock order as the charge completion RPC.
    SELECT * INTO STRICT v_order FROM public.stock_orders WHERE id = v_order_id FOR UPDATE;
    PERFORM 1 FROM public.asaas_payments WHERE order_type = 'stock' AND order_id = v_order_id
    ORDER BY asaas_payment_id FOR UPDATE;
    SELECT * INTO v_cached FROM public.asaas_payments
    WHERE asaas_payment_id = v_event.payment_id FOR UPDATE;
    SELECT * INTO v_primary FROM public.asaas_payments
    WHERE asaas_payment_id = v_order.asaas_charge_id;
    v_group_id := v_primary.installment_group_id;
    v_installments := COALESCE(v_primary.total_installments, 1);
    v_group_valid := v_group_id IS NULL AND v_installments = 1;
    IF v_group_id IS NOT NULL THEN
      SELECT v_installments >= 2 AND count(*) = v_installments
        AND count(DISTINCT installment_number) = v_installments
        AND min(installment_number) = 1 AND max(installment_number) = v_installments
        AND sum(value) = round(v_order.total_value, 2)
        AND bool_and(COALESCE(source = 'asaas' AND order_type = 'stock'
          AND order_id = v_order.id AND billing_type = 'CREDIT_CARD'
          AND total_installments = v_installments AND value > 0
          AND asaas_customer_id = v_order.asaas_customer_id
          AND external_reference = v_primary.external_reference, false))
      INTO v_group_valid FROM public.asaas_payments WHERE installment_group_id = v_group_id;
    END IF;
    v_provider_status := v_payment->>'status';
    v_status := 'reconciliation_required';
    v_reason := 'payment_identity_mismatch';

    IF v_order.asaas_charge_id IS DISTINCT FROM v_event.payment_id
      AND (v_group_id IS NULL OR v_cached.installment_group_id IS DISTINCT FROM v_group_id) THEN
      v_reason := 'charge_changed';
    ELSIF (SELECT count(*) FROM public.stock_orders
      WHERE asaas_charge_id = v_order.asaas_charge_id) > 1 THEN
      v_reason := 'ambiguous_charge_link';
    ELSIF v_order.manual_payment OR EXISTS (
      SELECT 1 FROM public.asaas_payments
      WHERE order_type = 'stock' AND order_id = v_order.id AND source = 'manual'
    ) THEN
      v_reason := 'manual_payment_preserved';
    ELSIF EXISTS (
      SELECT 1 FROM public.asaas_payments
      WHERE order_type = 'stock' AND order_id = v_order.id
        AND asaas_payment_id <> v_event.payment_id
        AND (v_group_id IS NULL OR installment_group_id IS DISTINCT FROM v_group_id)
        AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
    ) THEN
      v_reason := 'other_receipt_preserved';
    ELSIF v_cached.asaas_payment_id IS NULL THEN
      v_status := 'pending';
      v_reason := 'charge_cache_pending';
    ELSIF v_cached.source = 'asaas' AND v_cached.order_type = 'stock'
      AND v_cached.order_id = v_order.id
      AND v_cached.asaas_customer_id = v_payment->>'customer'
      AND v_order.asaas_customer_id = v_payment->>'customer'
      AND v_cached.external_reference = v_payment->>'externalReference'
      AND v_cached.billing_type = v_payment->>'billingType' THEN

      IF NULLIF(v_payment->>'subscription', '') IS NOT NULL
        OR v_payment->>'billingType' NOT IN ('PIX', 'CREDIT_CARD')
        OR v_installments NOT BETWEEN 1 AND 12
        OR (v_payment->>'billingType' = 'PIX' AND v_group_id IS NOT NULL) THEN
        v_reason := 'outside_store_payment_pilot';
      ELSIF NOT COALESCE(v_group_valid, false)
        OR NULLIF(v_payment->>'installment', '') IS DISTINCT FROM v_group_id
        OR (v_payment->>'installmentNumber' IS NOT NULL AND
          (v_payment->>'installmentNumber')::numeric IS DISTINCT FROM v_cached.installment_number::numeric) THEN
        v_reason := 'installment_group_mismatch';
      ELSIF jsonb_typeof(v_payment->'value') IS DISTINCT FROM 'number'
        OR (v_payment->>'value')::numeric <= 0
        OR (v_payment->>'value')::numeric IS DISTINCT FROM v_cached.value
        OR (v_group_id IS NULL AND (v_payment->>'value')::numeric IS DISTINCT FROM round(v_order.total_value, 2)) THEN
        v_reason := 'payment_amount_mismatch';
      ELSE
        BEGIN
          v_event_time := NULLIF(p_event->>'dateCreated', '')::timestamp;
          v_paid_date := COALESCE(NULLIF(v_payment->>'paymentDate', '')::date,
            NULLIF(v_payment->>'clientPaymentDate', '')::date,
            CASE WHEN v_payment->>'billingType' = 'CREDIT_CARD'
              THEN NULLIF(v_payment->>'confirmedDate', '')::date END);
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          v_event_time := NULL;
        END;
        IF v_event_time IS NULL THEN
          v_reason := 'invalid_event_date';
        ELSIF EXISTS (
          SELECT 1 FROM public.asaas_store_webhook_events previous
          WHERE previous.payment_id = v_event.payment_id
            AND previous.status = 'processed'
            AND previous.event_created_at > v_event_time
        ) THEN
          v_status := 'ignored';
          v_reason := 'older_event';
        ELSIF v_order.payment_status IN ('cancelled', 'refunded', 'voided')
          OR v_cached.status IN ('REFUNDED', 'CANCELLED', 'CANCELED') THEN
          v_reason := 'terminal_payment_preserved';
        ELSE
          v_next_status := CASE
            WHEN v_event.event_type IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')
              AND v_provider_status IN ('RECEIVED', 'CONFIRMED') THEN 'paid'
            WHEN v_event.event_type = 'PAYMENT_OVERDUE' AND v_provider_status = 'OVERDUE' THEN 'overdue'
            WHEN v_event.event_type IN ('PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_RESTORED')
              AND v_provider_status = 'PENDING' THEN 'charge_sent'
            ELSE NULL END;
          IF v_next_status IS NULL THEN
            v_reason := 'unsupported_event_or_status';
          ELSIF (v_order.payment_status = 'paid'
              OR v_cached.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'))
            AND v_next_status <> 'paid' THEN
            v_status := 'ignored';
            v_reason := 'paid_payment_preserved';
          ELSIF v_cached.status = 'RECEIVED' AND v_provider_status = 'CONFIRMED' THEN
            v_status := 'ignored';
            v_reason := 'received_payment_preserved';
          ELSIF v_next_status = 'paid' AND v_paid_date IS NULL THEN
            v_reason := 'missing_payment_date';
          ELSE
            UPDATE public.asaas_payments SET
              status = v_provider_status,
              net_value = COALESCE((v_payment->>'netValue')::numeric, net_value),
              due_date = COALESCE((v_payment->>'dueDate')::date, due_date),
              payment_date = COALESCE(v_paid_date, payment_date),
              credit_date = COALESCE((v_payment->>'creditDate')::date,
                (v_payment->>'estimatedCreditDate')::date, credit_date),
              raw = v_payment,
              last_synced_at = now()
            WHERE id = v_cached.id;
            IF v_group_id IS NOT NULL THEN
              SELECT CASE
                WHEN bool_and(status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')) THEN 'paid'
                WHEN bool_or(status = 'OVERDUE') THEN 'overdue'
                ELSE 'charge_sent' END,
                min(payment_date)
              INTO v_next_status, v_paid_date
              FROM public.asaas_payments WHERE installment_group_id = v_group_id;
            END IF;
            UPDATE public.stock_orders SET
              payment_status = v_next_status,
              payment_date = CASE WHEN v_next_status = 'paid'
                THEN COALESCE(payment_date, v_paid_date) ELSE payment_date END,
              payment_method = CASE WHEN v_next_status <> 'paid' THEN payment_method
                WHEN v_cached.billing_type = 'CREDIT_CARD' THEN 'card_' || v_installments || 'x'
                ELSE 'pix' END,
              due_date = COALESCE((SELECT due_date FROM public.asaas_payments
                WHERE asaas_payment_id = v_order.asaas_charge_id), due_date),
              updated_date = now()
            WHERE id = v_order.id;
            IF v_order.payment_status IS DISTINCT FROM v_next_status THEN
              INSERT INTO public.sales_status_events(order_type, order_id, previous_status,
                new_status, reason, metadata, actor_id)
              VALUES ('stock', v_order.id, v_order.payment_status, v_next_status,
                'asaas_store_webhook', jsonb_build_object('asaas_event_id', v_event.event_id,
                  'asaas_payment_id', v_event.payment_id), NULL);
            END IF;
            v_status := 'processed';
            v_reason := 'payment_updated';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  UPDATE public.asaas_store_webhook_events SET status = v_status, reason = v_reason,
    order_id = v_order_id, event_created_at = v_event_time,
    processed_at = CASE WHEN v_status = 'pending' THEN NULL ELSE now() END
  WHERE event_id = v_event.event_id;
  RETURN jsonb_build_object('status', v_status, 'reason', v_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.process_asaas_store_webhook(jsonb, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_asaas_store_webhook(jsonb, uuid[]) TO service_role;

COMMIT;
