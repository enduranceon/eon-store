BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(31);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.process_internal_assessment_renewals(integer,integer,uuid[])',
    'EXECUTE'
  ),
  'service_role can process internal renewals'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.process_internal_assessment_renewals(integer,integer,uuid[])',
    'EXECUTE'
  ),
  'anon cannot process internal renewals'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.process_internal_assessment_renewals(integer,integer,uuid[])',
    'EXECUTE'
  ),
  'authenticated clients cannot call the service-only renewal function'
);
SELECT ok(
  (
    SELECT procedure.prosecdef
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = 'public.process_internal_assessment_renewals(integer,integer,uuid[])'::regprocedure
  ),
  'renewal processing uses its owner privileges for the server-only transaction'
);
SELECT ok(
  (
    SELECT 'search_path=""' = ANY(procedure.proconfig)
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = 'public.process_internal_assessment_renewals(integer,integer,uuid[])'::regprocedure
  ),
  'the privileged renewal function keeps an empty search path'
);

INSERT INTO public.assessment_modalities (id, name)
VALUES ('10000000-0000-4000-a000-000000000010', 'renovacao-interna-test');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee
) VALUES (
  '10000000-0000-4000-a000-000000000011',
  '10000000-0000-4000-a000-000000000010',
  'Plano mensal de teste',
  'mensal',
  1,
  200,
  200,
  1,
  50
);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES (
  '10000000-0000-4000-a000-000000000012',
  'Coach de renovação',
  'renewal-test@example.test',
  'senior',
  ARRAY['10000000-0000-4000-a000-000000000010'::uuid]
);

INSERT INTO public.presale_customers (id, full_name, whatsapp)
VALUES
  ('10000000-0000-4000-a000-000000000021', 'Auto em cinco dias', '11900000021'),
  ('10000000-0000-4000-a000-000000000022', 'Manual em quinze dias', '11900000022'),
  ('10000000-0000-4000-a000-000000000023', 'Auto fora da janela', '11900000023'),
  ('10000000-0000-4000-a000-000000000024', 'Auto com rascunho legado', '11900000024'),
  ('10000000-0000-4000-a000-000000000025', 'Auto iniciando hoje', '11900000025'),
  ('10000000-0000-4000-a000-000000000026', 'Auto no fim do mês', '11900000026'),
  ('10000000-0000-4000-a000-000000000027', 'Auto cancelada depois do agendamento', '11900000027');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, manual_discount, discount_reason,
  discount_recurring, auto_renewal, renewal_generated
) VALUES
  (
    '10000000-0000-4000-a000-000000000101', 'ASS-900001',
    '10000000-0000-4000-a000-000000000021',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 25, current_date + 5, current_date + 5,
    current_date, 1, 'pix', 'paid', 20, 'Desconto recorrente', true, true, false
  ),
  (
    '10000000-0000-4000-a000-000000000102', 'ASS-900002',
    '10000000-0000-4000-a000-000000000022',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 15, current_date + 15, current_date + 15,
    current_date, 1, 'pix', 'paid', 0, null, false, false, false
  ),
  (
    '10000000-0000-4000-a000-000000000103', 'ASS-900003',
    '10000000-0000-4000-a000-000000000023',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 24, current_date + 6, current_date + 6,
    current_date, 1, 'pix', 'paid', 0, null, false, true, false
  ),
  (
    '10000000-0000-4000-a000-000000000104', 'ASS-900004',
    '10000000-0000-4000-a000-000000000024',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 25, current_date + 5, current_date + 5,
    current_date, 1, 'pix', 'paid', 0, null, false, true, true
  ),
  (
    '10000000-0000-4000-a000-000000000105', 'ASS-900005',
    '10000000-0000-4000-a000-000000000025',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 30, current_date, current_date,
    current_date, 1, 'pix', 'paid', 0, null, false, true, true
  ),
  (
    '10000000-0000-4000-a000-000000000106', 'ASS-900006',
    '10000000-0000-4000-a000-000000000026',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date,
    (date_trunc('year', current_date)::date + interval '1 year 1 month - 1 day')::date,
    (date_trunc('year', current_date)::date + interval '1 year 1 month - 1 day')::date,
    current_date, 1, 'pix', 'paid', 0, null, false, true, false
  ),
  (
    '10000000-0000-4000-a000-000000000107', 'ASS-900007',
    '10000000-0000-4000-a000-000000000027',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 30, current_date, current_date,
    current_date, 1, 'pix', 'paid', 0, null, false, true, true
  );

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated,
  parent_contract_id
) VALUES
  (
    '10000000-0000-4000-a000-000000000201', 'ASS-900101',
    '10000000-0000-4000-a000-000000000024',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'draft', current_date + 5, current_date + 35, current_date + 35,
    current_date + 5, 1, 'pix', 'pending', true, false,
    '10000000-0000-4000-a000-000000000104'
  ),
  (
    '10000000-0000-4000-a000-000000000202', 'ASS-900102',
    '10000000-0000-4000-a000-000000000025',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'scheduled', current_date, current_date + 30, current_date + 30,
    current_date, 1, 'pix', 'pending', true, false,
    '10000000-0000-4000-a000-000000000105'
  ),
  (
    '10000000-0000-4000-a000-000000000203', 'ASS-900103',
    '10000000-0000-4000-a000-000000000027',
    '10000000-0000-4000-a000-000000000012',
    '10000000-0000-4000-a000-000000000011',
    '{"name":"Plano mensal de teste","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"10000000-0000-4000-a000-000000000010"}'::jsonb,
    'scheduled', current_date, current_date + 30, current_date + 30,
    current_date, 1, 'pix', 'pending', true, false,
    '10000000-0000-4000-a000-000000000107'
  );

