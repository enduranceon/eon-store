BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(11);

SELECT ok(
  NOT has_function_privilege('anon', 'public.guard_open_payout_for_inactive_contract()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.guard_open_payout_for_inactive_contract()', 'EXECUTE'),
  'the guard function is not exposed'
);

-- Fixtures fictícias: um coach, um aluno, dois planos e um fechamento em revisão
-- de dois meses atrás.
INSERT INTO public.assessment_modalities (id, name) VALUES
  ('86000000-0000-4000-a000-000000000011', 'pendencia-cancelado-corrida-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES
  ('86000000-0000-4000-a000-000000000012', '86000000-0000-4000-a000-000000000011',
   'Pendência cancelado mensal', 'mensal', 1, 200, 200, 1, 0),
  ('86000000-0000-4000-a000-000000000013', '86000000-0000-4000-a000-000000000011',
   'Pendência cancelado mensal plus', 'mensal', 1, 300, 300, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active) VALUES
  ('86000000-0000-4000-a000-000000000001', 'Coach pendência cancelado', 'pendencia-cancelado@example.test', 'pleno',
   ARRAY['86000000-0000-4000-a000-000000000011'::uuid], true);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('86000000-0000-4000-a000-000000000031', 'Aluno pendência cancelado', '11900008631');
INSERT INTO public.payout_monthly_closings (id, competence, status, generated_at)
VALUES ('86000000-0000-4000-a000-0000000000c1',
        (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '2 months')::date,
        'pending_approval', now());

-- Contratos: 01 pago e depois cancelado; 02 cancelado sem pagar; 03 pago e
-- descartado; 04 rascunho; 05 ativo sem pagar.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status, payment_date,
  manual_payment, auto_renewal, renewal_generated
)
SELECT ('86000000-0000-4000-a000-0000000001' || n)::uuid, 'ASS-986' || n,
       '86000000-0000-4000-a000-000000000031', '86000000-0000-4000-a000-000000000001',
       '86000000-0000-4000-a000-000000000012',
       '{"plan_id":"86000000-0000-4000-a000-000000000012","name":"Pendência cancelado mensal","period_months":1,"price_total":200,"modality_id":"86000000-0000-4000-a000-000000000011"}'::jsonb,
       'active', current_date - 90, current_date + 30, current_date + 30, 1, payment_status,
       CASE WHEN payment_status = 'paid' THEN current_date - 90 END,
       true, false, false
FROM (VALUES ('01', 'paid'), ('02', 'pending'), ('03', 'paid'), ('04', 'pending'), ('05', 'pending'))
  AS fixture(n, payment_status);

-- Diferenças de mudança de plano do contrato 01: uma paga e uma não paga.
INSERT INTO public.assessment_contract_plan_changes (
  id, contract_id, change_type, status, effective_date, from_plan_id, to_plan_id, to_plan_snapshot,
  from_coach_id, to_coach_id, from_price, to_price, cycle_days, remaining_days,
  amount, max_installments, payment_status
)
SELECT ('86000000-0000-4000-a000-0000000002' || n)::uuid, '86000000-0000-4000-a000-000000000101',
       'upgrade', 'applied', current_date - days_ago,
       '86000000-0000-4000-a000-000000000012', '86000000-0000-4000-a000-000000000013', '{}'::jsonb,
       '86000000-0000-4000-a000-000000000001', '86000000-0000-4000-a000-000000000001',
       200, 300, 30, 20, 50, 1, payment_status
FROM (VALUES ('01', 'paid', 60), ('02', 'charge_sent', 50)) AS fixture(n, payment_status, days_ago);

-- Pendências resgatadas pelo fechamento, como antes de um recálculo.
INSERT INTO public.payout_pending_repasse (
  id, contract_id, coach_id, source_type, reference_competence, amount, status,
  resolved_in_closing_id, resolved_at, plan_change_id
)
SELECT ('86000000-0000-4000-a000-0000000003' || n)::uuid, contract_id::uuid,
       '86000000-0000-4000-a000-000000000001', source_type,
       (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '3 months')::date,
       10.00, 'resolved', '86000000-0000-4000-a000-0000000000c1', now(), plan_change_id::uuid
