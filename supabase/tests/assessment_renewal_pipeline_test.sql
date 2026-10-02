BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(40);

SELECT ok(has_function_privilege('service_role',
  'public.transition_assessment_renewal_stage(uuid,text,text,date,timestamptz,uuid,text,text)',
  'EXECUTE'), 'only the API service can invoke renewal transitions');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.transition_assessment_renewal_stage(uuid,text,text,date,timestamptz,uuid,text,text)',
  'EXECUTE'), 'browser users cannot invoke the transition RPC');
SELECT ok(NOT has_function_privilege('anon',
  'public.transition_assessment_renewal_stage(uuid,text,text,date,timestamptz,uuid,text,text)',
  'EXECUTE'), 'anonymous users cannot invoke the transition RPC');

INSERT INTO public.assessment_modalities (id, name)
VALUES ('71000000-0000-4000-a000-000000000001', 'renewal-pipeline-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly,
  price_total, max_installments, enrollment_fee
) VALUES
  ('71000000-0000-4000-a000-000000000011',
   '71000000-0000-4000-a000-000000000001', 'Mensal teste', 'mensal',
   1, 200, 200, 1, 0),
  ('71000000-0000-4000-a000-000000000012',
   '71000000-0000-4000-a000-000000000001', 'Trimestral teste', 'trimestral',
   3, 200, 600, 3, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('71000000-0000-4000-a000-000000000021', 'Coach fictício',
  'renewal-pipeline@example.test', 'senior',
  ARRAY['71000000-0000-4000-a000-000000000001'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('71000000-0000-4000-a000-000000000031', 'Manual vencida', '11900007131'),
  ('71000000-0000-4000-a000-000000000032', 'Mensal automática', '11900007132'),
  ('71000000-0000-4000-a000-000000000033', 'Saída real', '11900007133'),
  ('71000000-0000-4000-a000-000000000034', 'Venda descartada', '11900007134');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot,
  status, start_date, end_date, original_end_date, installments,
  payment_status, payment_date, auto_renewal, renewal_generated
) VALUES
  ('71000000-0000-4000-a000-000000000101', 'ASS-971001',
   '71000000-0000-4000-a000-000000000031',
   '71000000-0000-4000-a000-000000000021',
   '71000000-0000-4000-a000-000000000012',
   '{"name":"Trimestral teste","period":"trimestral","period_months":3,"price_total":600}'::jsonb,
   'active', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 96,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date - 6,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date - 6,
   3, 'paid', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 96,
   false, false),
  ('71000000-0000-4000-a000-000000000102', 'ASS-971002',
   '71000000-0000-4000-a000-000000000032',
   '71000000-0000-4000-a000-000000000021',
   '71000000-0000-4000-a000-000000000011',
   '{"name":"Mensal teste","period":"mensal","period_months":1,"price_total":200}'::jsonb,
   'active', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 25,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 5,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 5,
   1, 'paid', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 25,
   true, false),
  ('71000000-0000-4000-a000-000000000103', 'ASS-971003',
   '71000000-0000-4000-a000-000000000033',
   '71000000-0000-4000-a000-000000000021',
   '71000000-0000-4000-a000-000000000012',
   '{"name":"Trimestral teste","period":"trimestral","period_months":3,"price_total":600}'::jsonb,
   'active', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 70,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 20,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 20,
   3, 'paid', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 70,
   false, true),
  ('71000000-0000-4000-a000-000000000104', 'ASS-971004',
   '71000000-0000-4000-a000-000000000034',
   '71000000-0000-4000-a000-000000000021',
   '71000000-0000-4000-a000-000000000012',
   '{"name":"Trimestral teste","period":"trimestral","period_months":3,"price_total":600}'::jsonb,
   'active', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 60,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 30,
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 30,
   3, 'paid', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 60,
   false, true);

SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000101'),
  NULL::text, 'original contract has no renewal stage');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT public.process_internal_assessment_renewals(10, 5, NULL)$$,
  'daily job catches up a D+6 manual contract and prepares a D-5 auto contract');
RESET ROLE;
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
  'contact_pending', 'overdue manual renewal stays in contact pending');
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  'waiting_payment', 'monthly automatic renewal skips contact and charge stages');
SELECT ok((SELECT auto_renewal FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  'automatic child keeps the subscription marker');
SELECT ok((SELECT end_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
  FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000101'),
  'manual parent really is overdue');
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT public.process_internal_assessment_renewals(10, 5, NULL)$$,
  'daily job can be repeated');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
  1, 'daily retry did not duplicate the manual child');
