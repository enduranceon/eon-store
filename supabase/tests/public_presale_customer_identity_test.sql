BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(49);

INSERT INTO public.presale_campaigns (
  id, name, status, start_date, end_date
) VALUES (
  '00000000-0000-4000-a000-000000000101',
  'Campanha de teste do checkout público',
  'active',
  current_date - 1,
  current_date + 1
);

INSERT INTO public.presale_products (
  id, campaign_id, name, status, sale_price, cost_price, variations, extras
) VALUES (
  '00000000-0000-4000-a000-000000000102',
  '00000000-0000-4000-a000-000000000101',
  'Produto de teste',
  'active',
  100,
  40,
  '[]'::jsonb,
  '[]'::jsonb
);

INSERT INTO public.presale_customers (
  id, full_name, whatsapp, email, updated_date
) VALUES
  (
    '00000000-0000-4000-a000-000000000201',
    'Cliente protegido por telefone',
    '11999990001',
    'telefone@original.test',
    '2026-01-02 03:04:05+00'
  ),
  (
    '00000000-0000-4000-a000-000000000202',
    'Cliente protegido por email',
    '11999990002',
    'email@original.test',
    '2026-02-03 04:05:06+00'
  );

CREATE TEMPORARY TABLE checkout_results (
  scenario TEXT PRIMARY KEY,
  result JSONB NOT NULL
);
GRANT SELECT, INSERT ON checkout_results TO anon;

SET LOCAL ROLE anon;

INSERT INTO checkout_results (scenario, result)
SELECT 'phone_match', public.create_public_presale_order(
  jsonb_build_object(
    'campaign_id', '00000000-0000-4000-a000-000000000101',
    'customer', jsonb_build_object(
      'full_name', 'Nome enviado com telefone existente',
      'whatsapp', '(11) 99999-0001',
      'email', 'TROCA@EXAMPLE.TEST'
    ),
    'delivery', jsonb_build_object('method', 'shipping', 'city', null),
    'payment_preference', 'pix_boleto',
    'items', jsonb_build_array(
      jsonb_build_object(
        'product_id', '00000000-0000-4000-a000-000000000102',
        'quantity', 1
      )
    )
  )
);

INSERT INTO checkout_results (scenario, result)
SELECT 'email_match', public.create_public_presale_order(
  jsonb_build_object(
    'campaign_id', '00000000-0000-4000-a000-000000000101',
    'customer', jsonb_build_object(
      'full_name', 'Nome enviado com email existente',
      'whatsapp', '11999990003',
      'email', 'EMAIL@ORIGINAL.TEST'
    ),
    'delivery', jsonb_build_object('method', 'shipping', 'city', null),
    'payment_preference', 'pix_boleto',
    'items', jsonb_build_array(
      jsonb_build_object(
        'product_id', '00000000-0000-4000-a000-000000000102',
        'quantity', 1
      )
    )
  )
);

INSERT INTO checkout_results (scenario, result)
SELECT 'conflicting_contacts', public.create_public_presale_order(
  jsonb_build_object(
    'campaign_id', '00000000-0000-4000-a000-000000000101',
    'customer', jsonb_build_object(
      'full_name', 'Nome enviado com contatos conflitantes',
      'whatsapp', '11999990001',
      'email', 'email@original.test'
    ),
    'delivery', jsonb_build_object('method', 'shipping', 'city', null),
    'payment_preference', 'card_2x',
    'items', jsonb_build_array(
      jsonb_build_object(
        'product_id', '00000000-0000-4000-a000-000000000102',
        'quantity', 1
      )
    )
  )
);

INSERT INTO checkout_results (scenario, result)
SELECT 'new_contact', public.create_public_presale_order(
  jsonb_build_object(
    'campaign_id', '00000000-0000-4000-a000-000000000101',
    'customer', jsonb_build_object(
      'full_name', 'Pessoa ainda não cadastrada',
      'whatsapp', '11999990004',
      'email', 'NOVA@EXAMPLE.TEST'
    ),
    'delivery', jsonb_build_object('method', 'pickup', 'city', 'São Paulo'),
    'payment_preference', 'pix_boleto',
    'items', jsonb_build_array(
      jsonb_build_object(
        'product_id', '00000000-0000-4000-a000-000000000102',
        'quantity', 2
      )
    )
  )
);

