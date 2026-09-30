BEGIN;

-- Centros de receita: todo recebimento de produto e de plano cai num centro.
--
-- - As vendas da loja nunca achavam o centro do produto no extrato: a
--   conferência do código do produto tinha um bloco a menos e nunca batia.
-- - Item de pedido que aponta para o produto-base (e não para o produto da
--   loja ou da pré-venda) usa o centro dos produtos ligados a ele, quando
--   todos têm o mesmo.
-- - Loja e pré-venda ficam num centro só, "Loja" (antes "Loja · Equipamentos").
--   "Loja · Lifestyle", que nunca foi usado, fica inativo.
-- - Produtos, planos e eventos sem centro recebem o centro da sua área, com
--   cópia do estado anterior em eon_private.
-- - Cadastro novo sem centro recebe o centro da área, quando a área tem um
--   só centro ativo.

-- 1. Centro padrão da área -------------------------------------------------------

-- O centro ativo de um tipo (assessoria, loja, eventos), quando só existe um.
-- Com mais de um, não há padrão: a escolha fica com quem cadastra.
CREATE OR REPLACE FUNCTION eon_private.default_revenue_center(p_type text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(center.id))[1] END
  FROM public.revenue_centers AS center
  WHERE center.type = p_type
    AND COALESCE(center.active, true);
$$;

CREATE OR REPLACE FUNCTION eon_private.fill_default_revenue_center()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.revenue_center_id IS NULL THEN
    NEW.revenue_center_id := eon_private.default_revenue_center(TG_ARGV[0]);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_default_revenue_center ON public.presale_products;
CREATE TRIGGER fill_default_revenue_center
  BEFORE INSERT ON public.presale_products
  FOR EACH ROW EXECUTE FUNCTION eon_private.fill_default_revenue_center('loja');

DROP TRIGGER IF EXISTS fill_default_revenue_center ON public.stock_products;
CREATE TRIGGER fill_default_revenue_center
  BEFORE INSERT ON public.stock_products
  FOR EACH ROW EXECUTE FUNCTION eon_private.fill_default_revenue_center('loja');

DROP TRIGGER IF EXISTS fill_default_revenue_center ON public.assessment_plans;
CREATE TRIGGER fill_default_revenue_center
  BEFORE INSERT ON public.assessment_plans
  FOR EACH ROW EXECUTE FUNCTION eon_private.fill_default_revenue_center('assessoria');

DROP TRIGGER IF EXISTS fill_default_revenue_center ON public.events;
CREATE TRIGGER fill_default_revenue_center
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION eon_private.fill_default_revenue_center('eventos');

-- 2. Cópia do estado anterior ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS eon_private.revenue_center_backfill_backups (
  backup_key text PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);

REVOKE ALL ON TABLE eon_private.revenue_center_backfill_backups
  FROM PUBLIC, anon, authenticated, service_role;

-- 3. Loja e pré-venda num centro só -------------------------------------------------

INSERT INTO eon_private.revenue_center_backfill_backups (backup_key, snapshot)
SELECT 'revenue_centers:' || center.id::text, to_jsonb(center)
FROM public.revenue_centers AS center
WHERE center.type = 'loja'
  AND center.name IN ('Loja · Equipamentos', 'Loja · Lifestyle')
ON CONFLICT (backup_key) DO NOTHING;

UPDATE public.revenue_centers AS center
   SET name = 'Loja',
       updated_at = now()
 WHERE center.type = 'loja'
   AND center.name = 'Loja · Equipamentos'
   AND NOT EXISTS (
     SELECT 1 FROM public.revenue_centers AS other WHERE other.name = 'Loja'
   );

-- Só sai de uso se nada estiver ligado a ele.
UPDATE public.revenue_centers AS center
   SET active = false,
       updated_at = now()
 WHERE center.type = 'loja'
   AND center.name = 'Loja · Lifestyle'
   AND COALESCE(center.active, true)
   AND NOT EXISTS (SELECT 1 FROM public.presale_products AS product WHERE product.revenue_center_id = center.id)
   AND NOT EXISTS (SELECT 1 FROM public.stock_products AS product WHERE product.revenue_center_id = center.id)
   AND NOT EXISTS (SELECT 1 FROM public.assessment_plans AS plan WHERE plan.revenue_center_id = center.id)
   AND NOT EXISTS (SELECT 1 FROM public.events AS event WHERE event.revenue_center_id = center.id);

