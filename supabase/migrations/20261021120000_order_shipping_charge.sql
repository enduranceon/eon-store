-- Frete cobrado depois do envio.
--
-- O checkout já avisa que o frete é calculado e enviado à parte. Agora o
-- pedido com frete (loja ou pré-venda) ganha a etapa "Enviado": ao marcar,
-- o administrador informa o rastreio, quanto pagou de frete e quanto vai
-- cobrar (pode ser um pouco mais, pelo imposto). O sistema cria a cobrança do
-- frete como um pedido da loja só com o item "Frete", ligado ao pedido de
-- origem: segue o caminho de qualquer cobrança (link externo, Central,
-- conferência do Asaas, "Receber", Financeiro), sem mexer em estoque e sem
-- comissão. O que foi pago de frete entra no Financeiro como despesa da loja.

-- Campos --------------------------------------------------------------------------

ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS tracking_code text,
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipping_cost numeric(12,2),
  ADD COLUMN IF NOT EXISTS shipping_parent_type text,
  ADD COLUMN IF NOT EXISTS shipping_parent_id uuid;
ALTER TABLE public.presale_orders
  ADD COLUMN IF NOT EXISTS tracking_code text,
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipping_cost numeric(12,2);

ALTER TABLE public.stock_orders DROP CONSTRAINT IF EXISTS stock_orders_shipping_cost_check;
ALTER TABLE public.stock_orders
  ADD CONSTRAINT stock_orders_shipping_cost_check CHECK (shipping_cost IS NULL OR shipping_cost >= 0);
ALTER TABLE public.presale_orders DROP CONSTRAINT IF EXISTS presale_orders_shipping_cost_check;
ALTER TABLE public.presale_orders
  ADD CONSTRAINT presale_orders_shipping_cost_check CHECK (shipping_cost IS NULL OR shipping_cost >= 0);
ALTER TABLE public.stock_orders DROP CONSTRAINT IF EXISTS stock_orders_shipping_parent_check;
ALTER TABLE public.stock_orders
  ADD CONSTRAINT stock_orders_shipping_parent_check CHECK (
    (shipping_parent_type IS NULL AND shipping_parent_id IS NULL)
    OR (shipping_parent_type IN ('stock', 'presale') AND shipping_parent_id IS NOT NULL)
  );

-- Uma cobrança de frete em aberto (ou paga) por pedido.
CREATE UNIQUE INDEX IF NOT EXISTS stock_orders_one_shipping_charge
  ON public.stock_orders (shipping_parent_type, shipping_parent_id)
  WHERE shipping_parent_id IS NOT NULL
    AND COALESCE(payment_status, '') NOT IN ('cancelled', 'refunded');

COMMENT ON COLUMN public.stock_orders.tracking_code IS 'Código de rastreio do envio (pedido com frete).';
COMMENT ON COLUMN public.stock_orders.shipped_at IS 'Quando o pedido com frete foi marcado como enviado.';
COMMENT ON COLUMN public.stock_orders.shipping_cost IS 'Quanto a loja pagou de frete neste envio (despesa no Financeiro).';
COMMENT ON COLUMN public.stock_orders.shipping_parent_id IS
  'Preenchido só na cobrança de frete: o pedido (shipping_parent_type) cujo frete este pedido cobra.';
COMMENT ON COLUMN public.presale_orders.tracking_code IS 'Código de rastreio do envio (pedido com frete).';
COMMENT ON COLUMN public.presale_orders.shipped_at IS 'Quando o pedido com frete foi marcado como enviado.';
COMMENT ON COLUMN public.presale_orders.shipping_cost IS 'Quanto a loja pagou de frete neste envio (despesa no Financeiro).';

-- Etapa "Enviado" ------------------------------------------------------------------
-- Só para pedido com frete: separado -> enviado -> entregue. Separado ->
-- entregue continua valendo (retirada ou envio sem registro). A cobrança de
-- frete não tem etapa de entrega.

