-- Public checkout data is an order snapshot. A visitor has not proved that
-- they own an existing customer record, so the checkout must neither mutate
-- nor link that record. Administrators can review the unlinked order later.

CREATE OR REPLACE FUNCTION eon_private.create_public_presale_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.presale_campaigns%ROWTYPE;
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
  v_phone TEXT := regexp_replace(
    COALESCE(p_payload #>> '{customer,whatsapp}', ''),
    '\D',
    '',
    'g'
  );
  v_email TEXT := lower(NULLIF(trim(p_payload #>> '{customer,email}'), ''));
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
  IF char_length(v_phone) NOT BETWEEN 10 AND 11 THEN
    RAISE EXCEPTION 'WhatsApp inválido';
  END IF;
  IF v_email IS NOT NULL AND char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'E-mail inválido';
  END IF;
  IF v_delivery_method IS NULL OR v_delivery_method NOT IN ('pickup', 'shipping') THEN
    RAISE EXCEPTION 'Forma de entrega inválida';
  END IF;
  IF v_delivery_method = 'pickup' AND v_delivery_city IS NULL THEN
    RAISE EXCEPTION 'Informe a cidade de retirada';
  END IF;
  IF v_delivery_city IS NOT NULL AND char_length(v_delivery_city) > 120 THEN
    RAISE EXCEPTION 'Cidade inválida';
  END IF;
  IF v_payment_preference IS NULL OR (
    v_payment_preference <> 'pix_boleto'
    AND v_payment_preference !~ '^card_([1-9]|1[0-2])x$'
  ) THEN
    RAISE EXCEPTION 'Preferência de pagamento inválida';
  END IF;
  IF p_payload->'items' IS NULL
     OR jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'items') = 0 THEN
    RAISE EXCEPTION 'Adicione produtos ao pedido';
  END IF;
  IF jsonb_array_length(p_payload->'items') > 50
     OR octet_length(p_payload::text) > 100000 THEN
    RAISE EXCEPTION 'Pedido excede o limite permitido';
  END IF;

  SELECT * INTO v_campaign
  FROM public.presale_campaigns
  WHERE id = (p_payload->>'campaign_id')::uuid
  FOR SHARE;

  IF NOT FOUND
     OR v_campaign.status <> 'active'
     OR (
       v_campaign.end_date IS NOT NULL
       AND v_campaign.end_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
     ) THEN
    RAISE EXCEPTION 'Esta pré-venda está encerrada';
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_payload->'items')
    ORDER BY value->>'product_id'
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > 100 THEN
      RAISE EXCEPTION 'Quantidade inválida';
    END IF;

    SELECT * INTO v_product
    FROM public.presale_products
    WHERE id = (v_item->>'product_id')::uuid
      AND status = 'active'
      AND (
        campaign_id = v_campaign.id
        OR v_campaign.id = ANY(COALESCE(campaign_ids, '{}'::uuid[]))
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produto indisponível';
    END IF;

    v_variation := NULL;
    IF NULLIF(v_item->>'variation', '') IS NOT NULL THEN
      SELECT value INTO v_variation
      FROM jsonb_array_elements(COALESCE(v_product.variations, '[]'::jsonb))
      WHERE value->>'name' = v_item->>'variation'
      LIMIT 1;
      IF v_variation IS NULL THEN
        RAISE EXCEPTION 'Variação indisponível para %', v_product.name;
      END IF;
    END IF;

    v_sale_price := COALESCE(
      (v_variation->>'sale_price')::numeric,
      v_product.sale_price,
      0
    );
    v_cost_price := COALESCE(
      (v_variation->>'cost_price')::numeric,
      v_product.cost_price,
      0
    );
    v_valid_extras := '[]'::jsonb;
    v_extra_names := ARRAY[]::text[];
    v_extras_total := 0;

    FOR v_requested_extra IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_item->'extras', '[]'::jsonb))
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
      IF v_catalog_extra IS NULL THEN
        RAISE EXCEPTION 'Adicional indisponível para %', v_product.name;
      END IF;
      v_valid_extras := v_valid_extras || jsonb_build_array(
        jsonb_build_object(
          'name', v_catalog_extra->>'name',
          'price', COALESCE((v_catalog_extra->>'price')::numeric, 0)
        )
      );
      v_extras_total := v_extras_total
        + COALESCE((v_catalog_extra->>'price')::numeric, 0);
    END LOOP;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product.id,
        'product_name', v_product.name,
        'variation', v_variation->>'name',
        'extras', v_valid_extras,
        'extras_total', v_extras_total,
        'quantity', v_quantity,
        'sale_price', v_sale_price,
        'cost_price', v_cost_price
      )
    );
    v_subtotal := v_subtotal + ((v_sale_price + v_extras_total) * v_quantity);
    v_total_cost := v_total_cost + (v_cost_price * v_quantity);
  END LOOP;

  SELECT coupon_id, coupon_code, discount
  INTO v_coupon_id, v_coupon_code, v_discount
  FROM eon_private.claim_public_coupon(
    p_payload->>'coupon_code',
    v_subtotal,
    v_phone
  );

  INSERT INTO public.presale_orders(
    campaign_id,
    customer_id,
    checkout_name,
    checkout_whatsapp,
    checkout_email,
    items,
    total_value,
    total_cost,
    delivery_method,
    delivery_city,
    payment_preference,
    payment_method,
    payment_status,
    due_date,
    delivery_status,
    coupon_code,
    discount_value
  ) VALUES (
    v_campaign.id,
    NULL,
    v_name,
    v_phone,
    v_email,
    v_items,
    GREATEST(v_subtotal - v_discount, 0),
    v_total_cost,
    v_delivery_method,
    v_delivery_city,
    v_payment_preference,
    NULL,
    'awaiting_charge',
    NULL,
    'awaiting_supplier',
    v_coupon_code,
    v_discount
  )
  RETURNING * INTO v_order;

  IF v_coupon_id IS NOT NULL THEN
    INSERT INTO public.coupon_uses(
      coupon_id,
      coupon_code,
      order_id,
      order_type,
      order_number,
      customer_identifier,
      customer_name,
      discount_applied
    ) VALUES (
      v_coupon_id,
      v_coupon_code,
      v_order.id,
      'presale',
      v_order.order_number,
      v_phone,
      v_name,
      v_discount
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
    'items', COALESCE(
      (
        SELECT jsonb_agg(item.value - 'cost_price' ORDER BY item.ordinality)
        FROM jsonb_array_elements(v_order.items)
          WITH ORDINALITY AS item(value, ordinality)
      ),
      '[]'::jsonb
    ),
    'coupon_code', v_order.coupon_code,
    'discount_value', v_order.discount_value
  );