UPDATE public.assessment_contracts
SET status = 'cancelled', cancellation_date = current_date
WHERE id = '10000000-0000-4000-a000-000000000107';

CREATE TEMPORARY TABLE renewal_test_runs (
  name text PRIMARY KEY,
  result jsonb NOT NULL
);
GRANT SELECT, INSERT ON renewal_test_runs TO service_role;

SET LOCAL ROLE service_role;
INSERT INTO renewal_test_runs (name, result)
SELECT 'initial', public.process_internal_assessment_renewals(15, 5, NULL);
RESET ROLE;

SELECT is((SELECT (result->>'processed')::int FROM renewal_test_runs WHERE name = 'initial'), 4, 'the initial run processes four renewal transitions');
SELECT is((SELECT (result->>'drafts_created')::int FROM renewal_test_runs WHERE name = 'initial'), 1, 'manual renewal creates one draft');
SELECT is((SELECT (result->>'automatic_renewals_scheduled')::int FROM renewal_test_runs WHERE name = 'initial'), 2, 'new and legacy automatic renewals are scheduled');
SELECT is((SELECT (result->>'automatic_drafts_approved')::int FROM renewal_test_runs WHERE name = 'initial'), 1, 'legacy automatic draft is approved');
SELECT is((SELECT (result->>'scheduled_renewals_activated')::int FROM renewal_test_runs WHERE name = 'initial'), 1, 'due scheduled renewal is activated');

SELECT is((SELECT status FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'), 'scheduled', 'automatic renewal is scheduled five days before start');
SELECT is((SELECT payment_status FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'), 'awaiting_charge', 'automatic renewal opens an internal receivable');
SELECT is((SELECT due_date FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'), current_date + 5, 'automatic renewal is due on its start date');
SELECT ok((SELECT discount_recurring AND manual_discount = 20 FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'), 'recurring discount is preserved');
SELECT ok((SELECT asaas_charge_id IS NULL AND asaas_payment_link IS NULL AND external_payment_link IS NULL FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'), 'automatic renewal does not create external charge data');

SELECT is((SELECT status FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000102'), 'draft', 'manual renewal remains a draft');
SELECT is((SELECT payment_status FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000102'), 'pending', 'manual draft remains outside the financial queue');
SELECT is((SELECT count(*)::int FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000103'), 0, 'automatic renewal outside the five-day window is not created');

SELECT is((SELECT status FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000201'), 'scheduled', 'legacy automatic draft becomes scheduled');
SELECT is((SELECT payment_status FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000201'), 'awaiting_charge', 'legacy automatic draft enters the financial queue');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000202'), 'active', 'scheduled renewal starts on its effective date');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000105'), 'finished', 'parent finishes when the new term starts');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000203'), 'scheduled', 'renewal of a cancelled parent is not activated');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000107'), 'cancelled', 'blocked renewal does not change the cancelled parent');
SELECT ok((SELECT renewal_generated FROM public.assessment_contracts WHERE id = '10000000-0000-4000-a000-000000000101'), 'processed parent is marked as renewed');

SET LOCAL ROLE service_role;
INSERT INTO renewal_test_runs (name, result)
SELECT 'repeat', public.process_internal_assessment_renewals(15, 5, NULL);
RESET ROLE;

SELECT is((SELECT (result->>'processed')::int FROM renewal_test_runs WHERE name = 'repeat'), 0, 'a repeated job is idempotent');
SELECT is((SELECT count(*)::int FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'), 1, 'a repeated job does not duplicate an open renewal');

SET LOCAL ROLE service_role;
INSERT INTO renewal_test_runs (name, result)
SELECT 'month_end', public.process_internal_assessment_renewals(
  15,
  5,
  ARRAY['10000000-0000-4000-a000-000000000106'::uuid]
);
RESET ROLE;

SELECT is((SELECT (result->>'processed')::int FROM renewal_test_runs WHERE name = 'month_end'), 1, 'an explicitly requested parent can be renewed outside the normal horizon');
SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE parent_contract_id = '10000000-0000-4000-a000-000000000106'),
  (date_trunc('year', current_date)::date + interval '1 year 2 months - 1 day')::date,
  'month-end renewal clamps to the last day of February'
);
SELECT is(
  (SELECT count(*)::int FROM public.asaas_payments WHERE order_type = 'contract' AND order_id IN (
    SELECT id FROM public.assessment_contracts
    WHERE parent_contract_id IN (
      '10000000-0000-4000-a000-000000000101',
      '10000000-0000-4000-a000-000000000102',
      '10000000-0000-4000-a000-000000000106'
    )
  )),
  0,
  'internal renewal processing does not invent Asaas payments'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id IN (
      SELECT id FROM public.assessment_contracts
      WHERE parent_contract_id = '10000000-0000-4000-a000-000000000101'
    )
      AND event_type = 'renewal_scheduled'
      AND payload->>'source' = 'internal_renewal_job'
  ),
  'automatic scheduling is recorded in the audit trail'
);

SELECT * FROM finish();
ROLLBACK;
