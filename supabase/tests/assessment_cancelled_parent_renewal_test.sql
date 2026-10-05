BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
-- As regras usam a data de São Paulo; o current_date das fixtures também.
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(16);

INSERT INTO public.assessment_modalities (id, name)
VALUES ('20000000-0000-4000-a000-000000000010', 'cancelamento-renovacao-test');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee
) VALUES (
  '20000000-0000-4000-a000-000000000011',
  '20000000-0000-4000-a000-000000000010',
  'Plano de cancelamento e renovacao',
  'mensal', 1, 280, 280, 1, 0
);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES (
  '20000000-0000-4000-a000-000000000012',
  'Coach cancelamento renovacao',
  'cancel-renewal@example.test',
  'senior',
  ARRAY['20000000-0000-4000-a000-000000000010'::uuid]
);

INSERT INTO public.presale_customers (id, full_name, whatsapp)
VALUES
  ('20000000-0000-4000-a000-000000000021', 'Cancelamento com rascunho limpo', '11900001021'),
  ('20000000-0000-4000-a000-000000000022', 'Cancelamento anterior legado', '11900001022');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated,
  cancellation_date, cancellation_reason
) VALUES
  (
    '20000000-0000-4000-a000-000000000101', 'ASS-910001',
    '20000000-0000-4000-a000-000000000021',
    '20000000-0000-4000-a000-000000000012',
    '20000000-0000-4000-a000-000000000011',
    '{"name":"Plano de cancelamento e renovacao","period":"mensal","period_months":1,"price_total":280,"price_monthly":280,"modality_id":"20000000-0000-4000-a000-000000000010"}'::jsonb,
    'active', current_date - 20, current_date + 10, current_date + 10,
    current_date - 5, 1, 'pix', 'paid', false, true, NULL, NULL
  ),
  (
    '20000000-0000-4000-a000-000000000102', 'ASS-910002',
    '20000000-0000-4000-a000-000000000022',
    '20000000-0000-4000-a000-000000000012',
    '20000000-0000-4000-a000-000000000011',
    '{"name":"Plano de cancelamento e renovacao","period":"mensal","period_months":1,"price_total":280,"price_monthly":280,"modality_id":"20000000-0000-4000-a000-000000000010"}'::jsonb,
    'cancelled', current_date - 30, current_date, current_date,
    current_date - 20, 1, 'pix', 'paid', false, true,
    current_date - 1, 'Solicitacao da atleta'
  );

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated,
  parent_contract_id
) VALUES
  (
    '20000000-0000-4000-a000-000000000201', 'ASS-910101',
    '20000000-0000-4000-a000-000000000021',
    '20000000-0000-4000-a000-000000000012',
    '20000000-0000-4000-a000-000000000011',
    '{"name":"Plano de cancelamento e renovacao","period":"mensal","period_months":1,"price_total":280,"price_monthly":280,"modality_id":"20000000-0000-4000-a000-000000000010"}'::jsonb,
    'draft', current_date + 10, current_date + 40, current_date + 40,
    current_date + 10, 1, 'pix', 'pending', false, false,
    '20000000-0000-4000-a000-000000000101'
  ),
  (
    '20000000-0000-4000-a000-000000000202', 'ASS-910102',
    '20000000-0000-4000-a000-000000000022',
    '20000000-0000-4000-a000-000000000012',
    '20000000-0000-4000-a000-000000000011',
    '{"name":"Plano de cancelamento e renovacao","period":"mensal","period_months":1,"price_total":280,"price_monthly":280,"modality_id":"20000000-0000-4000-a000-000000000010"}'::jsonb,
    'draft', current_date, current_date + 30, current_date + 30,
    current_date, 1, 'pix', 'pending', false, false,
    '20000000-0000-4000-a000-000000000102'
  );

CREATE TEMPORARY TABLE cancelled_parent_renewal_results (
  name text PRIMARY KEY,
  result jsonb NOT NULL
);
GRANT SELECT, INSERT ON cancelled_parent_renewal_results TO service_role;

