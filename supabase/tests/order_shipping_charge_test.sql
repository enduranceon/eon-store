BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(31);

-- Fixtures fictícias: uma pessoa, um pedido da loja com frete, um de retirada
-- e uma pré-venda com frete.
INSERT INTO auth.users (id, email) VALUES ('91000000-0000-4000-a000-0000000000ff', 'frete-admin@example.test');
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf) VALUES
  ('91000000-0000-4000-a000-000000000001', 'Cliente Frete Teste', '11900009101', '52998224725');

INSERT INTO public.stock_orders (
  id, order_number, customer_id, customer_name, customer_whatsapp, total_value,
  payment_status, payment_date, delivery_method, delivery_status, items
) VALUES
  ('91000000-0000-4000-a000-000000000011', 'FRETE-LOJA-TEST', '91000000-0000-4000-a000-000000000001',
   'Cliente Frete Teste', '11900009101', 150, 'paid', current_date, 'shipping', 'awaiting_delivery',
   '[{"product_name":"Camiseta frete teste","quantity":1,"sale_price":150}]'),
  ('91000000-0000-4000-a000-000000000012', 'RETIRADA-TEST', '91000000-0000-4000-a000-000000000001',
   'Cliente Frete Teste', '11900009101', 80, 'paid', current_date, 'pickup', 'separated',
   '[{"product_name":"Boné retirada teste","quantity":1,"sale_price":80}]');
INSERT INTO public.presale_orders (
  id, order_number, customer_id, customer_name, checkout_name, total_value,
  payment_status, payment_date, delivery_method, delivery_status, items
) VALUES (
  '91000000-0000-4000-a000-000000000013', 'FRETE-PV-TEST', '91000000-0000-4000-a000-000000000001',
  NULL, 'Cliente Frete Teste', 300, 'paid', current_date, 'shipping', 'received',
  '[{"product_name":"Jaqueta pré-venda teste","quantity":1,"sale_price":300}]'
);

-- Etapa Enviado -------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT public.mark_order_shipped('stock', '91000000-0000-4000-a000-000000000011', 'AB123BR', 30, 34, '91000000-0000-4000-a000-0000000000ff')$$,
  'P0001', 'Marque o pedido como separado antes de enviar',
  'an order is separated before it is shipped'
);
SELECT throws_ok(
  $$SELECT public.mark_order_shipped('stock', '91000000-0000-4000-a000-000000000012', NULL, 10, 10, '91000000-0000-4000-a000-0000000000ff')$$,
  'P0001', 'Só pedido com frete tem a etapa Enviado',
  'a pickup order has no Shipped step'
);
SELECT throws_ok(
  $$SELECT public.update_order_fulfillment('stock', '91000000-0000-4000-a000-000000000012', 'shipped', NULL, NULL, NULL, '91000000-0000-4000-a000-0000000000ff')$$,
  'P0001', 'Só pedido com frete tem a etapa Enviado',
  'the generic step change also refuses Shipped for pickup'
);

SELECT lives_ok(
  $$SELECT public.update_order_fulfillment('stock', '91000000-0000-4000-a000-000000000011', 'separated', NULL, NULL, NULL, '91000000-0000-4000-a000-0000000000ff')$$,
  'the order is separated'
);

CREATE TEMPORARY TABLE shipping_runs (name text PRIMARY KEY, result jsonb);
INSERT INTO shipping_runs
SELECT 'first', public.mark_order_shipped('stock', '91000000-0000-4000-a000-000000000011', ' AB123BR ', 30.5, 34, '91000000-0000-4000-a000-0000000000ff');

