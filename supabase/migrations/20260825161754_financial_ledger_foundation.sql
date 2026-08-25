-- Read-only financial ledger used by every business area. It keeps cash facts,
-- receivables, refunds, expenses and coach payouts in one consistent shape.
-- Historical records are never changed here: legacy paid orders are explicitly
-- marked so they can be reconciled later through the normal application flow.

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
      SELECT COALESCE(stock_product.revenue_center_id, presale_product.revenue_center_id) AS revenue_center_id
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS item(value)
      LEFT JOIN public.stock_products stock_product
        ON stock_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
      LEFT JOIN public.presale_products presale_product
        ON presale_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
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
      SELECT COALESCE(stock_product.revenue_center_id, presale_product.revenue_center_id) AS revenue_center_id
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS item(value)
      LEFT JOIN public.stock_products stock_product
        ON stock_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
      LEFT JOIN public.presale_products presale_product
        ON presale_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
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
  LEFT JOIN public.assessment_plans plan ON plan.id = c.plan_id

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
    COALESCE(p.value, 0)::numeric AS gross_amount,
    GREATEST(0::numeric, COALESCE(p.value, 0) - COALESCE(p.net_value, p.value, 0)) AS fee_amount,
    COALESCE(p.net_value, p.value, 0)::numeric AS net_amount,
    COALESCE(p.net_value, p.value, 0)::numeric AS signed_net_amount,
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
      'external_reference', p.external_reference
    )) AS metadata
  FROM public.asaas_payments p
  LEFT JOIN order_context order_row
    ON order_row.order_id = p.order_id
   AND order_row.order_type = p.order_type
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
    COALESCE(c.refund_amount, 0)::numeric AS gross_amount,
    0::numeric AS fee_amount,
    COALESCE(c.refund_amount, 0)::numeric AS net_amount,
    -COALESCE(c.refund_amount, 0)::numeric AS signed_net_amount,
    c.payment_method,
    c.refund_date AS occurred_on,
    NULL::date AS due_on,
    c.refund_date AS recognition_on,
    c.refund_date AS scheduled_on,
    COALESCE(c.contract_number, 'Estorno de contrato') AS description,
    c.updated_at AS created_at,
    jsonb_strip_nulls(jsonb_build_object('refund_notes', c.refund_notes)) AS metadata
  FROM public.assessment_contracts c
  LEFT JOIN public.assessment_plans plan ON plan.id = c.plan_id
  WHERE c.refund_date IS NOT NULL
    AND COALESCE(c.refund_amount, 0) > 0
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

COMMENT ON VIEW public.financial_movements IS
  'Read-only canonical ledger for receipts, receivables, refunds, expenses and payouts.';

REVOKE ALL ON public.financial_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_movements TO authenticated, service_role;

CREATE OR REPLACE VIEW public.financial_data_quality
WITH (security_invoker = true) AS
WITH open_orders AS (
  SELECT
    'presale_orders'::text AS source_table,
    o.id AS source_id,
    o.id AS order_id,
    'presale'::text AS order_type,
    o.order_number AS reference,
    'pre_venda'::text AS business_unit,
    COALESCE(o.total_value, o.total_amount, 0)::numeric AS amount,
    o.payment_status,
    o.due_date AS due_on,
    o.created_date::date AS occurred_on
  FROM public.presale_orders o

  UNION ALL

  SELECT
    'stock_orders'::text,
    o.id,
    o.id,
    'stock'::text,
    o.order_number,
    'loja'::text,
    COALESCE(o.total_value, 0)::numeric,
    o.payment_status,
    o.due_date,
    o.created_date::date
  FROM public.stock_orders o

  UNION ALL

  SELECT
    'assessment_contracts'::text,
    c.id,
    c.id,
    'contract'::text,
    c.contract_number,
    'assessoria'::text,
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
    c.payment_status,
    c.due_date,
    c.created_at::date
  FROM public.assessment_contracts c
  LEFT JOIN public.assessment_plans plan ON plan.id = c.plan_id

  UNION ALL

  SELECT
    'event_registrations'::text,
    r.id,
    r.id,
    'event'::text,
    r.registration_number,
    'eventos'::text,
    COALESCE(registration_type.price, 0)::numeric,
    r.payment_status,
    r.due_date,
    r.created_at::date
  FROM public.event_registrations r
  LEFT JOIN public.event_registration_types registration_type ON registration_type.id = r.registration_type_id
)
SELECT
  ('legacy-receipt:' || movement.movement_id)::text AS issue_id,
  'high'::text AS severity,
  'receipt_without_payment_row'::text AS issue_type,
  movement.business_unit,
  movement.source_table,
  movement.source_id,
  movement.order_id,
  movement.order_type,
  movement.reference,
  movement.gross_amount AS amount,
  movement.occurred_on,
  'Recebimento considerado pelo pedido, mas sem parcela confirmada no historico financeiro.'::text AS message,
  movement.metadata
