BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
-- As regras usam a data de São Paulo; o current_date das fixtures também.
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(45);

-- Acesso ----------------------------------------------------------------------

SELECT ok(
  has_function_privilege('service_role', 'public.change_assessment_contract_coach(uuid, uuid, date, timestamptz, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.cancel_assessment_contract_coach_change(uuid, timestamptz, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.apply_due_assessment_coach_changes(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.change_assessment_contract_coach(uuid, uuid, date, timestamptz, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.cancel_assessment_contract_coach_change(uuid, timestamptz, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.apply_due_assessment_coach_changes(uuid)', 'EXECUTE'),
  'coach changes run only through the backend'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.assessment_contract_coach_history', 'INSERT,UPDATE,DELETE')
  AND has_table_privilege('service_role', 'public.assessment_contract_coach_history', 'SELECT,INSERT,UPDATE,DELETE'),
  'the browser cannot write the coach history'
);

-- Fixtures fictícias ----------------------------------------------------------

INSERT INTO public.assessment_modalities (id, name) VALUES
  ('70000000-0000-4000-a000-000000000001', 'troca-coach-corrida-test'),
  ('70000000-0000-4000-a000-000000000002', 'troca-coach-natacao-test');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES
  ('70000000-0000-4000-a000-000000000011', '70000000-0000-4000-a000-000000000001',
   'Troca coach semestral', 'semestral', 6, 200, 1200, 6, 0),
  ('70000000-0000-4000-a000-000000000012', '70000000-0000-4000-a000-000000000001',
   'Troca coach semestral bis', 'semestral', 6, 200, 1200, 6, 0);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active) VALUES
  ('70000000-0000-4000-a000-000000000021', 'Coach A troca', 'troca-a@example.test', 'pleno',
   ARRAY['70000000-0000-4000-a000-000000000001'::uuid], true),
  ('70000000-0000-4000-a000-000000000022', 'Coach B troca', 'troca-b@example.test', 'pleno',
   ARRAY['70000000-0000-4000-a000-000000000001'::uuid], true),
  ('70000000-0000-4000-a000-000000000023', 'Coach C troca', 'troca-c@example.test', 'pleno',
   ARRAY['70000000-0000-4000-a000-000000000001'::uuid], true),
  ('70000000-0000-4000-a000-000000000024', 'Coach natacao troca', 'troca-d@example.test', 'pleno',
   ARRAY['70000000-0000-4000-a000-000000000002'::uuid], true),
  ('70000000-0000-4000-a000-000000000025', 'Coach inativo troca', 'troca-e@example.test', 'pleno',
   ARRAY['70000000-0000-4000-a000-000000000001'::uuid], false);

INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('70000000-0000-4000-a000-000000000031', 'Aluno troca um', '11900007031'),
  ('70000000-0000-4000-a000-000000000032', 'Aluno troca dois', '11900007032'),
  ('70000000-0000-4000-a000-000000000033', 'Aluno troca tres', '11900007033'),
  ('70000000-0000-4000-a000-000000000035', 'Aluno troca cinco', '11900007035'),
  ('70000000-0000-4000-a000-000000000036', 'Aluno troca seis', '11900007036');

-- K1, K5 e K6 em andamento; K2 perto do fim, com renovação agendada (R2);
-- K3 ainda não começou.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status, payment_date,
  manual_payment, auto_renewal, renewal_generated
) VALUES
  ('70000000-0000-4000-a000-000000000101', 'ASS-970001', '70000000-0000-4000-a000-000000000031',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'active', current_date - 40, current_date + 140, current_date + 140, 6, 'paid', current_date - 40, true, false, false),
  ('70000000-0000-4000-a000-000000000102', 'ASS-970002', '70000000-0000-4000-a000-000000000032',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'active', current_date - 160, current_date + 20, current_date + 20, 6, 'paid', current_date - 160, true, false, true),
  ('70000000-0000-4000-a000-000000000103', 'ASS-970003', '70000000-0000-4000-a000-000000000033',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'scheduled', current_date + 20, current_date + 200, current_date + 200, 6, 'paid', current_date, true, false, false),
  ('70000000-0000-4000-a000-000000000105', 'ASS-970005', '70000000-0000-4000-a000-000000000035',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'active', current_date - 60, current_date + 120, current_date + 120, 6, 'paid', current_date - 60, true, false, false),
  ('70000000-0000-4000-a000-000000000106', 'ASS-970006', '70000000-0000-4000-a000-000000000036',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'active', current_date - 30, current_date + 15, current_date + 15, 6, 'paid', current_date - 30, true, false, false);

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status,
  manual_payment, auto_renewal, renewal_generated, parent_contract_id
) VALUES
  ('70000000-0000-4000-a000-000000000112', 'ASS-970012', '70000000-0000-4000-a000-000000000032',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'scheduled', current_date + 20, current_date + 200, current_date + 200, 6, 'pending',
   false, false, false, '70000000-0000-4000-a000-000000000102');

