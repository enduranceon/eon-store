-- Idempotent paid refunds and item cancellation commands.
-- External Asaas calls happen in the Edge Function between prepare/complete;
-- the database functions only hold locks for short local transactions.

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_operation_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_operation_type_check
  CHECK (operation_type IN ('cancel_order', 'refund_order', 'cancel_item'));

-- A refunded/cancelled stock order that was already delivered must wait for a
-- physical return. Non-delivered orders continue to restock automatically.
CREATE OR REPLACE FUNCTION public.sync_stock_on_order_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  item JSONB;
  prod_id UUID;
  required_qty INTEGER;
  current_qty INTEGER;
  is_old_active BOOLEAN;
  is_new_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    is_old_active := false;
    is_new_active := NEW.payment_status IS NULL
                     OR NEW.payment_status NOT IN ('cancelled', 'refunded');
  ELSIF TG_OP = 'UPDATE' THEN
    is_old_active := OLD.payment_status IS NULL
                     OR OLD.payment_status NOT IN ('cancelled', 'refunded');
    is_new_active := NEW.payment_status IS NULL
                     OR NEW.payment_status NOT IN ('cancelled', 'refunded');
  ELSE
    RETURN NEW;
  END IF;

  IF is_old_active = is_new_active OR NEW.items IS NULL THEN
    RETURN NEW;
  END IF;

  IF is_new_active AND NOT is_old_active THEN
    FOR item IN
      SELECT value
      FROM jsonb_array_elements(NEW.items)
      ORDER BY value->>'product_id'
    LOOP
      prod_id := NULLIF(item->>'product_id', '')::UUID;
      required_qty := COALESCE(NULLIF(item->>'quantity', '')::INTEGER, 0);
      IF prod_id IS NOT NULL
         AND required_qty > 0
         AND COALESCE((item->>'cancelled')::BOOLEAN, false) = false THEN
        SELECT quantity INTO current_qty
        FROM public.stock_products
        WHERE id = prod_id
        FOR UPDATE;

        IF current_qty IS NULL THEN
          CONTINUE;
        END IF;
        IF current_qty < required_qty THEN
          RAISE EXCEPTION 'Estoque insuficiente para "%": disponível %, requerido %',
            COALESCE(item->>'product_name', prod_id::TEXT), current_qty, required_qty;
        END IF;

        UPDATE public.stock_products
        SET quantity = quantity - required_qty
        WHERE id = prod_id;
      END IF;
    END LOOP;
  ELSIF is_old_active AND NOT is_new_active THEN
    IF COALESCE(NEW.delivery_status, '') = 'delivered' THEN
      RETURN NEW;
    END IF;

    FOR item IN
      SELECT value
      FROM jsonb_array_elements(NEW.items)
      ORDER BY value->>'product_id'
    LOOP
      prod_id := NULLIF(item->>'product_id', '')::UUID;
      required_qty := COALESCE(NULLIF(item->>'quantity', '')::INTEGER, 0);
      IF prod_id IS NOT NULL
         AND required_qty > 0
         AND COALESCE((item->>'cancelled')::BOOLEAN, false) = false THEN
        UPDATE public.stock_products
        SET quantity = COALESCE(quantity, 0) + required_qty
        WHERE id = prod_id;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_order_refund(
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
  v_total NUMERIC;
  v_items JSONB;
  v_delivery_status TEXT;
  v_operation public.order_operations%ROWTYPE;
BEGIN
  IF p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de pedido inválido';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo de estorno inválido';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, order_number, total_value,
           COALESCE(items, '[]'::jsonb), delivery_status
    INTO v_payment_status, v_charge_id, v_order_number, v_total,
         v_items, v_delivery_status
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, order_number, total_value,
           COALESCE(items, '[]'::jsonb), delivery_status
    INTO v_payment_status, v_charge_id, v_order_number, v_total,
         v_items, v_delivery_status
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF v_payment_status NOT IN ('paid', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente pedidos pagos podem ser estornados';
  END IF;
  IF v_payment_status = 'paid' AND NULLIF(v_charge_id, '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Pedido pago sem cobrança Asaas vinculada';
  END IF;
  IF v_payment_status = 'paid' AND COALESCE(v_total, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Valor de estorno inválido';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_operations
    WHERE order_type = p_order_type
      AND order_id = p_order_id
      AND status IN ('prepared', 'reconciliation_required')
      AND NOT (operation_type = 'refund_order' AND operation_key = 'full')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outra operação financeira pendente para este pedido';
  END IF;

  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, result
  )
  VALUES (
    'refund_order', 'full', p_order_type, p_order_id,
    CASE WHEN v_payment_status = 'refunded' THEN 'completed' ELSE 'prepared' END,
    p_actor_id, trim(p_reason),
    jsonb_build_object(
      'payment_status', v_payment_status,
      'asaas_charge_id', v_charge_id,
      'order_number', v_order_number,
      'refund_value', round(COALESCE(v_total, 0), 2),
      'items', v_items,
      'delivery_status', v_delivery_status
    ),
    CASE WHEN v_payment_status = 'refunded' THEN
      jsonb_build_object(
        'order_id', p_order_id,
        'order_type', p_order_type,
        'payment_status', 'refunded',
        'already_refunded', true
      )
    ELSE NULL END
  )
  ON CONFLICT (operation_type, order_type, order_id, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'refund_order'
    AND operation_key = 'full'
    AND order_type = p_order_type
    AND order_id = p_order_id;

  IF v_payment_status = 'refunded' AND v_operation.status <> 'completed' THEN
    UPDATE public.order_operations
    SET status = 'completed',
        result = jsonb_build_object(
          'operation_id', v_operation.id,
          'order_id', v_operation.order_id,
          'order_type', v_operation.order_type,
          'payment_status', 'refunded',
          'already_refunded', true
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
    'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
    'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
    'refund_marker', 'EON refund ' || v_operation.id::TEXT,
    'external_result', v_operation.external_result,
    'result', v_operation.result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_order_refund(
  p_operation_id UUID,
  p_external_result JSONB
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
  v_total NUMERIC;
  v_items JSONB;
  v_delivery_status TEXT;
  v_order_number TEXT;
  v_customer_name TEXT;
  v_was_delivered BOOLEAN;
  v_active_gross NUMERIC := 0;
  v_active_items INTEGER := 0;
  v_allocated_refund NUMERIC := 0;
  v_item JSONB;
  v_item_index INTEGER;
  v_item_gross NUMERIC;
  v_item_refund NUMERIC;
  v_product_id UUID;
  v_coupon_uses INTEGER := 0;
  v_returns INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id AND operation_type = 'refund_order';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de estorno não encontrada';
  END IF;

  IF v_operation.order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, total_value,
           COALESCE(items, '[]'::jsonb), delivery_status, order_number,
           COALESCE(checkout_name, customer_name)
    INTO v_payment_status, v_charge_id, v_total, v_items,
         v_delivery_status, v_order_number, v_customer_name
    FROM public.presale_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, total_value,
           COALESCE(items, '[]'::jsonb), delivery_status, order_number,
           customer_name
    INTO v_payment_status, v_charge_id, v_total, v_items,
         v_delivery_status, v_order_number, v_customer_name
    FROM public.stock_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id AND operation_type = 'refund_order'
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

  IF p_external_result->>'outcome' NOT IN ('refunded', 'already_refunded') THEN
    v_error := 'O estorno externo não foi confirmado';
  ELSIF v_payment_status = 'refunded' THEN
    v_result := jsonb_build_object(
      'operation_id', v_operation.id,
      'order_id', v_operation.order_id,
      'order_type', v_operation.order_type,
      'payment_status', 'refunded',
      'already_refunded', true
    );
  ELSIF v_payment_status <> 'paid'
        OR v_charge_id IS DISTINCT FROM NULLIF(v_operation.payload->>'asaas_charge_id', '')
        OR round(COALESCE(v_total, 0), 2) IS DISTINCT FROM (v_operation.payload->>'refund_value')::NUMERIC
        OR v_items IS DISTINCT FROM v_operation.payload->'items' THEN
    v_error := 'O pedido mudou durante o estorno';
  END IF;

  IF v_result IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'completed', external_result = p_external_result,
        result = v_result, updated_at = now()
    WHERE id = v_operation.id;
    RETURN v_result;
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required', external_result = p_external_result,
        last_error = v_error, updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', 'reconciliation_required',
      'error', v_error
    );
  END IF;

  v_was_delivered := COALESCE(v_delivery_status, '') = 'delivered';

  IF v_operation.order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET payment_status = 'refunded',
        cancellation_reason = v_operation.reason,
        updated_date = now()
    WHERE id = v_operation.order_id;
  ELSE
    UPDATE public.stock_orders
    SET payment_status = 'refunded',
        cancellation_reason = v_operation.reason,
        updated_date = now()
    WHERE id = v_operation.order_id;
  END IF;

  SELECT COALESCE(sum(
    (COALESCE(NULLIF(value->>'sale_price', '')::NUMERIC, 0)
      + COALESCE(NULLIF(value->>'extras_total', '')::NUMERIC, 0))
    * COALESCE(NULLIF(value->>'quantity', '')::NUMERIC, 0)
  ), 0), count(*)::INTEGER
  INTO v_active_gross, v_active_items
  FROM jsonb_array_elements(v_items)
  WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false;

  FOR v_item, v_item_index IN
    SELECT value, (ordinality - 1)::INTEGER
    FROM jsonb_array_elements(v_items) WITH ORDINALITY
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false
  LOOP
    v_item_gross :=
      (COALESCE(NULLIF(v_item->>'sale_price', '')::NUMERIC, 0)
        + COALESCE(NULLIF(v_item->>'extras_total', '')::NUMERIC, 0))
      * COALESCE(NULLIF(v_item->>'quantity', '')::NUMERIC, 0);
    v_item_refund := CASE
      WHEN v_returns = v_active_items - 1
        THEN (v_operation.payload->>'refund_value')::NUMERIC - v_allocated_refund
      WHEN v_active_gross > 0
        THEN round((v_operation.payload->>'refund_value')::NUMERIC * v_item_gross / v_active_gross, 2)
      ELSE 0
    END;
    v_product_id := CASE
      WHEN COALESCE(v_item->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (v_item->>'product_id')::UUID
      ELSE NULL
    END;

    INSERT INTO public.order_returns (
      order_id, order_type, order_number, customer_name, item_index,
      product_id, product_name, variation, quantity, unit_price,
      refund_value, was_delivered, status, notes
    )
    VALUES (
      v_operation.order_id, v_operation.order_type, v_order_number,
      v_customer_name, v_item_index, v_product_id,
      COALESCE(v_item->>'product_name', 'Item'), NULLIF(v_item->>'variation', ''),
      COALESCE(NULLIF(v_item->>'quantity', '')::INTEGER, 0),
      COALESCE(NULLIF(v_item->>'sale_price', '')::NUMERIC, 0),
      v_item_refund, v_was_delivered,
      CASE WHEN v_was_delivered THEN 'pending_return' ELSE 'completed' END,
      v_operation.reason
    );
    v_allocated_refund := v_allocated_refund + v_item_refund;
    v_returns := v_returns + 1;
  END LOOP;

  UPDATE public.coupon_uses
  SET cancelled = true
  WHERE order_id = v_operation.order_id
    AND order_type = v_operation.order_type
    AND cancelled IS NOT TRUE;
  GET DIAGNOSTICS v_coupon_uses = ROW_COUNT;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    v_operation.order_type, v_operation.order_id, v_payment_status, 'refunded',
    v_operation.reason,
    jsonb_build_object(
      'action', 'refunded',
      'operation_id', v_operation.id,
      'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
      'external_result', p_external_result,
      'returns_created', v_returns,
      'coupon_uses_cancelled', v_coupon_uses
    ),
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', 'refunded',
    'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
    'returns_created', v_returns,
    'awaiting_physical_return', v_was_delivered
  );

  UPDATE public.order_operations
  SET status = 'completed', external_result = p_external_result,
      result = v_result, last_error = NULL, updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_item_cancellation(
  p_order_type TEXT,
  p_order_id UUID,
  p_item_index INTEGER,
  p_was_delivered BOOLEAN,
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
  v_external_link TEXT;
  v_message_sent_at TIMESTAMPTZ;
  v_manual_payment BOOLEAN;
  v_order_number TEXT;
  v_customer_name TEXT;
  v_items JSONB;
  v_item JSONB;
  v_new_items JSONB;
  v_old_total NUMERIC;
  v_old_discount NUMERIC;
  v_old_manual_discount NUMERIC;
  v_old_gross NUMERIC;
  v_new_gross NUMERIC;
  v_new_discount NUMERIC;
  v_new_manual_discount NUMERIC;
  v_new_total NUMERIC;
  v_new_total_cost NUMERIC := 0;
  v_refund_value NUMERIC;
  v_active_items INTEGER;
  v_new_payment_status TEXT;
  v_requires_external BOOLEAN := false;
  v_operation_key TEXT;
  v_operation public.order_operations%ROWTYPE;
BEGIN
  IF p_order_type NOT IN ('presale', 'stock') OR p_item_index IS NULL OR p_item_index < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Pedido ou item inválido';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF char_length(COALESCE(p_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo de cancelamento inválido';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, external_payment_link,
           payment_message_sent_at, manual_payment, order_number,
           COALESCE(checkout_name, customer_name), COALESCE(items, '[]'::jsonb),
           COALESCE(total_value, 0), COALESCE(discount_value, 0),
           COALESCE(manual_discount, 0)
    INTO v_payment_status, v_charge_id, v_external_link, v_message_sent_at,
         v_manual_payment, v_order_number, v_customer_name, v_items,
         v_old_total, v_old_discount, v_old_manual_discount
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, external_payment_link,
           payment_message_sent_at, manual_payment, order_number,
           customer_name, COALESCE(items, '[]'::jsonb),
           COALESCE(total_value, 0), COALESCE(discount_value, 0),
           COALESCE(manual_discount, 0)
    INTO v_payment_status, v_charge_id, v_external_link, v_message_sent_at,
         v_manual_payment, v_order_number, v_customer_name, v_items,
         v_old_total, v_old_discount, v_old_manual_discount
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  v_item := v_items->p_item_index;
  IF v_item IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Item não encontrado no pedido';
  END IF;

  v_operation_key := 'item:' || p_item_index::TEXT;

  IF COALESCE((v_item->>'cancelled')::BOOLEAN, false) THEN
    INSERT INTO public.order_operations (
      operation_type, operation_key, order_type, order_id, status,
      requested_by, reason, payload, result
    )
    VALUES (
      'cancel_item', v_operation_key, p_order_type, p_order_id, 'completed',
      p_actor_id, COALESCE(NULLIF(trim(p_reason), ''), 'Cancelamento de peça'),
      jsonb_build_object('item_index', p_item_index),
      jsonb_build_object(
        'order_id', p_order_id, 'order_type', p_order_type,
        'item_index', p_item_index, 'already_cancelled', true
      )
    )
    ON CONFLICT (operation_type, order_type, order_id, operation_key) DO NOTHING;

    SELECT * INTO v_operation
    FROM public.order_operations
    WHERE operation_type = 'cancel_item' AND operation_key = v_operation_key
      AND order_type = p_order_type AND order_id = p_order_id;

    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'result', v_operation.result
    );
  END IF;

  IF v_payment_status = 'paid' THEN
    IF NULLIF(v_charge_id, '') IS NOT NULL AND NOT COALESCE(v_manual_payment, false) THEN
      v_requires_external := true;
    ELSIF COALESCE(v_manual_payment, false) AND NULLIF(v_charge_id, '') IS NULL THEN
      v_requires_external := false;
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A origem do pagamento precisa de conferência antes do cancelamento do item';
    END IF;
  ELSIF v_payment_status IN ('pending', 'awaiting_charge', 'charge_sent') THEN
    IF NULLIF(v_charge_id, '') IS NOT NULL
       OR NULLIF(v_external_link, '') IS NOT NULL
       OR v_message_sent_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cancele ou reabra a cobrança antes de alterar os itens';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O estado atual do pedido não permite cancelar itens';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_operations
    WHERE order_type = p_order_type AND order_id = p_order_id
      AND status IN ('prepared', 'reconciliation_required')
      AND NOT (operation_type = 'cancel_item' AND operation_key = v_operation_key)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outra operação financeira pendente para este pedido';
  END IF;

  SELECT COALESCE(sum(
    (COALESCE(NULLIF(value->>'sale_price', '')::NUMERIC, 0)
      + COALESCE(NULLIF(value->>'extras_total', '')::NUMERIC, 0))
    * COALESCE(NULLIF(value->>'quantity', '')::NUMERIC, 0)
  ), 0)
  INTO v_old_gross
  FROM jsonb_array_elements(v_items)
  WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false;

  SELECT COALESCE(jsonb_agg(
    CASE WHEN (ordinality - 1)::INTEGER = p_item_index
      THEN value || jsonb_build_object('cancelled', true, 'cancelled_at', now())
      ELSE value END
    ORDER BY ordinality
  ), '[]'::jsonb)
  INTO v_new_items
  FROM jsonb_array_elements(v_items) WITH ORDINALITY;

  SELECT COALESCE(sum(
    (COALESCE(NULLIF(value->>'sale_price', '')::NUMERIC, 0)
      + COALESCE(NULLIF(value->>'extras_total', '')::NUMERIC, 0))
    * COALESCE(NULLIF(value->>'quantity', '')::NUMERIC, 0)
  ), 0), count(*)::INTEGER
  INTO v_new_gross, v_active_items
  FROM jsonb_array_elements(v_new_items)
  WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false;

  v_new_discount := CASE WHEN v_old_discount > 0 AND v_old_gross > 0
    THEN LEAST(round(v_new_gross * (v_old_discount / v_old_gross), 2), v_new_gross)
    ELSE 0 END;
  v_new_manual_discount := LEAST(
    v_old_manual_discount,
    GREATEST(0, v_new_gross - v_new_discount)
  );
  v_new_total := round(GREATEST(0, v_new_gross - v_new_discount - v_new_manual_discount), 2);
  v_refund_value := round(GREATEST(0, v_old_total - v_new_total), 2);
  v_requires_external := v_requires_external AND v_refund_value > 0;

  IF p_order_type = 'presale' THEN
    SELECT COALESCE(sum(
      COALESCE(NULLIF(value->>'cost_price', '')::NUMERIC, 0)
      * COALESCE(NULLIF(value->>'quantity', '')::NUMERIC, 0)
    ), 0)
    INTO v_new_total_cost
    FROM jsonb_array_elements(v_new_items)
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false;
  END IF;

  v_new_payment_status := CASE
    WHEN v_active_items = 0 AND v_payment_status = 'paid' THEN 'refunded'
    WHEN v_active_items = 0 THEN 'cancelled'
    ELSE v_payment_status
  END;

  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload
  )
  VALUES (
    'cancel_item', v_operation_key, p_order_type, p_order_id, 'prepared',
    p_actor_id, COALESCE(NULLIF(trim(p_reason), ''), 'Cancelamento de peça'),
    jsonb_build_object(
      'item_index', p_item_index,
      'item', v_item,
      'old_items', v_items,
      'new_items', v_new_items,
      'old_payment_status', v_payment_status,
      'new_payment_status', v_new_payment_status,
      'asaas_charge_id', v_charge_id,
      'old_total', round(v_old_total, 2),
      'new_total', v_new_total,
      'old_discount', round(v_old_discount, 2),
      'new_discount', v_new_discount,
      'old_manual_discount', round(v_old_manual_discount, 2),
      'new_manual_discount', v_new_manual_discount,
      'new_total_cost', round(v_new_total_cost, 2),
      'refund_value', v_refund_value,
      'requires_external_refund', v_requires_external,
      'was_delivered', COALESCE(p_was_delivered, false),
      'order_number', v_order_number,
      'customer_name', v_customer_name,
      'all_cancelled', v_active_items = 0,
      'manual_payment', COALESCE(v_manual_payment, false)
    )
  )
  ON CONFLICT (operation_type, order_type, order_id, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'cancel_item' AND operation_key = v_operation_key
    AND order_type = p_order_type AND order_id = p_order_id;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
    'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
    'requires_external_refund', (v_operation.payload->>'requires_external_refund')::BOOLEAN,
    'target_payment_status', v_operation.payload->>'new_payment_status',
    'refund_marker', 'EON refund ' || v_operation.id::TEXT,
    'external_result', v_operation.external_result,
    'result', v_operation.result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_operation_external_result(
  p_operation_id UUID,
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
  IF p_external_result->>'outcome' NOT IN ('refunded', 'already_refunded') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type IN ('refund_order', 'cancel_item')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação financeira não encontrada';
  END IF;

  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'external_result', v_operation.external_result
    );
  END IF;

  IF v_operation.external_result IS NOT NULL THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'external_result', v_operation.external_result
    );
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

CREATE OR REPLACE FUNCTION public.complete_item_cancellation(
  p_operation_id UUID,
  p_external_result JSONB DEFAULT '{"provider":"none","outcome":"not_required"}'::jsonb
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
  v_items JSONB;
  v_total NUMERIC;
  v_discount NUMERIC;
  v_manual_discount NUMERIC;
  v_manual_payment BOOLEAN;
  v_product_id UUID;
  v_stock_quantity INTEGER;
  v_installments INTEGER := 0;
  v_total_cents BIGINT;
  v_base_cents BIGINT;
  v_remainder BIGINT;
  v_coupon_uses INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id AND operation_type = 'cancel_item';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de item não encontrada';
  END IF;

  IF v_operation.order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, COALESCE(items, '[]'::jsonb),
           COALESCE(total_value, 0), COALESCE(discount_value, 0),
           COALESCE(manual_discount, 0), manual_payment
    INTO v_payment_status, v_charge_id, v_items, v_total, v_discount,
         v_manual_discount, v_manual_payment
    FROM public.presale_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, COALESCE(items, '[]'::jsonb),
           COALESCE(total_value, 0), COALESCE(discount_value, 0),
           COALESCE(manual_discount, 0), manual_payment
    INTO v_payment_status, v_charge_id, v_items, v_total, v_discount,
         v_manual_discount, v_manual_payment
    FROM public.stock_orders
    WHERE id = v_operation.order_id
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id AND operation_type = 'cancel_item'
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

  IF (v_operation.payload->>'requires_external_refund')::BOOLEAN
     AND p_external_result->>'outcome' NOT IN ('refunded', 'already_refunded') THEN
    v_error := 'O estorno externo do item não foi confirmado';
  ELSIF v_payment_status IS DISTINCT FROM v_operation.payload->>'old_payment_status'
        OR v_charge_id IS DISTINCT FROM NULLIF(v_operation.payload->>'asaas_charge_id', '')
        OR v_items IS DISTINCT FROM v_operation.payload->'old_items'
        OR round(v_total, 2) IS DISTINCT FROM (v_operation.payload->>'old_total')::NUMERIC
        OR round(v_discount, 2) IS DISTINCT FROM (v_operation.payload->>'old_discount')::NUMERIC
        OR round(v_manual_discount, 2) IS DISTINCT FROM (v_operation.payload->>'old_manual_discount')::NUMERIC
        OR COALESCE(v_manual_payment, false) IS DISTINCT FROM (v_operation.payload->>'manual_payment')::BOOLEAN THEN
    v_error := 'O pedido mudou durante o cancelamento do item';
  END IF;

  IF v_error IS NULL
     AND (v_operation.payload->>'manual_payment')::BOOLEAN
     AND v_operation.payload->>'new_payment_status' = 'paid' THEN
    SELECT count(*)::INTEGER INTO v_installments
    FROM public.asaas_payments
    WHERE order_id = v_operation.order_id
      AND order_type = v_operation.order_type
      AND source = 'manual'
      AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');
    IF v_installments = 0 THEN
      v_error := 'As parcelas manuais do pedido não foram encontradas';
    END IF;
  END IF;

  IF v_error IS NULL
     AND v_operation.order_type = 'stock'
     AND NOT (v_operation.payload->>'was_delivered')::BOOLEAN THEN
    v_product_id := CASE
      WHEN COALESCE(v_operation.payload->'item'->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (v_operation.payload->'item'->>'product_id')::UUID
      ELSE NULL
    END;
    IF v_product_id IS NOT NULL THEN
      SELECT quantity INTO v_stock_quantity
      FROM public.stock_products
      WHERE id = v_product_id
      FOR UPDATE;
      IF NOT FOUND THEN
        v_error := 'Produto de estoque não encontrado para reposição';
      END IF;
    END IF;
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required', external_result = p_external_result,
        last_error = v_error, updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', 'reconciliation_required',
      'error', v_error
    );
  END IF;

  IF v_operation.order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET items = v_operation.payload->'new_items',
        total_value = (v_operation.payload->>'new_total')::NUMERIC,
        total_cost = (v_operation.payload->>'new_total_cost')::NUMERIC,
        discount_value = (v_operation.payload->>'new_discount')::NUMERIC,
        manual_discount = (v_operation.payload->>'new_manual_discount')::NUMERIC,
        payment_status = v_operation.payload->>'new_payment_status',
        updated_date = now()
    WHERE id = v_operation.order_id;
  ELSE
    UPDATE public.stock_orders
    SET items = v_operation.payload->'new_items',
        total_value = (v_operation.payload->>'new_total')::NUMERIC,
        discount_value = (v_operation.payload->>'new_discount')::NUMERIC,
        manual_discount = (v_operation.payload->>'new_manual_discount')::NUMERIC,
        payment_status = v_operation.payload->>'new_payment_status',
        updated_date = now()
    WHERE id = v_operation.order_id;
  END IF;

  IF v_installments > 0 THEN
    v_total_cents := round((v_operation.payload->>'new_total')::NUMERIC * 100)::BIGINT;
    v_base_cents := v_total_cents / v_installments;
    v_remainder := v_total_cents % v_installments;

    WITH ranked AS (
      SELECT id,
             row_number() OVER (ORDER BY installment_number NULLS LAST, id) AS rn
      FROM public.asaas_payments
      WHERE order_id = v_operation.order_id
        AND order_type = v_operation.order_type
        AND source = 'manual'
        AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
    )
    UPDATE public.asaas_payments payment
    SET value = (v_base_cents + CASE WHEN ranked.rn <= v_remainder THEN 1 ELSE 0 END)::NUMERIC / 100,
        net_value = (v_base_cents + CASE WHEN ranked.rn <= v_remainder THEN 1 ELSE 0 END)::NUMERIC / 100,
        updated_at = now()
    FROM ranked
    WHERE payment.id = ranked.id;
  END IF;

  IF v_product_id IS NOT NULL THEN
    UPDATE public.stock_products
    SET quantity = COALESCE(quantity, 0)
      + COALESCE(NULLIF(v_operation.payload->'item'->>'quantity', '')::INTEGER, 0),
        updated_date = now()
    WHERE id = v_product_id;
  END IF;

  INSERT INTO public.order_returns (
    order_id, order_type, order_number, customer_name, item_index,
    product_id, product_name, variation, quantity, unit_price,
    refund_value, was_delivered, status, notes
  )
  VALUES (
    v_operation.order_id,
    v_operation.order_type,
    v_operation.payload->>'order_number',
    v_operation.payload->>'customer_name',
    (v_operation.payload->>'item_index')::INTEGER,
    CASE
      WHEN COALESCE(v_operation.payload->'item'->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (v_operation.payload->'item'->>'product_id')::UUID
      ELSE NULL
    END,
    COALESCE(v_operation.payload->'item'->>'product_name', 'Item'),
    NULLIF(v_operation.payload->'item'->>'variation', ''),
    COALESCE(NULLIF(v_operation.payload->'item'->>'quantity', '')::INTEGER, 0),
    COALESCE(NULLIF(v_operation.payload->'item'->>'sale_price', '')::NUMERIC, 0),
    (v_operation.payload->>'refund_value')::NUMERIC,
    (v_operation.payload->>'was_delivered')::BOOLEAN,
    CASE WHEN (v_operation.payload->>'was_delivered')::BOOLEAN
      THEN 'pending_return' ELSE 'completed' END,
    v_operation.reason
  );

  IF (v_operation.payload->>'all_cancelled')::BOOLEAN THEN
    UPDATE public.coupon_uses
    SET cancelled = true
    WHERE order_id = v_operation.order_id
      AND order_type = v_operation.order_type
      AND cancelled IS NOT TRUE;
    GET DIAGNOSTICS v_coupon_uses = ROW_COUNT;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    v_operation.order_type,
    v_operation.order_id,
    v_operation.payload->>'old_payment_status',
    v_operation.payload->>'new_payment_status',
    v_operation.reason,
    jsonb_build_object(
      'action', 'item_cancelled',
      'operation_id', v_operation.id,
      'item_index', (v_operation.payload->>'item_index')::INTEGER,
      'product_name', v_operation.payload->'item'->>'product_name',
      'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
      'external_result', p_external_result,
      'coupon_uses_cancelled', v_coupon_uses
    ),
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'item_index', (v_operation.payload->>'item_index')::INTEGER,
    'payment_status', v_operation.payload->>'new_payment_status',
    'new_total', (v_operation.payload->>'new_total')::NUMERIC,
    'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
    'awaiting_physical_return', (v_operation.payload->>'was_delivered')::BOOLEAN
  );

  UPDATE public.order_operations
  SET status = 'completed', external_result = p_external_result,
      result = v_result, last_error = NULL, updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_order_refund(TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_refund(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_item_cancellation(TEXT, UUID, INTEGER, BOOLEAN, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_item_cancellation(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_operation_external_result(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_order_refund(TEXT, UUID, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_item_cancellation(TEXT, UUID, INTEGER, BOOLEAN, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_item_cancellation(UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_operation_external_result(UUID, JSONB)
  TO service_role;
