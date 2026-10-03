BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL timezone='America/Sao_Paulo';
SELECT no_plan();

-- Fictional contracts exercise historical membership, not just today's
-- status. end_date is exclusive; cancellation_date counts as an active day.
INSERT INTO public.assessment_modalities(id,name)
VALUES('c1000000-0000-4000-a000-000000000001','onboarding-eligibility-test');
INSERT INTO public.assessment_plans
  (id,modality_id,name,period,period_months,price_monthly,price_total,max_installments,enrollment_fee)
VALUES
  ('c1000000-0000-4000-a000-000000000011','c1000000-0000-4000-a000-000000000001',
   'Plano inicial fictício','mensal',1,100,100,1,0),
  ('c1000000-0000-4000-a000-000000000012','c1000000-0000-4000-a000-000000000001',
   'Plano alterado fictício','semestral',6,100,600,6,0);
INSERT INTO public.assessment_coaches(id,name,email,role,modality_ids)
VALUES
  ('c2000000-0000-4000-a000-000000000001','Treinador inicial','onboarding1@example.test',
   'pleno',ARRAY['c1000000-0000-4000-a000-000000000001'::uuid]),
  ('c2000000-0000-4000-a000-000000000002','Treinadora substituta','onboarding2@example.test',
   'pleno',ARRAY['c1000000-0000-4000-a000-000000000001'::uuid]);
INSERT INTO public.presale_customers(id,full_name,whatsapp)
SELECT ('c3000000-0000-4000-a000-0000000000'||lpad(n::text,2,'0'))::uuid,
  'Pessoa fictícia '||n,'119999800'||lpad(n::text,2,'0')
FROM generate_series(1,11) n;

