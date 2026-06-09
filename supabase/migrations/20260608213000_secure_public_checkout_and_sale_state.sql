-- Public checkout hardening and canonical sale-state rules.
-- Public users no longer read/write customers, orders, stock or coupon usage
-- directly. Public RPC wrappers call privileged functions kept outside the
-- exposed schema.

CREATE SCHEMA IF NOT EXISTS eon_private;
REVOKE ALL ON SCHEMA eon_private FROM PUBLIC, anon, authenticated;

ALTER TABLE public.presale_orders
  ADD COLUMN IF NOT EXISTS payment_preference TEXT,
  ADD COLUMN IF NOT EXISTS public_token UUID DEFAULT gen_random_uuid();

ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS payment_preference TEXT,
  ADD COLUMN IF NOT EXISTS public_token UUID DEFAULT gen_random_uuid();

UPDATE public.presale_orders SET public_token = gen_random_uuid() WHERE public_token IS NULL;
UPDATE public.stock_orders SET public_token = gen_random_uuid() WHERE public_token IS NULL;

ALTER TABLE public.presale_orders ALTER COLUMN public_token SET NOT NULL;
ALTER TABLE public.stock_orders ALTER COLUMN public_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS presale_orders_public_token_key
  ON public.presale_orders(public_token);
CREATE UNIQUE INDEX IF NOT EXISTS stock_orders_public_token_key
  ON public.stock_orders(public_token);

UPDATE public.presale_orders
SET payment_preference = payment_method
WHERE payment_preference IS NULL
  AND payment_method IS NOT NULL
  AND payment_status <> 'paid';

UPDATE public.stock_orders
SET payment_preference = payment_method
WHERE payment_preference IS NULL
  AND payment_method IS NOT NULL
  AND payment_status <> 'paid';

CREATE TABLE IF NOT EXISTS public.sales_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_type TEXT NOT NULL CHECK (order_type IN ('presale', 'stock', 'contract')),
  order_id UUID NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_status_events_order_idx
  ON public.sales_status_events(order_type, order_id, created_at DESC);

ALTER TABLE public.sales_status_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_full ON public.sales_status_events;
CREATE POLICY auth_full ON public.sales_status_events
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Preserve the legacy state before normalizing rows that have no technical
-- evidence that a charge was created or sent.
INSERT INTO public.sales_status_events (
  order_type, order_id, previous_status, new_status, reason, metadata, actor_id
)
SELECT
  'presale',
  id,
  payment_status,
  'awaiting_charge',
  'legacy_status_without_charge_evidence',
  jsonb_build_object('previous_due_date', due_date),
  NULL
FROM public.presale_orders
WHERE payment_status IN ('pending', 'charge_sent')
  AND asaas_charge_id IS NULL
  AND asaas_payment_link IS NULL
  AND asaas_pix_copy IS NULL
  AND external_payment_link IS NULL
  AND payment_message_sent_at IS NULL;

UPDATE public.presale_orders
SET payment_status = 'awaiting_charge',
    due_date = NULL,
    updated_date = now()
WHERE payment_status IN ('pending', 'charge_sent')
  AND asaas_charge_id IS NULL
  AND asaas_payment_link IS NULL
  AND asaas_pix_copy IS NULL
  AND external_payment_link IS NULL
  AND payment_message_sent_at IS NULL;

