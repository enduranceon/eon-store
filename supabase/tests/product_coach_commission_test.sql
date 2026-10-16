BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(31);

-- Fixtures fictícias: dois coaches, uma pessoa com contrato ativo, uma sem
-- coach e três produtos (10%, R$ 15 por unidade e sem comissão).
INSERT INTO public.assessment_modalities (id, name) VALUES
  ('87000000-0000-4000-a000-000000000011', 'comissao-corrida-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES
  ('87000000-0000-4000-a000-000000000012', '87000000-0000-4000-a000-000000000011',
   'Comissão mensal teste', 'mensal', 1, 200, 200, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active) VALUES
  ('87000000-0000-4000-a000-000000000001', 'Coach Comissão Um', 'comissao-um@example.test', 'pleno',
   ARRAY['87000000-0000-4000-a000-000000000011'::uuid], true),
  ('87000000-0000-4000-a000-000000000002', 'Coach Comissão Dois', 'comissao-dois@example.test', 'pleno',
   ARRAY['87000000-0000-4000-a000-000000000011'::uuid], true);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('87000000-0000-4000-a000-000000000031', 'Aluno Comissão Teste', '11900008731'),
  ('87000000-0000-4000-a000-000000000032', 'Cliente Sem Coach Teste', '11900008732');
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status, payment_date,
  manual_payment, auto_renewal, renewal_generated
) VALUES (
  '87000000-0000-4000-a000-000000000041', 'ASS-987001',
  '87000000-0000-4000-a000-000000000031', '87000000-0000-4000-a000-000000000001',
  '87000000-0000-4000-a000-000000000012',
  '{"plan_id":"87000000-0000-4000-a000-000000000012","name":"Comissão mensal teste","period_months":1,"price_total":200,"modality_id":"87000000-0000-4000-a000-000000000011"}'::jsonb,
  'active', current_date - 10, current_date + 20, current_date + 20, 1, 'paid', current_date - 10,
  true, false, false
);

INSERT INTO public.products (id, name, commission_type, commission_value) VALUES
  ('87000000-0000-4000-a000-000000000051', 'Gel comissão teste', 'percent', 10),
  ('87000000-0000-4000-a000-000000000052', 'Meia comissão teste', 'fixed', 15),
  ('87000000-0000-4000-a000-000000000053', 'Boné sem comissão teste', NULL, NULL);
INSERT INTO public.stock_products (id, name, product_id) VALUES
  ('87000000-0000-4000-a000-000000000061', 'Gel comissão teste', '87000000-0000-4000-a000-000000000051'),
  ('87000000-0000-4000-a000-000000000062', 'Meia comissão teste', '87000000-0000-4000-a000-000000000052'),
  ('87000000-0000-4000-a000-000000000063', 'Boné sem comissão teste', '87000000-0000-4000-a000-000000000053');
INSERT INTO public.presale_products (id, name, product_id, sku) VALUES
  ('87000000-0000-4000-a000-000000000071', 'Gel pré-venda comissão teste', '87000000-0000-4000-a000-000000000051', 'COMISSAO-PV-TEST');

-- Regra no produto ---------------------------------------------------------------

SELECT throws_ok(
  $$UPDATE public.products SET commission_value = 120 WHERE id = '87000000-0000-4000-a000-000000000051'$$,
  '23514', NULL, 'a percentage above 100 is refused'
);
SELECT throws_ok(
  $$UPDATE public.products SET commission_type = 'fixed', commission_value = NULL WHERE id = '87000000-0000-4000-a000-000000000053'$$,
  '23514', NULL, 'a rule needs a value'
);
SELECT throws_ok(
  $$UPDATE public.products SET commission_type = 'bonus', commission_value = 5 WHERE id = '87000000-0000-4000-a000-000000000053'$$,
  '23514', NULL, 'only percent or fixed are accepted'
);