CREATE FUNCTION pg_temp.customer(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('c3000000-0000-4000-a000-0000000000'||lpad(p_n::text,2,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.contract_id(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('c4000000-0000-4000-a000-0000000000'||lpad(p_n::text,2,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.add_contract(
  p_n integer,p_customer integer,p_status text,p_start date,p_end date,
  p_created timestamptz,p_relationship text DEFAULT NULL,p_previous uuid DEFAULT NULL,
  p_parent uuid DEFAULT NULL,p_cancellation date DEFAULT NULL,
  p_payment text DEFAULT 'paid'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid:=pg_temp.contract_id(p_n);
BEGIN
  INSERT INTO public.assessment_contracts
    (id,contract_number,customer_id,coach_id,plan_id,plan_snapshot,status,
     start_date,end_date,original_end_date,installments,payment_method,
     payment_status,payment_date,manual_payment,auto_renewal,renewal_generated,
     prospect_customer_relationship,prospect_previous_contract_id,
     parent_contract_id,cancellation_date,created_at)
  VALUES
    (v_id,'ASS-990'||lpad(p_n::text,3,'0'),pg_temp.customer(p_customer),
     'c2000000-0000-4000-a000-000000000001',
     'c1000000-0000-4000-a000-000000000011',
     '{"name":"Plano inicial fictício","period":"mensal","period_months":1,"price_total":100}'::jsonb,
     p_status,p_start,p_end,p_end,1,'pix',p_payment,
     CASE WHEN p_payment='paid' THEN p_start END,p_payment='paid',false,false,
     p_relationship,p_previous,p_parent,p_cancellation,p_created);
  RETURN v_id;
END;
$$;
CREATE FUNCTION pg_temp.eligible(p_n integer) RETURNS boolean LANGUAGE sql AS $$
  SELECT eon_private.communication_onboarding_eligible(pg_temp.contract_id(p_n));
$$;
CREATE FUNCTION pg_temp.case_count(p_n integer) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.communication_cases
  WHERE source_type='contract' AND source_id=pg_temp.contract_id(p_n)
    AND purpose='onboarding' AND status='open';
$$;

SELECT pg_temp.add_contract(1,1,'active',current_date-30,current_date+30,now()-interval '30 days',
  'new_customer');
SELECT ok(pg_temp.eligible(1),'first paid membership is eligible');
SELECT is(pg_temp.case_count(1),1::bigint,'first membership gets one open onboarding case');

SELECT pg_temp.add_contract(2,1,'active',current_date-5,current_date+35,now()-interval '20 days',
  'active_student',pg_temp.contract_id(1));
SELECT ok(NOT pg_temp.eligible(2),'additional contract for active student is ineligible');
SELECT is(pg_temp.case_count(2),0::bigint,'additional active contract gets no onboarding case');
SELECT ok(pg_temp.eligible(1),'later additional contract does not reclassify first membership');

SELECT pg_temp.add_contract(3,1,'scheduled',current_date+30,current_date+60,
  now()-interval '1 day',NULL,NULL,pg_temp.contract_id(1));
SELECT ok(NOT pg_temp.eligible(3),'renewal child never gets onboarding');
SELECT is(pg_temp.case_count(3),0::bigint,'renewal child gets no onboarding case');

SELECT pg_temp.add_contract(4,2,'finished',current_date-60,current_date-10,
  now()-interval '60 days');
SELECT pg_temp.add_contract(5,2,'active',current_date-8,current_date+22,
  now()-interval '8 days','former_student',pg_temp.contract_id(4));
SELECT ok(pg_temp.eligible(5),'former student returning after complete gap is eligible');
SELECT is(pg_temp.case_count(5),1::bigint,'return after gap gets a case');

SELECT pg_temp.add_contract(6,3,'finished',current_date-60,current_date-10,
  now()-interval '60 days');
SELECT pg_temp.add_contract(7,3,'active',current_date-10,current_date+20,
  now()-interval '10 days','former_student',pg_temp.contract_id(6));
SELECT ok(NOT pg_temp.eligible(7),'entry on exclusive end_date is continuous membership');
SELECT is(pg_temp.case_count(7),0::bigint,'continuous membership has no onboarding case');

SELECT pg_temp.add_contract(8,4,'finished',current_date-60,current_date+5,
  now()-interval '60 days');
SELECT pg_temp.add_contract(9,4,'active',current_date-10,current_date+20,
  now()-interval '10 days',NULL);
SELECT ok(NOT pg_temp.eligible(9),
  'historical overlap is ineligible even when earlier contract is now finished');

SELECT pg_temp.add_contract(10,5,'cancelled',current_date-60,current_date+10,
  now()-interval '60 days',NULL,NULL,NULL,current_date-10);
SELECT pg_temp.add_contract(11,5,'active',current_date-8,current_date+20,
  now()-interval '8 days','former_student',pg_temp.contract_id(10));
SELECT ok(pg_temp.eligible(11),'paid cancelled membership with full day gap allows return');

SELECT pg_temp.add_contract(12,6,'cancelled',current_date-60,current_date+10,
  now()-interval '60 days',NULL,NULL,NULL,current_date-9);
SELECT pg_temp.add_contract(13,6,'active',current_date-8,current_date+20,
  now()-interval '8 days','former_student',pg_temp.contract_id(12));
SELECT ok(NOT pg_temp.eligible(13),'entry day after cancellation has no complete gap');

SELECT pg_temp.add_contract(14,7,'finished',current_date-60,current_date-10,
  now()-interval '60 days');
-- Simulate a legacy direct contract whose INSERT predates case triggers.
ALTER TABLE public.assessment_contracts DISABLE TRIGGER communication_contract_source;
SELECT pg_temp.add_contract(15,7,'active',current_date-8,current_date+20,
  now()-interval '8 days');
ALTER TABLE public.assessment_contracts ENABLE TRIGGER communication_contract_source;
SELECT ok(pg_temp.eligible(15),'legacy direct root contract infers a real return');
SELECT ok((public.preview_communication_case_sync('contract',50)->'sample') @>
  jsonb_build_array(jsonb_build_object('source_type','contract',
    'source_id',pg_temp.contract_id(15),'purpose','onboarding','obligation_key','welcome')),
  'read-only backfill preview uses the same eligibility rule');
SELECT is(pg_temp.case_count(15),0::bigint,'preview does not create a case');
SELECT ok(eon_private.ensure_communication_case('contract',pg_temp.contract_id(15),'onboarding')
  IS NOT NULL,'explicit sync creates the previously missing case');

SELECT pg_temp.add_contract(23,8,'cancelled',current_date-60,current_date-10,
  now()-interval '60 days',p_payment=>'pending');
SELECT pg_temp.add_contract(16,8,'active',current_date-5,current_date+25,
  now()-interval '5 days','former_student',pg_temp.contract_id(23));
SELECT ok(NOT pg_temp.eligible(16),'unverifiable former-student label is held for review');
SELECT pg_temp.add_contract(17,9,'active',current_date-5,current_date+25,
  now()-interval '5 days','new_customer');
SELECT ok(pg_temp.eligible(17),'a different customer remains an independent first membership');
SELECT pg_temp.add_contract(18,9,'active',current_date-3,current_date+27,
  now()-interval '5 days');
SELECT ok(NOT pg_temp.eligible(18),
  'canonical contract numbers order additional contracts in the same transaction');
SELECT ok(pg_temp.eligible(17),
  'same-timestamp later contract cannot turn the first membership into a return');

SELECT pg_temp.add_contract(19,10,'overdue',current_date-60,current_date-10,
  now()-interval '60 days');
SELECT pg_temp.add_contract(20,10,'active',current_date-8,current_date+22,
  now()-interval '8 days','former_student',pg_temp.contract_id(19));
SELECT ok(pg_temp.eligible(20),
  'past exclusive end allows return even when older contract still says overdue');
SELECT pg_temp.add_contract(21,11,'active',current_date-60,current_date-10,
  now()-interval '60 days');
SELECT pg_temp.add_contract(22,11,'active',current_date-8,current_date+22,
  now()-interval '8 days');
SELECT ok(pg_temp.eligible(22),
  'past exclusive end allows return despite stale active status on older contract');

INSERT INTO public.assessment_contract_event(contract_id,event_type,payload)
VALUES(pg_temp.contract_id(1),'onboarding_welcome_sent','{"source":"fictional_test"}');
UPDATE public.assessment_contracts SET
  plan_id='c1000000-0000-4000-a000-000000000012',
  plan_snapshot='{"name":"Plano alterado fictício","period":"semestral","period_months":6,"price_total":600}'::jsonb,
  coach_id='c2000000-0000-4000-a000-000000000002',
  start_date=start_date-1,end_date=end_date+1
WHERE id=pg_temp.contract_id(1);
SELECT ok(pg_temp.eligible(1),'same-contract plan, coach and date edits preserve onboarding');
SELECT is(pg_temp.case_count(1),1::bigint,'same-contract edits do not open another case');
SELECT is((SELECT eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context('contract',pg_temp.contract_id(1)))->>'action_code'
  FROM public.communication_cases c WHERE c.source_id=pg_temp.contract_id(1)
    AND c.purpose='onboarding' AND c.status='open'),
  'onboarding_checkin','welcome history still advances the same case to check-in');
SELECT is((SELECT count(*) FROM public.assessment_contract_event
  WHERE contract_id=pg_temp.contract_id(1) AND event_type='onboarding_welcome_sent'),
  1::bigint,'same-contract edits preserve one welcome event');
INSERT INTO public.assessment_contract_event(contract_id,event_type,payload)
VALUES(pg_temp.contract_id(1),'onboarding_checkin_sent','{"source":"fictional_test"}');
SELECT ok(NOT pg_temp.eligible(1),'completed check-in cannot restart onboarding');
SELECT is(pg_temp.case_count(1),0::bigint,
  'completed check-in resolves the original case without a replacement');

SELECT * FROM finish();
ROLLBACK;
