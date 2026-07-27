-- Centralize stock-order and inventory mutations behind api-v1.
-- All functions are invoked only by the service-role client after the Edge
-- Function has validated the caller as an allowlisted application admin.

CREATE TABLE public.stock_order_creation_operations (
  idempotency_key UUID PRIMARY KEY,
  requested_by UUID NOT NULL,
  request_payload JSONB NOT NULL,
  order_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.stock_order_creation_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stock_order_creation_operations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.stock_order_creation_operations
  TO service_role;

COMMENT ON TABLE public.stock_order_creation_operations IS
  'Server-only idempotency ledger for administrative stock-order creation.';

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
  v_product public.stock_products%ROWTYPE;
  v_order_id UUID := gen_random_uuid();
  v_customer_id UUID;
  v_item JSONB;
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
  SELECT count(*), count(DISTINCT value->>'product_id')
    INTO v_item_count, v_distinct_product_count
  FROM jsonb_array_elements(p_payload->'items');
  IF v_item_count < 1 OR v_item_count > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe entre 1 e 100 itens';
  END IF;
  IF v_item_count <> v_distinct_product_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O mesmo produto aparece mais de uma vez';
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
    ORDER BY value->>'product_id'
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

    SELECT * INTO v_product
    FROM public.stock_products
    WHERE id = v_product_id
    FOR UPDATE;
    IF NOT FOUND OR COALESCE(v_product.status, 'inactive') <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto ativo não encontrado';
    END IF;
    IF COALESCE(v_product.quantity, 0) < v_quantity THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format('Estoque insuficiente para "%s": disponível %s, requerido %s',
          v_product.name, COALESCE(v_product.quantity, 0), v_quantity);
    END IF;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity', v_quantity,
      'sale_price', round(COALESCE(v_product.sale_price, 0), 2),
      'cost_price', round(COALESCE(v_product.cost_price, 0), 2)
    ));
    v_subtotal := v_subtotal + round(COALESCE(v_product.sale_price, 0), 2) * v_quantity;
    v_total_cost := v_total_cost + round(COALESCE(v_product.cost_price, 0), 2) * v_quantity;
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