-- Pedido da loja: coach do contrato ativo, regra registrada no pagamento --------
-- Gel R$ 100 x1 (10%), meia R$ 50 x2 (R$ 15/un.), boné R$ 40 x1 (sem regra).
-- Itens somam R$ 240; desconto de R$ 24 deixa o pedido em R$ 216 (fator 0,9).
INSERT INTO public.stock_orders (id, order_number, customer_id, customer_name, total_value, discount_value, payment_status, items)
VALUES (
  '87000000-0000-4000-a000-000000000081', 'COMISSAO-LOJA-TEST', '87000000-0000-4000-a000-000000000031',
  'Aluno Comissão Teste', 216, 24, 'awaiting_charge',
  jsonb_build_array(
    jsonb_build_object('product_id', '87000000-0000-4000-a000-000000000061', 'product_name', 'Gel comissão teste', 'quantity', 1, 'sale_price', 100),
    jsonb_build_object('product_id', '87000000-0000-4000-a000-000000000062', 'product_name', 'Meia comissão teste', 'quantity', 2, 'sale_price', 50),
    jsonb_build_object('product_id', '87000000-0000-4000-a000-000000000063', 'product_name', 'Boné sem comissão teste', 'quantity', 1, 'sale_price', 40)
  )
);

SELECT is(
  (SELECT coach_id FROM public.stock_orders WHERE id = '87000000-0000-4000-a000-000000000081'),
  '87000000-0000-4000-a000-000000000001'::uuid,
  'a new store order takes the coach of the buyer''s active contract'
);
SELECT is(
  (SELECT count(*)::int FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000081'),
  0,
  'an unpaid order has no commission'
);

UPDATE public.stock_orders
SET payment_status = 'paid', payment_date = '2026-09-15'
WHERE id = '87000000-0000-4000-a000-000000000081';

SELECT is(
  (SELECT jsonb_array_length(commission_snapshot->'items') FROM public.stock_orders WHERE id = '87000000-0000-4000-a000-000000000081'),
  2,
  'the payment records the rule of the two items that pay commission'
);
SELECT results_eq(
  $$SELECT item_index, amount, base_value, kind, competence, coach_id
    FROM public.product_commissions
    WHERE order_id = '87000000-0000-4000-a000-000000000081'
    ORDER BY item_index$$,
  $$VALUES (0, 9.00::numeric(12,2), 90.00::numeric(12,2), 'commission'::text, '2026-09-01'::date, '87000000-0000-4000-a000-000000000001'::uuid),
           (1, 30.00::numeric(12,2), 90.00::numeric(12,2), 'commission'::text, '2026-09-01'::date, '87000000-0000-4000-a000-000000000001'::uuid)$$,
  '10% of the paid value (with discount) and R$ 15 per unit, in the payment month'
);
SELECT is(
  (SELECT customer_name FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000081' LIMIT 1),
  'Aluno Comissão Teste',
  'the entry keeps who bought'
);

-- Mudar o produto depois não muda a venda paga.
UPDATE public.products SET commission_value = 50 WHERE id = '87000000-0000-4000-a000-000000000051';
UPDATE public.stock_orders SET payment_date = '2026-09-16' WHERE id = '87000000-0000-4000-a000-000000000081';
SELECT is(
  (SELECT count(*)::int FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000081'),
  2,
  'changing the product rule does not touch a paid sale'
);

-- Item cancelado: a meia sai; o gel continua com o mesmo valor pago.
UPDATE public.stock_orders
SET items = jsonb_set(items, '{1,cancelled}', 'true'::jsonb), total_value = 126, discount_value = 14
WHERE id = '87000000-0000-4000-a000-000000000081';
SELECT results_eq(
  $$SELECT item_index, amount, kind, reason, competence
    FROM public.product_commissions
    WHERE order_id = '87000000-0000-4000-a000-000000000081' AND kind = 'adjustment'$$,
  $$VALUES (1, -30.00::numeric(12,2), 'adjustment'::text, 'Item cancelado'::text,
            date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date)$$,
  'a cancelled item reverses its commission in the current month'
);
SELECT is(
  (SELECT sum(amount) FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000081' AND item_index = 0),
  9.00::numeric,
  'the other item keeps its commission'
);

-- Troca de coach depois do pagamento: estorna de um, lança para o outro.
SELECT lives_ok(
  $$SELECT public.update_order_coach('stock', '87000000-0000-4000-a000-000000000081',
      '87000000-0000-4000-a000-000000000002', '87000000-0000-4000-a000-0000000000ff')$$,
  'the coach of a paid order can be changed'
);
SELECT results_eq(
  $$SELECT coach_id, sum(amount)
    FROM public.product_commissions
    WHERE order_id = '87000000-0000-4000-a000-000000000081' AND item_index = 0
    GROUP BY coach_id ORDER BY coach_id$$,
  $$VALUES ('87000000-0000-4000-a000-000000000001'::uuid, 0.00::numeric),
           ('87000000-0000-4000-a000-000000000002'::uuid, 9.00::numeric)$$,
  'the old coach nets zero and the new one gets the commission'
);
SELECT is(
  (SELECT competence FROM public.product_commissions
   WHERE order_id = '87000000-0000-4000-a000-000000000081'
     AND coach_id = '87000000-0000-4000-a000-000000000002'),
  '2026-09-01'::date,
  'the new coach''s commission keeps the payment month'
);
SELECT is(
  (SELECT reason FROM public.product_commissions
   WHERE order_id = '87000000-0000-4000-a000-000000000081'
     AND coach_id = '87000000-0000-4000-a000-000000000001' AND amount < 0 AND item_index = 0),
  'Coach do pedido trocado',
  'the reversal says why'
);
SELECT is(
  (SELECT metadata->>'action' FROM public.sales_status_events
   WHERE order_id = '87000000-0000-4000-a000-000000000081' ORDER BY created_at DESC LIMIT 1),
  'coach_changed',
  'the change goes to the order history'
);

-- Estorno do pedido: tudo volta a zero.
UPDATE public.stock_orders SET payment_status = 'refunded' WHERE id = '87000000-0000-4000-a000-000000000081';
SELECT is(
  (SELECT sum(amount) FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000081'),
  0.00::numeric,
  'a refunded order nets zero commission'
);
SELECT is(
  (SELECT reason FROM public.product_commissions
   WHERE order_id = '87000000-0000-4000-a000-000000000081'
     AND coach_id = '87000000-0000-4000-a000-000000000002' AND amount < 0),
  'Pedido estornado',
  'the refund adjustment says why'
);

-- Sem coach, sem comissão ---------------------------------------------------------

INSERT INTO public.stock_orders (id, order_number, customer_id, customer_name, total_value, payment_status, payment_date, items)
VALUES (
  '87000000-0000-4000-a000-000000000082', 'COMISSAO-SEM-COACH-TEST', '87000000-0000-4000-a000-000000000032',
  'Cliente Sem Coach Teste', 100, 'paid', '2026-09-20',
  jsonb_build_array(jsonb_build_object('product_id', '87000000-0000-4000-a000-000000000061', 'product_name', 'Gel comissão teste', 'quantity', 1, 'sale_price', 100))
);
SELECT is(
  (SELECT coach_id FROM public.stock_orders WHERE id = '87000000-0000-4000-a000-000000000082'),
  NULL,
  'a buyer without an active contract has no coach'
);
SELECT is(
  (SELECT count(*)::int FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000082'),
  0,
  'a paid order without coach stays with the assessoria'
);
-- Coach informado depois: a comissão passa a valer.
SELECT lives_ok(
  $$SELECT public.update_order_coach('stock', '87000000-0000-4000-a000-000000000082',
      '87000000-0000-4000-a000-000000000001', '87000000-0000-4000-a000-0000000000ff')$$,
  'a coach can be set on a paid order'
);
SELECT is(
  (SELECT sum(amount) FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000082'),
  50.00::numeric,
  'setting a coach later gives the commission with the rule recorded at payment (50% now)'
);

-- Pré-venda ------------------------------------------------------------------------

INSERT INTO public.presale_orders (id, order_number, customer_id, customer_name, total_value, payment_status, payment_date, items)
VALUES (
  '87000000-0000-4000-a000-000000000083', 'COMISSAO-PV-TEST', '87000000-0000-4000-a000-000000000031',
  'Aluno Comissão Teste', 220, 'paid', '2026-10-02',
  jsonb_build_array(jsonb_build_object('product_id', '87000000-0000-4000-a000-000000000071', 'product_name', 'Gel pré-venda comissão teste',
    'quantity', 2, 'sale_price', 100, 'extras_total', 10))
);
SELECT results_eq(
  $$SELECT coach_id, amount, base_value, competence FROM public.product_commissions
    WHERE order_id = '87000000-0000-4000-a000-000000000083'$$,
  $$VALUES ('87000000-0000-4000-a000-000000000001'::uuid, 110.00::numeric(12,2), 220.00::numeric(12,2), '2026-10-01'::date)$$,
  'a pre-sale item (with extras) follows the main product rule'
);

-- Pedido pago antes da comissão existir nunca gera comissão.
-- O vínculo de estoque é adiado; dispara agora para liberar o ALTER TABLE.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.stock_orders DISABLE TRIGGER order_commission_snapshot;
INSERT INTO public.stock_orders (id, order_number, customer_id, customer_name, total_value, payment_status, payment_date, items)
VALUES (
  '87000000-0000-4000-a000-000000000084', 'COMISSAO-ANTIGO-TEST', '87000000-0000-4000-a000-000000000031',
  'Aluno Comissão Teste', 100, 'paid', '2026-08-01',
  jsonb_build_array(jsonb_build_object('product_id', '87000000-0000-4000-a000-000000000061', 'product_name', 'Gel comissão teste', 'quantity', 1, 'sale_price', 100))
);
ALTER TABLE public.stock_orders ENABLE TRIGGER order_commission_snapshot;
UPDATE public.stock_orders SET total_value = 90 WHERE id = '87000000-0000-4000-a000-000000000084';
SELECT is(
  (SELECT count(*)::int FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000084'),
  0,
  'an order paid before the commission existed never generates one'
);

-- Livro só recebe lançamentos novos ----------------------------------------------

SELECT throws_ok(
  $$DELETE FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000083'$$,
  'P0001', NULL, 'a commission entry cannot be deleted'
);
SELECT throws_ok(
  $$UPDATE public.product_commissions SET amount = 1 WHERE order_id = '87000000-0000-4000-a000-000000000083'$$,
  'P0001', NULL, 'a commission entry cannot be rewritten'
);

ALTER TABLE public.payout_monthly_closings DISABLE TRIGGER guard_payout_closing_month;
INSERT INTO public.payout_monthly_closings (id, competence, status)
VALUES ('87000000-0000-4000-a000-0000000000c1', '2026-08-01', 'pending_approval');
ALTER TABLE public.payout_monthly_closings ENABLE TRIGGER guard_payout_closing_month;
SELECT lives_ok(
  $$UPDATE public.product_commissions SET closing_id = '87000000-0000-4000-a000-0000000000c1'
    WHERE order_id = '87000000-0000-4000-a000-000000000083'$$,
  'the closing marks the entry it takes'
);
SELECT lives_ok(
  $$INSERT INTO public.payout_monthly_statement_items (closing_id, coach_id, source_type, description, amount, reference_competence, product_commission_id)
    SELECT closing_id, coach_id, 'product_commission', product_name, amount, competence, id
    FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000083'$$,
  'the statement accepts a product commission item'
);
DELETE FROM public.payout_monthly_closings WHERE id = '87000000-0000-4000-a000-0000000000c1';
SELECT is(
  (SELECT closing_id FROM public.product_commissions WHERE order_id = '87000000-0000-4000-a000-000000000083'),
  NULL,
  'deleting a closing in review leaves the commission open again'
);

-- Acesso -----------------------------------------------------------------------------

SELECT ok(
  NOT has_table_privilege('anon', 'public.product_commissions', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.product_commissions', 'INSERT,UPDATE,DELETE'),
  'the browser can at most read commissions (admin only, by RLS)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.update_order_coach(text, uuid, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.update_order_coach(text, uuid, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'eon_private.reconcile_product_commissions(text, uuid)', 'EXECUTE'),
  'only the backend changes the coach or reconciles commissions'
);

SELECT * FROM finish();
ROLLBACK;