RESET ROLE;

CREATE TEMPORARY TABLE checkout_order_context AS
SELECT
  results.scenario,
  orders.id AS order_id
FROM checkout_results AS results
JOIN public.presale_orders AS orders
  ON orders.public_token = (results.result->>'public_token')::uuid;
GRANT SELECT ON checkout_order_context TO service_role;

SELECT is(
  (SELECT count(*)::INTEGER
   FROM public.presale_customers
   WHERE whatsapp IN ('11999990001', '11999990002', '11999990003', '11999990004')
      OR lower(email) IN (
        'telefone@original.test',
        'email@original.test',
        'troca@example.test',
        'nova@example.test'
      )),
  2,
  'public checkout does not create canonical customers'
);

SELECT is(
  (SELECT full_name FROM public.presale_customers
   WHERE id = '00000000-0000-4000-a000-000000000201'),
  'Cliente protegido por telefone',
  'phone match cannot overwrite the canonical name'
);

SELECT is(
  (SELECT email FROM public.presale_customers
   WHERE id = '00000000-0000-4000-a000-000000000201'),
  'telefone@original.test',
  'phone match cannot overwrite the canonical email'
);

SELECT ok(
  (SELECT updated_date = '2026-01-02 03:04:05+00'::timestamptz
   FROM public.presale_customers
   WHERE id = '00000000-0000-4000-a000-000000000201'),
  'phone match leaves the canonical timestamp untouched'
);

SELECT is(
  (SELECT full_name FROM public.presale_customers
   WHERE id = '00000000-0000-4000-a000-000000000202'),
  'Cliente protegido por email',
  'email match cannot overwrite the canonical name'
);

SELECT is(
  (SELECT whatsapp FROM public.presale_customers
   WHERE id = '00000000-0000-4000-a000-000000000202'),
  '11999990002',
  'email match cannot overwrite the canonical phone'
);

SELECT ok(
  (SELECT updated_date = '2026-02-03 04:05:06+00'::timestamptz
   FROM public.presale_customers
   WHERE id = '00000000-0000-4000-a000-000000000202'),
  'email match leaves the canonical timestamp untouched'
);

SELECT is(
  (SELECT count(*)::INTEGER
   FROM public.presale_orders
   WHERE campaign_id = '00000000-0000-4000-a000-000000000101'),
  4,
  'all valid public requests still create orders'
);

SELECT is(
  (SELECT count(*)::INTEGER
   FROM public.presale_orders
   WHERE campaign_id = '00000000-0000-4000-a000-000000000101'
     AND customer_id IS NULL),
  4,
  'public orders remain unlinked until administrative review'
);

SELECT is(
  (SELECT checkout_whatsapp FROM public.presale_orders
   WHERE checkout_whatsapp = '11999990001'
     AND checkout_email = 'troca@example.test'),
  '11999990001',
  'the order keeps a normalized phone snapshot'
);

SELECT is(
  (SELECT checkout_email FROM public.presale_orders
   WHERE checkout_whatsapp = '11999990003'),
  'email@original.test',
  'the order keeps a normalized email snapshot'
);

SELECT is(
  (SELECT total_value FROM public.presale_orders
   WHERE checkout_whatsapp = '11999990004'),
  200::numeric,
  'the unlinked order keeps server-calculated totals'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM checkout_results r
    CROSS JOIN LATERAL jsonb_array_elements(r.result->'items') AS item(value)
    WHERE item.value ? 'cost_price'
  ),
  'the public response does not expose internal product cost'
);

SELECT ok(
  (
    SELECT bool_and((item.value->>'cost_price')::numeric = 40)
    FROM public.presale_orders o
    CROSS JOIN LATERAL jsonb_array_elements(o.items) AS item(value)
    WHERE o.campaign_id = '00000000-0000-4000-a000-000000000101'
  ),
  'the private order snapshot retains cost for internal accounting'
);

