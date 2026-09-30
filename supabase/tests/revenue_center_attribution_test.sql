BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(20);

-- Acesso ----------------------------------------------------------------------

SELECT ok(
  NOT has_function_privilege('anon', 'eon_private.default_revenue_center(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'eon_private.default_revenue_center(text)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'eon_private.default_revenue_center(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'eon_private.fill_default_revenue_center()', 'EXECUTE'),
  'only the database uses the default revenue center helpers'
);
SELECT ok(
  to_regclass('eon_private.revenue_center_backfill_backups') IS NOT NULL
  AND NOT has_table_privilege('service_role', 'eon_private.revenue_center_backfill_backups', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'eon_private.revenue_center_backfill_backups', 'SELECT'),
  'the backfill keeps a private copy of the previous state'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.revenue_centers WHERE name = 'Loja' AND type = 'loja' AND active)
  AND NOT EXISTS (SELECT 1 FROM public.revenue_centers WHERE name = 'Loja · Lifestyle' AND active),
  'store and presale share one active store center'
);
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_trigger
   WHERE tgname = 'fill_default_revenue_center' AND NOT tgisinternal
     AND tgrelid IN ('public.presale_products'::regclass, 'public.stock_products'::regclass,
                     'public.assessment_plans'::regclass, 'public.events'::regclass)),
  4,
  'products, plans and events get the default center when created without one'
);

-- Fixtures fictícias: só os centros de teste ficam ativos ----------------------

UPDATE public.revenue_centers SET active = false;

INSERT INTO public.revenue_centers (id, name, type, active) VALUES
  ('60000000-0000-4000-a000-000000000001', 'Centro loja teste', 'loja', true),
  ('60000000-0000-4000-a000-000000000002', 'Centro assessoria teste', 'assessoria', true),
  ('60000000-0000-4000-a000-000000000003', 'Centro eventos teste', 'eventos', true),
  ('60000000-0000-4000-a000-000000000004', 'Centro loja outro teste', 'loja', false);

SELECT is(
  ARRAY[
    eon_private.default_revenue_center('loja'),
    eon_private.default_revenue_center('assessoria'),
    eon_private.default_revenue_center('eventos')
  ],
  ARRAY[
    '60000000-0000-4000-a000-000000000001',
    '60000000-0000-4000-a000-000000000002',
    '60000000-0000-4000-a000-000000000003'
  ]::uuid[],
  'each area has its only active center as default'
);

INSERT INTO public.assessment_modalities (id, name) VALUES
  ('60000000-0000-4000-a000-000000000010', 'centro-receita-test');

INSERT INTO public.products (id, name) VALUES
  ('60000000-0000-4000-a000-000000000020', 'Regata base teste'),
  ('60000000-0000-4000-a000-000000000021', 'Camisa base teste');

-- Sem centro no cadastro: o banco usa o centro da área.
INSERT INTO public.stock_products (id, name, product_id) VALUES
  ('60000000-0000-4000-a000-000000000031', 'Regata loja teste', '60000000-0000-4000-a000-000000000020');
INSERT INTO public.presale_products (id, name, product_id, sku) VALUES
  ('60000000-0000-4000-a000-000000000032', 'Regata pre-venda teste', '60000000-0000-4000-a000-000000000020', 'TEST-CENTRO-1');
INSERT INTO public.assessment_plans (id, modality_id, name, price_monthly, price_total) VALUES
  ('60000000-0000-4000-a000-000000000033', '60000000-0000-4000-a000-000000000010', 'Plano centro teste', 100, 600);
INSERT INTO public.events (id, name, slug) VALUES
  ('60000000-0000-4000-a000-000000000034', 'Evento centro teste', 'evento-centro-teste');
-- Centro escolhido no cadastro fica.
INSERT INTO public.presale_products (id, name, product_id, sku, revenue_center_id) VALUES
  ('60000000-0000-4000-a000-000000000035', 'Camisa pre-venda teste', '60000000-0000-4000-a000-000000000021',
   'TEST-CENTRO-2', '60000000-0000-4000-a000-000000000004');