FROM (VALUES
  ('01', '86000000-0000-4000-a000-000000000101', 'athlete_repasse', NULL),
  ('02', '86000000-0000-4000-a000-000000000102', 'athlete_repasse', NULL),
  ('03', '86000000-0000-4000-a000-000000000103', 'athlete_repasse', NULL),
  ('04', '86000000-0000-4000-a000-000000000104', 'athlete_repasse', NULL),
  ('05', '86000000-0000-4000-a000-000000000105', 'athlete_repasse', NULL),
  ('06', '86000000-0000-4000-a000-000000000101', 'athlete_repasse', '86000000-0000-4000-a000-000000000201'),
  ('07', '86000000-0000-4000-a000-000000000101', 'direct_leadership', '86000000-0000-4000-a000-000000000202')
) AS fixture(n, contract_id, source_type, plan_change_id);

UPDATE public.assessment_contracts
SET status = 'cancelled', cancellation_date = current_date - 5
WHERE id IN ('86000000-0000-4000-a000-000000000101', '86000000-0000-4000-a000-000000000102');
UPDATE public.assessment_contracts
SET status = 'voided'
WHERE id = '86000000-0000-4000-a000-000000000103';
UPDATE public.assessment_contracts
SET status = 'draft'
WHERE id = '86000000-0000-4000-a000-000000000104';

-- O recálculo devolve as pendências resgatadas para abertas.
UPDATE public.payout_pending_repasse
SET status = 'open', resolved_in_closing_id = NULL, resolved_at = NULL
WHERE resolved_in_closing_id = '86000000-0000-4000-a000-0000000000c1';

SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolved_at', resolved_at)
   FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000301'),
  jsonb_build_object('status', 'open', 'resolved_at', NULL),
  'a pending of a contract paid and then cancelled stays open for the next closing'
);
SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolved_in', resolved_in_closing_id, 'has_resolved_at', resolved_at IS NOT NULL)
   FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000302'),
  jsonb_build_object('status', 'cancelled', 'resolved_in', NULL, 'has_resolved_at', true),
  'a pending of a contract cancelled without payment is cancelled'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000303'),
  'cancelled',
  'a pending of a voided contract is cancelled even if it was paid'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000304'),
  'cancelled',
  'a pending of a draft contract is cancelled'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000305'),
  'open',
  'a pending of an active contract not paid yet stays open'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000306'),
  'open',
  'a paid plan change difference of a cancelled contract stays open'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000307'),
  'cancelled',
  'an unpaid plan change difference of a cancelled contract is cancelled'
);

-- Pendência nova (detectada) segue a mesma regra.
INSERT INTO public.payout_pending_repasse (
  id, contract_id, coach_id, source_type, reference_competence, amount, status
)
SELECT ('86000000-0000-4000-a000-0000000004' || n)::uuid, contract_id::uuid,
       '86000000-0000-4000-a000-000000000001', 'athlete_repasse',
       (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '2 months')::date,
       12.00, 'open'
FROM (VALUES
  ('01', '86000000-0000-4000-a000-000000000101'),
  ('02', '86000000-0000-4000-a000-000000000102')
) AS fixture(n, contract_id);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000401'),
  'open',
  'a new pending of a contract paid and then cancelled stays open'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000402'),
  'cancelled',
  'a new pending of a contract cancelled without payment is cancelled'
);

-- Pagamento desfeito depois do cancelamento: a pendência reaberta é cancelada.
UPDATE public.payout_pending_repasse
SET status = 'resolved', resolved_in_closing_id = '86000000-0000-4000-a000-0000000000c1', resolved_at = now()
WHERE id = '86000000-0000-4000-a000-000000000301';
UPDATE public.assessment_contracts
SET payment_status = 'refunded'
WHERE id = '86000000-0000-4000-a000-000000000101';
UPDATE public.payout_pending_repasse
SET status = 'open', resolved_in_closing_id = NULL, resolved_at = NULL
WHERE id = '86000000-0000-4000-a000-000000000301';
SELECT is(
  (SELECT status FROM public.payout_pending_repasse WHERE id = '86000000-0000-4000-a000-000000000301'),
  'cancelled',
  'once the contract is no longer paid, the reopened pending is cancelled'
);

SELECT * FROM finish();
ROLLBACK;
