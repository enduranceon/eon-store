BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL timezone='America/Sao_Paulo';
SELECT no_plan();

-- Fictitious store orders and prospects walk the billing flow: the overdue
-- cadence starts after the due date even without a first message, runs every
-- day from D+3, "skip" moves to the next day without a send, and prospects
-- stay on their board.
INSERT INTO public.stock_orders(id,order_number,customer_name,customer_whatsapp,total_value,
  payment_status,due_date,asaas_payment_link,payment_message_sent_at)
VALUES
  ('b3000000-0000-4000-a000-000000000001','EST-BILL-1','Pessoa Cobrança 1','11999991001',150,
   'charge_sent',current_date-1,'https://example.test/pay/b1',NULL),
  ('b3000000-0000-4000-a000-000000000002','EST-BILL-2','Pessoa Cobrança 2','11999991002',150,
   'charge_sent',current_date-4,'https://example.test/pay/b2',NULL),
  ('b3000000-0000-4000-a000-000000000003','EST-BILL-3','Pessoa Cobrança 3','11999991003',150,
   'charge_sent',current_date+2,'https://example.test/pay/b3',NULL),
  ('b3000000-0000-4000-a000-000000000004','EST-BILL-4','Pessoa Cobrança 4','11999991004',150,
   'charge_sent',current_date-3,'https://example.test/pay/b4',now()-interval '6 days'),
  ('b3000000-0000-4000-a000-000000000005','EST-BILL-5','Pessoa Cobrança 5','11999991005',150,
   'charge_sent',current_date-9,'https://example.test/pay/b5',now()-interval '12 days'),
  ('b3000000-0000-4000-a000-000000000006','EST-BILL-6','Pessoa Cobrança 6','11999991006',150,
   'charge_sent',current_date,'https://example.test/pay/b6',now()-interval '6 days'),
  ('b3000000-0000-4000-a000-000000000007','EST-BILL-7','Pessoa Cobrança 7','11999991007',150,
   'charge_sent',current_date-6,'https://example.test/pay/b7',now()-interval '3 days');

CREATE FUNCTION pg_temp.oid(p_n int) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('b3000000-0000-4000-a000-00000000000'||p_n::text)::uuid;
$$;
CREATE FUNCTION pg_temp.case_for(p_n int) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.communication_cases
  WHERE source_type='stock' AND source_id=pg_temp.oid(p_n) AND purpose='billing' AND status='open'
  ORDER BY created_at DESC LIMIT 1;
$$;
CREATE FUNCTION pg_temp.suggest(p_n int, p_extra jsonb DEFAULT '{}'::jsonb,
  p_policy jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type,c.source_id) || p_extra,NULL,p_policy)
  FROM public.communication_cases c WHERE c.id=pg_temp.case_for(p_n);