CREATE FUNCTION pg_temp.ver(p_id uuid) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT updated_at FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.coach(p_id uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT coach_id FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.change(p_id uuid, p_coach uuid, p_date date) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.change_assessment_contract_coach(
    p_id, p_coach, p_date, pg_temp.ver(p_id), '70000000-0000-4000-a000-000000000999');
$$;
CREATE FUNCTION pg_temp.cancel(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.cancel_assessment_contract_coach_change(
    p_id, pg_temp.ver(p_id), '70000000-0000-4000-a000-000000000999');
$$;

-- Troca para trás: vale na hora, e o repasse divide pelos dias ------------------

SET LOCAL ROLE service_role;
SELECT is(
  (pg_temp.change('70000000-0000-4000-a000-000000000101', '70000000-0000-4000-a000-000000000022', current_date - 5)->>'applies_now')::boolean,
  true,
  'a change dated five days ago applies right away'
);
RESET ROLE;
SELECT is(pg_temp.coach('70000000-0000-4000-a000-000000000101'), '70000000-0000-4000-a000-000000000022'::uuid,
  'the contract shows the new coach');
SELECT is(
  ARRAY[
    eon_private.contract_coach_on('70000000-0000-4000-a000-000000000101', current_date - 6),
    eon_private.contract_coach_on('70000000-0000-4000-a000-000000000101', current_date - 5),
    eon_private.contract_coach_on('70000000-0000-4000-a000-000000000101', current_date)
  ],
  ARRAY['70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000022',
        '70000000-0000-4000-a000-000000000022']::uuid[],
  'the payout splits the month: the old coach until the day before, the new one from the chosen day'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_coach_history
   WHERE contract_id = '70000000-0000-4000-a000-000000000101'),
  2,
  'only the chosen date is written; the old trigger does not add a row for today'
);
SELECT is(
  (SELECT payload->>'effective_date' FROM public.assessment_contract_event
   WHERE contract_id = '70000000-0000-4000-a000-000000000101' AND event_type = 'coach_changed'),
  (current_date - 5)::text,
  'the timeline records the day the new coach started'
);

-- Validações --------------------------------------------------------------------

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000101', '70000000-0000-4000-a000-000000000023', current_date - 6)$$,
  '22023', NULL,
  'the new coach cannot start before the current coach started'
);
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000022', current_date - 61)$$,
  '22023', NULL,
  'the new coach cannot start before the contract'
);
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000022', current_date + 120)$$,
  '22023', NULL,
  'the new coach must start by the last day of the contract'
);
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000025', current_date)$$,
  '22023', 'Selecione um coach ativo',
  'an inactive coach is refused'
);
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000024', current_date)$$,
  '22023', 'Esse coach não atende a modalidade do plano',
  'a coach from another modality is refused'
);
SELECT throws_ok(
  $$SELECT public.change_assessment_contract_coach('70000000-0000-4000-a000-000000000105',
      '70000000-0000-4000-a000-000000000022', current_date, now() - interval '1 day',
      '70000000-0000-4000-a000-000000000999')$$,
  'P0001', 'O contrato foi alterado por outra ação. Atualize a página e tente novamente',
  'a stale contract version is refused'
);
SELECT is(
  (pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000021', current_date)->>'unchanged')::boolean,
  true,
  'choosing the current coach changes nothing'
);

-- Troca para frente: agendada, cancelável, aplicada na data ---------------------

SELECT is(
  (pg_temp.change('70000000-0000-4000-a000-000000000101', '70000000-0000-4000-a000-000000000023', current_date + 10)->>'applies_now')::boolean,
  false,
  'a change dated in the future is scheduled'
);
RESET ROLE;
SELECT is(pg_temp.coach('70000000-0000-4000-a000-000000000101'), '70000000-0000-4000-a000-000000000022'::uuid,
  'until the date, the contract keeps the current coach');
SELECT is(
  ARRAY[
    eon_private.contract_coach_on('70000000-0000-4000-a000-000000000101', current_date + 9),
    eon_private.contract_coach_on('70000000-0000-4000-a000-000000000101', current_date + 10)
  ],
  ARRAY['70000000-0000-4000-a000-000000000022', '70000000-0000-4000-a000-000000000023']::uuid[],
  'the payout already knows the scheduled change'
);
SELECT is(
  (eon_private.pending_contract_coach_change('70000000-0000-4000-a000-000000000101')).started_at,
  current_date + 10,
  'the scheduled change is pending'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.assessment_contract_event
          WHERE contract_id = '70000000-0000-4000-a000-000000000101' AND event_type = 'coach_change_scheduled'),
  'the timeline records the scheduled change'
);

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000101', '70000000-0000-4000-a000-000000000021', current_date + 20)$$,
  'P0001', NULL,
  'another change waits until the scheduled one is cancelled'
);
SELECT lives_ok(
  $$SELECT pg_temp.cancel('70000000-0000-4000-a000-000000000101')$$,
  'the scheduled change can be cancelled'
);
RESET ROLE;
SELECT is(
  eon_private.contract_coach_on('70000000-0000-4000-a000-000000000101', current_date + 10),
  '70000000-0000-4000-a000-000000000022'::uuid,
  'after cancelling, the current coach stays'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.assessment_contract_event
          WHERE contract_id = '70000000-0000-4000-a000-000000000101' AND event_type = 'coach_change_cancelled'),
  'the timeline records the cancellation'
);
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT pg_temp.cancel('70000000-0000-4000-a000-000000000101')$$,
  'P0001', 'Não há troca de coach agendada neste contrato',
  'there is nothing left to cancel'
);