SELECT is(
  ARRAY[
    (SELECT revenue_center_id FROM public.stock_products WHERE id = '60000000-0000-4000-a000-000000000031'),
    (SELECT revenue_center_id FROM public.presale_products WHERE id = '60000000-0000-4000-a000-000000000032')
  ],
  ARRAY['60000000-0000-4000-a000-000000000001', '60000000-0000-4000-a000-000000000001']::uuid[],
  'a new store or presale product without center goes to the store center'
);
SELECT is(
  (SELECT revenue_center_id FROM public.assessment_plans WHERE id = '60000000-0000-4000-a000-000000000033'),
  '60000000-0000-4000-a000-000000000002'::uuid,
  'a new plan without center goes to the coaching center'
);
SELECT is(
  (SELECT revenue_center_id FROM public.events WHERE id = '60000000-0000-4000-a000-000000000034'),
  '60000000-0000-4000-a000-000000000003'::uuid,
  'a new event without center goes to the events center'
);
SELECT is(
  (SELECT revenue_center_id FROM public.presale_products WHERE id = '60000000-0000-4000-a000-000000000035'),
  '60000000-0000-4000-a000-000000000004'::uuid,
  'a center chosen on the product is kept'
);

-- Com dois centros de loja ativos, não há padrão.
UPDATE public.revenue_centers SET active = true WHERE id = '60000000-0000-4000-a000-000000000004';
INSERT INTO public.stock_products (id, name) VALUES
  ('60000000-0000-4000-a000-000000000036', 'Produto sem padrao teste');
SELECT is(
  (SELECT revenue_center_id FROM public.stock_products WHERE id = '60000000-0000-4000-a000-000000000036'),
  NULL::uuid,
  'with two active store centers the product keeps no center'
);
SELECT is(
  eon_private.default_revenue_center('loja'),
  NULL::uuid,
  'two active centers of the same area have no default'
);
UPDATE public.revenue_centers SET active = false WHERE id = '60000000-0000-4000-a000-000000000004';

-- Extrato: centro dos produtos nos recebimentos --------------------------------

INSERT INTO public.stock_orders (id, order_number, customer_name, total_value, payment_status, items) VALUES
  ('60000000-0000-4000-a000-000000000041', 'CENTRO-LOJA-TEST', 'Cliente ficticio loja', 120, 'paid',
   jsonb_build_array(jsonb_build_object('product_id', '60000000-0000-4000-a000-000000000031',
     'product_name', 'Regata loja teste', 'quantity', 1, 'sale_price', 120))),
  ('60000000-0000-4000-a000-000000000042', 'CENTRO-LOJA-SEM-TEST', 'Cliente ficticio loja', 90, 'paid',
   jsonb_build_array(jsonb_build_object('product_id', '60000000-0000-4000-a000-000000000036',
     'product_name', 'Produto sem padrao teste', 'quantity', 1, 'sale_price', 90)));

INSERT INTO public.presale_orders (id, order_number, customer_name, total_value, payment_status, items) VALUES
  ('60000000-0000-4000-a000-000000000043', 'CENTRO-PV-TEST', 'Cliente ficticio pre-venda', 250, 'paid',
   jsonb_build_array(jsonb_build_object('product_id', '60000000-0000-4000-a000-000000000032',
     'product_name', 'Regata pre-venda teste', 'quantity', 1, 'sale_price', 250))),
  -- Item que aponta para o produto-base.
  ('60000000-0000-4000-a000-000000000044', 'CENTRO-PV-BASE-TEST', 'Cliente ficticio pre-venda', 250, 'paid',
   jsonb_build_array(jsonb_build_object('product_id', '60000000-0000-4000-a000-000000000020',
     'product_name', 'Regata base teste', 'quantity', 1, 'sale_price', 250))),
  -- Produtos de centros diferentes no mesmo pedido.
  ('60000000-0000-4000-a000-000000000045', 'CENTRO-PV-MISTO-TEST', 'Cliente ficticio pre-venda', 370, 'paid',
   jsonb_build_array(
     jsonb_build_object('product_id', '60000000-0000-4000-a000-000000000032',
       'product_name', 'Regata pre-venda teste', 'quantity', 1, 'sale_price', 250),
     jsonb_build_object('product_id', '60000000-0000-4000-a000-000000000035',
       'product_name', 'Camisa pre-venda teste', 'quantity', 1, 'sale_price', 120)));

