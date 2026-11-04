BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(15);

-- Fixtures fictícias: sete contratos semestrais com licença.
--   01 licença sem data de volta, encerrada numa data passada
--   02 licença sem data de volta, data de fim no futuro (recusada)
--   03 licença sem data de volta, data de fim antes do início (recusada)
--   04 licença sem data de volta, encerrada sem data (vale hoje, como antes)
--   05 licença sem data de volta, data de fim em repasse já fechado (recusada)
--   06 licença sem data de volta, último dia = último dia do mês fechado (aceita)
--   07 licença que já tem data de fim
INSERT INTO auth.users (id, email)
VALUES ('96400000-0000-4000-a000-0000000000ff', 'finish-leave-date-admin@example.test');

-- Banco novo não tem repasse fechado: cria um fictício para o mês passado.
-- Onde já há (produção, dry-run), usa o que existe.
INSERT INTO public.payout_monthly_closings (competence, status, approved_at, approved_by)
SELECT (date_trunc('month', current_date) - interval '1 month')::date, 'approved', now(),
       '96400000-0000-4000-a000-0000000000ff'
WHERE eon_private.first_open_payout_day() IS NULL;

-- fo: primeiro dia de repasse ainda aberto. e: um dia passado que o repasse aceita.
CREATE TEMP TABLE t_dates AS
SELECT eon_private.first_open_payout_day() AS fo,
       greatest(current_date - 20, eon_private.first_open_payout_day() - 1) AS e;

INSERT INTO public.assessment_modalities (id, name)
VALUES ('96400000-0000-4000-a000-000000000010', 'encerrar-licenca-data-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '96400000-0000-4000-a000-000000000011', '96400000-0000-4000-a000-000000000010',
  'Plano semestral encerrar licença com data', 'semestral', 6, 185, 1110, 6, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('96400000-0000-4000-a000-000000000012', 'Coach Encerrar Com Data', 'encerrar-com-data@example.test', 'senior',
        ARRAY['96400000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('96400000-0000-4000-a000-000000000021', 'Pessoa Licença Um', '11900009651'),
  ('96400000-0000-4000-a000-000000000022', 'Pessoa Licença Dois', '11900009652'),
  ('96400000-0000-4000-a000-000000000023', 'Pessoa Licença Três', '11900009653'),
  ('96400000-0000-4000-a000-000000000024', 'Pessoa Licença Quatro', '11900009654'),
  ('96400000-0000-4000-a000-000000000025', 'Pessoa Licença Cinco', '11900009655'),
  ('96400000-0000-4000-a000-000000000026', 'Pessoa Licença Seis', '11900009656'),
  ('96400000-0000-4000-a000-000000000027', 'Pessoa Licença Sete', '11900009657');

-- Fim original daqui a 60 dias do dia e, para o 04, daqui a 40 dias de hoje.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
)
SELECT ('96400000-0000-4000-a000-0000000001' || fixture.n)::uuid, 'ASS-9964' || fixture.n,
       ('96400000-0000-4000-a000-0000000000' || (20 + fixture.n::int))::uuid,
       '96400000-0000-4000-a000-000000000012', '96400000-0000-4000-a000-000000000011',
       '{"name":"Plano semestral encerrar licença com data","period":"semestral","period_months":6,"price_total":1110,"price_monthly":185,"modality_id":"96400000-0000-4000-a000-000000000010"}'::jsonb,
       'active', current_date - 400, fixture.original_end, fixture.original_end,
       current_date - 400, 1, 'pix', 'paid', false, false
FROM t_dates, LATERAL (VALUES
  ('01', t_dates.e + 60), ('02', t_dates.e + 60), ('03', t_dates.e + 60),
  ('04', current_date + 40), ('05', t_dates.fo + 100), ('06', t_dates.fo + 100),
  ('07', t_dates.e + 60)
) AS fixture(n, original_end);

INSERT INTO public.assessment_leaves (contract_id, start_date, status)
SELECT ('96400000-0000-4000-a000-0000000001' || fixture.n)::uuid, fixture.leave_start, 'active'
FROM t_dates, LATERAL (VALUES
  ('01', t_dates.e - 10), ('02', t_dates.e - 10), ('03', t_dates.e - 3),
  ('04', current_date - 5), ('05', t_dates.fo - 30), ('06', t_dates.fo - 30)
) AS fixture(n, leave_start);
-- 07: licença com data de fim (o gatilho já soma os 6 dias ao fim do contrato).
INSERT INTO public.assessment_leaves (contract_id, start_date, end_date, status)
SELECT '96400000-0000-4000-a000-000000000107', e - 10, e - 5, 'active' FROM t_dates;

CREATE TEMP TABLE t_res (contract uuid, res jsonb);
CREATE FUNCTION pg_temp.finish_on(p_contract uuid, p_end date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT public.finish_assessment_contract_leave(
    p_contract,
    (SELECT id FROM public.assessment_leaves WHERE contract_id = p_contract AND status = 'active'),
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_contract),
    '96400000-0000-4000-a000-0000000000ff',
    p_end) INTO v;
  INSERT INTO t_res VALUES (p_contract, v);
  RETURN v;
END;
$$;

-- 01: encerrada numa data passada. Dias de licença: do início ao dia informado, inclusive.
SELECT lives_ok(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000101', (SELECT e FROM t_dates))$$,
  'a leave without an end date can be finished on a past date');
SELECT is(
  (SELECT end_date FROM public.assessment_leaves WHERE contract_id = '96400000-0000-4000-a000-000000000101'),
  (SELECT e FROM t_dates),
  'the leave ends on the chosen day');
SELECT is(
  (SELECT days FROM public.assessment_leaves WHERE contract_id = '96400000-0000-4000-a000-000000000101'),
  11,
  'the stopped days count from the start to the chosen day, both included');
SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '96400000-0000-4000-a000-000000000101'),
  (SELECT e + 71 FROM t_dates),
  'only those days are added to the contract end, not the days until today');
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = '96400000-0000-4000-a000-000000000101'),
  'active',
  'the contract goes back to active');