SELECT is((SELECT count(*)::int FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  1, 'daily retry did not duplicate the automatic child');

SELECT throws_ok($$UPDATE public.assessment_contracts SET auto_renewal = true
  WHERE id = '71000000-0000-4000-a000-000000000103'$$,
  '22023', NULL, 'nonmonthly automatic activation is blocked on update');
SELECT throws_ok($$INSERT INTO public.assessment_contracts (
    id, customer_id, coach_id, plan_id, plan_snapshot, status,
    start_date, end_date, original_end_date, installments,
    payment_status, auto_renewal, parent_contract_id
  ) VALUES (
    '71000000-0000-4000-a000-000000000204',
    '71000000-0000-4000-a000-000000000034',
    '71000000-0000-4000-a000-000000000021',
    '71000000-0000-4000-a000-000000000012',
    '{"period_months":3,"price_total":600}'::jsonb, 'draft',
    current_date + 30, current_date + 120, current_date + 120,
    3, 'pending', true, '71000000-0000-4000-a000-000000000104'
  )$$, '22023', NULL,
  'nonmonthly automatic child cannot be inserted');
SELECT throws_ok($$UPDATE public.assessment_contracts
  SET renewal_stage = 'renewed'
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'$$,
  '23514', NULL, 'a payment-free child cannot be marked renewed');
SELECT throws_ok($$UPDATE public.assessment_contracts
  SET renewal_stage = 'not_renewed'
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'$$,
  '23514', NULL, 'non-renewal requires safe resolution evidence');

SELECT set_config('test.renewal_message_version', (
  SELECT updated_at::text FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'
), true);
CREATE FUNCTION pg_temp.manual_action(
  p_action text, p_key text, p_response text DEFAULT NULL,
  p_follow_up date DEFAULT NULL, p_expected timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.transition_assessment_renewal_stage(
    (SELECT id FROM public.assessment_contracts
     WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
    p_action, p_response, p_follow_up,
    COALESCE(p_expected, (SELECT updated_at FROM public.assessment_contracts
      WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101')),
    '71000000-0000-4000-a000-000000000999', p_key, NULL
  );
$$;

SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.manual_action('message_sent',
  'renewal:test:message', NULL, NULL,
  current_setting('test.renewal_message_version')::timestamptz)$$,
  'first message moves the manual child');
RESET ROLE;
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
  'waiting_response', 'message sent creates waiting response');
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.manual_action('message_sent',
  'renewal:test:message', NULL, NULL,
  current_setting('test.renewal_message_version')::timestamptz)$$,
  'same idempotency key and payload returns the earlier result');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.assessment_contract_event
  WHERE contract_id = '71000000-0000-4000-a000-000000000101'
    AND event_type = 'renewal_message_sent'),
  1, 'message retry does not create another event');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT pg_temp.manual_action('message_sent',
  'renewal:test:message', 'will_renew', NULL,
  current_setting('test.renewal_message_version')::timestamptz)$$,
  'P0001', NULL, 'same key with a different payload is rejected');
SELECT throws_ok($$SELECT pg_temp.manual_action('register_response',
  'renewal:test:stale', 'thinking', NULL, '2000-01-01'::timestamptz)$$,
  'P0001', NULL, 'stale card version cannot update the response');
SELECT lives_ok($$SELECT pg_temp.manual_action('register_response',
  'renewal:test:thinking', 'thinking', current_date + 1)$$,
  'thinking response can schedule a follow-up');
RESET ROLE;
SELECT is((SELECT renewal_response_code FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
  'thinking', 'thinking is recorded without terminal resolution');
SELECT is((SELECT renewal_follow_up_at FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
  current_date + 1, 'follow-up date is persistent');
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.manual_action('register_response',
  'renewal:test:yes', 'will_renew')$$,
  'athlete decision can advance toward billing');
RESET ROLE;
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000101'),
  'charge_pending', 'positive response enters charge pending');

UPDATE public.assessment_contracts
SET payment_status = 'paid', payment_date = current_date, updated_at = now()
WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102';
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  'renewed', 'payment confirmation updates the stage server-side');
UPDATE public.assessment_contracts
SET payment_status = 'overdue', payment_date = NULL, updated_at = now()
WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102';
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  'waiting_payment', 'reversed payment returns to waiting payment');