-- 4. Cadastros sem centro recebem o centro da sua área ------------------------------------

INSERT INTO eon_private.revenue_center_backfill_backups (backup_key, snapshot)
SELECT 'presale_products:' || product.id::text,
       jsonb_build_object('id', product.id, 'name', product.name, 'revenue_center_id', product.revenue_center_id)
FROM public.presale_products AS product
WHERE product.revenue_center_id IS NULL
  AND eon_private.default_revenue_center('loja') IS NOT NULL
ON CONFLICT (backup_key) DO NOTHING;

UPDATE public.presale_products
   SET revenue_center_id = eon_private.default_revenue_center('loja'),
       updated_date = now()
 WHERE revenue_center_id IS NULL
   AND eon_private.default_revenue_center('loja') IS NOT NULL;

INSERT INTO eon_private.revenue_center_backfill_backups (backup_key, snapshot)
SELECT 'stock_products:' || product.id::text,
       jsonb_build_object('id', product.id, 'name', product.name, 'revenue_center_id', product.revenue_center_id)
FROM public.stock_products AS product
WHERE product.revenue_center_id IS NULL
  AND eon_private.default_revenue_center('loja') IS NOT NULL
ON CONFLICT (backup_key) DO NOTHING;

UPDATE public.stock_products
   SET revenue_center_id = eon_private.default_revenue_center('loja'),
       updated_date = now()
 WHERE revenue_center_id IS NULL
   AND eon_private.default_revenue_center('loja') IS NOT NULL;

INSERT INTO eon_private.revenue_center_backfill_backups (backup_key, snapshot)
SELECT 'assessment_plans:' || plan.id::text,
       jsonb_build_object('id', plan.id, 'name', plan.name, 'revenue_center_id', plan.revenue_center_id)
FROM public.assessment_plans AS plan
WHERE plan.revenue_center_id IS NULL
  AND eon_private.default_revenue_center('assessoria') IS NOT NULL
ON CONFLICT (backup_key) DO NOTHING;

-- Os contratos desses planos não guardaram centro na venda; o extrato usa o
-- centro do plano.
UPDATE public.assessment_plans
   SET revenue_center_id = eon_private.default_revenue_center('assessoria'),
       updated_at = now()
 WHERE revenue_center_id IS NULL
   AND eon_private.default_revenue_center('assessoria') IS NOT NULL;

INSERT INTO eon_private.revenue_center_backfill_backups (backup_key, snapshot)
SELECT 'events:' || event.id::text,
       jsonb_build_object('id', event.id, 'name', event.name, 'revenue_center_id', event.revenue_center_id)
FROM public.events AS event
WHERE event.revenue_center_id IS NULL
  AND eon_private.default_revenue_center('eventos') IS NOT NULL
ON CONFLICT (backup_key) DO NOTHING;

UPDATE public.events
   SET revenue_center_id = eon_private.default_revenue_center('eventos'),
       updated_at = now()
 WHERE revenue_center_id IS NULL
   AND eon_private.default_revenue_center('eventos') IS NOT NULL;

-- 5. Extrato financeiro: centro dos produtos nas vendas da loja ----------------------