CREATE OR REPLACE FUNCTION eon_private.claim_public_coupon(
  p_code TEXT,
  p_subtotal NUMERIC,
  p_customer_identifier TEXT
)
RETURNS TABLE(coupon_id UUID, coupon_code TEXT, discount NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_coupon public.coupons%ROWTYPE;
  v_customer_uses INTEGER;
  v_discount NUMERIC := 0;
  v_today DATE := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF NULLIF(trim(p_code), '') IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 0::numeric;
    RETURN;
  END IF;

  SELECT *
  INTO v_coupon
  FROM public.coupons
  WHERE lower(code) = lower(trim(p_code))
  FOR UPDATE;

  IF NOT FOUND OR NOT v_coupon.active THEN
    RAISE EXCEPTION 'Cupom inválido ou inativo';
  END IF;
  IF v_coupon.valid_from IS NOT NULL AND v_coupon.valid_from > v_today THEN
    RAISE EXCEPTION 'Cupom ainda não está válido';
  END IF;
  IF v_coupon.valid_until IS NOT NULL AND v_coupon.valid_until < v_today THEN
    RAISE EXCEPTION 'Cupom expirado';
  END IF;
  IF p_subtotal < COALESCE(v_coupon.min_purchase, 0) THEN
    RAISE EXCEPTION 'Pedido abaixo do valor mínimo do cupom';
  END IF;
  IF v_coupon.usage_limit_total IS NOT NULL
     AND COALESCE(v_coupon.uses_count, 0) >= v_coupon.usage_limit_total THEN
    RAISE EXCEPTION 'Limite de usos do cupom atingido';
  END IF;

  IF v_coupon.usage_limit_per_customer IS NOT NULL
     AND NULLIF(p_customer_identifier, '') IS NOT NULL THEN
    SELECT count(*)
    INTO v_customer_uses
    FROM public.coupon_uses
    WHERE coupon_id = v_coupon.id
      AND customer_identifier = p_customer_identifier
      AND cancelled = false;

    IF v_customer_uses >= v_coupon.usage_limit_per_customer THEN
      RAISE EXCEPTION 'Cupom já utilizado pelo cliente';
    END IF;
  END IF;

  IF v_coupon.discount_type = 'percentage' THEN
    v_discount := round(p_subtotal * v_coupon.discount_value / 100, 2);
    IF v_coupon.max_discount IS NOT NULL THEN
      v_discount := LEAST(v_discount, v_coupon.max_discount);
    END IF;
  ELSE
    v_discount := LEAST(v_coupon.discount_value, p_subtotal);
  END IF;

  RETURN QUERY SELECT v_coupon.id, v_coupon.code, GREATEST(v_discount, 0);
END;
$$;

REVOKE ALL ON FUNCTION eon_private.claim_public_coupon(TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION eon_private.list_public_campaigns()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.end_date, c.name), '[]'::jsonb)
  FROM (
    SELECT id, name, description, status, start_date, end_date,
           product_order, delivery_days, slug, supplier
    FROM public.presale_campaigns
    WHERE status = 'active'
      AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)
  ) c;
$$;

CREATE OR REPLACE FUNCTION eon_private.get_public_presale_catalog(p_campaign_reference TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.presale_campaigns%ROWTYPE;
BEGIN
  SELECT *
  INTO v_campaign
  FROM public.presale_campaigns
  WHERE (id::text = p_campaign_reference OR slug = p_campaign_reference)
    AND COALESCE(status, 'draft') <> 'draft'
  ORDER BY created_date DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Campanha não encontrada';
  END IF;

  RETURN jsonb_build_object(
    'campaign', jsonb_build_object(
      'id', v_campaign.id,
      'name', v_campaign.name,
      'description', v_campaign.description,
      'status', v_campaign.status,
      'start_date', v_campaign.start_date,
      'end_date', v_campaign.end_date,
      'product_order', v_campaign.product_order,
      'delivery_days', v_campaign.delivery_days,
      'slug', v_campaign.slug,
      'supplier', v_campaign.supplier
    ),
    'products', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.name)
      FROM (
        SELECT id, campaign_id, campaign_ids, name, description, status,
               sale_price, regular_price, category, subcategory, variations,
               images, discount_percent, sku, extras, product_number, supplier
        FROM public.presale_products
        WHERE status = 'active'
          AND (campaign_id = v_campaign.id OR v_campaign.id = ANY(COALESCE(campaign_ids, '{}'::uuid[])))
      ) p
    ), '[]'::jsonb),
    'trainers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name)
      FROM public.presale_trainers
    ), '[]'::jsonb)
  );
END;
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
    SELECT id, name, description, category, images, sale_price,
           regular_price, quantity, status
    FROM public.stock_products
    WHERE status = 'active'
  ) p;
$$;