CREATE FUNCTION pg_temp.subscription_link(p_key text, p_link text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.transition_assessment_renewal_stage(
    (SELECT id FROM public.assessment_contracts
     WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
    'register_subscription_link', NULL, NULL,
    (SELECT updated_at FROM public.assessment_contracts
     WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
    '71000000-0000-4000-a000-000000000999', p_key, p_link
  );
$$;
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.subscription_link(
  'renewal:test:link', 'https://www.asaas.com/i/fictional')$$,
  'existing subscription link can be recorded without creating a charge');
RESET ROLE;
SELECT is((SELECT asaas_payment_link FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  'https://www.asaas.com/i/fictional', 'link stays on the original sale');
SELECT is((SELECT count(*)::int FROM public.asaas_payments
  WHERE order_type = 'contract'
    AND order_id = (SELECT id FROM public.assessment_contracts
      WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102')),
  0, 'registering the link creates no Asaas payment record');
SELECT ok((SELECT payload ? 'new_link_host' AND NOT payload ? 'new_link'
  FROM public.assessment_contract_event
  WHERE contract_id = (SELECT id FROM public.assessment_contracts
    WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102')
    AND event_type = 'renewal_subscription_link_registered'
  ORDER BY created_at DESC LIMIT 1),
  'link audit contains only the host, without URL token');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT pg_temp.subscription_link(
  'renewal:test:link', 'https://www.asaas.com/i/changed')$$,
  'P0001', NULL, 'link payload participates in the idempotency fingerprint');
RESET ROLE;
UPDATE public.assessment_contracts
SET status = 'finished', updated_at = now()
WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102';
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE parent_contract_id = '71000000-0000-4000-a000-000000000102'),
  'waiting_payment', 'a finished term does not hide an unpaid renewal');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot,
  status, start_date, end_date, original_end_date, installments,
  payment_status, auto_renewal, parent_contract_id
) VALUES
  ('71000000-0000-4000-a000-000000000203', 'ASS-971203',
   '71000000-0000-4000-a000-000000000033',
   '71000000-0000-4000-a000-000000000021',
   '71000000-0000-4000-a000-000000000012',
   '{"period_months":3,"price_total":600}'::jsonb,
   'draft', current_date + 20, current_date + 110, current_date + 110,
   3, 'pending', false, '71000000-0000-4000-a000-000000000103'),
  ('71000000-0000-4000-a000-000000000204', 'ASS-971204',
   '71000000-0000-4000-a000-000000000034',
   '71000000-0000-4000-a000-000000000021',
   '71000000-0000-4000-a000-000000000012',
   '{"period_months":3,"price_total":600}'::jsonb,
   'draft', current_date + 30, current_date + 120, current_date + 120,
   3, 'pending', false, '71000000-0000-4000-a000-000000000104');
UPDATE public.assessment_contracts
SET status = 'voided', payment_status = 'cancelled', updated_at = now()
WHERE id IN ('71000000-0000-4000-a000-000000000203',
             '71000000-0000-4000-a000-000000000204');
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000204'),
  NULL::text, 'discarded sale is not counted as non-renewal');
INSERT INTO public.assessment_contract_event (
  contract_id, event_type, payload, notes
) VALUES (
  '71000000-0000-4000-a000-000000000103', 'renewal_declined',
  '{"discarded_contract_id":"71000000-0000-4000-a000-000000000203","resolution":"non_renewal"}'::jsonb,
  'Resolução fictícia para teste de etapa'
);
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000203'),
  'not_renewed', 'safe non-renewal event resolves only the matching child');
SELECT ok((SELECT renewal_resolved_at IS NOT NULL FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000203'),
  'resolved timestamp supports the five-day board window');
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000204'),
  NULL::text, 'another voided sale remains unclassified');
UPDATE public.assessment_contracts
SET status = 'cancelled', payment_status = 'paid', payment_date = current_date,
    updated_at = now()
WHERE id = '71000000-0000-4000-a000-000000000204';
UPDATE public.assessment_contracts
SET payment_status = 'paid', updated_at = now()
WHERE id = '71000000-0000-4000-a000-000000000204';
SELECT is((SELECT renewal_stage FROM public.assessment_contracts
  WHERE id = '71000000-0000-4000-a000-000000000204'),
  NULL::text, 'cancelled and paid without non-renewal evidence stays for review');

SELECT * FROM finish();
ROLLBACK;
