BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(has_function_privilege('service_role', 'public.create_manual_assessment_prospect(text,text,text,text,uuid,uuid,integer,text,text,uuid,text,date)', 'EXECUTE'), 'backend can create prospects with profile');
SELECT ok(NOT has_function_privilege('anon', 'public.create_manual_assessment_prospect(text,text,text,text,uuid,uuid,integer,text,text,uuid,text,date)', 'EXECUTE'), 'anonymous cannot create prospects');
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_manual_assessment_prospect(text,text,text,text,uuid,uuid,integer,text,text,uuid,text,date)', 'EXECUTE'), 'browser cannot bypass the admin API');
SELECT ok(has_function_privilege('service_role', 'public.create_manual_assessment_prospect(text,text,text,text,uuid,uuid,integer,text,text,uuid)', 'EXECUTE'), 'legacy backend signature remains available');
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_manual_assessment_prospect(text,text,text,text,uuid,uuid,integer,text,text,uuid)', 'EXECUTE'), 'legacy signature remains backend-only');
SELECT ok(NOT has_function_privilege('anon', 'public.create_manual_assessment_prospect(text,text,text,text,uuid,uuid,integer,text,text,uuid)', 'EXECUTE'), 'legacy signature is not anonymous');
SELECT ok(bool_and(NOT prosecdef AND 'search_path=""' = ANY(proconfig)), 'both signatures use caller privileges and an empty search path')
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'create_manual_assessment_prospect';

INSERT INTO auth.users (id, email) VALUES ('81000000-0000-4000-a000-000000000001', 'prospect-admin@example.test');
INSERT INTO public.assessment_modalities (id, name) VALUES ('81000000-0000-4000-a000-000000000002', 'prospect-test-modality');
INSERT INTO public.assessment_plans (id, name, modality_id, period, period_months, price_monthly, price_total, max_installments, enrollment_fee)
VALUES ('81000000-0000-4000-a000-000000000003', 'Prospect test plan', '81000000-0000-4000-a000-000000000002', 'trimestral', 3, 200, 600, 3, 50);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('81000000-0000-4000-a000-000000000004', 'Prospect test coach', 'prospect-coach@example.test', 'senior', ARRAY['81000000-0000-4000-a000-000000000002'::uuid]);

CREATE FUNCTION pg_temp.create_prospect(operation_key text, overrides jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH input AS (
    SELECT jsonb_build_object(
      'full_name', 'Pessoa Prospect Ficticia', 'whatsapp', '+55 (51) 99999-9981',
      'email', ' Prospect81@example.test ', 'cpf', '123.456.789-09',
      'gender', 'feminino', 'birth_date', '2000-02-29', 'installments', 3
    ) || overrides AS data
  )
  SELECT public.create_manual_assessment_prospect(
    data->>'full_name', data->>'whatsapp', data->>'email', data->>'cpf',
    '81000000-0000-4000-a000-000000000003', '81000000-0000-4000-a000-000000000004',
    (data->>'installments')::integer, NULL, operation_key, '81000000-0000-4000-a000-000000000001',
    data->>'gender', (data->>'birth_date')::date
  ) FROM input;
$$;

CREATE TEMP TABLE financial_baseline AS SELECT count(*) AS payments FROM public.asaas_payments;
GRANT SELECT ON financial_baseline TO service_role;
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.create_prospect('prospect:test:valid')$$, 'formatted phone, CPF and email create a manual prospect');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_creation_operations WHERE operation_key = 'prospect:test:valid'), 1, 'manual_prospect is allowed in the creation ledger');
SELECT is((SELECT status FROM public.assessment_contracts WHERE customer_id = (SELECT id FROM public.presale_customers WHERE email = 'prospect81@example.test')), 'draft', 'prospect is not an activated sale');
SELECT is((SELECT prospect_stage FROM public.assessment_contracts WHERE customer_id = (SELECT id FROM public.presale_customers WHERE email = 'prospect81@example.test')), 'new', 'prospect appears in the new column');
SELECT is((SELECT gender FROM public.presale_customers WHERE email = 'prospect81@example.test'), 'feminino', 'gender saved on the customer');
SELECT is((SELECT birth_date::text FROM public.presale_customers WHERE email = 'prospect81@example.test'), '2000-02-29', 'valid leap-day birthday persisted');
SELECT is((SELECT whatsapp FROM public.presale_customers WHERE email = 'prospect81@example.test'), '+5551999999981', 'phone is normalized to E.164');
SELECT is((SELECT cpf FROM public.presale_customers WHERE email = 'prospect81@example.test'), '12345678909', 'CPF punctuation removed');
SELECT is((SELECT (plan_snapshot->>'price_total')::numeric FROM public.assessment_contracts WHERE customer_id = (SELECT id FROM public.presale_customers WHERE email = 'prospect81@example.test')), 600::numeric, 'plan amount unchanged');
SELECT is((SELECT installments FROM public.assessment_contracts WHERE customer_id = (SELECT id FROM public.presale_customers WHERE email = 'prospect81@example.test')), 3, 'installments preserved');
SELECT is(pg_temp.create_prospect('prospect:test:valid'), pg_temp.create_prospect('prospect:test:valid'), 'same-key retries return the same prospect');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_event WHERE contract_id = (pg_temp.create_prospect('prospect:test:valid')->'contract'->>'id')::uuid), 1, 'retry does not duplicate the event');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:valid', '{"gender":"outro"}')$$, 'P0001', NULL, 'gender participates in the idempotency fingerprint');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:valid', '{"birth_date":"2000-03-01"}')$$, 'P0001', NULL, 'birth date participates in the fingerprint');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:duplicate')$$, 'P0001', 'Este cliente já possui um prospect em negociação', 'different key cannot duplicate an open prospect');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_creation_operations WHERE operation_key = 'prospect:test:duplicate'), 0, 'failed operation is rolled back');