SELECT ok(
  (
    SELECT bool_and(
      result ? 'public_token'
      AND result ? 'order_number'
      AND result ? 'total_value'
      AND result ? 'payment_status'
    )
    FROM checkout_results
  ),
  'the public response contract remains available'
);

SELECT ok(
  has_function_privilege(
    'anon',
    'public.create_public_presale_order(jsonb)',
    'EXECUTE'
  ),
  'anonymous checkout keeps explicit RPC permission'
);

SELECT ok(
  to_regprocedure(
    'public.link_presale_order_customer(uuid,uuid,uuid)'
  ) IS NULL
  AND to_regprocedure(
    'public.link_presale_order_customer(uuid,uuid,timestamptz,uuid)'
  ) IS NULL,
  'the legacy customer-link overloads are absent'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.link_presale_order_customer(uuid,uuid,uuid,timestamptz,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.link_presale_order_customer(uuid,uuid,uuid,timestamptz,uuid)',
    'EXECUTE'
  ),
  'browser callers cannot link an order to a canonical customer'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.link_presale_order_customer(uuid,uuid,uuid,timestamptz,uuid)',
    'EXECUTE'
  )
  AND (
    SELECT prosecdef
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure(
      'public.link_presale_order_customer(uuid,uuid,uuid,timestamptz,uuid)'
    )
  )
  AND (
    SELECT proconfig @> ARRAY['search_path=""']::text[]
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure(
      'public.link_presale_order_customer(uuid,uuid,uuid,timestamptz,uuid)'
    )
  ),
  'the server role can perform an administrative customer link'
);

SELECT ok(
  to_regprocedure(
    'public.prepare_presale_order_charge_creation(uuid,text,date,integer,text,text,uuid,timestamptz,uuid)'
  ) IS NOT NULL
  AND has_function_privilege(
    'service_role',
    'public.prepare_presale_order_charge_creation(uuid,text,date,integer,text,text,uuid,timestamptz,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.prepare_presale_order_charge_creation(uuid,text,date,integer,text,text,uuid,timestamptz,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.prepare_presale_order_charge_creation(uuid,text,date,integer,text,text,uuid,timestamptz,uuid)',
    'EXECUTE'
  )
  AND (
    SELECT prosecdef
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure(
      'public.prepare_presale_order_charge_creation(uuid,text,date,integer,text,text,uuid,timestamptz,uuid)'
    )
  )
  AND (
    SELECT proconfig @> ARRAY['search_path=""']::text[]
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure(
      'public.prepare_presale_order_charge_creation(uuid,text,date,integer,text,text,uuid,timestamptz,uuid)'
    )
  ),
  'only the server role can prepare a presale Asaas charge with reviewed identity'
);

SELECT throws_ok(
  $$
    SELECT public.prepare_order_charge_creation(
      'presale',
      (
        SELECT order_id
        FROM checkout_order_context
        WHERE scenario = 'email_match'
      ),
      'PIX',
      current_date + 1,
      1,
      '12345678901',
      NULL,
      'checkout-unlinked-asaas',
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'Confirme o cliente do pedido antes de gerar uma cobrança Asaas',
  'even a direct generic Asaas prepare cannot bypass identity review'
);

UPDATE public.presale_orders
SET asaas_charge_id = 'pay_identity_test',
    updated_date = '2026-03-02 03:04:05+00'::timestamptz
WHERE id = (
  SELECT order_id FROM checkout_order_context WHERE scenario = 'email_match'
);

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (
        SELECT order_id
        FROM checkout_order_context
        WHERE scenario = 'email_match'
      ),
      '00000000-0000-4000-a000-000000000201'::uuid,
      NULL,
      '2026-03-02 03:04:05+00'::timestamptz,
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'Reconcilie a identidade da cobrança Asaas antes de alterar o cliente',
  'an existing Asaas identity cannot be attached to an arbitrary first customer'
);
RESET ROLE;

UPDATE public.presale_orders
SET asaas_charge_id = NULL
WHERE id = (
  SELECT order_id FROM checkout_order_context WHERE scenario = 'email_match'
);

UPDATE public.presale_orders
SET payment_status = 'charge_sent',
    external_payment_link = 'https://payments.example.test/open-charge',
    updated_date = '2026-03-03 04:05:06+00'::timestamptz