-- A data chega: a troca agendada é aplicada.
SELECT lives_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000101', '70000000-0000-4000-a000-000000000023', current_date + 10)$$,
  'the change is scheduled again'
);
RESET ROLE;
UPDATE public.assessment_contract_coach_history
SET started_at = current_date
WHERE contract_id = '70000000-0000-4000-a000-000000000101'
  AND coach_id = '70000000-0000-4000-a000-000000000023';
SET LOCAL ROLE service_role;
SELECT is(
  jsonb_array_length(public.apply_due_assessment_coach_changes('70000000-0000-4000-a000-000000000999')->'changed'),
  1,
  'on the date, the daily transitions apply the change'
);
SELECT is(
  jsonb_array_length(public.apply_due_assessment_coach_changes('70000000-0000-4000-a000-000000000999')->'changed'),
  0,
  'applying again changes nothing'
);
RESET ROLE;
SELECT is(pg_temp.coach('70000000-0000-4000-a000-000000000101'), '70000000-0000-4000-a000-000000000023'::uuid,
  'the contract now shows the scheduled coach');
SELECT ok(
  EXISTS (SELECT 1 FROM public.assessment_contract_event
          WHERE contract_id = '70000000-0000-4000-a000-000000000101' AND event_type = 'coach_changed'
            AND payload->>'scheduled' = 'true'
            AND payload->>'to_coach_id' = '70000000-0000-4000-a000-000000000023'),
  'the timeline records the applied scheduled change'
);

-- Renovação que ainda não começou ---------------------------------------------------

SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000102', '70000000-0000-4000-a000-000000000022', current_date + 5)$$,
  'a change is scheduled on a contract whose renewal already exists'
);
RESET ROLE;
SELECT is(
  ARRAY[
    pg_temp.coach('70000000-0000-4000-a000-000000000112'),
    (SELECT coach_id FROM public.assessment_contract_coach_history WHERE contract_id = '70000000-0000-4000-a000-000000000112')
  ],
  ARRAY['70000000-0000-4000-a000-000000000022', '70000000-0000-4000-a000-000000000022']::uuid[],
  'the scheduled renewal follows the coach of the last day'
);
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT pg_temp.cancel('70000000-0000-4000-a000-000000000102')$$,
  'the change on the finishing contract is cancelled'
);
RESET ROLE;
SELECT is(
  pg_temp.coach('70000000-0000-4000-a000-000000000112'),
  '70000000-0000-4000-a000-000000000021'::uuid,
  'cancelling brings the renewal back to the previous coach'
);
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000102', '70000000-0000-4000-a000-000000000023', current_date)$$,
  'an immediate change on the finishing contract'
);
RESET ROLE;
SELECT is(
  pg_temp.coach('70000000-0000-4000-a000-000000000112'),
  '70000000-0000-4000-a000-000000000023'::uuid,
  'the renewal follows an immediate change too'
);