SELECT lives_ok($$SELECT pg_temp.create_prospect('prospect:test:optional', '{"whatsapp":"51999999982","cpf":null,"email":null,"gender":null,"birth_date":null}')$$, 'profile and document fields remain optional');
SELECT is((SELECT gender FROM public.presale_customers WHERE whatsapp = '+5551999999982'), NULL, 'empty gender remains null');
SELECT is((SELECT birth_date FROM public.presale_customers WHERE whatsapp = '+5551999999982'), NULL, 'empty birth date remains null');
SELECT lives_ok($$SELECT public.create_manual_assessment_prospect('Legacy Ficticio', '51999999983', NULL, NULL, '81000000-0000-4000-a000-000000000003', '81000000-0000-4000-a000-000000000004', 1, NULL, 'prospect:test:legacy', '81000000-0000-4000-a000-000000000001')$$, 'old API payload still works during a rollout or rollback');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:badphone', '{"whatsapp":"123"}')$$, '22023', NULL, 'invalid phone rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:badcpf', '{"cpf":"123"}')$$, '22023', NULL, 'incomplete CPF rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:bademail', '{"email":"bad@"}')$$, '22023', NULL, 'invalid email rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:badgender', '{"gender":"invalid"}')$$, '22023', NULL, 'invalid gender rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:future', '{"birth_date":"2999-01-01"}')$$, '22023', NULL, 'future birthday rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:old', '{"birth_date":"1899-12-31"}')$$, '22023', NULL, 'out-of-range birthday rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:invaliddate', '{"birth_date":"2025-02-29"}')$$, '22008', NULL, 'invalid calendar date rejected');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:installments', '{"installments":4}')$$, '22023', 'Quantidade de parcelas acima do limite do plano', 'plan installment limit enforced');

-- Reusing an existing customer can fill missing profile fields, never erase them.
RESET ROLE;
UPDATE public.assessment_contracts SET prospect_stage = 'lost'
WHERE customer_id = (SELECT id FROM public.presale_customers WHERE whatsapp = '+5551999999982');
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.create_prospect('prospect:test:fill', '{"whatsapp":"+55 (51) 99999-9982","cpf":null,"email":null}')$$, 'formatted phone reuses the existing customer');
SELECT is((SELECT count(*)::integer FROM public.presale_customers WHERE whatsapp = '+5551999999982'), 1, 'customer not duplicated');
SELECT is((SELECT birth_date::text FROM public.presale_customers WHERE whatsapp = '+5551999999982'), '2000-02-29', 'missing birthday filled on existing customer');
SELECT is((SELECT gender FROM public.presale_customers WHERE whatsapp = '+5551999999982'), 'feminino', 'missing gender filled on existing customer');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:conflictingdob', '{"birth_date":"2001-01-01"}')$$, 'P0001', NULL, 'conflicting birthday does not overwrite existing data');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:conflictinggender', '{"gender":"masculino"}')$$, 'P0001', NULL, 'conflicting gender does not overwrite existing data');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:conflictingcpf', '{"cpf":"98765432100"}')$$, 'P0001', NULL, 'shared phone with another CPF needs review');
SELECT throws_ok($$SELECT pg_temp.create_prospect('prospect:test:multiple', '{"whatsapp":"51999999982"}')$$, 'P0001', NULL, 'conflicting contact matches cannot choose a customer arbitrarily');
RESET ROLE;
UPDATE public.assessment_contracts SET prospect_stage = 'lost'
WHERE customer_id = (SELECT id FROM public.presale_customers WHERE email = 'prospect81@example.test');
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.create_prospect('prospect:test:preserve', '{"gender":null,"birth_date":null}')$$, 'omitted profile does not require changing the existing customer');
SELECT is((SELECT gender FROM public.presale_customers WHERE email = 'prospect81@example.test'), 'feminino', 'existing gender preserved when omitted');
SELECT is((SELECT birth_date::text FROM public.presale_customers WHERE email = 'prospect81@example.test'), '2000-02-29', 'existing birth date preserved when omitted');
SELECT is((SELECT count(*) FROM public.asaas_payments), (SELECT payments FROM financial_baseline), 'creation never generates charges or changes financial records');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.assessment_contracts WHERE coach_id = '81000000-0000-4000-a000-000000000004' AND (status <> 'draft' OR auto_renewal OR asaas_charge_id IS NOT NULL)), 'prospects remain drafts without automatic billing');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_creation_operations WHERE operation_scope = 'manual_prospect' AND operation_key LIKE 'prospect:test:%'), 5, 'only successful logical operations are recorded');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
