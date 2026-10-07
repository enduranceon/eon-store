BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL timezone='America/Sao_Paulo';
SELECT no_plan();

-- Fictional new students walk the three onboarding steps (welcome, check-in on
-- day 5, feedback on day 20) through the same action the panel uses. Sending is
-- manual: an early step or a missing phone does not lock the registration.
INSERT INTO public.assessment_modalities(id,name)
VALUES('d1000000-0000-4000-a000-000000000001','onboarding-steps-test');
INSERT INTO public.assessment_plans
  (id,modality_id,name,period,period_months,price_monthly,price_total,max_installments,enrollment_fee)
VALUES('d1000000-0000-4000-a000-000000000011','d1000000-0000-4000-a000-000000000001',
  'Plano fictício de passos','mensal',1,100,100,1,0);
INSERT INTO public.assessment_coaches(id,name,email,role,modality_ids)
VALUES('d2000000-0000-4000-a000-000000000001','Treinador fictício','passos@example.test',
  'pleno',ARRAY['d1000000-0000-4000-a000-000000000001'::uuid]);
INSERT INTO public.presale_customers(id,full_name,whatsapp)
SELECT ('d3000000-0000-4000-a000-0000000000'||lpad(n::text,2,'0'))::uuid,
  'Pessoa passos '||n,CASE WHEN n=2 THEN NULL ELSE '119999700'||lpad(n::text,2,'0') END
FROM generate_series(1,4) n;