-- Renovação criada depois de uma troca agendada sai com o coach do último dia.
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000106', '70000000-0000-4000-a000-000000000022', current_date + 5)$$,
  'a change is scheduled before the renewal exists'
);
RESET ROLE;
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status,
  manual_payment, auto_renewal, renewal_generated, parent_contract_id
) VALUES
  ('70000000-0000-4000-a000-000000000116', 'ASS-970016', '70000000-0000-4000-a000-000000000036',
   '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000011',
   '{"plan_id":"70000000-0000-4000-a000-000000000011","name":"Troca coach semestral","period_months":6,"price_total":1200,"modality_id":"70000000-0000-4000-a000-000000000001"}'::jsonb,
   'scheduled', current_date + 15, current_date + 195, current_date + 195, 6, 'pending',
   false, false, false, '70000000-0000-4000-a000-000000000106');
SELECT is(
  pg_temp.coach('70000000-0000-4000-a000-000000000116'),
  '70000000-0000-4000-a000-000000000022'::uuid,
  'a renewal created after the scheduled change starts with the new coach'
);

-- Contrato que ainda não começou -------------------------------------------------

SET LOCAL ROLE service_role;
SELECT is(
  (pg_temp.change('70000000-0000-4000-a000-000000000103', '70000000-0000-4000-a000-000000000022', current_date + 20)->>'applies_now')::boolean,
  true,
  'on a contract that has not started, a change from the first day applies right away'
);
SELECT is(
  (pg_temp.change('70000000-0000-4000-a000-000000000103', '70000000-0000-4000-a000-000000000023', current_date + 30)->>'applies_now')::boolean,
  false,
  'a later change on that contract is scheduled'
);
RESET ROLE;
SELECT is(pg_temp.coach('70000000-0000-4000-a000-000000000103'), '70000000-0000-4000-a000-000000000022'::uuid,
  'the contract that has not started shows the coach of its first day');

-- Mudança de plano ---------------------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO public.assessment_contract_plan_changes (
      contract_id, change_type, status, effective_date, from_plan_id, to_plan_id, to_plan_snapshot,
      from_coach_id, to_coach_id, from_price, to_price, cycle_days, remaining_days,
      amount, max_installments, payment_status
    ) VALUES (
      '70000000-0000-4000-a000-000000000103', 'lateral', 'scheduled', current_date + 40,
      '70000000-0000-4000-a000-000000000011', '70000000-0000-4000-a000-000000000012', '{}'::jsonb,
      '70000000-0000-4000-a000-000000000022', '70000000-0000-4000-a000-000000000022',
      1200, 1200, 180, 160, 0, 1, 'not_required')$$,
  'P0001', NULL,
  'a plan change waits while a coach change is scheduled'
);

INSERT INTO public.assessment_contract_plan_changes (
  contract_id, change_type, status, effective_date, from_plan_id, to_plan_id, to_plan_snapshot,
  from_coach_id, to_coach_id, from_price, to_price, cycle_days, remaining_days,
  amount, max_installments, payment_status
) VALUES (
  '70000000-0000-4000-a000-000000000105', 'lateral', 'scheduled', current_date + 30,
  '70000000-0000-4000-a000-000000000011', '70000000-0000-4000-a000-000000000012', '{}'::jsonb,
  '70000000-0000-4000-a000-000000000021', '70000000-0000-4000-a000-000000000021',
  1200, 1200, 180, 90, 0, 1, 'not_required');
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000022', current_date)$$,
  'P0001', NULL,
  'a scheduled plan change carries its own coach'
);
RESET ROLE;
DELETE FROM public.assessment_contract_plan_changes
WHERE contract_id = '70000000-0000-4000-a000-000000000105';

-- Repasse fechado ----------------------------------------------------------------

INSERT INTO public.payout_monthly_closings (competence, status)
VALUES ((date_trunc('month', current_date) - interval '1 month')::date, 'approved');
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000022',
      date_trunc('month', current_date)::date - 1)$$,
  '22023', NULL,
  'a change cannot enter a month whose payout is already approved'
);
SELECT lives_ok(
  $$SELECT pg_temp.change('70000000-0000-4000-a000-000000000105', '70000000-0000-4000-a000-000000000022',
      date_trunc('month', current_date)::date)$$,
  'a change from the first open day is accepted'
);
RESET ROLE;

-- Gatilho antigo: data de São Paulo --------------------------------------------------

SET LOCAL timezone = 'Pacific/Kiritimati';
UPDATE public.assessment_contracts
SET coach_id = '70000000-0000-4000-a000-000000000023'
WHERE id = '70000000-0000-4000-a000-000000000106';
SELECT is(
  (SELECT started_at FROM public.assessment_contract_coach_history
   WHERE contract_id = '70000000-0000-4000-a000-000000000106'
     AND coach_id = '70000000-0000-4000-a000-000000000023'),
  (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  'a direct coach update is dated in São Paulo, not in the session time zone'
);

SELECT * FROM finish();
ROLLBACK;