FROM public.financial_movements movement
WHERE movement.is_legacy

UNION ALL

SELECT
  ('open-without-due:' || open_order.order_type || ':' || open_order.order_id)::text,
  CASE WHEN open_order.payment_status IN ('charge_sent', 'overdue', 'partially_paid') THEN 'high' ELSE 'medium' END,
  'open_sale_without_due_date'::text,
  open_order.business_unit,
  open_order.source_table,
  open_order.source_id,
  open_order.order_id,
  open_order.order_type,
  open_order.reference,
  open_order.amount,
  open_order.occurred_on,
  'Venda em aberto sem data de vencimento definida.'::text,
  jsonb_build_object('payment_status', open_order.payment_status)
FROM open_orders open_order
WHERE open_order.payment_status IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid')
  AND open_order.amount > 0
  AND open_order.due_on IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.asaas_payments p
    WHERE p.order_id = open_order.order_id
      AND p.order_type = open_order.order_type
      AND p.status IN ('PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
      AND p.due_date IS NOT NULL
  )

UNION ALL

SELECT
  ('missing-revenue-center:' || movement.movement_id)::text,
  CASE WHEN movement.is_actual THEN 'medium' ELSE 'low' END,
  'movement_without_revenue_center'::text,
  movement.business_unit,
  movement.source_table,
  movement.source_id,
  movement.order_id,
  movement.order_type,
  movement.reference,
  movement.gross_amount,
  COALESCE(movement.occurred_on, movement.scheduled_on),
  'Movimento financeiro sem centro de receita identificado.'::text,
  movement.metadata
FROM public.financial_movements movement
WHERE movement.movement_kind IN ('receipt', 'receivable')
  AND movement.order_id IS NOT NULL
  AND movement.revenue_center_id IS NULL
  AND NOT movement.is_legacy

UNION ALL

SELECT
  ('pending-contract-refund:' || c.id)::text,
  'high'::text,
  'pending_refund'::text,
  'assessoria'::text,
  'assessment_contracts'::text,
  c.id,
  c.id,
  'contract'::text,
  c.contract_number,
  COALESCE(c.refund_amount, 0)::numeric,
  c.cancellation_date,
  'Estorno de contrato pendente de conclusao.'::text,
  jsonb_strip_nulls(jsonb_build_object('refund_status', c.refund_status, 'refund_notes', c.refund_notes))
FROM public.assessment_contracts c
WHERE c.refund_status = 'pending'
  AND COALESCE(c.refund_amount, 0) > 0

UNION ALL

SELECT
  ('event-refund-without-details:' || r.id)::text,
  'high'::text,
  'event_refund_without_details'::text,
  'eventos'::text,
  'event_registrations'::text,
  r.id,
  r.id,
  'event'::text,
  r.registration_number,
  COALESCE(registration_type.price, 0)::numeric,
  r.updated_at::date,
  'Inscricao de evento marcada como estornada sem valor e data de estorno registrados.'::text,
  jsonb_build_object('payment_status', r.payment_status)
FROM public.event_registrations r
LEFT JOIN public.event_registration_types registration_type ON registration_type.id = r.registration_type_id
WHERE r.payment_status = 'refunded';

COMMENT ON VIEW public.financial_data_quality IS
  'Read-only list of financial records that need human reconciliation.';

REVOKE ALL ON public.financial_data_quality FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_data_quality TO authenticated, service_role;