INSERT INTO public.asaas_payments (asaas_payment_id, status, value, net_value, payment_date, credit_date,
  order_id, order_type, source) VALUES
  ('centro_loja_test', 'CONFIRMED', 120, 120, '2026-09-10', '2026-09-10',
   '60000000-0000-4000-a000-000000000041', 'stock', 'manual'),
  ('centro_loja_sem_test', 'CONFIRMED', 90, 90, '2026-09-10', '2026-09-10',
   '60000000-0000-4000-a000-000000000042', 'stock', 'manual'),
  ('centro_pv_test', 'CONFIRMED', 250, 250, '2026-09-11', '2026-09-11',
   '60000000-0000-4000-a000-000000000043', 'presale', 'manual'),
  ('centro_pv_base_test', 'CONFIRMED', 250, 250, '2026-09-12', '2026-09-12',
   '60000000-0000-4000-a000-000000000044', 'presale', 'manual'),
  ('centro_pv_misto_test', 'CONFIRMED', 370, 370, '2026-09-13', '2026-09-13',
   '60000000-0000-4000-a000-000000000045', 'presale', 'manual');

CREATE FUNCTION pg_temp.receipt_center(p_payment text) RETURNS uuid LANGUAGE sql AS $$
  SELECT revenue_center_id FROM public.financial_movements
  WHERE movement_kind = 'receipt' AND metadata ->> 'asaas_payment_id' = p_payment;
$$;

SELECT is(
  pg_temp.receipt_center('centro_loja_test'),
  '60000000-0000-4000-a000-000000000001'::uuid,
  'a store sale gets the center of its store product'
);
SELECT is(
  (SELECT gross_amount FROM public.financial_movements
   WHERE movement_kind = 'receipt' AND metadata ->> 'asaas_payment_id' = 'centro_loja_test'),
  120::numeric,
  'the store receipt keeps its amount'
);
SELECT is(
  pg_temp.receipt_center('centro_pv_test'),
  '60000000-0000-4000-a000-000000000001'::uuid,
  'a presale sale gets the center of its presale product'
);
SELECT is(
  pg_temp.receipt_center('centro_pv_base_test'),
  '60000000-0000-4000-a000-000000000001'::uuid,
  'an item pointing to the base product uses the center of the products linked to it'
);
SELECT is(
  pg_temp.receipt_center('centro_pv_misto_test'),
  NULL::uuid,
  'an order mixing products of different centers stays without center'
);
SELECT is(
  pg_temp.receipt_center('centro_loja_sem_test'),
  NULL::uuid,
  'a product without center is not guessed from other products'
);

-- Produto-base cujos produtos discordam: sem centro.
UPDATE public.presale_products
   SET product_id = '60000000-0000-4000-a000-000000000020'
 WHERE id = '60000000-0000-4000-a000-000000000035';
SELECT is(
  pg_temp.receipt_center('centro_pv_base_test'),
  NULL::uuid,
  'a base product whose products disagree on the center gives no center'
);

-- Contrato sem centro na venda usa o centro do plano.
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids) VALUES
  ('60000000-0000-4000-a000-000000000052', 'Coach centro', 'centro@example.test', 'pleno',
   ARRAY['60000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('60000000-0000-4000-a000-000000000050', 'Aluno ficticio centro', '11900006050');
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status, payment_date,
  manual_payment, auto_renewal, renewal_generated
) VALUES
  ('60000000-0000-4000-a000-000000000051', 'ASS-960001', '60000000-0000-4000-a000-000000000050',
   '60000000-0000-4000-a000-000000000052', '60000000-0000-4000-a000-000000000033',
   '{"plan_id":"60000000-0000-4000-a000-000000000033","name":"Plano centro teste","period_months":6,"price_total":600,"price_monthly":100,"modality_id":"60000000-0000-4000-a000-000000000010","revenue_center_id":null}'::jsonb,
   'active', current_date - 20, current_date + 160, current_date + 160, 6, 'paid', current_date - 20,
   true, false, false);
INSERT INTO public.asaas_payments (asaas_payment_id, status, value, net_value, payment_date, credit_date,
  order_id, order_type, source) VALUES
  ('centro_contrato_test', 'CONFIRMED', 100, 100, '2026-09-14', '2026-09-14',
   '60000000-0000-4000-a000-000000000051', 'contract', 'manual');
SELECT is(
  pg_temp.receipt_center('centro_contrato_test'),
  '60000000-0000-4000-a000-000000000002'::uuid,
  'a contract sold without center in the snapshot uses the plan center'
);
SELECT is(
  (SELECT count(*)::int FROM public.financial_movements
   WHERE movement_kind = 'receipt' AND metadata ->> 'asaas_payment_id' LIKE 'centro_%_test'),
  6,
  'each fictitious payment is one receipt in the ledger'
);

SELECT * FROM finish();
ROLLBACK;
