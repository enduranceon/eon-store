-- A compra pública guarda os dados informados no pedido, mas a equipe decide
-- conscientemente a qual cadastro interno ele pertence.

CREATE OR REPLACE FUNCTION eon_private.create_public_stock_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.stock_orders%ROWTYPE;
  v_item JSONB;
  v_reserved_item JSONB;
  v_items JSONB := '[]'::jsonb;
  v_name TEXT := trim(p_payload #>> '{customer,full_name}');
  v_phone TEXT := regexp_replace(COALESCE(p_payload #>> '{customer,whatsapp}', ''), '\D', '', 'g');
  v_email TEXT := lower(NULLIF(trim(p_payload #>> '{customer,email}'), ''));
  v_delivery_method TEXT := p_payload #>> '{delivery,method}';
  v_delivery_city TEXT := NULLIF(trim(p_payload #>> '{delivery,city}'), '');
  v_payment_preference TEXT := p_payload ->> 'payment_preference';
  v_quantity INTEGER;
  v_subtotal NUMERIC := 0;
  v_coupon_id UUID;
  v_coupon_code TEXT;
  v_discount NUMERIC := 0;
BEGIN
  IF v_name IS NULL OR char_length(v_name) < 3 OR char_length(v_name) > 160 THEN
    RAISE EXCEPTION 'Informe o nome completo';
  END IF;
  IF char_length(v_phone) NOT BETWEEN 10 AND 11 THEN RAISE EXCEPTION 'WhatsApp inválido'; END IF;
  IF v_email IS NOT NULL AND char_length(v_email) > 254 THEN RAISE EXCEPTION 'E-mail inválido'; END IF;
  IF v_delivery_method IS NULL OR v_delivery_method NOT IN ('pickup', 'shipping') THEN
    RAISE EXCEPTION 'Forma de entrega inválida';
  END IF;
  IF v_delivery_method = 'pickup' AND v_delivery_city IS NULL THEN RAISE EXCEPTION 'Informe a cidade de retirada'; END IF;
  IF v_delivery_city IS NOT NULL AND char_length(v_delivery_city) > 120 THEN RAISE EXCEPTION 'Cidade inválida'; END IF;
  IF v_payment_preference IS NULL OR (
     v_payment_preference <> 'pix_boleto'
     AND v_payment_preference !~ '^card_([1-6])x$') THEN
    RAISE EXCEPTION 'Preferência de pagamento inválida';
  END IF;
  IF p_payload->'items' IS NULL
     OR jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'Adicione produtos ao pedido';
  END IF;
  IF jsonb_array_length(p_payload->'items') > 50 OR octet_length(p_payload::text) > 100000 THEN
    RAISE EXCEPTION 'Pedido excede o limite permitido';
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_payload->'items')
    ORDER BY value->>'product_id', COALESCE(value->>'variation', '')
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > 100 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;

    v_reserved_item := eon_private.reserve_stock_product(
      (v_item->>'product_id')::uuid,
      v_quantity,
      NULLIF(trim(COALESCE(v_item->>'variation', '')), ''),
      TRUE
    );

    v_items := v_items || jsonb_build_array(v_reserved_item);
    v_subtotal := v_subtotal
      + (COALESCE(NULLIF(v_reserved_item->>'sale_price', '')::NUMERIC, 0) * v_quantity);
  END LOOP;

  SELECT coupon_id, coupon_code, discount
  INTO v_coupon_id, v_coupon_code, v_discount
  FROM eon_private.claim_public_coupon(p_payload->>'coupon_code', v_subtotal, v_phone);

  INSERT INTO public.stock_orders(
    customer_id, customer_name, customer_whatsapp, customer_email,
    items, total_value, payment_preference, payment_method, payment_status,
    due_date, delivery_status, delivery_method, delivery_city,
    coupon_code, discount_value
  )
  VALUES (
    NULL, v_name, v_phone, v_email,
    v_items, GREATEST(v_subtotal - v_discount, 0), v_payment_preference, NULL, 'awaiting_charge',
    NULL, 'awaiting_delivery', v_delivery_method, v_delivery_city,
    v_coupon_code, v_discount
  )
  RETURNING * INTO v_order;

  IF v_coupon_id IS NOT NULL THEN
    INSERT INTO public.coupon_uses(
      coupon_id, coupon_code, order_id, order_type, order_number,
      customer_identifier, customer_name, discount_applied
    )
    VALUES (
      v_coupon_id, v_coupon_code, v_order.id, 'stock', v_order.order_number,
      v_phone, v_name, v_discount
    );
  END IF;

  RETURN jsonb_build_object(
    'public_token', v_order.public_token,
    'order_number', v_order.order_number,
    'total_value', v_order.total_value,
    'payment_status', v_order.payment_status,
    'customer_name', v_order.customer_name,
    'customer_whatsapp', v_order.customer_whatsapp,
    'customer_email', v_order.customer_email,
    'items', v_order.items,
    'coupon_code', v_order.coupon_code,
    'discount_value', v_order.discount_value
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.link_stock_order_customer(
  p_order_id UUID,
  p_customer_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Pedido ou cliente inválido';
  END IF;

  PERFORM 1
  FROM public.presale_customers
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente não encontrado';
  END IF;

  UPDATE public.stock_orders o
  SET customer_id = p_customer_id,
      updated_date = now()
  WHERE o.id = p_order_id
  RETURNING to_jsonb(o) INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.link_stock_order_customer(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_stock_order_customer(UUID, UUID, UUID)
  TO service_role;

COMMENT ON FUNCTION public.link_stock_order_customer(UUID, UUID, UUID) IS
  'Links a store order to an internal customer chosen by an administrator without changing the order contact snapshot.';