$$;
CREATE FUNCTION pg_temp.act(p_n int, p_action text, p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_detail jsonb := public.get_communication_case(pg_temp.case_for(p_n));
BEGIN
  RETURN public.apply_communication_case_action(pg_temp.case_for(p_n),
    jsonb_build_object('action',p_action,
      'expected_version',(v_detail->'case'->>'version')::bigint,
      'expected_source_fingerprint',v_detail->'case'->>'source_fingerprint',
      'source_ui','sql_test')
    || CASE WHEN p_action='message_sent' THEN jsonb_build_object(
      'expected_rule_version',(v_detail->'suggestion'->>'rule_version')::int,
      'channel','whatsapp','confirmed_external_send',true,
      'message','Mensagem fictícia enviada pelo WhatsApp.') ELSE '{}'::jsonb END,
    p_key,'a1000000-0000-4000-a000-000000000001');
END;
$$;

INSERT INTO public.communication_case_events(case_id,event_type,contact_date,payload)
VALUES(pg_temp.case_for(7),'message_sent',current_date-3,'{"action_code":"overdue_daily"}');

-- 1. No first message and the due date already passed: the overdue cadence runs.
SELECT is(pg_temp.suggest(1)->>'action_code','overdue_daily',
  'after the due date the first message no longer holds the cadence');
SELECT is((pg_temp.suggest(1)->>'eligible_at')::date,current_date+2,
  'the first overdue reminder waits for D+3');
SELECT is(pg_temp.suggest(2)->>'action_code','overdue_daily',
  'D+4 without any message asks for the overdue reminder');
SELECT is(pg_temp.suggest(2)->>'blocked_reason',NULL,'the overdue reminder is actionable');
SELECT ok(pg_temp.suggest(2)->>'message' LIKE '%https://example.test/pay/b2%',
  'the overdue reminder carries the payment link');
SELECT ok(pg_temp.suggest(2)->>'message' LIKE '%vencida há *4 dias*%',
  'the overdue reminder says how many days it is overdue');
SELECT ok(pg_temp.suggest(2)->>'message' LIKE '%referente ao seu pedido EST-BILL-2%',
  'the overdue reminder says what the charge is for');
SELECT is(pg_temp.suggest(7)->>'action_code','overdue_daily',
  'D+6 after a D+3 send asks for today''s reminder');
SELECT is(pg_temp.suggest(7)->>'blocked_reason',NULL,
  'a day without a send does not hold the next one');
SELECT ok(pg_temp.suggest(7)->>'message' LIKE '%vencida há *6 dias*%',
  'the count follows the calendar, not the reminders sent');
SELECT is(pg_temp.suggest(3)->>'action_code','initial_charge',
  'before the due date the charge message still comes first');

-- 2. Pre-due reminder for longer plans, once.
SELECT is(pg_temp.suggest(6,jsonb_build_object('period_months',3),
    jsonb_build_object('pre_due_enabled',true,'pre_due_offset',-1,'pre_due_months',ARRAY[3,6]))->>'action_code',
  'pre_due','a quarterly plan gets the pre-due reminder');
SELECT is(pg_temp.suggest(6,jsonb_build_object('period_months',1),
    jsonb_build_object('pre_due_enabled',true,'pre_due_offset',-1,'pre_due_months',ARRAY[3,6]))->>'action_code',
  'overdue_daily','a monthly plan has no pre-due reminder');
INSERT INTO public.communication_case_events(case_id,event_type,contact_date,payload)
VALUES(pg_temp.case_for(6),'message_skipped',current_date-1,'{"action_code":"pre_due"}');
SELECT is(pg_temp.suggest(6,jsonb_build_object('period_months',3),
    jsonb_build_object('pre_due_enabled',true,'pre_due_offset',-1,'pre_due_months',ARRAY[3,6]))->>'action_code',
  'overdue_daily','a handled pre-due reminder is not suggested again on the due date');

-- 3. "Desconsiderar mensagem" skips the step without a send.
UPDATE public.communication_settings
  SET value=jsonb_build_object('enabled',true,'enabled_at',now()) WHERE key='cases_rollout';
CREATE TEMP TABLE before_skip AS
  SELECT payment_message_sent_at FROM public.stock_orders WHERE id=pg_temp.oid(4);
GRANT SELECT ON before_skip TO service_role;
SET LOCAL ROLE service_role;
SELECT is(pg_temp.suggest(4)->>'action_code','overdue_daily','D+3 reminder is due');
SELECT lives_ok($$SELECT pg_temp.act(4,'message_skipped','bill:skip:d3:0001')$$,'the D+3 reminder can be skipped');
SELECT is((SELECT count(*)::int FROM public.communication_case_events
  WHERE case_id=pg_temp.case_for(4) AND event_type='message_skipped' AND contact_date=current_date),1,
  'the skip is in the case history');
SELECT is((SELECT count(*)::int FROM public.communication_case_events
  WHERE case_id=pg_temp.case_for(4) AND event_type='message_sent'),0,'a skip is not a send');
SELECT is((SELECT payment_message_sent_at FROM public.stock_orders WHERE id=pg_temp.oid(4)),
  (SELECT payment_message_sent_at FROM before_skip),'the sale is not touched by a skip');
SELECT is((SELECT next_action_at FROM public.communication_cases WHERE id=pg_temp.case_for(4)),
  current_date+1,'the next reminder is tomorrow');
SELECT is(pg_temp.suggest(4)->>'blocked_reason','skipped_today','the screen shows the skip until tomorrow');
SELECT throws_ok($$SELECT pg_temp.act(4,'message_skipped','bill:skip:d3:0002')$$,'P0001',NULL,
  'the same step is not skipped twice');
SELECT throws_ok($$SELECT pg_temp.act(4,'message_sent','bill:send:d3:0003')$$,'P0001',NULL,
  'no send is registered on the day of the skip');
SELECT throws_ok($$SELECT pg_temp.act(1,'message_skipped','bill:skip:fut:0001')$$,'P0001',NULL,
  'a step that is not due cannot be skipped');

-- 4. Daily reminders: a skip moves to tomorrow.
SELECT is(pg_temp.suggest(5)->>'action_code','overdue_daily','D+9 still gets the daily reminder');
SELECT lives_ok($$SELECT pg_temp.act(5,'message_skipped','bill:skip:day:0001')$$,'a daily reminder can be skipped');
SELECT is((SELECT next_action_at FROM public.communication_cases WHERE id=pg_temp.case_for(5)),
  current_date+1,'the daily reminder comes back tomorrow');
RESET ROLE;

-- 5. One overdue model with the days and what the charge is for.
SELECT is((SELECT array_agg(slug ORDER BY slug) FROM public.communication_rules
  WHERE journey='billing' AND task_kind='charge_overdue' AND active),
  ARRAY['billing-charge-overdue'],'a single active overdue model');
SELECT ok((SELECT message_template LIKE '%{dias_atraso}%' AND message_template LIKE '%{referente}%'
  FROM public.communication_rules WHERE slug='billing-charge-overdue'),
  'the overdue model uses the days and the reference');
SELECT is((SELECT milestones FROM public.communication_cadence_policies),ARRAY[3],
  'the policy records the single D+3 milestone');
SELECT is((SELECT daily_after FROM public.communication_cadence_policies),3,
  'the policy records daily reminders from D+3');
SELECT is(eon_private.communication_template_context(jsonb_build_object('source_type','contract',
    'reference','ASS-TESTE','plan_name','Corrida - Trimestral','due_date',current_date-1))->>'referente',
  'referente ao seu plano Corrida - Trimestral (ASS-TESTE)','a contract names the plan');
SELECT is(eon_private.communication_template_context(jsonb_build_object('source_type','contract',
    'reference','ASS-TESTE','due_date',current_date-1))->>'dias_atraso',
  '1 dia','one day overdue is singular');
SELECT is((SELECT jsonb_build_object('dias_atraso',ctx->'dias_atraso','referente',ctx->'referente')
    FROM eon_private.communication_template_context(jsonb_build_object('source_type','presale',
      'reference','PED-TESTE','due_date',current_date,'items',jsonb_build_array(
        jsonb_build_object('product_name','Camiseta fictícia','quantity',1),
        jsonb_build_object('product_name','Boné fictício','quantity',1)))) ctx),
  jsonb_build_object('dias_atraso','','referente','referente ao seu pedido PED-TESTE (Camiseta fictícia +1)'),
  'an order names its items and a charge due today has no overdue days');
SELECT is(eon_private.communication_template_context(jsonb_build_object('source_type','event',
    'reference','INS-TESTE','items',jsonb_build_array(jsonb_build_object('name','Prova fictícia 10 km'))))->>'referente',
  'referente à sua inscrição INS-TESTE (Prova fictícia 10 km)','an event registration names the race');

-- 6. Prospects are billed on the Prospects board, not in the Central.
INSERT INTO auth.users (id, email) VALUES ('83000000-0000-4000-a000-000000000001', 'cobranca-admin@example.test');
INSERT INTO public.assessment_modalities (id, name) VALUES ('83000000-0000-4000-a000-000000000002', 'cobranca-test-modality');
INSERT INTO public.assessment_plans (id, name, modality_id, period, period_months, price_monthly, price_total, max_installments, enrollment_fee)
VALUES ('83000000-0000-4000-a000-000000000003', 'Plano fictício da cobrança', '83000000-0000-4000-a000-000000000002', 'mensal', 1, 300, 300, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('83000000-0000-4000-a000-000000000004', 'Coach fictício da cobrança', 'cobranca-coach@example.test', 'senior', ARRAY['83000000-0000-4000-a000-000000000002'::uuid]);
CREATE TEMP TABLE prospect_ids(id uuid);
GRANT ALL ON prospect_ids TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO prospect_ids SELECT (public.create_manual_assessment_prospect(
  'Pessoa Prospect Cobrança', '51999998301', NULL, NULL,
  '83000000-0000-4000-a000-000000000003', '83000000-0000-4000-a000-000000000004',
  1, NULL, 'cobranca:test:prospect', '83000000-0000-4000-a000-000000000001', NULL, NULL
)->'contract'->>'id')::uuid;
SELECT lives_ok($$SELECT public.prepare_assessment_prospect_proposal(
  (SELECT id FROM prospect_ids), 0, 0, 'https://www.asaas.com/i/ficticiocobranca', current_date + 1,
  (SELECT updated_at FROM public.assessment_contracts WHERE id=(SELECT id FROM prospect_ids)),
  '83000000-0000-4000-a000-000000000001')$$,'the prospect gets a proposal with a link');
RESET ROLE;
SELECT is((SELECT payment_status FROM public.assessment_contracts WHERE id=(SELECT id FROM prospect_ids)),
  'charge_sent','the prospect has an open charge');
SELECT is(eon_private.ensure_communication_case('contract',(SELECT id FROM prospect_ids),'billing'),NULL,
  'a prospect does not open a billing case in the Central');
SELECT is((SELECT count(*)::int FROM public.communication_cases
  WHERE source_type='contract' AND source_id=(SELECT id FROM prospect_ids)
    AND purpose='billing' AND status='open'),0,'no open billing case for the prospect');

SELECT * FROM finish();
ROLLBACK;