CREATE OR REPLACE FUNCTION public.update_order_fulfillment(
  p_order_type text,
  p_order_id uuid,
  p_delivery_status text,
  p_delivery_date date,
  p_internal_notes text,
  p_fulfillment_reason text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_previous_delivery_status TEXT;
  v_previous_delivery_date DATE;
  v_previous_internal_notes TEXT;
  v_delivery_method TEXT;
  v_is_shipping_charge BOOLEAN := false;
  v_effective_previous_status TEXT;
  v_target_delivery_status TEXT;
  v_next_delivery_date DATE;
  v_next_internal_notes TEXT;
  v_fulfillment_reason TEXT := NULLIF(trim(COALESCE(p_fulfillment_reason, '')), '');
  v_status_changed BOOLEAN;
  v_date_changed BOOLEAN;
  v_notes_changed BOOLEAN;
  v_result JSONB;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;

  IF p_delivery_status IS NOT NULL
    AND p_order_type = 'presale'
    AND p_delivery_status NOT IN (
      'awaiting_supplier', 'supplier_ordered', 'received', 'separated', 'shipped', 'delivered', 'cancelled'
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Status de entrega inválido';
  END IF;

  IF p_delivery_status IS NOT NULL
    AND p_order_type = 'stock'
    AND p_delivery_status NOT IN (
      'awaiting_delivery', 'separated', 'shipped', 'delivered', 'cancelled'
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Status de entrega inválido';
  END IF;

  IF char_length(COALESCE(p_internal_notes, '')) > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Observações muito longas';
  END IF;

  IF char_length(COALESCE(v_fulfillment_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo muito longo';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT o.delivery_status, o.delivery_date, o.internal_notes, o.delivery_method
      INTO v_previous_delivery_status, v_previous_delivery_date, v_previous_internal_notes, v_delivery_method
    FROM public.presale_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT o.delivery_status, o.delivery_date, o.internal_notes, o.delivery_method,
           o.shipping_parent_id IS NOT NULL
      INTO v_previous_delivery_status, v_previous_delivery_date, v_previous_internal_notes, v_delivery_method,
           v_is_shipping_charge
    FROM public.stock_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  -- A missing legacy status is only interpreted as the beginning of the flow
  -- for validation. It is never normalized by a notes-only save.
  v_effective_previous_status := COALESCE(
    v_previous_delivery_status,
    CASE WHEN p_order_type = 'presale' THEN 'awaiting_supplier' ELSE 'awaiting_delivery' END
  );
  v_target_delivery_status := COALESCE(p_delivery_status, v_previous_delivery_status);
  v_status_changed := v_target_delivery_status IS DISTINCT FROM v_previous_delivery_status;

  IF v_status_changed THEN
    IF v_is_shipping_charge THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'A cobrança de frete não tem etapa de entrega';
    END IF;

    IF v_target_delivery_status = 'shipped' AND v_delivery_method IS DISTINCT FROM 'shipping' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Só pedido com frete tem a etapa Enviado';
    END IF;

    IF p_order_type = 'presale' THEN
      IF NOT (
        (v_effective_previous_status = 'awaiting_supplier'
          AND v_target_delivery_status IN ('awaiting_supplier', 'supplier_ordered', 'cancelled'))
        OR (v_effective_previous_status = 'supplier_ordered'
          AND v_target_delivery_status IN ('received', 'cancelled'))
        OR (v_effective_previous_status = 'received'
          AND v_target_delivery_status IN ('separated', 'cancelled'))
        OR (v_effective_previous_status = 'separated'
          AND v_target_delivery_status IN ('shipped', 'delivered', 'cancelled'))
        OR (v_effective_previous_status = 'shipped'
          AND v_target_delivery_status IN ('delivered', 'cancelled'))
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Transição de entrega inválida para este pedido';
      END IF;
    ELSIF NOT (
      (v_effective_previous_status = 'awaiting_delivery'
        AND v_target_delivery_status IN ('awaiting_delivery', 'separated', 'cancelled'))
      OR (v_effective_previous_status = 'separated'
        AND v_target_delivery_status IN ('shipped', 'delivered', 'cancelled'))
      OR (v_effective_previous_status = 'shipped'
        AND v_target_delivery_status IN ('delivered', 'cancelled'))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Transição de entrega inválida para este pedido';
    END IF;

    IF v_target_delivery_status = 'cancelled' AND v_fulfillment_reason IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Informe o motivo para interromper a entrega';
    END IF;
  END IF;

  -- Null means "leave unchanged" at the API boundary. An empty notes string
  -- still deliberately clears the notes. This prevents an unrelated PATCH
  -- from silently erasing data on legacy orders.
  v_next_delivery_date := COALESCE(p_delivery_date, v_previous_delivery_date);
  v_next_internal_notes := CASE
    WHEN p_internal_notes IS NULL THEN v_previous_internal_notes
    ELSE NULLIF(trim(p_internal_notes), '')
  END;

  IF v_status_changed
    AND v_target_delivery_status = 'delivered'
    AND p_delivery_date IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Informe a data ao marcar o pedido como entregue';
  END IF;

  v_date_changed := v_next_delivery_date IS DISTINCT FROM v_previous_delivery_date;
  v_notes_changed := v_next_internal_notes IS DISTINCT FROM v_previous_internal_notes;

  IF NOT (v_status_changed OR v_date_changed OR v_notes_changed) THEN
    IF p_order_type = 'presale' THEN
      SELECT to_jsonb(o) INTO v_result
      FROM public.presale_orders o
      WHERE o.id = p_order_id;
    ELSE
      SELECT to_jsonb(o) INTO v_result
      FROM public.stock_orders o
      WHERE o.id = p_order_id;
    END IF;
    RETURN v_result;
  END IF;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET delivery_status = v_target_delivery_status,
        delivery_date = v_next_delivery_date,
        internal_notes = v_next_internal_notes,
        shipped_at = CASE WHEN v_target_delivery_status = 'shipped' THEN COALESCE(o.shipped_at, now()) ELSE o.shipped_at END,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET delivery_status = v_target_delivery_status,
        delivery_date = v_next_delivery_date,
        internal_notes = v_next_internal_notes,
        shipped_at = CASE WHEN v_target_delivery_status = 'shipped' THEN COALESCE(o.shipped_at, now()) ELSE o.shipped_at END,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  IF v_status_changed THEN
    INSERT INTO public.sales_status_events (
      order_type,
      order_id,
      previous_status,
      new_status,
      reason,
      metadata,
      actor_id
    ) VALUES (
      p_order_type,
      p_order_id,
      v_previous_delivery_status,
      v_target_delivery_status,
      COALESCE(v_fulfillment_reason, 'Etapa de entrega atualizada'),
      jsonb_build_object(
        'action', 'fulfillment_status_changed',
        'status_domain', 'delivery',
        'previous_delivery_status', v_previous_delivery_status,
        'new_delivery_status', v_target_delivery_status,
        'delivery_date', v_next_delivery_date,
        'legacy_status_was_unset', v_previous_delivery_status IS NULL
      ),
      p_actor_id
    );
  END IF;

  RETURN v_result;
END;
$function$;

-- Enviar e cobrar o frete ------------------------------------------------------------
-- Marca o pedido com frete como enviado (de "Separado"; se já está enviado ou
-- entregue, só atualiza rastreio e custo) e, com valor a cobrar, cria a
-- cobrança de frete. Chamar de novo não duplica: devolve a cobrança aberta.

CREATE OR REPLACE FUNCTION public.mark_order_shipped(
  p_order_type text,
  p_order_id uuid,
  p_tracking_code text,
  p_shipping_cost numeric,
  p_shipping_price numeric,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tracking text := NULLIF(btrim(COALESCE(p_tracking_code, '')), '');
  v_cost numeric := CASE WHEN p_shipping_cost IS NULL THEN NULL ELSE round(p_shipping_cost, 2) END;
  v_price numeric := CASE WHEN p_shipping_price IS NULL THEN NULL ELSE round(p_shipping_price, 2) END;
  v_status text;
  v_method text;
  v_payment_status text;
  v_order_number text;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_whatsapp text;
  v_customer_email text;
  v_customer_cpf text;
  v_coach_id uuid;
  v_is_shipping_charge boolean := false;
  v_charge public.stock_orders%ROWTYPE;
  v_order jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') OR p_order_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;
  IF v_tracking IS NOT NULL AND char_length(v_tracking) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Código de rastreio muito longo';
  END IF;
  IF (v_cost IS NOT NULL AND (v_cost < 0 OR v_cost > 100000))
     OR (v_price IS NOT NULL AND (v_price < 0 OR v_price > 100000)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valor de frete inválido';
  END IF;

  IF p_order_type = 'stock' THEN
    SELECT o.delivery_status, o.delivery_method, o.payment_status, o.order_number, o.customer_id,
           o.customer_name, o.customer_whatsapp, o.customer_email, o.customer_cpf, o.coach_id,
           o.shipping_parent_id IS NOT NULL
      INTO v_status, v_method, v_payment_status, v_order_number, v_customer_id,
           v_customer_name, v_customer_whatsapp, v_customer_email, v_customer_cpf, v_coach_id,
           v_is_shipping_charge
    FROM public.stock_orders o WHERE o.id = p_order_id FOR UPDATE;
  ELSE
    SELECT o.delivery_status, o.delivery_method, o.payment_status, o.order_number, o.customer_id,
           COALESCE(NULLIF(o.customer_name, ''), o.checkout_name),
           COALESCE(NULLIF(o.customer_whatsapp, ''), o.checkout_whatsapp),
           COALESCE(NULLIF(o.customer_email, ''), o.checkout_email),
           NULL, o.coach_id
      INTO v_status, v_method, v_payment_status, v_order_number, v_customer_id,
           v_customer_name, v_customer_whatsapp, v_customer_email, v_customer_cpf, v_coach_id
    FROM public.presale_orders o WHERE o.id = p_order_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF v_is_shipping_charge THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A cobrança de frete não é enviada';
  END IF;
  IF v_method IS DISTINCT FROM 'shipping' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Só pedido com frete tem a etapa Enviado';
  END IF;
  IF v_payment_status IN ('cancelled', 'refunded') OR v_status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Pedido cancelado não é enviado';
  END IF;

  IF v_status = 'separated' THEN
    PERFORM public.update_order_fulfillment(p_order_type, p_order_id, 'shipped', NULL, NULL, NULL, p_actor_id);
  ELSIF v_status NOT IN ('shipped', 'delivered') OR v_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Marque o pedido como separado antes de enviar';
  END IF;

  IF p_order_type = 'stock' THEN
    UPDATE public.stock_orders o
    SET tracking_code = COALESCE(v_tracking, o.tracking_code),
        shipping_cost = COALESCE(v_cost, o.shipping_cost),
        shipped_at = COALESCE(o.shipped_at, now()),
        updated_date = now()
    WHERE o.id = p_order_id;
  ELSE
    UPDATE public.presale_orders o
    SET tracking_code = COALESCE(v_tracking, o.tracking_code),
        shipping_cost = COALESCE(v_cost, o.shipping_cost),
        shipped_at = COALESCE(o.shipped_at, now()),
        updated_date = now()
    WHERE o.id = p_order_id;
    SELECT c.cpf INTO v_customer_cpf FROM public.presale_customers c WHERE c.id = v_customer_id;
  END IF;

  SELECT * INTO v_charge
  FROM public.stock_orders charge
  WHERE charge.shipping_parent_type = p_order_type
    AND charge.shipping_parent_id = p_order_id
    AND COALESCE(charge.payment_status, '') NOT IN ('cancelled', 'refunded')
  ORDER BY charge.created_date DESC
  LIMIT 1;

  IF v_charge.id IS NULL AND COALESCE(v_price, 0) > 0 THEN
    INSERT INTO public.stock_orders (
      customer_id, customer_name, customer_whatsapp, customer_email, customer_cpf, coach_id,
      items, total_value, discount_value, manual_discount, payment_status,
      delivery_method, delivery_status, shipping_parent_type, shipping_parent_id,
      created_by, internal_notes
    ) VALUES (
      v_customer_id, v_customer_name, v_customer_whatsapp, v_customer_email, v_customer_cpf, v_coach_id,
      jsonb_build_array(jsonb_build_object(
        'product_id', NULL,
        'product_name', CASE WHEN COALESCE(v_tracking, '') <> '' THEN 'Frete (rastreio ' || v_tracking || ')' ELSE 'Frete' END,
        'kind', 'shipping',
        'quantity', 1,
        'sale_price', v_price,
        'cost_price', COALESCE(v_cost, 0),
        'stock_reserved', false
      )),
      v_price, 0, 0, 'awaiting_charge',
      NULL, NULL, p_order_type, p_order_id,
      p_actor_id, 'Cobrança do frete do pedido ' || COALESCE(v_order_number, '')
    )
    RETURNING * INTO v_charge;

    INSERT INTO public.sales_status_events (
      order_type, order_id, previous_status, new_status, reason, metadata, actor_id
    ) VALUES
      (p_order_type, p_order_id, v_payment_status, COALESCE(v_payment_status, 'pending'),
       'Cobrança de frete criada',
       jsonb_build_object('action', 'shipping_charge_created', 'shipping_charge_id', v_charge.id,
         'shipping_charge_number', v_charge.order_number, 'shipping_price', v_price, 'shipping_cost', v_cost,
         'tracking_code', v_tracking),
       p_actor_id),
      ('stock', v_charge.id, NULL, 'awaiting_charge',
       'Cobrança do frete do pedido ' || COALESCE(v_order_number, ''),
       jsonb_build_object('action', 'shipping_charge_created', 'parent_order_type', p_order_type,
         'parent_order_id', p_order_id, 'parent_order_number', v_order_number),
       p_actor_id);
  END IF;

  IF p_order_type = 'stock' THEN
    SELECT to_jsonb(o) INTO v_order FROM public.stock_orders o WHERE o.id = p_order_id;
  ELSE
    SELECT to_jsonb(o) INTO v_order FROM public.presale_orders o WHERE o.id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'order', v_order,
    'shipping_charge', CASE WHEN v_charge.id IS NULL THEN NULL ELSE to_jsonb(v_charge) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_order_shipped(text, uuid, text, numeric, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_shipped(text, uuid, text, numeric, numeric, uuid) TO service_role;

COMMENT ON FUNCTION public.mark_order_shipped(text, uuid, text, numeric, numeric, uuid) IS
  'Marca o pedido com frete como enviado (rastreio e custo) e cria a cobrança do frete, ligada ao pedido.';

-- Mensagem de cobrança: "do frete do seu pedido" -------------------------------------

DO $do$
DECLARE
  v_def text;
  v_new text;
  v_anchor constant text := E'    WHEN ''event'' THEN ''da sua inscrição''\n    ELSE ''do seu pedido'' END;';
BEGIN
  SELECT pg_get_functiondef('eon_private.communication_template_context(jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'communication_template_context: trecho do pedido não encontrado uma única vez';
  END IF;
  v_new := replace(v_def, v_anchor,
    E'    WHEN ''event'' THEN ''da sua inscrição''\n'
    || E'    -- Cobrança de frete: o item tem kind = shipping.\n'
    || E'    ELSE CASE WHEN jsonb_typeof(p_context->''items'') = ''array'' AND EXISTS (\n'
    || E'      SELECT 1 FROM jsonb_array_elements(p_context->''items'') AS shipping_item(value)\n'
    || E'      WHERE shipping_item.value->>''kind'' = ''shipping'')\n'
    || E'      THEN ''do frete do seu pedido'' ELSE ''do seu pedido'' END END;');
  EXECUTE v_new;
END
$do$;

-- Financeiro: o frete pago entra como despesa da loja -------------------------------

DO $do$
DECLARE
  v_def text;
  v_anchor constant text := '), payout_movements AS (';
  v_cte constant text := $cte$), shipping_cost_movements AS (
         SELECT 'shipping-cost:'::text || shipped.order_type || ':'::text || shipped.id AS movement_id,
            'shipping_cost'::text AS source,
            shipped.source_table,
            shipped.id AS source_id,
            shipped.id AS order_id,
            shipped.order_type,
            shipped.order_number AS reference,
            'loja'::text AS business_unit,
            context.revenue_center_id,
            'expense'::text AS movement_kind,
            'outflow'::text AS cash_direction,
            true AS is_actual,
            false AS is_legacy,
            'RECORDED'::text AS status,
            shipped.shipping_cost AS gross_amount,
            0::numeric AS fee_amount,
            shipped.shipping_cost AS net_amount,
            - shipped.shipping_cost AS signed_net_amount,
            NULL::text AS payment_method,
            shipped.shipped_on AS occurred_on,
            NULL::date AS due_on,
            shipped.shipped_on AS recognition_on,
            shipped.shipped_on AS scheduled_on,
            'Frete do pedido '::text || COALESCE(shipped.order_number, ''::text) AS description,
            shipped.shipped_at AS created_at,
            jsonb_strip_nulls(jsonb_build_object('category', 'frete', 'tracking_code', shipped.tracking_code)) AS metadata
           FROM ( SELECT 'stock'::text AS order_type,
                    'stock_orders'::text AS source_table,
                    o.id, o.order_number, o.shipping_cost, o.shipped_at, o.tracking_code,
                    (o.shipped_at AT TIME ZONE 'America/Sao_Paulo')::date AS shipped_on
                   FROM stock_orders o
                  WHERE COALESCE(o.shipping_cost, 0::numeric) > 0::numeric AND o.shipped_at IS NOT NULL
                UNION ALL
                 SELECT 'presale'::text,
                    'presale_orders'::text,
                    o.id, o.order_number, o.shipping_cost, o.shipped_at, o.tracking_code,
                    (o.shipped_at AT TIME ZONE 'America/Sao_Paulo')::date
                   FROM presale_orders o
                  WHERE COALESCE(o.shipping_cost, 0::numeric) > 0::numeric AND o.shipped_at IS NOT NULL) shipped
             LEFT JOIN LATERAL ( SELECT order_context.revenue_center_id
                   FROM order_context
                  WHERE order_context.order_type = shipped.order_type AND order_context.order_id = shipped.id
                 LIMIT 1) context ON true
        ), payout_movements AS ($cte$;
BEGIN
  v_def := pg_get_viewdef('public.financial_movements'::regclass, true);
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'financial_movements: trecho do repasse não encontrado uma única vez';
  END IF;
  v_def := replace(v_def, v_anchor, v_cte);
  v_def := rtrim(v_def, E' \n;') || E'\nUNION ALL\n SELECT shipping_cost_movements.* FROM shipping_cost_movements';
  EXECUTE 'CREATE OR REPLACE VIEW public.financial_movements WITH (security_invoker = true) AS ' || v_def;
END
$do$;

-- Enviado já saiu da loja ----------------------------------------------------------
-- Para estoque e devolução, Enviado vale como Entregue: o produto está com o
-- correio ou com a pessoa. Cancelar ou estornar um pedido enviado não repõe o
-- estoque na hora (espera a devolução, como no entregue), e os itens de um
-- pedido enviado não podem mais ser trocados. A cobrança do frete também não
-- tem itens para trocar.

DO $do$
DECLARE
  v_patch record;
  v_def text;
  v_found integer;
BEGIN
  FOR v_patch IN
    SELECT * FROM (VALUES
      ('public.complete_order_cancellation(uuid,jsonb)'::regprocedure,
       $p$COALESCE(v_delivery_status, '') <> 'delivered'$p$,
       $p$COALESCE(v_delivery_status, '') NOT IN ('delivered', 'shipped')$p$, 3),
      ('public.complete_order_cancellation(uuid,jsonb)'::regprocedure,
       $p$WHEN COALESCE(delivery_status, '') = 'delivered' THEN delivery_status$p$,
       $p$WHEN COALESCE(delivery_status, '') IN ('delivered', 'shipped') THEN delivery_status$p$, 2),
      ('public.complete_order_refund(uuid,jsonb)'::regprocedure,
       $p$v_was_delivered := COALESCE(v_delivery_status, '') = 'delivered';$p$,
       $p$v_was_delivered := COALESCE(v_delivery_status, '') IN ('delivered', 'shipped');$p$, 1),
      ('public.sync_stock_on_order_change()'::regprocedure,
       $p$IF COALESCE(NEW.delivery_status, '') = 'delivered' THEN$p$,
       $p$IF COALESCE(NEW.delivery_status, '') IN ('delivered', 'shipped') THEN$p$, 1),
      ('public.replace_stock_order_items_from_api(uuid,jsonb,uuid)'::regprocedure,
       $p$  IF COALESCE(v_order.delivery_status, 'awaiting_delivery') IN ('separated', 'delivered', 'cancelled') THEN$p$,
       $p$  IF v_order.shipping_parent_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A cobrança de frete não tem itens para ajustar';
  END IF;

  IF COALESCE(v_order.delivery_status, 'awaiting_delivery') IN ('separated', 'shipped', 'delivered', 'cancelled') THEN$p$, 1)
    ) AS patch(fn, from_text, to_text, expected)
  LOOP
    v_def := pg_get_functiondef(v_patch.fn);
    v_found := (length(v_def) - length(replace(v_def, v_patch.from_text, ''))) / length(v_patch.from_text);
    IF v_found <> v_patch.expected THEN
      RAISE EXCEPTION '%: trecho "%" encontrado % vez(es), esperado %',
        v_patch.fn, v_patch.from_text, v_found, v_patch.expected;
    END IF;
    EXECUTE replace(v_def, v_patch.from_text, v_patch.to_text);
  END LOOP;
END
$do$;
