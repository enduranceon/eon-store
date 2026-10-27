BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(12);

-- Fixtures fictícias: contrato mensal com pro rata, link já enviado, que troca
-- de link antes do vencimento.
INSERT INTO auth.users (id, email) VALUES ('95100000-0000-4000-a000-0000000000ff', 'link-change-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('95100000-0000-4000-a000-000000000010', 'link-change-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES ('95100000-0000-4000-a000-000000000011', '95100000-0000-4000-a000-000000000010',
  'Plano Link Teste', 'mensal', 1, 210, 210, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('95100000-0000-4000-a000-000000000012', 'Coach Link Teste', 'link-teste@example.test', 'senior',
        ARRAY['95100000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf)
VALUES ('95100000-0000-4000-a000-000000000021', 'Pessoa Link Teste', '11900009511', '52998224725');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, manual_payment, external_payment_link, payment_message_sent_at,
  auto_renewal, renewal_generated
) VALUES (
  '95100000-0000-4000-a000-000000000101', 'ASS-995201', '95100000-0000-4000-a000-000000000021',
  '95100000-0000-4000-a000-000000000012', '95100000-0000-4000-a000-000000000011',
  jsonb_build_object('name', 'Plano Link Teste', 'period', 'mensal', 'period_months', 1, 'price_total', 70,
    'prorata', jsonb_build_object('cycle_day', 7, 'days', 10, 'full_price_total', 210,
      'start_date', current_date + 1, 'end_date', current_date + 11)),
  'scheduled', current_date + 1, current_date + 11, current_date + 11, current_date + 1, 1,
  'pix', 'charge_sent', false, 'https://example.test/pay/old', now() - interval '2 hours', false, false
);

INSERT INTO public.communication_cases (source_type, source_id, purpose, obligation_key, next_action_at)
VALUES ('contract', '95100000-0000-4000-a000-000000000101', 'billing', 'source', current_date)
ON CONFLICT (source_type, source_id, purpose, obligation_key) DO NOTHING;

CREATE FUNCTION pg_temp.suggest() RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type, c.source_id))
  FROM public.communication_cases c
  WHERE c.source_type = 'contract' AND c.source_id = '95100000-0000-4000-a000-000000000101'
    AND c.purpose = 'billing';
$$;
CREATE FUNCTION pg_temp.save(p_link text, p_due date) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.save_assessment_contract_external_charge(
    '95100000-0000-4000-a000-000000000101', p_link, p_due, 'pix', NULL, 'contract_detail',
    (SELECT updated_at FROM public.assessment_contracts WHERE id = '95100000-0000-4000-a000-000000000101'),
    '95100000-0000-4000-a000-0000000000ff');
$$;
CREATE FUNCTION pg_temp.sent_at() RETURNS timestamptz LANGUAGE sql AS $$
  SELECT payment_message_sent_at FROM public.assessment_contracts
  WHERE id = '95100000-0000-4000-a000-000000000101';
$$;

-- 1. Pro rata na referência da cobrança.
SELECT is(
  eon_private.communication_template_context(
    eon_private.communication_source_context('contract', '95100000-0000-4000-a000-000000000101'))->>'referente',
  'referente ao seu plano Plano Link Teste (ASS-995201, proporcional de '
    || to_char(current_date + 1, 'DD/MM') || ' a ' || to_char(current_date + 10, 'DD/MM') || ')',
  'the charge reference names the pro rata period up to the day before the cycle day');
SELECT is(
  eon_private.communication_template_context(
    '{"source_type":"contract","plan_name":"Plano X","reference":"ASS-1"}'::jsonb)->>'referente',
  'referente ao seu plano Plano X (ASS-1)',
  'a contract without pro rata keeps the plain reference');

-- 2. Mensagem já enviada com o link atual: nada de cobrança inicial de novo.
SELECT isnt(pg_temp.suggest()->>'action_code', 'initial_charge',
  'with the current link already sent the first charge is done');

-- 3. Mesmo link, outro vencimento: a mensagem continua enviada.
SELECT lives_ok($$SELECT pg_temp.save('https://example.test/pay/old', current_date + 2)$$,
  'the due date changes with the same link');
SELECT isnt(pg_temp.sent_at(), NULL, 'the same link keeps the message as sent');
SELECT isnt(pg_temp.suggest()->>'action_code', 'initial_charge',
  'the same link does not ask for the first charge again');

-- 4. Link novo: a mensagem volta a "não enviada" e a Central oferece a cobrança.
SELECT lives_ok($$SELECT pg_temp.save('https://example.test/pay/new', current_date + 1)$$,
  'the link changes');
SELECT is(pg_temp.sent_at(), NULL, 'a new link clears the message sent date');
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_event
   WHERE contract_id = '95100000-0000-4000-a000-000000000101'
     AND event_type = 'external_charge_updated' AND payload->>'link' = 'https://example.test/pay/new'),
  1, 'the link change is in the contract history');
SELECT is(pg_temp.suggest()->>'action_code', 'initial_charge',
  'the message sent with the old link no longer counts: the first charge is offered again');
SELECT ok(pg_temp.suggest()->>'message' LIKE '%https://example.test/pay/new%'
    AND pg_temp.suggest()->>'message' LIKE '%proporcional de%'
    AND pg_temp.suggest()->>'message' NOT LIKE '%vencida%',
  'the suggested message is the charge with the new link and the pro rata period');

-- 5. O contexto do contrato leva o pro rata.
SELECT is(
  eon_private.communication_source_context('contract', '95100000-0000-4000-a000-000000000101')->'prorata'->>'days',
  '10', 'the contract context carries the pro rata');

SELECT * FROM finish();
ROLLBACK;