CREATE OR REPLACE FUNCTION public.update_order_fulfillment(
  p_order_type TEXT,
  p_order_id UUID,
  p_delivery_status TEXT,
  p_delivery_date DATE,
  p_internal_notes TEXT,
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
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;
  IF p_order_type = 'presale' AND p_delivery_status NOT IN (
    'awaiting_supplier', 'supplier_ordered', 'received', 'separated', 'delivered', 'cancelled'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Status de entrega inválido';
  END IF;
  IF p_order_type = 'stock' AND p_delivery_status NOT IN (
    'awaiting_delivery', 'separated', 'delivered', 'cancelled'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Status de entrega inválido';
  END IF;
  IF char_length(COALESCE(p_internal_notes, '')) > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Observações muito longas';
  END IF;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET delivery_status = p_delivery_status,
        delivery_date = p_delivery_date,
        internal_notes = NULLIF(trim(p_internal_notes), ''),
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET delivery_status = p_delivery_status,
        delivery_date = p_delivery_date,
        internal_notes = NULLIF(trim(p_internal_notes), ''),
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_order_payment_message_sent(
  p_order_type TEXT,
  p_order_id UUID,
  p_external_payment_link TEXT,
  p_due_date DATE,
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
  v_payment_link TEXT;
  v_pix_copy TEXT;
  v_existing_external_link TEXT;
  v_previous_status TEXT;
  v_external_link TEXT := NULLIF(trim(p_external_payment_link), '');
  v_result JSONB;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;
  IF v_external_link IS NOT NULL AND (
    char_length(v_external_link) > 2000 OR v_external_link !~* '^https://[^[:space:]]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Link externo inválido';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, asaas_payment_link,
           asaas_pix_copy, external_payment_link
      INTO v_payment_status, v_charge_id, v_payment_link,
           v_pix_copy, v_existing_external_link
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, asaas_payment_link,
           asaas_pix_copy, external_payment_link
      INTO v_payment_status, v_charge_id, v_payment_link,
           v_pix_copy, v_existing_external_link
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pedido não aceita envio de cobrança neste estado';
  END IF;
  IF NULLIF(v_charge_id, '') IS NULL
     AND NULLIF(v_payment_link, '') IS NULL
     AND NULLIF(v_pix_copy, '') IS NULL
     AND COALESCE(v_external_link, NULLIF(v_existing_external_link, '')) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Gere uma cobrança ou informe um link externo antes de efetivar a venda';
  END IF;
  IF NULLIF(v_charge_id, '') IS NULL AND p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a data de vencimento da cobrança externa';
  END IF;

  v_previous_status := v_payment_status;
  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET payment_message_sent_at = now(),
        external_payment_link = CASE
          WHEN NULLIF(v_charge_id, '') IS NULL THEN COALESCE(v_external_link, v_existing_external_link)
          ELSE external_payment_link
        END,
        due_date = CASE
          WHEN NULLIF(v_charge_id, '') IS NULL THEN p_due_date
          ELSE due_date
        END,
        payment_status = CASE
          WHEN payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
          ELSE payment_status
        END,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET payment_message_sent_at = now(),
        external_payment_link = CASE
          WHEN NULLIF(v_charge_id, '') IS NULL THEN COALESCE(v_external_link, v_existing_external_link)
          ELSE external_payment_link
        END,
        due_date = CASE
          WHEN NULLIF(v_charge_id, '') IS NULL THEN p_due_date
          ELSE due_date
        END,
        payment_status = CASE
          WHEN payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
          ELSE payment_status
        END,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    p_order_type, p_order_id, v_previous_status, 'charge_sent',
    CASE WHEN v_previous_status = 'charge_sent' THEN 'Cobrança reenviada' ELSE 'Cobrança enviada' END,
    jsonb_build_object(
      'action', CASE WHEN v_previous_status = 'charge_sent' THEN 'charge_resent' ELSE 'charge_sent' END,
      'channel', 'whatsapp',
      'via', CASE
        WHEN NULLIF(v_charge_id, '') IS NOT NULL THEN 'asaas'
        WHEN COALESCE(v_external_link, NULLIF(v_existing_external_link, '')) IS NOT NULL THEN 'external_link'
        ELSE 'message_only'
      END,
      'due_date', p_due_date
    ),
    p_actor_id
  );

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_order_discount(
  p_order_type TEXT,
  p_order_id UUID,
  p_manual_discount NUMERIC,
  p_discount_reason TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_items JSONB;
  v_coupon_discount NUMERIC;
  v_payment_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_manual_payment BOOLEAN;
  v_old_discount NUMERIC;
  v_subtotal NUMERIC := 0;
  v_item JSONB;
  v_quantity NUMERIC;
  v_sale_price NUMERIC;
  v_extras_total NUMERIC;
  v_total NUMERIC;
  v_result JSONB;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;
  IF p_manual_discount IS NULL OR p_manual_discount < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Desconto inválido';
  END IF;
  IF char_length(COALESCE(p_discount_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo do desconto muito longo';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT COALESCE(items, '[]'::jsonb), COALESCE(discount_value, 0),
           payment_status, asaas_charge_id, external_payment_link,
           COALESCE(manual_payment, false), COALESCE(manual_discount, 0)
      INTO v_items, v_coupon_discount, v_payment_status, v_charge_id,
           v_external_link, v_manual_payment, v_old_discount
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT COALESCE(items, '[]'::jsonb), COALESCE(discount_value, 0),
           payment_status, asaas_charge_id, external_payment_link,
           COALESCE(manual_payment, false), COALESCE(manual_discount, 0)
      INTO v_items, v_coupon_discount, v_payment_status, v_charge_id,
           v_external_link, v_manual_payment, v_old_discount
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF v_payment_status IN ('paid', 'partially_paid', 'cancelled', 'refunded') OR v_manual_payment THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O desconto não pode ser alterado neste estado';
  END IF;
  IF NULLIF(v_charge_id, '') IS NOT NULL OR NULLIF(v_external_link, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cancele a cobrança atual antes de alterar o desconto';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items)
  LOOP
    IF COALESCE((v_item->>'cancelled')::BOOLEAN, false) THEN
      CONTINUE;
    END IF;
    BEGIN
      v_quantity := COALESCE((v_item->>'quantity')::NUMERIC, 0);
      v_sale_price := COALESCE((v_item->>'sale_price')::NUMERIC, 0);
      v_extras_total := COALESCE((v_item->>'extras_total')::NUMERIC, 0);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pedido contém um item inválido';
    END;
    v_subtotal := v_subtotal + GREATEST(0, v_sale_price + v_extras_total) * GREATEST(0, v_quantity);
  END LOOP;

  IF p_manual_discount > GREATEST(0, v_subtotal - v_coupon_discount) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O desconto supera o saldo do pedido';
  END IF;
  v_total := round(GREATEST(0, v_subtotal - v_coupon_discount - p_manual_discount), 2);

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET manual_discount = round(p_manual_discount, 2),
        discount_reason = NULLIF(trim(p_discount_reason), ''),
        total_value = v_total,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET manual_discount = round(p_manual_discount, 2),
        discount_reason = NULLIF(trim(p_discount_reason), ''),
        total_value = v_total,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    p_order_type, p_order_id, v_payment_status, v_payment_status,
    'Desconto manual atualizado',
    jsonb_build_object(
      'action', 'manual_discount_updated',
      'previous_discount', v_old_discount,
      'new_discount', round(p_manual_discount, 2),
      'total_value', v_total
    ),
    p_actor_id
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_stock_order_from_admin(JSONB, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_order_fulfillment(TEXT, UUID, TEXT, DATE, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_payment_message_sent(TEXT, UUID, TEXT, DATE, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_order_discount(TEXT, UUID, NUMERIC, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_stock_order_from_admin(JSONB, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_order_fulfillment(TEXT, UUID, TEXT, DATE, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_payment_message_sent(TEXT, UUID, TEXT, DATE, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_order_discount(TEXT, UUID, NUMERIC, TEXT, UUID)
  TO service_role;

-- Reads remain available for the current frontend while writes are now only
-- accepted through api-v1. Public checkout continues through its privileged,
-- validated RPC and is unaffected by these table-level revocations.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.stock_orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.stock_products FROM anon, authenticated;
