BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(8);

-- Fixtures fictícias: pedido da loja e pré-venda com link já enviado por
-- WhatsApp, que trocam de link depois (caso real: link trocado minutos depois
-- do envio e a pessoa ficou com o link antigo).
INSERT INTO auth.users (id, email) VALUES ('95200000-0000-4000-a000-0000000000ff', 'order-link-admin@example.test');

INSERT INTO public.stock_orders (
  id, order_number, customer_name, customer_whatsapp, total_value, payment_status,
  payment_method, due_date, external_payment_link, payment_message_sent_at, items
) VALUES (
  '95200000-0000-4000-a000-000000000101', 'EST-LINK-TEST', 'Pessoa Link Teste', '11999990011', 250,
  'charge_sent', 'pix', current_date + 1, 'https://example.test/pay/old', now() - interval '2 hours',
  '[{"product_name":"Camisa link teste","quantity":1,"sale_price":250}]'
);
INSERT INTO public.presale_orders (
  id, order_number, customer_name, total_value, payment_status, payment_method, due_date,
  external_payment_link, payment_message_sent_at, items
) VALUES (
  '95200000-0000-4000-a000-000000000102', 'PED-LINK-TEST', 'Pessoa Link Teste', 230, 'charge_sent', 'pix',
  current_date + 1, 'https://example.test/pay/old-pv', now() - interval '2 hours',
  '[{"product_name":"Camisa pré-venda link teste","quantity":1,"sale_price":230}]'
);

INSERT INTO public.communication_cases (source_type, source_id, purpose, obligation_key, next_action_at)
VALUES ('stock', '95200000-0000-4000-a000-000000000101', 'billing', 'source', current_date)
ON CONFLICT (source_type, source_id, purpose, obligation_key) DO NOTHING;

CREATE FUNCTION pg_temp.save(p_type text, p_id uuid, p_link text, p_due date) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.save_order_external_charge(
    p_type, p_id, p_link, p_due, 'pix', NULL,
    CASE p_type
      WHEN 'stock' THEN (SELECT coalesce(updated_date, created_date) FROM public.stock_orders WHERE id = p_id)
      ELSE (SELECT coalesce(updated_date, created_date) FROM public.presale_orders WHERE id = p_id)
    END,
    '95200000-0000-4000-a000-0000000000ff');
$$;
CREATE FUNCTION pg_temp.stock_sent_at() RETURNS timestamptz LANGUAGE sql AS $$
  SELECT payment_message_sent_at FROM public.stock_orders
  WHERE id = '95200000-0000-4000-a000-000000000101';
$$;
CREATE FUNCTION pg_temp.suggest() RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type, c.source_id))
  FROM public.communication_cases c
  WHERE c.source_type = 'stock' AND c.source_id = '95200000-0000-4000-a000-000000000101'
    AND c.purpose = 'billing';
$$;

-- 1. Mesmo link, outro vencimento: a mensagem continua enviada.
SELECT lives_ok(
  $$SELECT pg_temp.save('stock', '95200000-0000-4000-a000-000000000101', 'https://example.test/pay/old', current_date + 3)$$,
  'the due date changes with the same link');
SELECT isnt(pg_temp.stock_sent_at(), NULL, 'the same link keeps the message as sent');

-- 2. Link novo: a mensagem volta a "não enviada" e fica no histórico.
SELECT lives_ok(
  $$SELECT pg_temp.save('stock', '95200000-0000-4000-a000-000000000101', 'https://example.test/pay/new', current_date + 1)$$,
  'the store order link changes');
SELECT is(pg_temp.stock_sent_at(), NULL, 'a new link clears the message sent date');
SELECT is(
  (SELECT count(*)::int FROM public.sales_status_events
   WHERE order_id = '95200000-0000-4000-a000-000000000101'
     AND metadata->>'action' = 'external_charge_updated'
     AND metadata->>'external_payment_link' = 'https://example.test/pay/new'),
  1, 'the link change is in the order history');

-- 3. A Central volta a oferecer a cobrança, agora com o link novo.
SELECT ok(
  pg_temp.suggest()->>'action_code' = 'initial_charge'
    AND pg_temp.suggest()->>'message' LIKE '%https://example.test/pay/new%',
  'the Central offers the charge again with the new link');

-- 4. Pré-venda segue a mesma regra.
SELECT lives_ok(
  $$SELECT pg_temp.save('presale', '95200000-0000-4000-a000-000000000102', 'https://example.test/pay/new-pv', current_date + 1)$$,
  'the pre-sale order link changes');
SELECT is(
  (SELECT payment_message_sent_at FROM public.presale_orders
   WHERE id = '95200000-0000-4000-a000-000000000102'),
  NULL, 'a new link on a pre-sale order also clears the message sent date');

SELECT * FROM finish();
ROLLBACK;
