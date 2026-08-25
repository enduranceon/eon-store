-- Cancelar um pedido zerava a cobranca mas deixava a entrega como estava, entao
-- o pedido cancelado continuava aparecendo como "aguardando separacao" nas
-- listas operacionais. Em 18/ago/2026 havia 7 pedidos nesse estado.
--
-- Passa a cancelar tambem a entrega, no MESMO UPDATE que ja muda o pagamento
-- (importante: os gatilhos de estoque e de Asaas reagem a payment_status, entao
-- nao ha disparo extra nem devolucao de estoque em dobro).
--
-- Guarda: pedido ja ENTREGUE mantem a entrega como esta. A peca saiu de verdade;
-- apagar esse fato falsearia o historico. Cancelar o pagamento de um pedido
-- entregue continua possivel, so nao mexe na entrega.
--
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
  v_items JSONB := '[]'::jsonb;
  v_delivery_status TEXT;
  v_coupon_uses INTEGER := 0;
  v_manual_payments INTEGER := 0;
  v_stock_restocked INTEGER := 0;
  v_item JSONB;
  v_product_id UUID;
  v_quantity INTEGER;
  v_result JSONB;
  v_error TEXT;
BEGIN
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
    SELECT payment_status, asaas_charge_id, COALESCE(items, '[]'::jsonb), delivery_status
      INTO v_payment_status, v_charge_id, v_items, v_delivery_status
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

  IF v_error IS NULL
     AND v_operation.order_type = 'stock'
     AND COALESCE(v_delivery_status, '') <> 'delivered' THEN
    FOR v_item IN
      SELECT value
      FROM jsonb_array_elements(v_items)
      WHERE COALESCE(value->>'cancelled', 'false') <> 'true'
        AND COALESCE(value->>'stock_reserved', 'false') = 'true'
    LOOP
      IF COALESCE(v_item->>'product_id', '') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
         OR COALESCE(v_item->>'quantity', '') !~ '^[1-9][0-9]*$' THEN
        v_error := 'Item de estoque inválido para reposição';
        EXIT;
      END IF;

      v_product_id := (v_item->>'product_id')::UUID;
      PERFORM 1
      FROM public.stock_products
      WHERE id = v_product_id
      FOR UPDATE;

      IF NOT FOUND THEN
        v_error := 'Produto de estoque não encontrado para reposição';
        EXIT;
      END IF;
    END LOOP;
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

  IF v_operation.order_type = 'stock'
     AND COALESCE(v_delivery_status, '') <> 'delivered' THEN
    FOR v_item IN
      SELECT value
      FROM jsonb_array_elements(v_items)
      WHERE COALESCE(value->>'cancelled', 'false') <> 'true'
        AND COALESCE(value->>'stock_reserved', 'false') = 'true'
    LOOP
      v_product_id := (v_item->>'product_id')::UUID;
      v_quantity := (v_item->>'quantity')::INTEGER;

      PERFORM eon_private.restock_stock_product(
        v_product_id,
        v_quantity,
        NULLIF(trim(COALESCE(v_item->>'variation', '')), '')
      );

      v_stock_restocked := v_stock_restocked + v_quantity;
    END LOOP;
  END IF;

  IF v_operation.order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET payment_status = 'cancelled',
        delivery_status = CASE
          WHEN COALESCE(delivery_status, '') = 'delivered' THEN delivery_status
          ELSE 'cancelled'
        END,
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
        delivery_status = CASE
          WHEN COALESCE(delivery_status, '') = 'delivered' THEN delivery_status
          ELSE 'cancelled'
        END,
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
      'coupon_uses_cancelled', v_coupon_uses,
      'stock_restocked', v_stock_restocked,
      'delivery_cancelled', COALESCE(v_delivery_status, '') <> 'delivered'
    ),
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', 'cancelled',
    'manual_payments_removed', v_manual_payments,
    'coupon_uses_cancelled', v_coupon_uses,
    'stock_restocked', v_stock_restocked
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