END;
$$;

COMMENT ON FUNCTION eon_private.create_public_presale_order(JSONB) IS
  'Creates an unlinked public presale order from immutable checkout snapshots; customer linking requires an administrative decision.';

-- A public checkout no longer chooses a canonical customer. Keep the Asaas
-- saga closed until an administrator makes that decision. Enforcing this at
-- the operation ledger prevents any service-role caller from bypassing the UI.
CREATE OR REPLACE FUNCTION eon_private.require_presale_customer_for_asaas()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.operation_type = 'create_charge'
     AND NEW.order_type = 'presale'
     AND NEW.status = 'prepared'
     AND NOT EXISTS (
       SELECT 1
       FROM public.presale_orders AS orders
       WHERE orders.id = NEW.order_id
         AND orders.customer_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Confirme o cliente do pedido antes de gerar uma cobrança Asaas';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.require_presale_customer_for_asaas()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS require_presale_customer_for_asaas
  ON public.order_operations;
CREATE TRIGGER require_presale_customer_for_asaas
BEFORE INSERT OR UPDATE
ON public.order_operations
FOR EACH ROW
EXECUTE FUNCTION eon_private.require_presale_customer_for_asaas();

COMMENT ON FUNCTION eon_private.require_presale_customer_for_asaas() IS
  'Rejects preparation of an Asaas charge for an unreviewed public presale identity.';
COMMENT ON TRIGGER require_presale_customer_for_asaas
  ON public.order_operations IS
  'Requires a reviewed presale customer before opening an Asaas charge operation.';

-- Customer merge and legacy service code can update presale_orders directly.
-- Once a financial operation has been prepared, moving its customer would let
-- the provider request use a different identity from the current order.
CREATE OR REPLACE FUNCTION eon_private.block_presale_customer_change_during_operation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     AND EXISTS (
       SELECT 1
       FROM public.order_operations AS operation
       WHERE operation.order_type = 'presale'
         AND operation.order_id = OLD.id
         AND operation.status IN ('prepared', 'reconciliation_required')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Aguarde a conclusão ou reconciliação da operação financeira antes de vincular o cliente';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  eon_private.block_presale_customer_change_during_operation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS block_presale_customer_change_during_operation
  ON public.presale_orders;
CREATE TRIGGER block_presale_customer_change_during_operation
BEFORE UPDATE OF customer_id
ON public.presale_orders
FOR EACH ROW
EXECUTE FUNCTION eon_private.block_presale_customer_change_during_operation();

COMMENT ON FUNCTION
  eon_private.block_presale_customer_change_during_operation() IS
  'Prevents customer links and merges from changing the identity of a pending financial operation.';
COMMENT ON TRIGGER block_presale_customer_change_during_operation
  ON public.presale_orders IS
  'Keeps a presale customer stable while a financial operation is pending or awaiting reconciliation.';

-- The existing generic prepare function remains the implementation for stock
-- and contracts. Presale uses this wrapper so the identity displayed by the
-- administrative screen is validated under the same order lock that opens the
-- financial operation. Existing idempotent commands are delegated unchanged;
-- the underlying function validates their stored fingerprint and state.
CREATE OR REPLACE FUNCTION public.prepare_presale_order_charge_creation(
  p_order_id UUID,
  p_billing_type TEXT,
  p_due_date DATE,
  p_installments INTEGER,
  p_customer_cpf TEXT,
  p_idempotency_key TEXT,
  p_expected_customer_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.presale_orders%ROWTYPE;
  v_existing_operation BOOLEAN;
BEGIN
  IF p_order_id IS NULL OR p_expected_customer_id IS NULL
     OR p_expected_updated_at IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Pedido, cliente, versão ou operador inválido';
  END IF;

  SELECT true
  INTO v_existing_operation
  FROM public.order_operations AS operation
  WHERE operation.operation_type = 'create_charge'
    AND operation.operation_key = p_idempotency_key
    AND operation.order_type = 'presale'
    AND operation.order_id = p_order_id;

  IF coalesce(v_existing_operation, false) THEN
    RETURN public.prepare_order_charge_creation(
      'presale',
      p_order_id,
      p_billing_type,
      p_due_date,
      p_installments,
      p_customer_cpf,
      NULL,
      p_idempotency_key,
      p_actor_id
    );
  END IF;

  -- Customer merges lock customer rows before moving their orders. Following
  -- that order prevents a merge/charge deadlock and proves the expected
  -- customer still exists before the order is locked.
  PERFORM 1
  FROM public.presale_customers
  WHERE id = p_expected_customer_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Cliente confirmado não encontrado';
  END IF;

  SELECT orders.*
  INTO v_order
  FROM public.presale_orders AS orders
  WHERE orders.id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  IF v_order.customer_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Confirme o cliente do pedido antes de gerar uma cobrança Asaas';
  END IF;
  IF v_order.customer_id IS DISTINCT FROM p_expected_customer_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O vínculo do cliente mudou. Atualize a página antes de gerar a cobrança';
  END IF;
  IF coalesce(v_order.updated_date, v_order.created_date)
     IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O pedido mudou. Atualize a página antes de gerar a cobrança';
  END IF;

  RETURN public.prepare_order_charge_creation(
    'presale',
    p_order_id,
    p_billing_type,
    p_due_date,
    p_installments,
    p_customer_cpf,
    NULL,
    p_idempotency_key,
    p_actor_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_presale_order_charge_creation(
  UUID, TEXT, DATE, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_presale_order_charge_creation(
  UUID, TEXT, DATE, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID
) TO service_role;

COMMENT ON FUNCTION public.prepare_presale_order_charge_creation(
  UUID, TEXT, DATE, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID
) IS
  'Validates the reviewed presale identity and optimistic version atomically before delegating to the idempotent Asaas charge prepare function.';

DROP FUNCTION IF EXISTS public.link_presale_order_customer(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.link_presale_order_customer(
  UUID, UUID, TIMESTAMPTZ, UUID
);

CREATE OR REPLACE FUNCTION public.link_presale_order_customer(
  p_order_id UUID,
  p_customer_id UUID,
  p_expected_customer_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.presale_orders%ROWTYPE;
  v_previous_customer_id UUID;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL
     OR p_expected_updated_at IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Pedido, cliente, versão ou operador inválido';
  END IF;

  -- Customer merges lock customer rows before moving orders. Follow the same
  -- order here to avoid a customer-merge/customer-link deadlock.
  PERFORM 1
  FROM public.presale_customers
  WHERE id = p_customer_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente não encontrado';
  END IF;

  SELECT orders.*
  INTO v_order
  FROM public.presale_orders AS orders
  WHERE orders.id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  IF v_order.customer_id IS NOT DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object(
      'order', to_jsonb(v_order),
      'unchanged', true
    );
  END IF;

  IF v_order.customer_id IS DISTINCT FROM p_expected_customer_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O vínculo do cliente foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  -- Financial prepare functions lock this order before opening their ledger
  -- entry. Holding the same row lock here makes the check race-safe: either
  -- the link finishes first and prepare sees the reviewed customer, or the
  -- pending operation is visible and the link is rejected.
  IF EXISTS (
    SELECT 1
    FROM public.order_operations AS operation
    WHERE operation.order_type = 'presale'
      AND operation.order_id = p_order_id
      AND operation.status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Aguarde a conclusão ou reconciliação da operação financeira antes de vincular o cliente';
  END IF;

  IF coalesce(v_order.payment_status, '') NOT IN (
    'pending', 'awaiting_charge', 'charge_sent', 'overdue'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O cliente não pode ser alterado depois que o pedido recebe pagamento ou é encerrado';
  END IF;

  IF nullif(v_order.asaas_customer_id, '') IS NOT NULL
     OR nullif(v_order.asaas_charge_id, '') IS NOT NULL
     OR nullif(v_order.asaas_payment_link, '') IS NOT NULL
     OR nullif(v_order.asaas_pix_copy, '') IS NOT NULL
     OR nullif(v_order.asaas_pix_qrcode, '') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.asaas_payments AS payment
       WHERE payment.order_type = 'presale'
         AND payment.order_id = p_order_id
         AND payment.source = 'asaas'
         AND coalesce(payment.status, '') NOT IN (
           'CANCELLED', 'CANCELED', 'REFUNDED', 'DELETED'
         )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Reconcilie a identidade da cobrança Asaas antes de alterar o cliente';
  END IF;

  IF v_order.customer_id IS NOT NULL AND (
    coalesce(v_order.payment_status, '') IN ('charge_sent', 'overdue')
    OR nullif(v_order.external_payment_link, '') IS NOT NULL
    OR v_order.payment_message_sent_at IS NOT NULL
    OR coalesce(v_order.manual_payment, false)
    OR v_order.payment_date IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Troque o cliente antes de criar cobrança ou registrar pagamento';
  END IF;

  IF coalesce(v_order.updated_date, v_order.created_date)
     IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'O pedido foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_previous_customer_id := v_order.customer_id;

  UPDATE public.presale_orders AS orders
  SET customer_id = p_customer_id,
      updated_date = now()
  WHERE orders.id = p_order_id
  RETURNING orders.* INTO v_order;

  INSERT INTO public.sales_status_events (
    order_type,
    order_id,
    previous_status,
    new_status,
    reason,
    metadata,
    actor_id
  ) VALUES (
    'presale',
    p_order_id,
    v_order.payment_status,
    v_order.payment_status,
    'Vínculo de cliente atualizado',
    jsonb_build_object(
      'action', 'customer_link_changed',
      'previous_customer_id', v_previous_customer_id,
      'new_customer_id', p_customer_id
    ),
    p_actor_id
  );

  RETURN jsonb_build_object(
    'order', to_jsonb(v_order),
    'unchanged', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.link_presale_order_customer(
  UUID, UUID, UUID, TIMESTAMPTZ, UUID
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_presale_order_customer(
  UUID, UUID, UUID, TIMESTAMPTZ, UUID
)
  TO service_role;

COMMENT ON FUNCTION public.link_presale_order_customer(
  UUID, UUID, UUID, TIMESTAMPTZ, UUID
) IS
  'Links an open presale order to a reviewed customer with optimistic concurrency and an audit event, without changing checkout snapshots.';

-- Unlinked public orders use checkout_name as their durable customer snapshot.
-- Keep that name visible if such an order is later refunded.
CREATE OR REPLACE VIEW public.refunds_overview
WITH (security_invoker = true) AS
SELECT
  'assessment_contract'::text AS source_type,
  contracts.id AS source_id,
  contracts.contract_number AS reference,
  contracts.customer_id,
  customers.full_name AS customer_name,
  COALESCE(contracts.refund_amount, 0)::numeric AS amount,
  contracts.refund_status AS status,
  'manual'::text AS kind,
  contracts.cancellation_date AS requested_on,
  contracts.refund_date AS completed_on,
  contracts.refund_notes AS notes,
  contracts.payment_method,
  contracts.cancellation_reason AS reason,
  contracts.updated_at
FROM public.assessment_contracts AS contracts
LEFT JOIN public.presale_customers AS customers
  ON customers.id = contracts.customer_id
WHERE contracts.refund_status IS NOT NULL
  AND COALESCE(contracts.refund_amount, 0) > 0

UNION ALL

SELECT
  'presale_order',
  orders.id,
  orders.order_number,
  orders.customer_id,
  COALESCE(customers.full_name, orders.checkout_name, orders.customer_name),
  COALESCE(orders.total_amount, orders.total_value, 0)::numeric,
  'done',
  'automatic',
  orders.status_changed_at::date,
  orders.status_changed_at::date,
  NULL,
  orders.payment_method,
  orders.cancellation_reason,
  orders.status_changed_at
FROM public.presale_orders AS orders
LEFT JOIN public.presale_customers AS customers
  ON customers.id = orders.customer_id
WHERE orders.payment_status = 'refunded'

UNION ALL

SELECT
  'stock_order',
  orders.id,
  orders.order_number,
  orders.customer_id,
  COALESCE(customers.full_name, orders.customer_name),
  COALESCE(orders.total_value, 0)::numeric,
  'done',
  'automatic',
  orders.status_changed_at::date,
  orders.status_changed_at::date,
  NULL,
  orders.payment_method,
  orders.cancellation_reason,
  orders.status_changed_at
FROM public.stock_orders AS orders
LEFT JOIN public.presale_customers AS customers
  ON customers.id = orders.customer_id
WHERE orders.payment_status = 'refunded';

REVOKE ALL ON public.refunds_overview FROM PUBLIC, anon;
GRANT SELECT ON public.refunds_overview TO authenticated, service_role;
