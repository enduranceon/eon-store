BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(35);

-- Acesso: painel admin lê, escrita só pelo backend ---------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
   WHERE oid = 'public.assessment_contract_plan_history'::regclass),
  'plan history keeps RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
   WHERE oid = 'public.assessment_plan_transitions'::regclass),
  'plan transitions keep RLS enabled'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('assessment_contract_plan_history', 'assessment_plan_transitions')
     AND ((policyname = 'app_admin_only' AND permissive = 'RESTRICTIVE' AND cmd = 'ALL')
       OR (policyname = 'app_admin_read' AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'))
     AND roles = ARRAY['authenticated']::name[]),
  4,
  'both tables are readable only by app admins'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.assessment_contract_plan_history', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.assessment_plan_transitions', 'INSERT,UPDATE,DELETE'),
  'the browser cannot write plan history or transitions'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_contract_plan_history', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.assessment_plan_transitions', 'SELECT,INSERT,UPDATE,DELETE'),
  'anon has no access to plan history or transitions'
);
SELECT ok(
  has_table_privilege('service_role', 'public.assessment_contract_plan_history', 'SELECT,INSERT,UPDATE,DELETE')
  AND has_table_privilege('service_role', 'public.assessment_plan_transitions', 'SELECT,INSERT,UPDATE,DELETE'),
  'the backend keeps full access'
);
SELECT has_column('public', 'payout_monthly_statement_items', 'segments', 'statement items store the segments');
SELECT has_column('public', 'payout_pending_repasse', 'segments', 'pending payouts store the segments');

-- Fixtures fictícias ----------------------------------------------------------

INSERT INTO public.assessment_modalities (id, name) VALUES
  ('30000000-0000-4000-a000-000000000001', 'historico-plano-corrida-test'),
  ('30000000-0000-4000-a000-000000000002', 'historico-plano-triathlon-test');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee
) VALUES
  ('30000000-0000-4000-a000-000000000011', '30000000-0000-4000-a000-000000000001',
   'Historico corrida mensal', 'mensal', 1, 240, 240, 1, 0),
  ('30000000-0000-4000-a000-000000000012', '30000000-0000-4000-a000-000000000002',
   'Historico triathlon mensal', 'mensal', 1, 350, 350, 1, 0),
  ('30000000-0000-4000-a000-000000000013', '30000000-0000-4000-a000-000000000001',
   'Historico corrida mensal bis', 'mensal', 1, 240, 240, 1, 0),
  ('30000000-0000-4000-a000-000000000014', '30000000-0000-4000-a000-000000000002',
   'Historico triathlon trimestral', 'trimestral', 3, 330, 990, 1, 0);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids) VALUES
  ('30000000-0000-4000-a000-000000000021', 'Coach historico A', 'historico-a@example.test', 'pleno',
   ARRAY['30000000-0000-4000-a000-000000000001'::uuid, '30000000-0000-4000-a000-000000000002'::uuid]),
  ('30000000-0000-4000-a000-000000000022', 'Coach historico B', 'historico-b@example.test', 'pleno',
   ARRAY['30000000-0000-4000-a000-000000000001'::uuid, '30000000-0000-4000-a000-000000000002'::uuid]);

INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('30000000-0000-4000-a000-000000000031', 'Historico de plano um', '11900003031'),
  ('30000000-0000-4000-a000-000000000032', 'Historico de plano dois', '11900003032');

-- Matriz de mudanças ----------------------------------------------------------