SELECT is(
  (SELECT payload->>'retroactive' FROM public.assessment_contract_event
   WHERE contract_id = '96400000-0000-4000-a000-000000000101' AND event_type = 'leave_ended'),
  'true',
  'the history says the leave was ended on a past date');
SELECT is(
  (SELECT res->>'regenerate_competence' FROM t_res WHERE contract = '96400000-0000-4000-a000-000000000101'),
  (SELECT min(competence)::text FROM public.payout_monthly_closings
   WHERE status = 'pending_approval' AND competence >= date_trunc('month', (SELECT e FROM t_dates))::date),
  'the reply names the closing under review that must be generated again');

-- 02 e 03: datas que não valem.
SELECT throws_like(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000102', current_date + 1)$$,
  '%não pode estar no futuro%',
  'the last day of the leave cannot be in the future');
SELECT throws_like(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000103', (SELECT e - 4 FROM t_dates))$$,
  '%A licença começou em%',
  'the last day of the leave cannot be before it started');

-- 04: sem data, vale hoje, como antes (6 dias: de 5 dias atrás até hoje).
SELECT lives_ok(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000104', NULL)$$,
  'without a date the leave still ends today');
SELECT is(
  (SELECT days FROM public.assessment_leaves WHERE contract_id = '96400000-0000-4000-a000-000000000104'),
  6,
  'ending without a date counts the days until today');

-- 05 e 06: repasse já fechado.
SELECT throws_like(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000105', (SELECT fo - 2 FROM t_dates))$$,
  '%já foi fechado%',
  'the leave cannot end inside a payout month that is already closed');
SELECT lives_ok(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000106', (SELECT fo - 1 FROM t_dates))$$,
  'the last day of the closed month is still accepted');

-- 07: licença que já tem data de fim não troca de data ao encerrar.
SELECT throws_like(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000107', (SELECT e FROM t_dates))$$,
  '%já tem data de fim%',
  'a leave that already has an end date does not change it');
SELECT lives_ok(
  $$SELECT pg_temp.finish_on('96400000-0000-4000-a000-000000000107', NULL)$$,
  'a leave with an end date can still be finished without a date');

SELECT * FROM finish();
ROLLBACK;
