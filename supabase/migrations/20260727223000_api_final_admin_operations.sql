-- Finaliza as operações compostas que ainda eram executadas pelo navegador.

CREATE OR REPLACE FUNCTION public.merge_presale_customers_from_api(
  p_target_id uuid,
  p_duplicate_id uuid,
  p_customer jsonb,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_target public.presale_customers%ROWTYPE;
  v_duplicate public.presale_customers%ROWTYPE;
  v_presale integer := 0;
  v_stock integer := 0;
  v_contracts integer := 0;
BEGIN
  IF p_target_id = p_duplicate_id OR p_customer IS NULL
     OR jsonb_typeof(p_customer) <> 'object' OR pg_column_size(p_customer) > 32768 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados de mesclagem inválidos';
  END IF;

  SELECT * INTO v_target FROM public.presale_customers WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente de destino não encontrado'; END IF;
  SELECT * INTO v_duplicate FROM public.presale_customers WHERE id = p_duplicate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente duplicado não encontrado'; END IF;

  UPDATE public.presale_orders SET customer_id = p_target_id WHERE customer_id = p_duplicate_id;
  GET DIAGNOSTICS v_presale = ROW_COUNT;
  UPDATE public.stock_orders SET customer_id = p_target_id WHERE customer_id = p_duplicate_id;
  GET DIAGNOSTICS v_stock = ROW_COUNT;
  UPDATE public.assessment_contracts SET customer_id = p_target_id, updated_at = now()
  WHERE customer_id = p_duplicate_id;
  GET DIAGNOSTICS v_contracts = ROW_COUNT;

  UPDATE public.presale_customers
  SET full_name = COALESCE(NULLIF(p_customer->>'full_name', ''), v_target.full_name),
      whatsapp = CASE WHEN p_customer ? 'whatsapp' THEN NULLIF(p_customer->>'whatsapp', '') ELSE v_target.whatsapp END,
      email = CASE WHEN p_customer ? 'email' THEN NULLIF(lower(p_customer->>'email'), '') ELSE v_target.email END,
      cpf = CASE WHEN p_customer ? 'cpf' THEN NULLIF(regexp_replace(p_customer->>'cpf', '\D', '', 'g'), '') ELSE v_target.cpf END,
      internal_notes = CASE WHEN p_customer ? 'internal_notes' THEN NULLIF(p_customer->>'internal_notes', '') ELSE v_target.internal_notes END,
      updated_date = now()
  WHERE id = p_target_id
  RETURNING * INTO v_target;

  DELETE FROM public.presale_customers WHERE id = p_duplicate_id;

  RETURN jsonb_build_object(
    'customer', to_jsonb(v_target),
    'moved', jsonb_build_object('presale_orders', v_presale, 'stock_orders', v_stock, 'contracts', v_contracts),
    'actor_id', p_actor_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_presale_order_items_from_api(
  p_order_id uuid,
  p_items jsonb,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.presale_orders%ROWTYPE;
  v_item jsonb;
  v_subtotal numeric := 0;
  v_total_cost numeric := 0;
  v_quantity integer;
  v_sale numeric;
  v_extras numeric;
  v_cost numeric;
  v_previous_status text;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 100
     OR pg_column_size(p_items) > 262144 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Itens inválidos';
  END IF;

  SELECT * INTO v_order FROM public.presale_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado'; END IF;
  IF v_order.payment_status IN ('paid', 'partially_paid', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Os itens não podem ser alterados no estado atual do pedido';
  END IF;
  IF NULLIF(v_order.asaas_charge_id, '') IS NOT NULL OR NULLIF(v_order.external_payment_link, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cancele a cobrança antes de alterar os itens';
  END IF;
  v_previous_status := v_order.payment_status;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Item inválido';
    END IF;
    v_quantity := COALESCE((v_item->>'quantity')::integer, 0);
    v_sale := COALESCE((v_item->>'sale_price')::numeric, 0);
    v_extras := COALESCE((v_item->>'extras_total')::numeric, 0);
    v_cost := COALESCE((v_item->>'cost_price')::numeric, 0);
    IF v_quantity < 1 OR v_quantity > 1000 OR v_sale < 0 OR v_extras < 0 OR v_cost < 0
       OR length(COALESCE(v_item->>'product_name', '')) > 500 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Item inválido';
    END IF;
    IF COALESCE((v_item->>'cancelled')::boolean, false) IS NOT TRUE THEN
      v_subtotal := v_subtotal + ((v_sale + v_extras) * v_quantity);
      v_total_cost := v_total_cost + (v_cost * v_quantity);
    END IF;
  END LOOP;

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id AND order_type = 'presale' AND source = 'manual';

  UPDATE public.presale_orders
  SET items = p_items,
      total_value = GREATEST(0, v_subtotal - COALESCE(discount_value, 0) - COALESCE(manual_discount, 0)),
      total_cost = v_total_cost,
      payment_status = 'awaiting_charge', payment_method = NULL, payment_date = NULL,
      due_date = NULL, asaas_charge_id = NULL, asaas_payment_link = NULL,
      asaas_pix_qrcode = NULL, asaas_pix_copy = NULL, external_payment_link = NULL,
      payment_message_sent_at = NULL, manual_payment = false, manual_fee = NULL,
      updated_date = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'presale', p_order_id, v_previous_status, 'awaiting_charge',
    'Itens alterados pela API',
    jsonb_build_object('action', 'items_replaced', 'item_count', jsonb_array_length(p_items)),
    p_actor_id
  );

  RETURN jsonb_build_object('order', to_jsonb(v_order));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_order_payment_message_sent_with_metadata(
  p_order_type text,
  p_order_id uuid,
  p_external_payment_link text,
  p_due_date date,
  p_metadata jsonb,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
     OR pg_column_size(p_metadata) > 32768 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Metadados da comunicação inválidos';
  END IF;

  v_result := public.mark_order_payment_message_sent(
    p_order_type, p_order_id, p_external_payment_link, p_due_date, p_actor_id
  );

  UPDATE public.sales_status_events
  SET metadata = metadata || p_metadata
  WHERE id = (
    SELECT id FROM public.sales_status_events
    WHERE order_type = p_order_type AND order_id = p_order_id AND actor_id = p_actor_id
    ORDER BY created_at DESC, id DESC LIMIT 1
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_presale_customers_from_api(uuid, uuid, jsonb, uuid)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_presale_order_items_from_api(uuid, jsonb, uuid)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_payment_message_sent_with_metadata(text, uuid, text, date, jsonb, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_presale_customers_from_api(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_presale_order_items_from_api(uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_payment_message_sent_with_metadata(text, uuid, text, date, jsonb, uuid) TO service_role;

COMMENT ON FUNCTION public.merge_presale_customers_from_api(uuid, uuid, jsonb, uuid) IS
  'Server-only: mescla todas as referências de dois clientes em uma transação.';
COMMENT ON FUNCTION public.replace_presale_order_items_from_api(uuid, jsonb, uuid) IS
  'Server-only: recalcula e substitui itens de pré-venda após cancelamento da cobrança.';
COMMENT ON FUNCTION public.mark_order_payment_message_sent_with_metadata(text, uuid, text, date, jsonb, uuid) IS
  'Server-only: registra o envio de cobrança e anexa metadados allowlisted da comunicação.';