CREATE OR REPLACE VIEW public.financial_movements
WITH (security_invoker = true) AS
WITH order_context AS (
  SELECT
    'presale'::text AS order_type,
    o.id AS order_id,
    o.order_number AS reference,
    o.payment_status,
    o.payment_date,
    o.due_date,
    o.payment_method,
    o.manual_payment,
    o.status_changed_at::date AS refund_on,
    COALESCE(o.total_value, o.total_amount, 0)::numeric AS gross_amount,
    product_center.revenue_center_id,
    COALESCE(NULLIF(o.checkout_name, ''), NULLIF(o.customer_name, ''), o.order_number, 'Pedido de pre-venda') AS description,
    o.created_date AS created_at
  FROM public.presale_orders o
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND count(product_centers.revenue_center_id) = count(*)
        AND count(DISTINCT product_centers.revenue_center_id) = 1
      THEN (array_agg(product_centers.revenue_center_id))[1]
      ELSE NULL::uuid
    END AS revenue_center_id
    FROM (
      SELECT COALESCE(
        stock_product.revenue_center_id,
        presale_product.revenue_center_id,
        base_product.revenue_center_id
      ) AS revenue_center_id
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS item(value)
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
        END AS product_id
      ) AS item_ref
      LEFT JOIN public.stock_products stock_product ON stock_product.id = item_ref.product_id
      LEFT JOIN public.presale_products presale_product ON presale_product.id = item_ref.product_id
      -- Item que aponta para o produto-base, e não para o produto da loja ou
      -- da pré-venda: vale o centro dos produtos ligados a ele, se todos
      -- tiverem o mesmo.
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN count(*) > 0
            AND count(linked.revenue_center_id) = count(*)
            AND count(DISTINCT linked.revenue_center_id) = 1
          THEN (array_agg(linked.revenue_center_id))[1]
        END AS revenue_center_id
        FROM (
          SELECT linked_stock.revenue_center_id
          FROM public.stock_products linked_stock
          WHERE linked_stock.product_id = item_ref.product_id
          UNION ALL
          SELECT linked_presale.revenue_center_id
          FROM public.presale_products linked_presale
          WHERE linked_presale.product_id = item_ref.product_id
        ) AS linked
      ) AS base_product
        ON stock_product.id IS NULL
       AND presale_product.id IS NULL
    ) product_centers
  ) product_center ON true

  UNION ALL

  SELECT
    'stock'::text,
    o.id,
    o.order_number,
    o.payment_status,
    o.payment_date,
    o.due_date,
    o.payment_method,
    o.manual_payment,
    o.status_changed_at::date,
    COALESCE(o.total_value, 0)::numeric,
    product_center.revenue_center_id,
    COALESCE(NULLIF(o.customer_name, ''), o.order_number, 'Pedido de loja'),
    o.created_date
  FROM public.stock_orders o
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND count(product_centers.revenue_center_id) = count(*)
        AND count(DISTINCT product_centers.revenue_center_id) = 1
      THEN (array_agg(product_centers.revenue_center_id))[1]
      ELSE NULL::uuid
    END AS revenue_center_id
    FROM (
      SELECT COALESCE(
        stock_product.revenue_center_id,
        presale_product.revenue_center_id,
        base_product.revenue_center_id
      ) AS revenue_center_id
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS item(value)
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
        END AS product_id
      ) AS item_ref
      LEFT JOIN public.stock_products stock_product ON stock_product.id = item_ref.product_id
      LEFT JOIN public.presale_products presale_product ON presale_product.id = item_ref.product_id
      -- Item que aponta para o produto-base, e não para o produto da loja ou
      -- da pré-venda: vale o centro dos produtos ligados a ele, se todos
      -- tiverem o mesmo.
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN count(*) > 0
            AND count(linked.revenue_center_id) = count(*)
            AND count(DISTINCT linked.revenue_center_id) = 1
          THEN (array_agg(linked.revenue_center_id))[1]
        END AS revenue_center_id
        FROM (
          SELECT linked_stock.revenue_center_id
          FROM public.stock_products linked_stock
          WHERE linked_stock.product_id = item_ref.product_id
          UNION ALL
          SELECT linked_presale.revenue_center_id
          FROM public.presale_products linked_presale
          WHERE linked_presale.product_id = item_ref.product_id
        ) AS linked
      ) AS base_product
        ON stock_product.id IS NULL
       AND presale_product.id IS NULL
    ) product_centers
  ) product_center ON true

  UNION ALL

  SELECT
    'contract'::text,
    c.id,
    c.contract_number,
    c.payment_status,
    c.payment_date,
    c.due_date,
    c.payment_method,
    c.manual_payment,
    NULL::date,
    GREATEST(
      0::numeric,
      COALESCE(
        CASE
          WHEN COALESCE(c.plan_snapshot ->> 'price_total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN (c.plan_snapshot ->> 'price_total')::numeric
          ELSE NULL
        END,
        plan.price_total,
        0
      ) + COALESCE(c.enrollment_fee, 0) - COALESCE(c.manual_discount, 0) - COALESCE(c.credit_balance, 0)
    ),
    COALESCE(
      CASE
        WHEN COALESCE(c.plan_snapshot ->> 'revenue_center_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (c.plan_snapshot ->> 'revenue_center_id')::uuid
        ELSE NULL
      END,
      plan.revenue_center_id
    ),
    COALESCE(c.contract_number, 'Contrato de assessoria'),
    c.created_at
  FROM public.assessment_contracts c
  -- O plano vendido (linha original do histórico): depois de uma mudança no
  -- meio do ciclo, c.plan_id passa a ser o plano novo.
  LEFT JOIN public.assessment_plans plan ON plan.id = COALESCE(
    (
      SELECT history.plan_id
      FROM public.assessment_contract_plan_history history
      WHERE history.contract_id = c.id
        AND history.change_type = 'original'
    ),
    c.plan_id
  )

  UNION ALL

  SELECT
    'event'::text,
    r.id,
    r.registration_number,
    r.payment_status,
    r.payment_date,
    r.due_date,
    r.payment_method,
    r.manual_payment,
    NULL::date,
    COALESCE(registration_type.price, 0)::numeric,
    event.revenue_center_id,
    concat_ws(' - ', NULLIF(event.name, ''), NULLIF(registration_type.name, ''), r.registration_number),
    r.created_at
  FROM public.event_registrations r
  LEFT JOIN public.events event ON event.id = r.event_id
  LEFT JOIN public.event_registration_types registration_type ON registration_type.id = r.registration_type_id

  UNION ALL

  SELECT
    'plan_change'::text,
    change.id,
    COALESCE(contract.contract_number, 'Contrato de assessoria') || ' · mudança de plano',
    change.payment_status,
    change.payment_date,
    change.due_date,
    COALESCE(change.paid_payment_method, change.charge_payment_method),
    change.manual_payment,
    NULL::date,
    change.amount,
    COALESCE(
      CASE
        WHEN COALESCE(change.to_plan_snapshot ->> 'revenue_center_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (change.to_plan_snapshot ->> 'revenue_center_id')::uuid
        ELSE NULL
      END,
      to_plan.revenue_center_id
    ),
    COALESCE(contract.contract_number, 'Contrato de assessoria') || ' · mudança para '
      || COALESCE(change.to_plan_snapshot ->> 'name', to_plan.name, 'novo plano'),
    change.created_at
  FROM public.assessment_contract_plan_changes change
  JOIN public.assessment_contracts contract ON contract.id = change.contract_id
  LEFT JOIN public.assessment_plans to_plan ON to_plan.id = change.to_plan_id
  WHERE change.status <> 'cancelled'
),
-- Estorno no cartão por parcela: a parte estornada antes de a parcela cair
-- reduz o que ela recebe; a parte de parcela já recebida sai como estorno.
refund_allocations AS (
  SELECT
    allocation.payment_id,
    sum(allocation.value) FILTER (WHERE NOT allocation.already_credited) AS before_credit
  FROM public.assessment_contract_refund_allocations AS allocation
  GROUP BY allocation.payment_id
),
payment_movements AS (
  SELECT
    ('payment:' || p.id)::text AS movement_id,
    COALESCE(NULLIF(p.source, ''), 'asaas') AS source,
    'asaas_payments'::text AS source_table,
    p.id AS source_id,
    COALESCE(order_row.order_id, p.order_id) AS order_id,
    COALESCE(p.order_type, order_row.order_type) AS order_type,
    COALESCE(order_row.reference, NULLIF(p.external_reference, ''), p.asaas_payment_id) AS reference,
    CASE COALESCE(p.order_type, order_row.order_type)
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      WHEN 'contract' THEN 'assessoria'
      WHEN 'event' THEN 'eventos'
      WHEN 'plan_change' THEN 'assessoria'
      ELSE 'outros'
    END AS business_unit,
    order_row.revenue_center_id,
    CASE
      WHEN p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN 'receipt'
      ELSE 'receivable'
    END AS movement_kind,
    'inflow'::text AS cash_direction,
    p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') AS is_actual,
    false AS is_legacy,
    p.status,
    (COALESCE(p.value, 0) - COALESCE(refund.before_credit, 0))::numeric AS gross_amount,
    GREATEST(0::numeric, COALESCE(p.value, 0) - COALESCE(p.net_value, p.value, 0)) AS fee_amount,
    (COALESCE(p.net_value, p.value, 0) - COALESCE(refund.before_credit, 0))::numeric AS net_amount,
    (COALESCE(p.net_value, p.value, 0) - COALESCE(refund.before_credit, 0))::numeric AS signed_net_amount,
    COALESCE(NULLIF(p.billing_type, ''), order_row.payment_method) AS payment_method,
    CASE
      WHEN p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN COALESCE(p.credit_date, p.payment_date)
      ELSE NULL::date
    END AS occurred_on,
    p.due_date AS due_on,
    COALESCE(p.payment_date, p.credit_date, p.due_date) AS recognition_on,
    CASE
      WHEN p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN COALESCE(p.credit_date, p.payment_date)
      ELSE COALESCE(p.credit_date, p.due_date)
    END AS scheduled_on,
    COALESCE(NULLIF(p.description, ''), order_row.description, 'Pagamento') AS description,
    p.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'asaas_payment_id', p.asaas_payment_id,
      'installment_number', p.installment_number,
      'total_installments', p.total_installments,
      'external_reference', p.external_reference,
      'refunded_before_credit', refund.before_credit
    )) AS metadata
  FROM public.asaas_payments p
  LEFT JOIN order_context order_row
    ON order_row.order_id = p.order_id
   AND order_row.order_type = p.order_type
  LEFT JOIN refund_allocations refund
    ON refund.payment_id = p.id
  WHERE p.status IN (
    'RECEIVED',
    'CONFIRMED',
    'RECEIVED_IN_CASH',
    'PENDING',
    'OVERDUE',
    'AWAITING_RISK_ANALYSIS',
    'AWAITING_CREDIT_CARD',
    'AWAITING_CHARGEBACK_REVERSAL'
  )
    AND COALESCE(p.value, 0) - COALESCE(refund.before_credit, 0) > 0
),
legacy_receipts AS (
  SELECT
    ('legacy-receipt:' || order_row.order_type || ':' || order_row.order_id)::text AS movement_id,
    'legacy'::text AS source,
    'paid_order_without_receipt'::text AS source_table,
    order_row.order_id AS source_id,
    order_row.order_id,
    order_row.order_type,
    order_row.reference,
    CASE order_row.order_type
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      WHEN 'contract' THEN 'assessoria'
      WHEN 'event' THEN 'eventos'
      WHEN 'plan_change' THEN 'assessoria'
      ELSE 'outros'
    END AS business_unit,
    order_row.revenue_center_id,
    'receipt'::text AS movement_kind,
    'inflow'::text AS cash_direction,
    true AS is_actual,
    true AS is_legacy,
    'PAID_WITHOUT_RECEIPT'::text AS status,
    order_row.gross_amount,
    0::numeric AS fee_amount,
    order_row.gross_amount AS net_amount,
    order_row.gross_amount AS signed_net_amount,
    order_row.payment_method,
    order_row.payment_date AS occurred_on,
    NULL::date AS due_on,
    order_row.payment_date AS recognition_on,
    order_row.payment_date AS scheduled_on,
    COALESCE(order_row.description, 'Pagamento legado') AS description,
    order_row.created_at,
    jsonb_build_object('reason', 'paid_order_without_received_payment') AS metadata
  FROM order_context order_row
  WHERE order_row.payment_status = 'paid'
    AND order_row.payment_date IS NOT NULL
    AND order_row.gross_amount > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.asaas_payments p
      WHERE p.order_id = order_row.order_id
        AND p.order_type = order_row.order_type
        AND p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
    )
),
return_refunds AS (
  SELECT
    ('order-return:' || r.id)::text AS movement_id,
    'order_return'::text AS source,
    'order_returns'::text AS source_table,
    r.id AS source_id,
    r.order_id,
    r.order_type,
    r.order_number AS reference,
    CASE r.order_type
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      ELSE 'outros'
    END AS business_unit,
    COALESCE(stock_product.revenue_center_id, presale_product.revenue_center_id) AS revenue_center_id,
    'refund'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    'COMPLETED'::text AS status,
    COALESCE(r.refund_value, 0)::numeric AS gross_amount,
    0::numeric AS fee_amount,
    COALESCE(r.refund_value, 0)::numeric AS net_amount,
    -COALESCE(r.refund_value, 0)::numeric AS signed_net_amount,
    NULL::text AS payment_method,
    r.completed_at::date AS occurred_on,
    NULL::date AS due_on,
    r.completed_at::date AS recognition_on,
    r.completed_at::date AS scheduled_on,
    COALESCE(NULLIF(r.product_name, ''), r.order_number, 'Estorno de pedido') AS description,
    r.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'item_index', r.item_index,
      'quantity', r.quantity,
      'was_delivered', r.was_delivered
    )) AS metadata
  FROM public.order_returns r
  LEFT JOIN public.stock_products stock_product ON stock_product.id = r.product_id
  LEFT JOIN public.presale_products presale_product ON presale_product.id = r.product_id
  WHERE r.status = 'completed'
    AND COALESCE(r.refund_value, 0) > 0
),
full_order_refunds AS (
  SELECT
    ('order-refund:' || order_row.order_type || ':' || order_row.order_id)::text AS movement_id,
    'order_refund'::text AS source,
    order_row.order_type || '_orders' AS source_table,
    order_row.order_id AS source_id,
    order_row.order_id,
    order_row.order_type,
    order_row.reference,
    CASE order_row.order_type
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      ELSE 'outros'
    END AS business_unit,
    order_row.revenue_center_id,
    'refund'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    'COMPLETED'::text AS status,
    order_row.gross_amount,
    0::numeric AS fee_amount,
    order_row.gross_amount AS net_amount,
    -order_row.gross_amount AS signed_net_amount,
    order_row.payment_method,
    order_row.refund_on AS occurred_on,
    NULL::date AS due_on,
    order_row.refund_on AS recognition_on,
    order_row.refund_on AS scheduled_on,
    COALESCE(order_row.description, 'Estorno de pedido') AS description,
    order_row.created_at,
    jsonb_build_object('reason', 'order_payment_status_refunded') AS metadata
  FROM order_context order_row
  WHERE order_row.order_type IN ('presale', 'stock')
    AND order_row.payment_status = 'refunded'
    AND order_row.refund_on IS NOT NULL
    AND order_row.gross_amount > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.order_returns r
      WHERE r.order_id = order_row.order_id
        AND r.order_type = order_row.order_type
        AND r.status = 'completed'
    )
),
contract_refunds AS (
  SELECT
    ('contract-refund:' || c.id)::text AS movement_id,
    'contract_refund'::text AS source,
    'assessment_contracts'::text AS source_table,
    c.id AS source_id,
    c.id AS order_id,
    'contract'::text AS order_type,
    c.contract_number AS reference,
    'assessoria'::text AS business_unit,
    COALESCE(
      CASE
        WHEN COALESCE(c.plan_snapshot ->> 'revenue_center_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (c.plan_snapshot ->> 'revenue_center_id')::uuid
        ELSE NULL
      END,
      plan.revenue_center_id
    ) AS revenue_center_id,
    'refund'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    UPPER(COALESCE(c.refund_status, 'COMPLETED')) AS status,
    refund_split.outflow AS gross_amount,
    0::numeric AS fee_amount,
    refund_split.outflow AS net_amount,
    -refund_split.outflow AS signed_net_amount,
    COALESCE(c.refund_method, c.payment_method) AS payment_method,
    c.refund_date AS occurred_on,
    NULL::date AS due_on,
    c.refund_date AS recognition_on,
    c.refund_date AS scheduled_on,
    COALESCE(c.contract_number, 'Estorno de contrato') AS description,
    c.updated_at AS created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'refund_notes', c.refund_notes,
      'refund_method', c.refund_method,
      'refund_amount', c.refund_amount,
      'calculated_amount', c.refund_calculated_amount,
      'refunded_before_credit', NULLIF(COALESCE(c.refund_amount, 0) - refund_split.outflow, 0)
    )) AS metadata
  FROM public.assessment_contracts c
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN count(allocation.id) > 0
        THEN COALESCE(sum(allocation.value) FILTER (WHERE allocation.already_credited), 0)
      ELSE COALESCE(c.refund_amount, 0)
    END::numeric AS outflow
    FROM public.assessment_contract_refund_allocations AS allocation
    WHERE allocation.contract_id = c.id
  ) AS refund_split
  -- O plano vendido (linha original do histórico): depois de uma mudança no
  -- meio do ciclo, c.plan_id passa a ser o plano novo.
  LEFT JOIN public.assessment_plans plan ON plan.id = COALESCE(
    (
      SELECT history.plan_id
      FROM public.assessment_contract_plan_history history
      WHERE history.contract_id = c.id
        AND history.change_type = 'original'
    ),
    c.plan_id
  )
  WHERE c.refund_date IS NOT NULL
    AND refund_split.outflow > 0
),
event_expense_movements AS (
  SELECT
    ('event-expense:' || expense.id)::text AS movement_id,
    'event_expense'::text AS source,
    'event_expenses'::text AS source_table,
    expense.id AS source_id,
    NULL::uuid AS order_id,
    'event'::text AS order_type,
    event.slug AS reference,
    'eventos'::text AS business_unit,
    event.revenue_center_id,
    'expense'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    'RECORDED'::text AS status,
    COALESCE(expense.amount, 0)::numeric AS gross_amount,
    0::numeric AS fee_amount,
    COALESCE(expense.amount, 0)::numeric AS net_amount,
    -COALESCE(expense.amount, 0)::numeric AS signed_net_amount,
    NULL::text AS payment_method,
    expense.expense_date AS occurred_on,
    NULL::date AS due_on,
    expense.expense_date AS recognition_on,
    expense.expense_date AS scheduled_on,
    concat_ws(' - ', NULLIF(event.name, ''), NULLIF(expense.description, '')) AS description,
    expense.created_at,
    jsonb_strip_nulls(jsonb_build_object('category', expense.category, 'event_id', expense.event_id)) AS metadata
  FROM public.event_expenses expense
  LEFT JOIN public.events event ON event.id = expense.event_id
  WHERE COALESCE(expense.amount, 0) > 0
),
payout_movements AS (
  SELECT
    ('payout:' || closing.id)::text AS movement_id,
    'payout_closing'::text AS source,
    'payout_monthly_closings'::text AS source_table,
    closing.id AS source_id,
    NULL::uuid AS order_id,
    'contract'::text AS order_type,
    to_char(closing.competence, 'YYYY-MM') AS reference,
    'assessoria'::text AS business_unit,
    NULL::uuid AS revenue_center_id,
    CASE WHEN SUM(item.amount) >= 0 THEN 'payout' ELSE 'payout_adjustment' END AS movement_kind,
    CASE WHEN SUM(item.amount) >= 0 THEN 'outflow' ELSE 'inflow' END AS cash_direction,
    closing.status = 'paid' AS is_actual,
    false AS is_legacy,
    UPPER(closing.status) AS status,
    ABS(SUM(item.amount))::numeric AS gross_amount,
    0::numeric AS fee_amount,
    ABS(SUM(item.amount))::numeric AS net_amount,
    SUM(item.amount)::numeric * -1 AS signed_net_amount,
    NULL::text AS payment_method,
    CASE WHEN closing.status = 'paid' THEN closing.paid_at::date ELSE NULL::date END AS occurred_on,
    NULL::date AS due_on,
    closing.competence AS recognition_on,
    COALESCE(closing.paid_at::date, closing.competence) AS scheduled_on,
    'Repasse de assessoria ' || to_char(closing.competence, 'MM/YYYY') AS description,
    closing.generated_at AS created_at,
    jsonb_build_object('item_count', count(item.id), 'closing_status', closing.status) AS metadata
  FROM public.payout_monthly_closings closing
  JOIN public.payout_monthly_statement_items item ON item.closing_id = closing.id
  WHERE closing.status IN ('approved', 'paid')
  GROUP BY closing.id, closing.status, closing.competence, closing.paid_at, closing.generated_at
  HAVING SUM(item.amount) <> 0
)
SELECT * FROM payment_movements
UNION ALL
SELECT * FROM legacy_receipts
UNION ALL
SELECT * FROM return_refunds
UNION ALL
SELECT * FROM full_order_refunds
UNION ALL
SELECT * FROM contract_refunds
UNION ALL
SELECT * FROM event_expense_movements
UNION ALL
SELECT * FROM payout_movements;

-- 6. Acesso: só o banco usa as funções do centro padrão ------------------------------

REVOKE ALL ON FUNCTION eon_private.default_revenue_center(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION eon_private.fill_default_revenue_center()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION eon_private.default_revenue_center(text) IS
  'Centro de receita ativo de um tipo (assessoria, loja, eventos), quando só existe um.';
COMMENT ON FUNCTION eon_private.fill_default_revenue_center() IS
  'Cadastro novo sem centro de receita recebe o centro padrão da sua área.';
COMMENT ON TABLE eon_private.revenue_center_backfill_backups IS
  'Estado anterior dos centros, produtos, planos e eventos ajustados na migração dos centros de receita.';

COMMIT;