CREATE OR REPLACE FUNCTION eon_private.create_public_presale_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.presale_campaigns%ROWTYPE;
  v_customer public.presale_customers%ROWTYPE;
  v_order public.presale_orders%ROWTYPE;
  v_product public.presale_products%ROWTYPE;
  v_item JSONB;
  v_requested_extra JSONB;
  v_catalog_extra JSONB;
  v_variation JSONB;
  v_items JSONB := '[]'::jsonb;
  v_valid_extras JSONB;
  v_extra_names TEXT[];
  v_name TEXT := trim(p_payload #>> '{customer,full_name}');
  v_phone TEXT := regexp_replace(COALESCE(p_payload #>> '{customer,whatsapp}', ''), '\D', '', 'g');
  v_email TEXT := lower(NULLIF(trim(p_payload #>> '{customer,email}'), ''));
  v_trainer TEXT := NULLIF(trim(p_payload #>> '{customer,trainer}'), '');
  v_delivery_method TEXT := p_payload #>> '{delivery,method}';
  v_delivery_city TEXT := NULLIF(trim(p_payload #>> '{delivery,city}'), '');
  v_payment_preference TEXT := p_payload ->> 'payment_preference';
  v_quantity INTEGER;
  v_sale_price NUMERIC;
  v_cost_price NUMERIC;
  v_extras_total NUMERIC;
  v_subtotal NUMERIC := 0;
  v_total_cost NUMERIC := 0;
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
     AND v_payment_preference !~ '^card_([1-9]|1[0-2])x$') THEN
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

  SELECT *
  INTO v_campaign
  FROM public.presale_campaigns
  WHERE id = (p_payload->>'campaign_id')::uuid
  FOR SHARE;

  IF NOT FOUND OR v_campaign.status <> 'active'
     OR (v_campaign.end_date IS NOT NULL
         AND v_campaign.end_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date) THEN
    RAISE EXCEPTION 'Esta pré-venda está encerrada';
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_payload->'items')
    ORDER BY value->>'product_id'
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > 100 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;

    SELECT *
    INTO v_product
    FROM public.presale_products
    WHERE id = (v_item->>'product_id')::uuid
      AND status = 'active'
      AND (campaign_id = v_campaign.id OR v_campaign.id = ANY(COALESCE(campaign_ids, '{}'::uuid[])));

    IF NOT FOUND THEN RAISE EXCEPTION 'Produto indisponível'; END IF;

    v_variation := NULL;
    IF NULLIF(v_item->>'variation', '') IS NOT NULL THEN
      SELECT value INTO v_variation
      FROM jsonb_array_elements(COALESCE(v_product.variations, '[]'::jsonb))
      WHERE value->>'name' = v_item->>'variation'
      LIMIT 1;
      IF v_variation IS NULL THEN RAISE EXCEPTION 'Variação indisponível para %', v_product.name; END IF;
    END IF;

    v_sale_price := COALESCE((v_variation->>'sale_price')::numeric, v_product.sale_price, 0);
    v_cost_price := COALESCE((v_variation->>'cost_price')::numeric, v_product.cost_price, 0);
    v_valid_extras := '[]'::jsonb;
    v_extra_names := ARRAY[]::text[];
    v_extras_total := 0;

    FOR v_requested_extra IN
      SELECT value FROM jsonb_array_elements(COALESCE(v_item->'extras', '[]'::jsonb))
    LOOP
      IF v_requested_extra->>'name' = ANY(v_extra_names) THEN
        RAISE EXCEPTION 'Adicional duplicado';
      END IF;
      v_extra_names := array_append(v_extra_names, v_requested_extra->>'name');

      v_catalog_extra := NULL;
      SELECT value INTO v_catalog_extra
      FROM jsonb_array_elements(COALESCE(v_product.extras, '[]'::jsonb))
      WHERE value->>'name' = v_requested_extra->>'name'
      LIMIT 1;
      IF v_catalog_extra IS NULL THEN RAISE EXCEPTION 'Adicional indisponível para %', v_product.name; END IF;

      v_valid_extras := v_valid_extras || jsonb_build_array(
        jsonb_build_object(
          'name', v_catalog_extra->>'name',
          'price', COALESCE((v_catalog_extra->>'price')::numeric, 0)
        )
      );
      v_extras_total := v_extras_total + COALESCE((v_catalog_extra->>'price')::numeric, 0);
    END LOOP;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'variation', v_variation->>'name',
      'extras', v_valid_extras,
      'extras_total', v_extras_total,
      'quantity', v_quantity,
      'sale_price', v_sale_price,
      'cost_price', v_cost_price
    ));
    v_subtotal := v_subtotal + ((v_sale_price + v_extras_total) * v_quantity);
    v_total_cost := v_total_cost + (v_cost_price * v_quantity);
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
        trainer = COALESCE(v_trainer, trainer),
        updated_date = now()
    WHERE id = v_customer.id
    RETURNING * INTO v_customer;
  ELSE
    INSERT INTO public.presale_customers(full_name, whatsapp, email, trainer)
    VALUES (v_name, v_phone, v_email, v_trainer)
    RETURNING * INTO v_customer;
  END IF;

  INSERT INTO public.presale_orders(
    campaign_id, customer_id, checkout_name, checkout_whatsapp,
    checkout_email, checkout_trainer, items, total_value, total_cost,
    delivery_method, delivery_city, payment_preference, payment_method,
    payment_status, due_date, delivery_status, coupon_code, discount_value
  )
  VALUES (
    v_campaign.id, v_customer.id, v_name, v_phone,
    v_email, v_trainer, v_items, GREATEST(v_subtotal - v_discount, 0), v_total_cost,
    v_delivery_method, v_delivery_city, v_payment_preference, NULL,
    'awaiting_charge', NULL, 'awaiting_supplier', v_coupon_code, v_discount
  )
  RETURNING * INTO v_order;

  IF v_coupon_id IS NOT NULL THEN
    INSERT INTO public.coupon_uses(
      coupon_id, coupon_code, order_id, order_type, order_number,
      customer_identifier, customer_name, discount_applied
    )
    VALUES (
      v_coupon_id, v_coupon_code, v_order.id, 'presale', v_order.order_number,
      v_phone, v_name, v_discount
    );
  END IF;

  RETURN jsonb_build_object(
    'public_token', v_order.public_token,
    'order_number', v_order.order_number,
    'total_value', v_order.total_value,
    'payment_status', v_order.payment_status,
    'checkout_name', v_order.checkout_name,
    'checkout_whatsapp', v_order.checkout_whatsapp,
    'checkout_email', v_order.checkout_email,
    'items', v_order.items,
    'coupon_code', v_order.coupon_code,
    'discount_value', v_order.discount_value
  );
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
  v_product public.stock_products%ROWTYPE;
  v_item JSONB;
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
    ORDER BY value->>'product_id'
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > 100 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;

    SELECT *
    INTO v_product
    FROM public.stock_products
    WHERE id = (v_item->>'product_id')::uuid
      AND status = 'active'
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Produto indisponível'; END IF;
    IF COALESCE(v_product.quantity, 0) < v_quantity THEN
      RAISE EXCEPTION 'Estoque insuficiente para %', v_product.name;
    END IF;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity', v_quantity,
      'sale_price', COALESCE(v_product.sale_price, 0),
      'cost_price', COALESCE(v_product.cost_price, 0)
    ));
    v_subtotal := v_subtotal + (COALESCE(v_product.sale_price, 0) * v_quantity);
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

CREATE OR REPLACE FUNCTION public.list_public_campaigns()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT eon_private.list_public_campaigns(); $$;

CREATE OR REPLACE FUNCTION public.get_public_presale_catalog(p_campaign_reference TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT eon_private.get_public_presale_catalog(p_campaign_reference); $$;

CREATE OR REPLACE FUNCTION public.get_public_stock_catalog()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT eon_private.get_public_stock_catalog(); $$;

CREATE OR REPLACE FUNCTION public.create_public_presale_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT eon_private.create_public_presale_order(p_payload); $$;

CREATE OR REPLACE FUNCTION public.create_public_stock_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT eon_private.create_public_stock_order(p_payload); $$;

REVOKE ALL ON FUNCTION eon_private.list_public_campaigns() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.get_public_presale_catalog(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.get_public_stock_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.create_public_presale_order(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.create_public_stock_order(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_public_campaigns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_presale_catalog(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_stock_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_public_presale_order(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_public_stock_order(JSONB) FROM PUBLIC;

GRANT USAGE ON SCHEMA eon_private TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.list_public_campaigns() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.get_public_presale_catalog(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.get_public_stock_catalog() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.create_public_presale_order(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.create_public_stock_order(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_public_campaigns() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_presale_catalog(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_stock_catalog() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_presale_order(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_stock_order(JSONB) TO anon, authenticated;

COMMENT ON COLUMN public.presale_orders.payment_preference IS
  'Forma preferida no checkout; não comprova cobrança nem pagamento.';
COMMENT ON COLUMN public.stock_orders.payment_preference IS
  'Forma preferida no checkout; não comprova cobrança nem pagamento.';
COMMENT ON COLUMN public.presale_orders.public_token IS
  'Token revogável usado no acompanhamento público, separado do ID interno.';
COMMENT ON COLUMN public.stock_orders.public_token IS
  'Token revogável usado no acompanhamento público, separado do ID interno.';