SELECT results_eq(
  $$SELECT delivery_status, tracking_code, shipping_cost, shipped_at IS NOT NULL
    FROM public.stock_orders WHERE id = '91000000-0000-4000-a000-000000000011'$$,
  $$VALUES ('shipped'::text, 'AB123BR'::text, 30.50::numeric(12,2), true)$$,
  'the order is shipped with tracking code and what was paid'
);
SELECT is(
  (SELECT count(*)::int FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011'),
  1,
  'one shipping charge is created'
);
SELECT results_eq(
  $$SELECT total_value, payment_status, shipping_parent_type, customer_id, customer_name, delivery_status
    FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011'$$,
  $$VALUES (34::numeric, 'awaiting_charge'::text, 'stock'::text, '91000000-0000-4000-a000-000000000001'::uuid,
            'Cliente Frete Teste'::text, NULL::text)$$,
  'the charge is what will be charged, for the same person, waiting for a charge link'
);
SELECT results_eq(
  $$SELECT item->>'product_name', item->>'kind', (item->>'sale_price')::numeric, (item->>'cost_price')::numeric
    FROM public.stock_orders o, jsonb_array_elements(o.items) item
    WHERE o.shipping_parent_id = '91000000-0000-4000-a000-000000000011'$$,
  $$VALUES ('Frete (rastreio AB123BR)'::text, 'shipping'::text, 34::numeric, 30.5::numeric)$$,
  'the only item is the shipping, with tracking, price and cost'
);
SELECT ok(
  (SELECT order_number IS NOT NULL FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011'),
  'the charge gets its own order number'
);
SELECT is(
  (SELECT (result->'shipping_charge'->>'total_value')::numeric FROM shipping_runs WHERE name = 'first'),
  34::numeric,
  'the call returns the charge'
);

-- Chamar de novo não duplica; rastreio e custo podem ser corrigidos.
SELECT lives_ok(
  $$SELECT public.mark_order_shipped('stock', '91000000-0000-4000-a000-000000000011', 'CD456BR', 31, 34, '91000000-0000-4000-a000-0000000000ff')$$,
  'shipping again only updates the shipment'
);
SELECT is(
  (SELECT count(*)::int FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011'),
  1,
  'no second charge'
);
SELECT results_eq(
  $$SELECT tracking_code, shipping_cost FROM public.stock_orders WHERE id = '91000000-0000-4000-a000-000000000011'$$,
  $$VALUES ('CD456BR'::text, 31.00::numeric(12,2))$$,
  'tracking and cost are updated'
);
SELECT throws_ok(
  $$INSERT INTO public.stock_orders (customer_name, total_value, shipping_parent_type, shipping_parent_id, items)
    VALUES ('Duplicada', 10, 'stock', '91000000-0000-4000-a000-000000000011', '[]')$$,
  '23505', NULL,
  'the database keeps one open shipping charge per order'
);

-- A cobrança de frete não tem entrega e não é enviada.
SELECT throws_ok(
  format($$SELECT public.update_order_fulfillment('stock', %L, 'separated', NULL, NULL, NULL, '91000000-0000-4000-a000-0000000000ff')$$,
    (SELECT id FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011')),
  'P0001', 'A cobrança de frete não tem etapa de entrega',
  'the shipping charge has no delivery step'
);

SELECT throws_ok(
  format($$SELECT public.replace_stock_order_items_from_api(%L,
    '[{"product_id":"91000000-0000-4000-a000-0000000000aa","quantity":1}]'::jsonb,
    '91000000-0000-4000-a000-0000000000ff')$$,
    (SELECT id FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011')),
  'P0001', 'A cobrança de frete não tem itens para ajustar',
  'the shipping charge has no items to adjust'
);

-- Entregue depois de enviado.
SELECT lives_ok(
  $$SELECT public.update_order_fulfillment('stock', '91000000-0000-4000-a000-000000000011', 'delivered', current_date, NULL, NULL, '91000000-0000-4000-a000-0000000000ff')$$,
  'a shipped order is then delivered'
);

-- Mensagem de cobrança.
SELECT is(
  (SELECT eon_private.communication_template_context(jsonb_build_object(
     'source_type', 'stock', 'person_name', 'Cliente Frete Teste', 'balance', 34,
     'items', (SELECT items FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000011')
   ))->>'referente'),
  'do frete do seu pedido',
  'the charge message talks about the shipping of the order'
);
SELECT is(
  (SELECT eon_private.communication_template_context(jsonb_build_object(
     'source_type', 'stock', 'person_name', 'Cliente Frete Teste', 'balance', 150,
     'items', (SELECT items FROM public.stock_orders WHERE id = '91000000-0000-4000-a000-000000000011')
   ))->>'referente'),
  'do seu pedido',
  'a product order keeps its usual text'
);

-- Pré-venda: vale igual, com a pessoa da ficha.
SELECT lives_ok(
  $$SELECT public.update_order_fulfillment('presale', '91000000-0000-4000-a000-000000000013', 'separated', NULL, NULL, NULL, '91000000-0000-4000-a000-0000000000ff');
    SELECT public.mark_order_shipped('presale', '91000000-0000-4000-a000-000000000013', NULL, 25, 28, '91000000-0000-4000-a000-0000000000ff')$$,
  'a pre-sale order is separated and shipped'
);
SELECT results_eq(
  $$SELECT o.total_value, o.customer_name, o.customer_cpf, item->>'product_name'
    FROM public.stock_orders o, jsonb_array_elements(o.items) item
    WHERE o.shipping_parent_type = 'presale' AND o.shipping_parent_id = '91000000-0000-4000-a000-000000000013'$$,
  $$VALUES (28::numeric, 'Cliente Frete Teste'::text, '52998224725'::text, 'Frete'::text)$$,
  'a pre-sale order gets its shipping charge too'
);
SELECT is(
  (SELECT delivery_status FROM public.presale_orders WHERE id = '91000000-0000-4000-a000-000000000013'),
  'shipped',
  'the pre-sale order is shipped'
);

-- Sem valor a cobrar (frete grátis): só registra o envio.
UPDATE public.stock_orders SET delivery_status = 'separated', delivery_method = 'shipping'
WHERE id = '91000000-0000-4000-a000-000000000012';
SELECT lives_ok(
  $$SELECT public.mark_order_shipped('stock', '91000000-0000-4000-a000-000000000012', NULL, 12, 0, '91000000-0000-4000-a000-0000000000ff')$$,
  'an order with free shipping is shipped'
);
SELECT is(
  (SELECT count(*)::int FROM public.stock_orders WHERE shipping_parent_id = '91000000-0000-4000-a000-000000000012'),
  0,
  'free shipping creates no charge'
);

-- Enviado já saiu da loja: itens travados, e cancelar ou estornar espera a
-- devolução em vez de repor o estoque na hora.
INSERT INTO public.stock_orders (
  id, order_number, customer_id, customer_name, total_value, payment_status,
  delivery_method, delivery_status, items
) VALUES (
  '91000000-0000-4000-a000-000000000014', 'FRETE-ABERTO-TEST', '91000000-0000-4000-a000-000000000001',
  'Cliente Frete Teste', 60, 'awaiting_charge', 'shipping', 'separated',
  '[{"product_name":"Meia frete teste","quantity":1,"sale_price":60}]'
);
SELECT lives_ok(
  $$SELECT public.mark_order_shipped('stock', '91000000-0000-4000-a000-000000000014', NULL, 15, 18, '91000000-0000-4000-a000-0000000000ff')$$,
  'an unpaid order can be shipped too'
);
SELECT throws_ok(
  $$SELECT public.replace_stock_order_items_from_api('91000000-0000-4000-a000-000000000014',
    '[{"product_id":"91000000-0000-4000-a000-0000000000aa","quantity":1}]'::jsonb,
    '91000000-0000-4000-a000-0000000000ff')$$,
  'P0001', 'Os itens só podem ser ajustados antes da separação',
  'the items of a shipped order cannot be adjusted'
);
SELECT ok(
  pg_get_functiondef('public.complete_order_refund(uuid,jsonb)'::regprocedure)
    LIKE $$%v_was_delivered := COALESCE(v_delivery_status, '') IN ('delivered', 'shipped');%$$
  AND pg_get_functiondef('public.complete_order_cancellation(uuid,jsonb)'::regprocedure)
    NOT LIKE $$%<> 'delivered'%$$,
  'refund and cancellation treat a shipped order like a delivered one'
);

-- Financeiro: o que foi pago de frete é despesa da loja.
SELECT results_eq(
  $$SELECT movement_kind, cash_direction, net_amount, business_unit
    FROM public.financial_movements
    WHERE source = 'shipping_cost' AND source_id = '91000000-0000-4000-a000-000000000011'$$,
  $$VALUES ('expense'::text, 'outflow'::text, 31.00::numeric, 'loja'::text)$$,
  'the shipping paid shows as a store expense'
);
SELECT is(
  (SELECT count(*)::int FROM public.financial_movements WHERE source = 'shipping_cost'
     AND source_id IN ('91000000-0000-4000-a000-000000000012', '91000000-0000-4000-a000-000000000013',
                       '91000000-0000-4000-a000-000000000014')),
  3,
  'free shipping, pre-sale and unpaid shipped orders count their shipping cost'
);

-- Acesso.
SELECT ok(
  NOT has_function_privilege('anon', 'public.mark_order_shipped(text, uuid, text, numeric, numeric, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.mark_order_shipped(text, uuid, text, numeric, numeric, uuid)', 'EXECUTE'),
  'only the backend ships orders'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.financial_movements', 'SELECT')
  AND (SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class WHERE oid = 'public.financial_movements'::regclass),
  'the financial view keeps its access rules'
);

SELECT * FROM finish();
ROLLBACK;