WHERE id = (
  SELECT order_id FROM checkout_order_context WHERE scenario = 'phone_match'
);

SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$
    SELECT public.link_presale_order_customer(
      (
        SELECT order_id
        FROM checkout_order_context
        WHERE scenario = 'phone_match'
      ),
      '00000000-0000-4000-a000-000000000201'::uuid,
      NULL,
      '2026-03-03 04:05:06+00'::timestamptz,
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'an open external charge still accepts its first reviewed customer link'
);
RESET ROLE;

SELECT is(
  (SELECT customer_id
   FROM public.presale_orders
   WHERE id = (
     SELECT order_id FROM checkout_order_context WHERE scenario = 'phone_match'
   )),
  '00000000-0000-4000-a000-000000000201'::uuid,
  'initial linking remains compatible with the external-charge workflow'
);

UPDATE public.presale_orders
SET updated_date = '2026-03-04 05:06:07+00'::timestamptz
WHERE id = (
  SELECT order_id FROM checkout_order_context WHERE scenario = 'new_contact'
);

CREATE TEMPORARY TABLE customer_link_context AS
SELECT
  id AS order_id,
  coalesce(updated_date, created_date) AS original_updated_at,
  coalesce(updated_date, created_date) AS expected_updated_at
FROM public.presale_orders
WHERE id = (
  SELECT order_id FROM checkout_order_context WHERE scenario = 'new_contact'
);
GRANT SELECT ON customer_link_context TO service_role;

INSERT INTO public.order_operations (
  id,
  operation_type,
  operation_key,
  order_type,
  order_id,
  status,
  requested_by,
  reason
) VALUES (
  '00000000-0000-4000-a000-000000000301'::uuid,
  'change_due_date',
  'checkout-link-race',
  'presale',
  (SELECT order_id FROM customer_link_context),
  'prepared',
  '00000000-0000-4000-a000-000000000299'::uuid,
  'Operação concorrente de teste'
);

SELECT throws_ok(
  $$
    UPDATE public.presale_orders
    SET customer_id = '00000000-0000-4000-a000-000000000202'::uuid
    WHERE id = (SELECT order_id FROM customer_link_context)
  $$,
  'P0001',
  'Aguarde a conclusão ou reconciliação da operação financeira antes de vincular o cliente',
  'direct writes and customer merges cannot move an order during a financial operation'
);

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000202'::uuid,
      NULL,
      (SELECT original_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'Aguarde a conclusão ou reconciliação da operação financeira antes de vincular o cliente',
  'a prepared financial operation blocks customer linking'
);
RESET ROLE;

UPDATE public.order_operations
SET status = 'reconciliation_required'
WHERE id = '00000000-0000-4000-a000-000000000301'::uuid;

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000202'::uuid,
      NULL,
      (SELECT original_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'Aguarde a conclusão ou reconciliação da operação financeira antes de vincular o cliente',
  'an unresolved financial reconciliation blocks customer linking'
);
RESET ROLE;

SELECT ok(
  (SELECT customer_id IS NULL
   FROM public.presale_orders
   WHERE id = (SELECT order_id FROM customer_link_context))
  AND NOT EXISTS (
    SELECT 1
    FROM public.sales_status_events
    WHERE order_type = 'presale'
      AND order_id = (SELECT order_id FROM customer_link_context)
      AND metadata->>'action' = 'customer_link_changed'
  ),
  'blocked financial races preserve both customer identity and audit history'
);

DELETE FROM public.order_operations
WHERE id = '00000000-0000-4000-a000-000000000301'::uuid;

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000202'::uuid,
      NULL,
      (
        SELECT original_updated_at
        FROM customer_link_context
      ),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'the server role can link an unverified order after review'
);

RESET ROLE;

SELECT is(
  (SELECT customer_id
   FROM public.presale_orders
   WHERE checkout_whatsapp = '11999990004'),
  '00000000-0000-4000-a000-000000000202'::uuid,
  'the reviewed order links to the selected customer'
);