SELECT is(
  (SELECT transition_type FROM public.assessment_plan_transitions
   WHERE from_plan_id = '30000000-0000-4000-a000-000000000011'
     AND to_plan_id = '30000000-0000-4000-a000-000000000012'),
  'upgrade',
  'a more expensive plan of the same cycle starts as an upgrade'
);
SELECT is(
  (SELECT transition_type FROM public.assessment_plan_transitions
   WHERE from_plan_id = '30000000-0000-4000-a000-000000000012'
     AND to_plan_id = '30000000-0000-4000-a000-000000000011'),
  'downgrade',
  'a cheaper plan of the same cycle starts as a downgrade'
);
SELECT is(
  (SELECT transition_type FROM public.assessment_plan_transitions
   WHERE from_plan_id = '30000000-0000-4000-a000-000000000011'
     AND to_plan_id = '30000000-0000-4000-a000-000000000013'),
  'lateral',
  'a plan with the same price starts as lateral'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_plan_transitions
   WHERE '30000000-0000-4000-a000-000000000014' IN (from_plan_id, to_plan_id)
     AND ('30000000-0000-4000-a000-000000000011' IN (from_plan_id, to_plan_id)
       OR '30000000-0000-4000-a000-000000000012' IN (from_plan_id, to_plan_id))),
  0,
  'plans of different cycles get no pair'
);

UPDATE public.assessment_plan_transitions
SET transition_type = 'not_allowed'
WHERE from_plan_id = '30000000-0000-4000-a000-000000000011'
  AND to_plan_id = '30000000-0000-4000-a000-000000000012';

UPDATE public.assessment_plans
SET period = 'mensal', period_months = 1, price_monthly = 990, price_total = 990
WHERE id = '30000000-0000-4000-a000-000000000014';

SELECT is(
  (SELECT transition_type FROM public.assessment_plan_transitions
   WHERE from_plan_id = '30000000-0000-4000-a000-000000000011'
     AND to_plan_id = '30000000-0000-4000-a000-000000000014'),
  'upgrade',
  'a plan moved to another cycle gains the pairs of that cycle'
);
SELECT is(
  (SELECT transition_type FROM public.assessment_plan_transitions
   WHERE from_plan_id = '30000000-0000-4000-a000-000000000011'
     AND to_plan_id = '30000000-0000-4000-a000-000000000012'),
  'not_allowed',
  'adding pairs never overwrites a type adjusted on screen'
);
SELECT throws_ok(
  $$UPDATE public.assessment_plan_transitions SET transition_type = 'swap'
    WHERE from_plan_id = '30000000-0000-4000-a000-000000000011'
      AND to_plan_id = '30000000-0000-4000-a000-000000000013'$$,
  '23514',
  NULL,
  'transition type must be upgrade, downgrade, lateral or not_allowed'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_plan_transitions (from_plan_id, to_plan_id, transition_type)
    VALUES ('30000000-0000-4000-a000-000000000011', '30000000-0000-4000-a000-000000000011', 'lateral')$$,
  '23514',
  NULL,
  'a plan cannot transition to itself'
);

-- Histórico de plano ----------------------------------------------------------

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
) VALUES
  (
    '30000000-0000-4000-a000-000000000101', 'ASS-930001',
    '30000000-0000-4000-a000-000000000031',
    '30000000-0000-4000-a000-000000000021',
    '30000000-0000-4000-a000-000000000011',
    '{"name":"Historico corrida mensal","period":"mensal","period_months":1,"price_total":240,"price_monthly":240,"modality_id":"30000000-0000-4000-a000-000000000001"}'::jsonb,
    'active', '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-01', 1,
    'pix', 'paid', false, false
  ),
  (
    '30000000-0000-4000-a000-000000000102', 'ASS-930002',
    '30000000-0000-4000-a000-000000000032',
    '30000000-0000-4000-a000-000000000021',
    '30000000-0000-4000-a000-000000000011',
    '{"name":"Historico corrida mensal","period":"mensal","period_months":1,"price_total":240,"price_monthly":240,"modality_id":"30000000-0000-4000-a000-000000000001"}'::jsonb,
    'active', '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-01', 1,
    'pix', 'paid', false, false
  );

SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000101'),
  1,
  'a new contract gets exactly one plan history row'
);
SELECT is(
  (SELECT jsonb_build_object('plan', plan_id, 'from', valid_from, 'type', change_type,
                             'modality', plan_snapshot->>'modality_id')
   FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000101'),
  jsonb_build_object(
    'plan', '30000000-0000-4000-a000-000000000011',
    'from', '2026-09-01',
    'type', 'original',
    'modality', '30000000-0000-4000-a000-000000000001'
  ),
  'the original row copies the plan, snapshot and start of the contract'
);

-- "Trocar plano" corrige o plano desde o início.
UPDATE public.assessment_contracts
SET plan_id = '30000000-0000-4000-a000-000000000012',
    plan_snapshot = '{"name":"Historico triathlon mensal","period":"mensal","period_months":1,"price_total":350,"price_monthly":350,"modality_id":"30000000-0000-4000-a000-000000000002"}'::jsonb
WHERE id = '30000000-0000-4000-a000-000000000101';

SELECT is(
  (SELECT jsonb_build_object('plan', plan_id, 'from', valid_from,
                             'modality', plan_snapshot->>'modality_id')
   FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000101'),
  jsonb_build_object(
    'plan', '30000000-0000-4000-a000-000000000012',
    'from', '2026-09-01',
    'modality', '30000000-0000-4000-a000-000000000002'
  ),
  'a plan correction moves the only row to the new plan'
);

UPDATE public.assessment_contracts
SET start_date = '2026-09-03', end_date = '2026-10-02', original_end_date = '2026-10-02'
WHERE id = '30000000-0000-4000-a000-000000000101';

SELECT is(
  (SELECT valid_from FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000101'),
  '2026-09-03'::date,
  'the only plan row follows a new start date'
);
SELECT is(
  (SELECT started_at FROM public.assessment_contract_coach_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000101'),
  '2026-09-03'::date,
  'the only coach row follows a new start date'
);

-- Uma troca no meio do ciclo, registrada pelo backend.
SET LOCAL ROLE service_role;
INSERT INTO public.assessment_contract_plan_history (
  contract_id, plan_id, plan_snapshot, valid_from, change_type
) VALUES (
  '30000000-0000-4000-a000-000000000102',
  '30000000-0000-4000-a000-000000000012',
  '{"name":"Historico triathlon mensal","modality_id":"30000000-0000-4000-a000-000000000002"}'::jsonb,
  '2026-09-16',
  'upgrade'
);
UPDATE public.assessment_contracts
SET plan_id = '30000000-0000-4000-a000-000000000012',
    plan_snapshot = '{"name":"Historico triathlon mensal","period":"mensal","period_months":1,"price_total":350,"price_monthly":350,"modality_id":"30000000-0000-4000-a000-000000000002"}'::jsonb
WHERE id = '30000000-0000-4000-a000-000000000102';
RESET ROLE;

SELECT is(
  (SELECT jsonb_agg(jsonb_build_object('plan', plan_id, 'from', valid_from, 'type', change_type)
                    ORDER BY valid_from)
   FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000102'),
  jsonb_build_array(
    jsonb_build_object('plan', '30000000-0000-4000-a000-000000000011', 'from', '2026-09-01', 'type', 'original'),
    jsonb_build_object('plan', '30000000-0000-4000-a000-000000000012', 'from', '2026-09-16', 'type', 'upgrade')
  ),
  'after a mid-cycle change the original row keeps the plan it had'
);

UPDATE public.assessment_contracts
SET start_date = '2026-09-02', end_date = '2026-10-01', original_end_date = '2026-10-01'
WHERE id = '30000000-0000-4000-a000-000000000102';

SELECT is(
  (SELECT valid_from FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000102'
     AND change_type = 'original'),
  '2026-09-01'::date,
  'after a mid-cycle change the original row keeps its start too'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contract_plan_history (contract_id, plan_id, valid_from, change_type)
    VALUES ('30000000-0000-4000-a000-000000000102', '30000000-0000-4000-a000-000000000013', '2026-09-16', 'lateral')$$,
  '23505',
  NULL,
  'two plan rows cannot start on the same day'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contract_plan_history (contract_id, plan_id, valid_from, change_type)
    VALUES ('30000000-0000-4000-a000-000000000102', '30000000-0000-4000-a000-000000000013', '2026-09-20', 'original')$$,
  '23505',
  NULL,
  'a contract has a single original row'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contract_plan_history (contract_id, plan_id, valid_from, change_type)
    VALUES ('30000000-0000-4000-a000-000000000102', '30000000-0000-4000-a000-000000000013', '2026-09-25', 'downgrade')$$,
  '23514',
  NULL,
  'mid-cycle rows are only upgrade or lateral'
);
SELECT throws_ok(
  $$DELETE FROM public.assessment_plans WHERE id = '30000000-0000-4000-a000-000000000011'$$,
  '23503',
  NULL,
  'a plan used in a contract history cannot be deleted'
);

-- Histórico de treinador com troca registrada ---------------------------------

UPDATE public.assessment_contracts
SET coach_id = '30000000-0000-4000-a000-000000000022'
WHERE id = '30000000-0000-4000-a000-000000000102';

UPDATE public.assessment_contracts
SET start_date = '2026-09-04', end_date = '2026-10-03', original_end_date = '2026-10-03'
WHERE id = '30000000-0000-4000-a000-000000000102';

SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_coach_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000102'),
  2,
  'a coach change still adds a coach history row'
);
SELECT is(
  (SELECT started_at FROM public.assessment_contract_coach_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000102'
     AND coach_id = '30000000-0000-4000-a000-000000000021'),
  '2026-09-02'::date,
  'with a recorded coach change the rows keep their dates'
);

-- Invariantes gerais ----------------------------------------------------------

SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contracts AS contract
   WHERE (SELECT count(*) FROM public.assessment_contract_plan_history AS history
          WHERE history.contract_id = contract.id AND history.change_type = 'original') <> 1),
  0,
  'every contract has exactly one original plan row'
);
SELECT is(
  (SELECT count(*)::integer
   FROM public.assessment_plans AS origin
   JOIN public.assessment_plans AS target
     ON target.period_months = origin.period_months AND target.id <> origin.id
   WHERE NOT EXISTS (
     SELECT 1 FROM public.assessment_plan_transitions AS transition
     WHERE transition.from_plan_id = origin.id AND transition.to_plan_id = target.id)),
  0,
  'every pair of plans of the same cycle is in the matrix'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.assessment_contract_plan_history AS history
    JOIN public.assessment_contracts AS contract ON contract.id = history.contract_id
    WHERE history.change_type = 'original'
      AND NOT EXISTS (
        SELECT 1 FROM public.assessment_contract_plan_history AS change
        WHERE change.contract_id = history.contract_id AND change.change_type <> 'original')
      AND (history.plan_id <> contract.plan_id
        OR history.valid_from <> contract.start_date
        OR history.plan_snapshot <> coalesce(contract.plan_snapshot, '{}'::jsonb))
  ),
  'contracts without mid-cycle changes mirror their plan history row'
);

-- Contrato apagado leva o histórico junto.
DELETE FROM public.assessment_contracts WHERE id = '30000000-0000-4000-a000-000000000101';

SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_plan_history
   WHERE contract_id = '30000000-0000-4000-a000-000000000101'),
  0,
  'deleting a contract deletes its plan history'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'eon_private.add_missing_plan_transitions(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'eon_private.add_missing_plan_transitions(uuid)', 'EXECUTE'),
  'the browser cannot run the matrix filler'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'eon_private.coach_history_start_correction_backups', 'SELECT')
  AND NOT has_table_privilege('service_role', 'eon_private.coach_history_start_correction_backups', 'SELECT'),
  'the coach history backup stays private'
);

SELECT * FROM finish();

ROLLBACK;