SET LOCAL ROLE service_role;
INSERT INTO cancelled_parent_renewal_results (name, result)
SELECT 'automatic', public.cancel_assessment_contract(
  '20000000-0000-4000-a000-000000000101',
  current_date,
  100,
  'Solicitacao da atleta',
  (SELECT updated_at FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000101'),
  '20000000-0000-4000-a000-000000000099'
);
RESET ROLE;

SELECT is(
  (SELECT status FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000101'),
  'cancelled',
  'the requested parent cancellation still completes'
);
SELECT is(
  (SELECT cancellation_reason FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000101'),
  'Solicitacao da atleta',
  'the real cancellation reason is preserved'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000201'),
  'voided',
  'a clean renewal draft is voided with its parent cancellation'
);
SELECT is(
  (SELECT payment_status FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000201'),
  'cancelled',
  'the voided draft leaves the financial queue'
);
SELECT is(
  (SELECT cancellation_reason FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000201'),
  'Contrato anterior cancelado',
  'the draft records the precise discard reason'
);
SELECT ok(
  NOT (SELECT renewal_generated FROM public.assessment_contracts
       WHERE id = '20000000-0000-4000-a000-000000000101'),
  'the cancelled parent no longer claims an open renewal'
);
SELECT is(
  (SELECT result->'voided_renewal_ids'->>0
   FROM cancelled_parent_renewal_results WHERE name = 'automatic'),
  '20000000-0000-4000-a000-000000000201',
  'the cancellation response reports the automatically voided draft'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id = '20000000-0000-4000-a000-000000000201'
      AND event_type = 'sale_voided'
      AND payload->>'reason_code' = 'parent_cancelled'
      AND (payload->>'automatic')::boolean
  ),
  'automatic draft disposal is audited on the renewal'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id = '20000000-0000-4000-a000-000000000101'
      AND event_type = 'renewal_discarded'
      AND payload->>'reason_code' = 'parent_cancelled'
  ),
  'automatic draft disposal is audited on the parent'
);

SET LOCAL ROLE service_role;
INSERT INTO cancelled_parent_renewal_results (name, result)
SELECT 'prepare', public.prepare_assessment_renewal_resolution(
  '20000000-0000-4000-a000-000000000202',
  'discard',
  'parent_cancelled',
  'Contrato anterior foi cancelado',
  (SELECT updated_at FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000202'),
  'pending', NULL, false, NULL, false,
  'renewal:parent-cancelled:test',
  '20000000-0000-4000-a000-000000000099'
);
INSERT INTO cancelled_parent_renewal_results (name, result)
SELECT 'claim', public.claim_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid
   FROM cancelled_parent_renewal_results WHERE name = 'prepare')
);
INSERT INTO cancelled_parent_renewal_results (name, result)
SELECT 'record', public.record_assessment_renewal_external_result(
  (SELECT (result->>'operation_id')::uuid
   FROM cancelled_parent_renewal_results WHERE name = 'prepare'),
  (SELECT (result->>'lease_token')::uuid
   FROM cancelled_parent_renewal_results WHERE name = 'claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb
);
INSERT INTO cancelled_parent_renewal_results (name, result)
SELECT 'complete', public.complete_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid
   FROM cancelled_parent_renewal_results WHERE name = 'prepare'),
  (SELECT (result->>'lease_token')::uuid
   FROM cancelled_parent_renewal_results WHERE name = 'claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb
);
RESET ROLE;

SELECT is(
  (SELECT result->>'status' FROM cancelled_parent_renewal_results
   WHERE name = 'prepare'),
  'prepared',
  'a legacy draft can be prepared after its parent was cancelled'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000202'),
  'voided',
  'the defensive workflow voids a pre-existing orphan draft'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000102'),
  'cancelled',
  'the defensive workflow keeps the parent cancelled'
);
SELECT is(
  (SELECT cancellation_reason FROM public.assessment_contracts
   WHERE id = '20000000-0000-4000-a000-000000000102'),
  'Solicitacao da atleta',
  'the defensive workflow does not overwrite the original exit reason'
);
SELECT is(
  (SELECT result->>'parent_non_renewal'
   FROM cancelled_parent_renewal_results WHERE name = 'complete'),
  'false',
  'discarding the orphan does not record a second non-renewal exit'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id = '20000000-0000-4000-a000-000000000202'
      AND event_type = 'sale_voided'
      AND payload->>'reason_code' = 'parent_cancelled'
  ),
  'the defensive cleanup keeps a complete audit trail'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.perform_assessment_contract_cancellation(public.assessment_contracts,date,numeric,text,uuid,text)',
    'EXECUTE'
  ),
  'the cancellation helper remains unavailable to browser roles'
);

SELECT * FROM finish();
ROLLBACK;
