BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL timezone='America/Sao_Paulo';
SELECT no_plan();

-- Fictitious store orders and prospects walk the billing flow: the overdue
-- cadence starts after the due date even without a first message, "skip"
-- moves to the next step without a send, and prospects stay on their board.
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
   'charge_sent',current_date,'https://example.test/pay/b6',now()-interval '6 days');

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

-- 1. No first message and the due date already passed: the overdue cadence runs.
SELECT is(pg_temp.suggest(1)->>'action_code','overdue_d3',
  'after the due date the first message no longer holds the cadence');
SELECT is((pg_temp.suggest(1)->>'eligible_at')::date,current_date+2,
  'the first overdue reminder waits for D+3');
SELECT is(pg_temp.suggest(2)->>'action_code','overdue_d3',
  'D+4 without any message asks for the D+3 reminder');
SELECT is(pg_temp.suggest(2)->>'blocked_reason',NULL,'the overdue reminder is actionable');
SELECT ok(pg_temp.suggest(2)->>'message' LIKE '%https://example.test/pay/b2%',
  'the overdue reminder carries the payment link');
SELECT is(pg_temp.suggest(3)->>'action_code','initial_charge',
  'before the due date the charge message still comes first');

-- 2. Pre-due reminder for longer plans, once.
SELECT is(pg_temp.suggest(6,jsonb_build_object('period_months',3),
    jsonb_build_object('pre_due_enabled',true,'pre_due_offset',-1,'pre_due_months',ARRAY[3,6]))->>'action_code',
  'pre_due','a quarterly plan gets the pre-due reminder');
SELECT is(pg_temp.suggest(6,jsonb_build_object('period_months',1),
    jsonb_build_object('pre_due_enabled',true,'pre_due_offset',-1,'pre_due_months',ARRAY[3,6]))->>'action_code',
  'overdue_d3','a monthly plan has no pre-due reminder');
INSERT INTO public.communication_case_events(case_id,event_type,contact_date,payload)
VALUES(pg_temp.case_for(6),'message_skipped',current_date-1,'{"action_code":"pre_due"}');
SELECT is(pg_temp.suggest(6,jsonb_build_object('period_months',3),
    jsonb_build_object('pre_due_enabled',true,'pre_due_offset',-1,'pre_due_months',ARRAY[3,6]))->>'action_code',
  'overdue_d3','a handled pre-due reminder is not suggested again on the due date');

-- 3. "Desconsiderar mensagem" skips the step without a send.
UPDATE public.communication_settings
  SET value=jsonb_build_object('enabled',true,'enabled_at',now()) WHERE key='cases_rollout';
CREATE TEMP TABLE before_skip AS
  SELECT payment_message_sent_at FROM public.stock_orders WHERE id=pg_temp.oid(4);
GRANT SELECT ON before_skip TO service_role;
SET LOCAL ROLE service_role;
SELECT is(pg_temp.suggest(4)->>'action_code','overdue_d3','D+3 reminder is due');
SELECT lives_ok($$SELECT pg_temp.act(4,'message_skipped','bill:skip:d3:0001')$$,'the D+3 reminder can be skipped');
SELECT is((SELECT count(*)::int FROM public.communication_case_events
  WHERE case_id=pg_temp.case_for(4) AND event_type='message_skipped' AND contact_date=current_date),1,
  'the skip is in the case history');
SELECT is((SELECT count(*)::int FROM public.communication_case_events
  WHERE case_id=pg_temp.case_for(4) AND event_type='message_sent'),0,'a skip is not a send');
SELECT is((SELECT payment_message_sent_at FROM public.stock_orders WHERE id=pg_temp.oid(4)),
  (SELECT payment_message_sent_at FROM before_skip),'the sale is not touched by a skip');
SELECT is((SELECT next_action_at FROM public.communication_cases WHERE id=pg_temp.case_for(4)),
  current_date+2,'the next step is the D+5 reminder');
SELECT is(pg_temp.suggest(4)->>'blocked_reason','skipped_today','the screen shows the skip until tomorrow');
SELECT throws_ok($$SELECT pg_temp.act(4,'message_skipped','bill:skip:d3:0002')$$,'P0001',NULL,
  'the same step is not skipped twice');
SELECT throws_ok($$SELECT pg_temp.act(4,'message_sent','bill:send:d3:0003')$$,'P0001',NULL,
  'no send is registered on the day of the skip');
SELECT throws_ok($$SELECT pg_temp.act(1,'message_skipped','bill:skip:fut:0001')$$,'P0001',NULL,
  'a step that is not due cannot be skipped');

-- 4. Daily reminders after D+7: a skip moves to tomorrow.
SELECT is(pg_temp.suggest(5)->>'action_code','overdue_daily','after D+7 the reminder is daily');
SELECT lives_ok($$SELECT pg_temp.act(5,'message_skipped','bill:skip:day:0001')$$,'a daily reminder can be skipped');
SELECT is((SELECT next_action_at FROM public.communication_cases WHERE id=pg_temp.case_for(5)),
  current_date+1,'the daily reminder comes back tomorrow');
RESET ROLE;

-- 5. Prospects are billed on the Prospects board, not in the Central.
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
