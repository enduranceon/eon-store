-- Adjust the active lines of an unpaid stock order in one transaction.
-- Prices and stock quantities never come from the browser: the database
-- validates the catalog, locks inventory, recalculates totals and leaves an
-- audit event. Paid/charged orders keep using the cancellation/refund flow.

CREATE OR REPLACE FUNCTION public.replace_stock_order_items_from_api(
  p_order_id UUID,
  p_items JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.stock_orders%ROWTYPE;
  v_input_item JSONB;
  v_existing_item JSONB;
  v_reserved_item JSONB;
  v_historical_items JSONB := '[]'::JSONB;
  v_new_active_items JSONB := '[]'::JSONB;
  v_new_items JSONB := '[]'::JSONB;
  v_requested_signature JSONB := '[]'::JSONB;
  v_existing_signature JSONB := '[]'::JSONB;
  v_product_id UUID;
  v_variation TEXT;
  v_quantity INTEGER;
  v_sale_price NUMERIC;
  v_cost_price NUMERIC;
  v_subtotal NUMERIC := 0;
  v_old_total NUMERIC := 0;
  v_coupon_discount NUMERIC := 0;
  v_manual_discount NUMERIC := 0;
  v_total NUMERIC := 0;
  v_active_item_count INTEGER := 0;
  v_input_count INTEGER := 0;
  v_distinct_item_count INTEGER := 0;
  v_previous_status TEXT;
  v_product public.stock_products%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 100
     OR pg_column_size(p_items) > 262144 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Itens inválidos';
  END IF;

  FOR v_input_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF jsonb_typeof(v_input_item) <> 'object'
       OR jsonb_typeof(v_input_item->'product_id') <> 'string'
       OR COALESCE(v_input_item->>'product_id', '') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
       OR COALESCE(v_input_item->>'quantity', '') !~ '^[1-9][0-9]*$'
       OR (v_input_item ? 'variation'
           AND jsonb_typeof(v_input_item->'variation') NOT IN ('string', 'null'))
       OR char_length(COALESCE(v_input_item->>'variation', '')) > 150 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Item inválido';
    END IF;

    IF (v_input_item->>'quantity')::INTEGER > 100000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade do item inválida';
    END IF;
  END LOOP;

  SELECT count(*), count(DISTINCT (
    (value->>'product_id') || '|' || COALESCE(NULLIF(value->>'variation', ''), '')
  ))
  INTO v_input_count, v_distinct_item_count
  FROM jsonb_array_elements(p_items);
  IF v_input_count <> v_distinct_item_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O mesmo produto e tamanho aparecem mais de uma vez';
  END IF;

  SELECT * INTO v_order
  FROM public.stock_orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  IF v_order.payment_status NOT IN ('pending', 'awaiting_charge')
     OR COALESCE(v_order.manual_payment, false)
     OR NULLIF(v_order.asaas_charge_id, '') IS NOT NULL
     OR NULLIF(v_order.asaas_payment_link, '') IS NOT NULL
     OR NULLIF(v_order.asaas_pix_copy, '') IS NOT NULL
     OR NULLIF(v_order.external_payment_link, '') IS NOT NULL
     OR v_order.payment_message_sent_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Cancele ou reabra a cobrança antes de ajustar os itens';
  END IF;

  IF COALESCE(v_order.delivery_status, 'awaiting_delivery') IN ('separated', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Os itens só podem ser ajustados antes da separação';
  END IF;

  -- Preserve cancelled lines as history, while only replacing the active cart.
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::JSONB)
  INTO v_historical_items
  FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB)) WITH ORDINALITY
  WHERE COALESCE((value->>'cancelled')::BOOLEAN, false);

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'product_id', value->>'product_id',
      'variation', COALESCE(NULLIF(value->>'variation', ''), ''),
      'quantity', COALESCE((value->>'quantity')::INTEGER, 0)
    )
    ORDER BY value->>'product_id', COALESCE(NULLIF(value->>'variation', ''), '')
  ), '[]'::JSONB), count(*)
  INTO v_existing_signature, v_active_item_count
  FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB))
  WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false;

  IF v_active_item_count < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Este pedido não tem itens ativos para ajustar';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB))
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false
      AND COALESCE((value->>'stock_reserved')::BOOLEAN, false) = false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Este pedido antigo não tem a reserva de estoque por item necessária para ajuste automático';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'product_id', value->>'product_id',
      'variation', COALESCE(NULLIF(value->>'variation', ''), ''),
      'quantity', (value->>'quantity')::INTEGER
    )
    ORDER BY value->>'product_id', COALESCE(NULLIF(value->>'variation', ''), '')
  ), '[]'::JSONB)
  INTO v_requested_signature
  FROM jsonb_array_elements(p_items);

  IF v_existing_signature = v_requested_signature THEN
    RETURN jsonb_build_object('order', to_jsonb(v_order), 'changed', false);
  END IF;

  -- Lock all affected catalog rows in a stable order before changing quantities.
  -- This prevents two admins from overselling the same size concurrently.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB))
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false
      AND COALESCE(value->>'product_id', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O pedido contém um item antigo que precisa de conferência';
  END IF;

  PERFORM 1
  FROM public.stock_products
  WHERE id IN (
    SELECT (value->>'product_id')::UUID FROM jsonb_array_elements(p_items)
    UNION
    SELECT (value->>'product_id')::UUID
    FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB))
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false
  )
  ORDER BY id
  FOR UPDATE;

  -- Return each old active line to its original variation before reserving the
  -- adjusted cart. Both steps are inside this transaction, so no stock window
  -- is exposed to another order.
  PERFORM set_config('eon.stock_movement_type', 'order_item_cancelled', true);
  PERFORM set_config('eon.stock_movement_reason', 'Estoque liberado por ajuste de itens', true);
  PERFORM set_config('eon.stock_movement_actor_id', p_actor_id::TEXT, true);

  FOR v_existing_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB))
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false
    ORDER BY value->>'product_id', COALESCE(value->>'variation', '')
  LOOP
    v_product_id := (v_existing_item->>'product_id')::UUID;
    v_variation := NULLIF(trim(COALESCE(v_existing_item->>'variation', '')), '');
    IF COALESCE(v_existing_item->>'quantity', '') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Quantidade de item antigo inválida';
    END IF;
    v_quantity := (v_existing_item->>'quantity')::INTEGER;
    IF v_quantity > 100000 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Quantidade de item antigo inválida';
    END IF;

    SELECT * INTO v_product
    FROM public.stock_products
    WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto do pedido não encontrado';
    END IF;
    IF jsonb_array_length(CASE
      WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::JSONB)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::JSONB)
      ELSE '[]'::JSONB
    END) > 0 AND v_variation IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Um item antigo não possui o tamanho necessário para ajustar o estoque';
    END IF;
    IF jsonb_array_length(CASE
      WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::JSONB)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::JSONB)
      ELSE '[]'::JSONB
    END) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::JSONB)) = 'array'
        THEN COALESCE(v_product.variations, '[]'::JSONB)
        ELSE '[]'::JSONB
      END)
      WHERE eon_private.stock_variation_name(value) = v_variation
         OR NULLIF(trim(COALESCE(value->>'sku', '')), '') = v_variation
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'O tamanho de um item antigo não existe mais no catálogo';
    END IF;

    PERFORM eon_private.restock_stock_product(v_product_id, v_quantity, v_variation);
  END LOOP;

  PERFORM set_config('eon.stock_movement_type', 'order_reserved', true);
  PERFORM set_config('eon.stock_movement_reason', 'Estoque reservado por ajuste de itens', true);

  FOR v_input_item IN
    SELECT value
    FROM jsonb_array_elements(p_items)
    ORDER BY value->>'product_id', COALESCE(value->>'variation', '')
  LOOP
    v_product_id := (v_input_item->>'product_id')::UUID;
    v_variation := NULLIF(trim(COALESCE(v_input_item->>'variation', '')), '');
    v_quantity := (v_input_item->>'quantity')::INTEGER;

    v_reserved_item := eon_private.reserve_stock_product(
      v_product_id, v_quantity, v_variation, false
    );

    -- An existing line keeps the agreed unit price; only a newly added product
    -- receives the catalog price at the time of the adjustment.
    SELECT value INTO v_existing_item
    FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::JSONB))
    WHERE COALESCE((value->>'cancelled')::BOOLEAN, false) = false
      AND value->>'product_id' = v_product_id::TEXT
      AND COALESCE(NULLIF(value->>'variation', ''), '') = COALESCE(v_variation, '')
    LIMIT 1;

    IF v_existing_item IS NOT NULL THEN
      BEGIN
        v_sale_price := NULLIF(v_existing_item->>'sale_price', '')::NUMERIC;
        v_cost_price := NULLIF(v_existing_item->>'cost_price', '')::NUMERIC;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Preço de item antigo inválido';
      END;
      IF v_sale_price IS NULL OR v_sale_price < 0 OR v_cost_price IS NULL OR v_cost_price < 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Preço de item antigo inválido';
      END IF;
      v_reserved_item := jsonb_set(v_reserved_item, '{sale_price}', to_jsonb(round(v_sale_price, 2)));
      v_reserved_item := jsonb_set(v_reserved_item, '{cost_price}', to_jsonb(round(v_cost_price, 2)));
    END IF;

    v_sale_price := COALESCE(NULLIF(v_reserved_item->>'sale_price', '')::NUMERIC, 0);
    v_subtotal := v_subtotal + (v_sale_price * v_quantity);
    v_new_active_items := v_new_active_items || jsonb_build_array(v_reserved_item);
  END LOOP;

  v_coupon_discount := LEAST(COALESCE(v_order.discount_value, 0), v_subtotal);
  v_manual_discount := LEAST(
    COALESCE(v_order.manual_discount, 0),
    GREATEST(0, v_subtotal - v_coupon_discount)
  );
  v_total := round(GREATEST(0, v_subtotal - v_coupon_discount - v_manual_discount), 2);
  v_new_items := v_historical_items || v_new_active_items;
  v_previous_status := v_order.payment_status;
  v_old_total := COALESCE(v_order.total_value, 0);

  UPDATE public.stock_orders
  SET items = v_new_items,
      total_value = v_total,
      discount_value = round(v_coupon_discount, 2),
      manual_discount = round(v_manual_discount, 2),
      updated_date = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  UPDATE public.coupon_uses
  SET discount_applied = round(v_coupon_discount, 2)
  WHERE order_type = 'stock' AND order_id = p_order_id;

  -- Link both the release and the new reservation to this order before the
  -- deferred order trigger runs, preserving a complete stock ledger.
  UPDATE public.stock_movements
  SET order_id = p_order_id,
      metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'source', 'stock_order',
        'order_number', v_order.order_number,
        'action', 'items_adjusted'
      )
  WHERE order_id IS NULL
    AND metadata->>'transaction_id' = txid_current()::TEXT
    AND movement_type IN ('order_item_cancelled', 'order_reserved');

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'stock', p_order_id, v_previous_status, v_previous_status,
    'Itens do pedido ajustados',
    jsonb_build_object(
      'action', 'items_adjusted',
      'old_items', v_existing_signature,
      'new_items', v_requested_signature,
      'old_total', round(v_old_total, 2),
      'new_total', v_total,
      'coupon_discount', round(v_coupon_discount, 2),
      'manual_discount', round(v_manual_discount, 2)
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('order', to_jsonb(v_order), 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_stock_order_items_from_api(UUID, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_stock_order_items_from_api(UUID, JSONB, UUID)
  TO service_role;

COMMENT ON FUNCTION public.replace_stock_order_items_from_api(UUID, JSONB, UUID) IS
  'Server-only: ajusta itens de pedido de estoque sem cobrança ativa, recalcula total e reconcilia estoque por variação.';;