SELECT is(
  (SELECT checkout_name
   FROM public.presale_orders
   WHERE checkout_whatsapp = '11999990004'),
  'Pessoa ainda não cadastrada',
  'administrative linking does not rewrite the order snapshot'
);

SELECT isnt(
  (SELECT updated_date
   FROM public.presale_orders
   WHERE checkout_whatsapp = '11999990004'),
  (SELECT original_updated_at FROM customer_link_context),
  'administrative linking advances the optimistic-lock version'
);

SELECT ok(
  (
    SELECT count(*) = 1
      AND bool_and(previous_status = new_status)
      AND bool_and(actor_id = '00000000-0000-4000-a000-000000000299'::uuid)
      AND bool_and(metadata->>'action' = 'customer_link_changed')
      AND bool_and(metadata->>'previous_customer_id' IS NULL)
      AND bool_and(
        metadata->>'new_customer_id' =
          '00000000-0000-4000-a000-000000000202'
      )
    FROM public.sales_status_events
    WHERE order_type = 'presale'
      AND order_id = (SELECT order_id FROM customer_link_context)
      AND metadata->>'action' = 'customer_link_changed'
  ),
  'the customer link records actor, old identity and new identity atomically'
);

UPDATE customer_link_context
SET expected_updated_at = (
  SELECT coalesce(updated_date, created_date)
  FROM public.presale_orders
  WHERE id = (SELECT order_id FROM customer_link_context)
);

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    SELECT public.prepare_presale_order_charge_creation(
      (SELECT order_id FROM customer_link_context),
      'PIX',
      current_date + 1,
      1,
      '12345678901',
      'checkout-wrong-customer',
      '00000000-0000-4000-a000-000000000201'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O vínculo do cliente mudou. Atualize a página antes de gerar a cobrança',
  'a stale customer selection cannot prepare an Asaas charge'
);

SELECT throws_ok(
  $$
    SELECT public.prepare_presale_order_charge_creation(
      (SELECT order_id FROM customer_link_context),
      'PIX',
      current_date + 1,
      1,
      '12345678901',
      'checkout-stale-version',
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT original_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O pedido mudou. Atualize a página antes de gerar a cobrança',
  'a stale order version cannot prepare an Asaas charge'
);

SELECT lives_ok(
  $$
    SELECT public.prepare_presale_order_charge_creation(
      (SELECT order_id FROM customer_link_context),
      'PIX',
      current_date + 1,
      1,
      '12345678901',
      'checkout-reviewed-asaas',
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'a reviewed current customer can prepare an Asaas charge'
);

SELECT lives_ok(
  $$
    SELECT public.prepare_presale_order_charge_creation(
      (SELECT order_id FROM customer_link_context),
      'PIX',
      current_date + 1,
      1,
      '12345678901',
      'checkout-reviewed-asaas',
      '00000000-0000-4000-a000-000000000201'::uuid,
      (SELECT original_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'an identical idempotent retry returns the existing operation after the page version changes'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.order_operations
    WHERE operation_type = 'create_charge'
      AND operation_key = 'checkout-reviewed-asaas'
      AND order_type = 'presale'
      AND order_id = (SELECT order_id FROM customer_link_context)
      AND status = 'prepared'
      AND payload->>'local_customer_id' =
        '00000000-0000-4000-a000-000000000202'
  ),
  'the prepared operation persists the reviewed canonical customer'
);

DELETE FROM public.order_operations
WHERE operation_type = 'create_charge'
  AND operation_key = 'checkout-reviewed-asaas'
  AND order_type = 'presale'
  AND order_id = (SELECT order_id FROM customer_link_context);

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT original_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O pedido foi alterado por outra ação. Atualize a página e tente novamente',
  'a stale administrative screen cannot overwrite a newer customer link'
);

SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      NULL,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O vínculo do cliente foi alterado por outra ação. Atualize a página e tente novamente',
  'a stale customer identity cannot overwrite a merge that kept the same timestamp'
);

SELECT lives_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000202'::uuid,
      NULL,
      (SELECT original_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'repeating the same link is an idempotent no-op'
);

RESET ROLE;

SELECT is(
  (SELECT count(*)::INTEGER
   FROM public.sales_status_events
   WHERE order_type = 'presale'
     AND order_id = (SELECT order_id FROM customer_link_context)
     AND metadata->>'action' = 'customer_link_changed'),
  1,
  'conflicts and idempotent retries do not create duplicate audit events'
);

UPDATE public.presale_orders
SET payment_status = 'charge_sent',
    updated_date = clock_timestamp()
WHERE id = (SELECT order_id FROM customer_link_context);
UPDATE customer_link_context
SET expected_updated_at = (
  SELECT coalesce(updated_date, created_date)
  FROM public.presale_orders
  WHERE id = (SELECT order_id FROM customer_link_context)
);
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'Troque o cliente antes de criar cobrança ou registrar pagamento',
  'an order with a sent charge cannot reassign an existing customer'
);
RESET ROLE;

