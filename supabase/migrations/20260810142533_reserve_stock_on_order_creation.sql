-- Reserve stock as soon as a stock-store order is created. If the sale is
-- cancelled/refunded before delivery, return only items that were reserved by
-- this flow; delivered refunds keep using the physical return workflow.

ALTER TABLE public.stock_products
  ADD COLUMN IF NOT EXISTS show_in_store BOOLEAN;

UPDATE public.stock_products
SET show_in_store = TRUE
WHERE show_in_store IS NULL;

ALTER TABLE public.stock_products
  ALTER COLUMN show_in_store SET DEFAULT TRUE,
  ALTER COLUMN show_in_store SET NOT NULL;

COMMENT ON COLUMN public.stock_products.show_in_store IS
  'Controls whether an active stock product appears in the public store.';

CREATE OR REPLACE FUNCTION eon_private.stock_json_numeric(
  p_payload JSONB,
  p_key TEXT
)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN trim(COALESCE(p_payload->>p_key, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (p_payload->>p_key)::NUMERIC
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION eon_private.stock_variation_name(p_variation JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    NULLIF(trim(COALESCE(p_variation->>'name', '')), ''),
    NULLIF(array_to_string(ARRAY[
      NULLIF(trim(COALESCE(p_variation->>'gender', '')), ''),
      NULLIF(trim(COALESCE(p_variation->>'size', '')), '')
    ], ' - '), ''),
    NULLIF(trim(COALESCE(p_variation->>'sku', '')), '')
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.stock_variation_quantity(p_variation JSONB)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
SET search_path = ''
AS $$
  SELECT GREATEST(
    0,
    COALESCE(floor(eon_private.stock_json_numeric(p_variation, 'quantity'))::INTEGER, 0)
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.stock_variations_total_quantity(p_variations JSONB)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(sum(eon_private.stock_variation_quantity(value)), 0)::INTEGER
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(COALESCE(p_variations, '[]'::jsonb)) = 'array'
        THEN COALESCE(p_variations, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.get_public_stock_catalog()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.name), '[]'::jsonb)
  FROM (
    SELECT id, product_id, product_number, name, description, category,
           subcategory, supplier, supplier_id, images, sale_price,
           regular_price, cost_price, quantity, status, show_in_store,
           variations, extras
    FROM public.stock_products
    WHERE status = 'active'
      AND COALESCE(show_in_store, TRUE) = TRUE
  ) p;
$$;

CREATE OR REPLACE FUNCTION eon_private.reserve_stock_product(
  p_product_id UUID,
  p_quantity INTEGER,
  p_variation TEXT DEFAULT NULL,
  p_require_visible BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product public.stock_products%ROWTYPE;
  v_variations JSONB;
  v_updated_variations JSONB;
  v_variation JSONB;
  v_variation_name TEXT := NULLIF(trim(COALESCE(p_variation, '')), '');
  v_variation_index INTEGER;
  v_available INTEGER;
  v_total_quantity INTEGER;
  v_sale_price NUMERIC;
  v_regular_price NUMERIC;
  v_cost_price NUMERIC;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade inválida';
  END IF;

  SELECT *
  INTO v_product
  FROM public.stock_products
  WHERE id = p_product_id
    AND status = 'active'
    AND (NOT p_require_visible OR COALESCE(show_in_store, TRUE) = TRUE)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto indisponível';
  END IF;

  v_variations := CASE
    WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  IF jsonb_array_length(v_variations) > 0 THEN
    IF v_variation_name IS NULL THEN
      RAISE EXCEPTION 'Selecione o tamanho para %', v_product.name;
    END IF;

    SELECT (ordinality - 1)::INTEGER, value
      INTO v_variation_index, v_variation
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY
    WHERE eon_private.stock_variation_name(value) = v_variation_name
       OR NULLIF(trim(COALESCE(value->>'sku', '')), '') = v_variation_name
    ORDER BY ordinality
    LIMIT 1;

    IF v_variation IS NULL THEN
      RAISE EXCEPTION 'Tamanho indisponível para %', v_product.name;
    END IF;

    v_variation_name := eon_private.stock_variation_name(v_variation);
    v_available := eon_private.stock_variation_quantity(v_variation);
    IF v_available < p_quantity THEN
      RAISE EXCEPTION 'Estoque insuficiente para % - %', v_product.name, v_variation_name;
    END IF;

    v_sale_price := COALESCE(
      eon_private.stock_json_numeric(v_variation, 'sale_price'),
      v_product.sale_price,
      0
    );
    v_regular_price := COALESCE(
      eon_private.stock_json_numeric(v_variation, 'regular_price'),
      v_product.regular_price
    );
    v_cost_price := COALESCE(
      eon_private.stock_json_numeric(v_variation, 'cost_price'),
      v_product.cost_price,
      0
    );

    v_variation := jsonb_set(v_variation, '{name}', to_jsonb(v_variation_name), TRUE);
    v_variation := jsonb_set(v_variation, '{quantity}', to_jsonb(v_available - p_quantity), TRUE);

    SELECT COALESCE(
      jsonb_agg(
        CASE WHEN (ordinality - 1)::INTEGER = v_variation_index
          THEN v_variation
          ELSE value
        END
        ORDER BY ordinality
      ),
      '[]'::jsonb
    )
    INTO v_updated_variations
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY;

    v_total_quantity := eon_private.stock_variations_total_quantity(v_updated_variations);

    UPDATE public.stock_products
    SET variations = v_updated_variations,
        quantity = v_total_quantity,
        updated_date = now()
    WHERE id = v_product.id
    RETURNING * INTO v_product;
  ELSE
    IF COALESCE(v_product.quantity, 0) < p_quantity THEN
      RAISE EXCEPTION 'Estoque insuficiente para %', v_product.name;
    END IF;

    UPDATE public.stock_products
    SET quantity = COALESCE(quantity, 0) - p_quantity,
        updated_date = now()
    WHERE id = v_product.id
      AND status = 'active'
      AND COALESCE(quantity, 0) >= p_quantity
    RETURNING * INTO v_product;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Estoque insuficiente para %', v_product.name;
    END IF;

    v_sale_price := COALESCE(v_product.sale_price, 0);
    v_regular_price := v_product.regular_price;
    v_cost_price := COALESCE(v_product.cost_price, 0);
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'product_id', v_product.id,
    'product_name', v_product.name,
    'variation', v_variation_name,
    'quantity', p_quantity,
    'sale_price', round(v_sale_price, 2),
    'regular_price', CASE WHEN v_regular_price IS NULL THEN NULL ELSE round(v_regular_price, 2) END,
    'cost_price', round(v_cost_price, 2),
    'stock_reserved', TRUE,
    'stock_reserved_at', now()
  ));
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.restock_stock_product(
  p_product_id UUID,
  p_quantity INTEGER,
  p_variation TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product public.stock_products%ROWTYPE;
  v_variations JSONB;
  v_updated_variations JSONB;
  v_variation JSONB;
  v_variation_name TEXT := NULLIF(trim(COALESCE(p_variation, '')), '');
  v_variation_index INTEGER;
  v_available INTEGER;
  v_total_quantity INTEGER;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN;
  END IF;

  SELECT *
  INTO v_product
  FROM public.stock_products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto de estoque não encontrado';
  END IF;

  v_variations := CASE
    WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  IF jsonb_array_length(v_variations) > 0 AND v_variation_name IS NOT NULL THEN
    SELECT (ordinality - 1)::INTEGER, value
      INTO v_variation_index, v_variation
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY
    WHERE eon_private.stock_variation_name(value) = v_variation_name
       OR NULLIF(trim(COALESCE(value->>'sku', '')), '') = v_variation_name
    ORDER BY ordinality
    LIMIT 1;

    IF v_variation IS NOT NULL THEN
      v_variation_name := eon_private.stock_variation_name(v_variation);
      v_available := eon_private.stock_variation_quantity(v_variation);
      v_variation := jsonb_set(v_variation, '{name}', to_jsonb(v_variation_name), TRUE);
      v_variation := jsonb_set(v_variation, '{quantity}', to_jsonb(v_available + p_quantity), TRUE);

      SELECT COALESCE(
        jsonb_agg(
          CASE WHEN (ordinality - 1)::INTEGER = v_variation_index
            THEN v_variation
            ELSE value
          END
          ORDER BY ordinality
        ),
        '[]'::jsonb
      )
      INTO v_updated_variations
      FROM jsonb_array_elements(v_variations) WITH ORDINALITY;

      v_total_quantity := eon_private.stock_variations_total_quantity(v_updated_variations);

      UPDATE public.stock_products
      SET variations = v_updated_variations,
          quantity = v_total_quantity,
          updated_date = now()
      WHERE id = v_product.id;

      RETURN;
    END IF;
  END IF;

  UPDATE public.stock_products
  SET quantity = COALESCE(quantity, 0) + p_quantity,
      updated_date = now()
  WHERE id = v_product.id;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.create_public_stock_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer public.presale_customers%ROWTYPE;
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

  PERFORM pg_advisory_xact_lock(hashtext('public_customer:' || v_phone));
  SELECT *
  INTO v_customer
  FROM public.presale_customers
  WHERE whatsapp = v_phone
  ORDER BY created_date DESC
  LIMIT 1;

  IF NOT FOUND AND v_email IS NOT NULL THEN
    SELECT *
    INTO v_customer
    FROM public.presale_customers
    WHERE lower(email) = v_email
    ORDER BY created_date DESC
    LIMIT 1;
  END IF;

  IF FOUND THEN
    UPDATE public.presale_customers
    SET full_name = v_name,
        email = COALESCE(v_email, email),
        updated_date = now()
    WHERE id = v_customer.id
    RETURNING * INTO v_customer;
  ELSE
    INSERT INTO public.presale_customers(full_name, whatsapp, email)
    VALUES (v_name, v_phone, v_email)
    RETURNING * INTO v_customer;
  END IF;

  INSERT INTO public.stock_orders(
    customer_id, customer_name, customer_whatsapp, customer_email,
    items, total_value, payment_preference, payment_method, payment_status,
    due_date, delivery_status, delivery_method, delivery_city,
    coupon_code, discount_value
  )
  VALUES (
    v_customer.id, v_name, v_phone, v_email,
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

CREATE OR REPLACE FUNCTION public.create_stock_order_from_admin(
  p_payload JSONB,
  p_actor_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.stock_order_creation_operations%ROWTYPE;
  v_customer public.presale_customers%ROWTYPE;
  v_order_id UUID := gen_random_uuid();
  v_customer_id UUID;
  v_item JSONB;
  v_reserved_item JSONB;
  v_product_id UUID;
  v_quantity INTEGER;
  v_items JSONB := '[]'::jsonb;
  v_subtotal NUMERIC := 0;
  v_total_cost NUMERIC := 0;
  v_manual_discount NUMERIC := 0;
  v_total NUMERIC := 0;
  v_payment_preference TEXT;
  v_discount_reason TEXT;
  v_internal_notes TEXT;
  v_result JSONB;
  v_item_count INTEGER;
  v_distinct_product_count INTEGER;
BEGIN
  IF p_actor_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador ou chave de idempotência inválida';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do pedido inválidos';
  END IF;
  IF COALESCE(p_payload->>'customer_id', '') !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cliente inválido';
  END IF;
  v_customer_id := (p_payload->>'customer_id')::UUID;

  SELECT * INTO v_customer
  FROM public.presale_customers
  WHERE id = v_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente não encontrado';
  END IF;

  IF jsonb_typeof(p_payload->'items') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Itens do pedido inválidos';
  END IF;
  SELECT count(*),
         count(DISTINCT (COALESCE(value->>'product_id', '') || '::' || COALESCE(NULLIF(trim(value->>'variation'), ''), '')))
    INTO v_item_count, v_distinct_product_count
  FROM jsonb_array_elements(p_payload->'items');
  IF v_item_count < 1 OR v_item_count > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe entre 1 e 100 itens';
  END IF;
  IF v_item_count <> v_distinct_product_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O mesmo produto e tamanho aparece mais de uma vez';
  END IF;

  v_payment_preference := NULLIF(trim(p_payload->>'payment_preference'), '');
  IF v_payment_preference IS NULL OR v_payment_preference NOT IN (
    'pix_manual', 'cash', 'card_machine', 'bank_transfer', 'pix', 'boleto'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Preferência de pagamento inválida';
  END IF;

  BEGIN
    v_manual_discount := COALESCE((p_payload->>'manual_discount')::NUMERIC, 0);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Desconto inválido';
  END;
  IF v_manual_discount < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Desconto inválido';
  END IF;

  v_discount_reason := NULLIF(trim(p_payload->>'discount_reason'), '');
  v_internal_notes := NULLIF(trim(p_payload->>'internal_notes'), '');
  IF char_length(COALESCE(v_discount_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo do desconto muito longo';
  END IF;
  IF char_length(COALESCE(v_internal_notes, '')) > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Observações muito longas';
  END IF;

  SELECT * INTO v_operation
  FROM public.stock_order_creation_operations
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.request_payload IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A chave de idempotência já foi usada com outros dados';
    END IF;
    SELECT to_jsonb(o) INTO v_result
    FROM public.stock_orders o
    WHERE o.id = v_operation.order_id;
    IF v_result IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Operação de criação inconsistente';
    END IF;
    RETURN v_result;
  END IF;

  INSERT INTO public.stock_order_creation_operations (
    idempotency_key, requested_by, request_payload, order_id
  ) VALUES (
    p_idempotency_key, p_actor_id, p_payload, v_order_id
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_operation;

  IF NOT FOUND THEN
    SELECT * INTO v_operation
    FROM public.stock_order_creation_operations
    WHERE idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_operation.request_payload IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A chave de idempotência já foi usada com outros dados';
    END IF;
    SELECT to_jsonb(o) INTO v_result
    FROM public.stock_orders o
    WHERE o.id = v_operation.order_id;
    IF v_result IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Operação de criação ainda não foi concluída';
    END IF;
    RETURN v_result;
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_payload->'items')
    ORDER BY value->>'product_id', COALESCE(value->>'variation', '')
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR COALESCE(v_item->>'product_id', '') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
       OR COALESCE(v_item->>'quantity', '') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Item do pedido inválido';
    END IF;
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::INTEGER;
    IF v_quantity > 100000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade do item inválida';
    END IF;
    IF char_length(COALESCE(v_item->>'variation', '')) > 200 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tamanho do item inválido';
    END IF;

    v_reserved_item := eon_private.reserve_stock_product(
      v_product_id,
      v_quantity,
      NULLIF(trim(COALESCE(v_item->>'variation', '')), ''),
      FALSE
    );

    v_items := v_items || jsonb_build_array(v_reserved_item);
    v_subtotal := v_subtotal
      + round(COALESCE(NULLIF(v_reserved_item->>'sale_price', '')::NUMERIC, 0), 2) * v_quantity;
    v_total_cost := v_total_cost
      + round(COALESCE(NULLIF(v_reserved_item->>'cost_price', '')::NUMERIC, 0), 2) * v_quantity;
  END LOOP;

  IF v_manual_discount > v_subtotal THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O desconto supera o subtotal do pedido';
  END IF;
  v_total := round(GREATEST(0, v_subtotal - v_manual_discount), 2);

  INSERT INTO public.stock_orders (
    id, customer_id, customer_name, customer_whatsapp, customer_email,
    customer_cpf, items, total_value, manual_discount, discount_reason,
    payment_preference, payment_method, payment_status, due_date, payment_date,
    delivery_status, delivery_method, internal_notes, created_by
  ) VALUES (
    v_order_id, v_customer.id, v_customer.full_name, v_customer.whatsapp,
    v_customer.email, v_customer.cpf, v_items, v_total,
    round(v_manual_discount, 2), v_discount_reason, v_payment_preference,
    NULL, 'awaiting_charge', NULL, NULL, 'awaiting_delivery', 'pickup',
    v_internal_notes, p_actor_id
  );

  SELECT to_jsonb(o) INTO v_result
  FROM public.stock_orders o
  WHERE o.id = v_order_id;

  RETURN v_result;
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
      'coupon_uses_cancelled', v_coupon_uses,
      'stock_restocked', v_stock_restocked
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
  v_quantity INTEGER;
  v_coupon_uses INTEGER := 0;
  v_returns INTEGER := 0;
  v_stock_restocked INTEGER := 0;
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

  v_was_delivered := COALESCE(v_delivery_status, '') = 'delivered';

  IF v_result IS NULL
     AND v_error IS NULL
     AND v_operation.order_type = 'stock'
     AND NOT v_was_delivered THEN
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

    IF v_operation.order_type = 'stock'
       AND NOT v_was_delivered
      AND COALESCE(v_item->>'stock_reserved', 'false') = 'true'
      AND v_product_id IS NOT NULL THEN
      v_quantity := COALESCE(NULLIF(v_item->>'quantity', '')::INTEGER, 0);
      PERFORM eon_private.restock_stock_product(
        v_product_id,
        v_quantity,
        NULLIF(trim(COALESCE(v_item->>'variation', '')), '')
      );

      v_stock_restocked := v_stock_restocked + v_quantity;
    END IF;

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
      'coupon_uses_cancelled', v_coupon_uses,
      'stock_restocked', v_stock_restocked
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
    'awaiting_physical_return', v_was_delivered,
    'stock_restocked', v_stock_restocked
  );

  UPDATE public.order_operations
  SET status = 'completed', external_result = p_external_result,
      result = v_result, last_error = NULL, updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
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
  v_restock_quantity INTEGER := 0;
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
     AND NOT (v_operation.payload->>'was_delivered')::BOOLEAN
     AND COALESCE(v_operation.payload->'item'->>'stock_reserved', 'false') = 'true' THEN
    v_product_id := CASE
      WHEN COALESCE(v_operation.payload->'item'->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (v_operation.payload->'item'->>'product_id')::UUID
      ELSE NULL
    END;
    IF v_product_id IS NOT NULL THEN
      PERFORM 1
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

  IF v_product_id IS NOT NULL
     AND COALESCE(v_operation.payload->'item'->>'stock_reserved', 'false') = 'true' THEN
    v_restock_quantity := COALESCE(NULLIF(v_operation.payload->'item'->>'quantity', '')::INTEGER, 0);
    PERFORM eon_private.restock_stock_product(
      v_product_id,
      v_restock_quantity,
      NULLIF(trim(COALESCE(v_operation.payload->'item'->>'variation', '')), '')
    );
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
      'variation', NULLIF(v_operation.payload->'item'->>'variation', ''),
      'refund_value', (v_operation.payload->>'refund_value')::NUMERIC,
      'external_result', p_external_result,
      'coupon_uses_cancelled', v_coupon_uses,
      'stock_restocked', v_restock_quantity
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
    'awaiting_physical_return', (v_operation.payload->>'was_delivered')::BOOLEAN,
    'stock_restocked', v_restock_quantity
  );

  UPDATE public.order_operations
  SET status = 'completed', external_result = p_external_result,
      result = v_result, last_error = NULL, updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_order_return(
  p_return_id UUID,
  p_action TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_return public.order_returns%ROWTYPE;
  v_stock_restocked BOOLEAN := FALSE;
BEGIN
  IF p_action NOT IN ('receive', 'complete') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Ação de devolução inválida';
  END IF;

  SELECT *
    INTO v_return
    FROM public.order_returns
   WHERE id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Devolução não encontrada';
  END IF;

  IF p_action = 'receive' THEN
    IF v_return.status = 'received' THEN
      RETURN jsonb_build_object(
        'return', to_jsonb(v_return),
        'stock_restocked', FALSE
      );
    END IF;

    IF v_return.status <> 'pending_return' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format(
          'Não é possível receber uma devolução com status %s',
          v_return.status
        );
    END IF;

    UPDATE public.order_returns
       SET status = 'received',
           received_at = now()
     WHERE id = p_return_id
     RETURNING * INTO v_return;
  ELSE
    IF v_return.status = 'completed' THEN
      RETURN jsonb_build_object(
        'return', to_jsonb(v_return),
        'stock_restocked', FALSE
      );
    END IF;

    IF v_return.status <> 'received' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format(
          'Não é possível concluir uma devolução com status %s',
          v_return.status
        );
    END IF;

    IF v_return.quantity <= 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Quantidade da devolução deve ser positiva';
    END IF;

    IF v_return.product_id IS NOT NULL THEN
      PERFORM eon_private.restock_stock_product(
        v_return.product_id,
        v_return.quantity,
        NULLIF(trim(COALESCE(v_return.variation, '')), '')
      );
      v_stock_restocked := TRUE;
    END IF;

    UPDATE public.order_returns
       SET status = 'completed',
           completed_at = now()
     WHERE id = p_return_id
     RETURNING * INTO v_return;
  END IF;

  RETURN jsonb_build_object(
    'return', to_jsonb(v_return),
    'stock_restocked', v_stock_restocked
  );
END;
$$;

REVOKE ALL ON FUNCTION eon_private.create_public_stock_order(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.get_public_stock_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.stock_json_numeric(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.stock_variation_name(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.stock_variation_quantity(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.stock_variations_total_quantity(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.reserve_stock_product(UUID, INTEGER, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.restock_stock_product(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_stock_order_from_admin(JSONB, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_cancellation(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_refund(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_item_cancellation(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_order_return(UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION eon_private.create_public_stock_order(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.get_public_stock_catalog() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.reserve_stock_product(UUID, INTEGER, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.restock_stock_product(UUID, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_stock_order_from_admin(JSONB, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_cancellation(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_item_cancellation(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order_return(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION eon_private.create_public_stock_order(JSONB) IS
  'Creates public stock orders and reserves stock atomically.';
COMMENT ON FUNCTION public.create_stock_order_from_admin(JSONB, UUID, UUID) IS
  'Creates administrative stock orders idempotently and reserves stock atomically.';
COMMENT ON FUNCTION eon_private.reserve_stock_product(UUID, INTEGER, TEXT, BOOLEAN) IS
  'Atomically reserves stock by product and optional variation.';
COMMENT ON FUNCTION eon_private.restock_stock_product(UUID, INTEGER, TEXT) IS
  'Atomically returns stock by product and optional variation.';