CREATE FUNCTION pg_temp.contract_id(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('d4000000-0000-4000-a000-0000000000'||lpad(p_n::text,2,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.add_contract(p_n integer,p_paid_days_ago integer) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid:=pg_temp.contract_id(p_n);
BEGIN
  INSERT INTO public.assessment_contracts
    (id,contract_number,customer_id,coach_id,plan_id,plan_snapshot,status,
     start_date,end_date,original_end_date,installments,payment_method,
     payment_status,payment_date,manual_payment,auto_renewal,renewal_generated,
     prospect_customer_relationship,created_at)
  VALUES
    (v_id,'ASS-980'||lpad(p_n::text,3,'0'),
     ('d3000000-0000-4000-a000-0000000000'||lpad(p_n::text,2,'0'))::uuid,
     'd2000000-0000-4000-a000-000000000001','d1000000-0000-4000-a000-000000000011',
     '{"name":"Plano fictício de passos","period":"mensal","period_months":1,"price_total":100}'::jsonb,
     'active',current_date-p_paid_days_ago,current_date-p_paid_days_ago+30,
     current_date-p_paid_days_ago+30,1,'pix','paid',current_date-p_paid_days_ago,true,
     false,false,'new_customer',now()-make_interval(days=>p_paid_days_ago));
  RETURN v_id;
END;
$$;
CREATE FUNCTION pg_temp.case_id(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.communication_cases
  WHERE source_type='contract' AND source_id=pg_temp.contract_id(p_n)
    AND purpose='onboarding' ORDER BY created_at DESC LIMIT 1;
$$;
CREATE FUNCTION pg_temp.suggestion(p_n integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context('contract',c.source_id))
  FROM public.communication_cases c WHERE c.id=pg_temp.case_id(p_n);
$$;
CREATE FUNCTION pg_temp.send(p_n integer,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_detail jsonb:=public.get_communication_case(pg_temp.case_id(p_n));
BEGIN
  RETURN public.apply_communication_case_action(pg_temp.case_id(p_n),
    jsonb_build_object('action','message_sent',
      'expected_version',(v_detail->'case'->>'version')::bigint,
      'expected_source_fingerprint',v_detail->'case'->>'source_fingerprint',
      'expected_rule_version',(v_detail->'suggestion'->>'rule_version')::int,
      'source_ui','sql_test','channel','whatsapp','confirmed_external_send',true,
      'message','Mensagem copiada e enviada pelo WhatsApp.'),
    p_key,'a1000000-0000-4000-a000-000000000099');
END;
$$;

UPDATE public.communication_settings
  SET value=jsonb_build_object('enabled',true,'enabled_at',now()) WHERE key='cases_rollout';

SELECT ok(EXISTS(SELECT 1 FROM public.communication_rules WHERE slug='onboarding-feedback-20d'
  AND task_kind='onboarding_feedback' AND trigger_event='onboarding_welcome_sent'
  AND days_offset=20 AND active),'the day-20 feedback model is active');

-- 1. Welcome on the day of the payment.
SELECT pg_temp.add_contract(1,0);
SELECT is(pg_temp.suggestion(1)->>'action_code','onboarding_welcome','a new payment starts with the welcome');
SELECT pg_temp.send(1,'onb:steps:welcome01');
SELECT ok(EXISTS(SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id=pg_temp.contract_id(1) AND event_type='onboarding_welcome_sent'),
  'the welcome is recorded on the contract');
SELECT is((SELECT status FROM public.communication_cases WHERE id=pg_temp.case_id(1)),
  'open','the case stays open after the welcome');
SELECT is(pg_temp.suggestion(1)->>'action_code','onboarding_checkin','the next step is the check-in');
SELECT is((pg_temp.suggestion(1)->>'eligible_at')::date,current_date+5,'the check-in is planned for day 5');
SELECT is(pg_temp.suggestion(1)->>'blocked_reason',NULL,'a step before its date is not locked');

-- 2. A missing phone does not lock a manual send.
SELECT pg_temp.add_contract(2,0);
SELECT is(pg_temp.suggestion(2)->>'blocked_reason',NULL,'missing phone does not lock onboarding');
SELECT ok((pg_temp.send(2,'onb:steps:nophone1')->'event'->>'id') IS NOT NULL,
  'the welcome can be registered without a phone');

-- 3. The check-in can be registered before day 5 and leads to the feedback.
SELECT pg_temp.add_contract(3,2);
INSERT INTO public.assessment_contract_event(contract_id,event_type,payload,created_at)
VALUES(pg_temp.contract_id(3),'onboarding_welcome_sent','{"source":"fictional_test"}',now()-interval '2 days');
SELECT is(pg_temp.suggestion(3)->>'action_code','onboarding_checkin','two days after the welcome comes the check-in');
SELECT pg_temp.send(3,'onb:steps:checkin1');
SELECT ok(EXISTS(SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id=pg_temp.contract_id(3) AND event_type='onboarding_checkin_sent'),
  'an early check-in is recorded');
SELECT is((SELECT status FROM public.communication_cases WHERE id=pg_temp.case_id(3)),
  'open','the case stays open for the feedback');
SELECT is((SELECT next_action_at FROM public.communication_cases WHERE id=pg_temp.case_id(3)),
  current_date+18,'the case waits for day 20 after the welcome');
SELECT is(pg_temp.suggestion(3)->>'action_code','onboarding_feedback','the next step is the day-20 feedback');
SELECT is((pg_temp.suggestion(3)->>'eligible_at')::date,current_date+18,
  'the feedback is planned for day 20 after the welcome');

-- 4. The day-20 feedback completes onboarding.
SELECT pg_temp.add_contract(4,21);
INSERT INTO public.assessment_contract_event(contract_id,event_type,payload,created_at)
VALUES(pg_temp.contract_id(4),'onboarding_welcome_sent','{"source":"fictional_test"}',now()-interval '21 days'),
      (pg_temp.contract_id(4),'onboarding_checkin_sent','{"source":"communication_case"}',now()-interval '16 days');
SELECT is(pg_temp.suggestion(4)->>'action_code','onboarding_feedback','day 21 asks for the feedback');
SELECT is(pg_temp.suggestion(4)->>'rule_slug','onboarding-feedback-20d','the feedback uses its own model');
SELECT ok(pg_temp.suggestion(4)->>'message' LIKE '%20 dias%','the suggested text is the feedback message');
SELECT pg_temp.send(4,'onb:steps:feedback');
SELECT ok(EXISTS(SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id=pg_temp.contract_id(4) AND event_type='onboarding_feedback_sent'),
  'the feedback is recorded on the contract');
SELECT is((SELECT status||':'||resolution_reason FROM public.communication_cases WHERE id=pg_temp.case_id(4)),
  'resolved:onboarding_completed','the feedback completes the onboarding case');
SELECT ok(NOT eon_private.communication_onboarding_eligible(pg_temp.contract_id(4)),
  'a completed onboarding does not start again');

-- 5. The feedback model can be edited and simulated like the others.
CREATE TEMP TABLE model_results(name text PRIMARY KEY,result jsonb);
INSERT INTO model_results VALUES('draft',public.communication_model_command('save_draft',
  'a1000000-0000-4000-a000-000000000099',jsonb_build_object(
    'rule_id',(SELECT id FROM public.communication_rules WHERE slug='onboarding-feedback-20d'),
    'base_version',(SELECT template_version FROM public.communication_rules WHERE slug='onboarding-feedback-20d'),
    'rule',(SELECT jsonb_build_object('slug',slug,'name',name,'journey',journey,'task_kind',task_kind,
      'trigger_event',trigger_event,'days_offset',days_offset,'channel',channel,'active',active,
      'order_index',order_index,'message_template','Olá, {nome}! Como estão os treinos?')
      FROM public.communication_rules WHERE slug='onboarding-feedback-20d'))));
INSERT INTO model_results VALUES('simulation',public.communication_model_command('simulate',
  'a1000000-0000-4000-a000-000000000099',
  jsonb_build_object('draft_id',(SELECT result->>'id' FROM model_results WHERE name='draft'))));
SELECT is((SELECT result->>'can_publish' FROM model_results WHERE name='simulation'),'true',
  'the feedback draft can be published');
SELECT ok((SELECT bool_or((x->>'draft_selected')::boolean)
    FROM model_results, jsonb_array_elements(result->'scenarios') x WHERE name='simulation'),
  'the simulation selects the feedback draft');

SELECT * FROM finish();
ROLLBACK;