UPDATE public.presale_orders
SET payment_status = 'paid',
    updated_date = clock_timestamp()
WHERE id = (SELECT order_id FROM customer_link_context);
UPDATE customer_link_context
SET expected_updated_at = (
  SELECT coalesce(updated_date, created_date)
  FROM public.presale_orders
  WHERE id = (SELECT order_id FROM customer_link_context)
);
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O cliente não pode ser alterado depois que o pedido recebe pagamento ou é encerrado',
  'a paid order cannot be reassigned'
);
RESET ROLE;

UPDATE public.presale_orders
SET payment_status = 'partially_paid',
    updated_date = clock_timestamp()
WHERE id = (SELECT order_id FROM customer_link_context);
UPDATE customer_link_context
SET expected_updated_at = (
  SELECT coalesce(updated_date, created_date)
  FROM public.presale_orders
  WHERE id = (SELECT order_id FROM customer_link_context)
);
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O cliente não pode ser alterado depois que o pedido recebe pagamento ou é encerrado',
  'a partially paid order cannot be reassigned'
);
RESET ROLE;

UPDATE public.presale_orders
SET payment_status = 'cancelled',
    updated_date = clock_timestamp()
WHERE id = (SELECT order_id FROM customer_link_context);
UPDATE customer_link_context
SET expected_updated_at = (
  SELECT coalesce(updated_date, created_date)
  FROM public.presale_orders
  WHERE id = (SELECT order_id FROM customer_link_context)
);
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O cliente não pode ser alterado depois que o pedido recebe pagamento ou é encerrado',
  'a cancelled order cannot be reassigned'
);
RESET ROLE;

UPDATE public.presale_orders
SET payment_status = 'refunded',
    updated_date = clock_timestamp()
WHERE id = (SELECT order_id FROM customer_link_context);
UPDATE customer_link_context
SET expected_updated_at = (
  SELECT coalesce(updated_date, created_date)
  FROM public.presale_orders
  WHERE id = (SELECT order_id FROM customer_link_context)
);
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.link_presale_order_customer(
      (SELECT order_id FROM customer_link_context),
      '00000000-0000-4000-a000-000000000201'::uuid,
      '00000000-0000-4000-a000-000000000202'::uuid,
      (SELECT expected_updated_at FROM customer_link_context),
      '00000000-0000-4000-a000-000000000299'::uuid
    )
  $$,
  'P0001',
  'O cliente não pode ser alterado depois que o pedido recebe pagamento ou é encerrado',
  'a refunded order cannot be reassigned'
);
RESET ROLE;

SELECT is(
  (SELECT customer_id
   FROM public.presale_orders
   WHERE id = (SELECT order_id FROM customer_link_context)),
  '00000000-0000-4000-a000-000000000202'::uuid,
  'blocked reassignment attempts preserve the reviewed customer'
);

UPDATE public.presale_orders
SET customer_id = NULL
WHERE id = (SELECT order_id FROM customer_link_context);

SELECT is(
  (SELECT customer_name
   FROM public.refunds_overview
   WHERE source_type = 'presale_order'
     AND source_id = (
       SELECT id
       FROM public.presale_orders
       WHERE checkout_whatsapp = '11999990004'
     )),
  'Pessoa ainda não cadastrada',
  'refund reporting falls back to the immutable checkout name'
);

SELECT * FROM finish();
ROLLBACK;
