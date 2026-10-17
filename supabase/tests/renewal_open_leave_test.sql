BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(11);

-- Fixtures fictícias: três contratos terminando em 5 dias. O 01 está em licença
-- sem data de volta, o 02 está normal e o 03 teve licença com data (já somada).
INSERT INTO public.assessment_modalities (id, name)
VALUES ('89000000-0000-4000-a000-000000000010', 'licenca-renovacao-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '89000000-0000-4000-a000-000000000011', '89000000-0000-4000-a000-000000000010',
  'Plano trimestral licença teste', 'trimestral', 3, 200, 600, 3, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('89000000-0000-4000-a000-000000000012', 'Coach Licença Teste', 'licenca-teste@example.test', 'senior',
        ARRAY['89000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('89000000-0000-4000-a000-000000000021', 'Pessoa Em Licença Aberta', '11900008921'),
  ('89000000-0000-4000-a000-000000000022', 'Pessoa Sem Licença', '11900008922'),
  ('89000000-0000-4000-a000-000000000023', 'Pessoa Com Licença Datada', '11900008923');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
)
SELECT ('89000000-0000-4000-a000-0000000001' || n)::uuid, 'ASS-989' || n,
       ('89000000-0000-4000-a000-0000000000' || (20 + n::int))::uuid,
       '89000000-0000-4000-a000-000000000012', '89000000-0000-4000-a000-000000000011',
       '{"name":"Plano trimestral licença teste","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"89000000-0000-4000-a000-000000000010"}'::jsonb,
       'active', current_date - 85, current_date + 5, current_date + 5,
       current_date - 85, 1, 'pix', 'paid', false, false
FROM (VALUES ('01'), ('02'), ('03')) AS fixture(n);

-- 01: licença sem data de volta (o fim não muda até ela acabar).
INSERT INTO public.assessment_leaves (contract_id, start_date, status)
VALUES ('89000000-0000-4000-a000-000000000101', current_date - 20, 'active');
-- 03: licença de 3 dias já com data: o fim anda 3 dias na hora.
INSERT INTO public.assessment_leaves (contract_id, start_date, end_date, status)
VALUES ('89000000-0000-4000-a000-000000000103', current_date - 10, current_date - 8, 'active');

SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '89000000-0000-4000-a000-000000000101'),
  current_date + 5,
  'an open leave keeps the original end date'
);

SET LOCAL ROLE service_role;
SELECT public.process_internal_assessment_renewals(10, 5, NULL) IS NOT NULL AS ran \gset
RESET ROLE;

SELECT is(
  (SELECT count(*)::int FROM public.assessment_contracts WHERE parent_contract_id = '89000000-0000-4000-a000-000000000101'),
  0,
  'a contract on leave without a return date does not enter renewal'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE parent_contract_id = '89000000-0000-4000-a000-000000000102'),
  'draft',
  'a normal contract still gets its renewal draft 10 days before the end'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contracts WHERE parent_contract_id = '89000000-0000-4000-a000-000000000103'),
  1,
  'a leave with a known end date (already added to the end) does not block renewal'
);

-- Rascunho antigo, criado antes da regra, para um contrato em licença aberta.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_status,
  auto_renewal, renewal_generated, parent_contract_id
) VALUES (
  '89000000-0000-4000-a000-000000000201', 'ASS-989201',
  '89000000-0000-4000-a000-000000000021', '89000000-0000-4000-a000-000000000012',
  '89000000-0000-4000-a000-000000000011',
  '{"name":"Plano trimestral licença teste","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"89000000-0000-4000-a000-000000000010"}'::jsonb,
  'draft', current_date + 5, current_date + 95, current_date + 95, 1, 'pending',
  false, false, '89000000-0000-4000-a000-000000000101'
);
UPDATE public.assessment_contracts SET renewal_generated = true WHERE id = '89000000-0000-4000-a000-000000000101';

SELECT is(eon_private.void_renewal_drafts_of_open_leaves(), 1, 'the cleanup voids the draft of the contract on open leave');
SELECT results_eq(
  $$SELECT status, payment_status, renewal_stage FROM public.assessment_contracts WHERE id = '89000000-0000-4000-a000-000000000201'$$,
  $$VALUES ('voided'::text, 'cancelled'::text, 'discarded'::text)$$,
  'the draft leaves the renewal queue as discarded'
);
SELECT is(
  (SELECT count(*)::int FROM public.communication_cases
   WHERE source_type = 'contract' AND source_id = '89000000-0000-4000-a000-000000000201' AND status <> 'resolved'),
  0,
  'the renewal conversation in the Central is closed'
);
SELECT is(
  (SELECT renewal_generated FROM public.assessment_contracts WHERE id = '89000000-0000-4000-a000-000000000101'),
  false,
  'the contract on leave can renew again after the leave'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE parent_contract_id = '89000000-0000-4000-a000-000000000102'),
  'draft',
  'the cleanup leaves other renewal drafts alone'
);

-- Fim da licença: o fim anda os dias parados e a renovação fica para depois.
UPDATE public.assessment_leaves SET status = 'finished', end_date = current_date
WHERE contract_id = '89000000-0000-4000-a000-000000000101';
SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '89000000-0000-4000-a000-000000000101'),
  current_date + 26,
  'finishing the leave adds the 21 stopped days to the end'
);
SET LOCAL ROLE service_role;
SELECT public.process_internal_assessment_renewals(10, 5, NULL) IS NOT NULL AS ran_again \gset
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contracts
   WHERE parent_contract_id = '89000000-0000-4000-a000-000000000101' AND status = 'draft'),
  0,
  'after the leave the renewal waits for 10 days before the new end'
);

SELECT * FROM finish();
ROLLBACK;
