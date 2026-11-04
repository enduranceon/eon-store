BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(7);

-- Fixtures fictícias: cinco contratos trimestrais sem renovação.
--   01 licença aberta, fim original daqui a 5 dias
--   02 sem licença, fim daqui a 5 dias (controle)
--   03 licença aberta, fim original já passou há 3 dias
--   04 sem licença, fim passou há 3 dias (controle)
--   05 licença aberta há 2 dias, fim original daqui a 5 dias (a licença será encerrada)
INSERT INTO public.assessment_modalities (id, name)
VALUES ('96100000-0000-4000-a000-000000000010', 'conferencia-licenca-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '96100000-0000-4000-a000-000000000011', '96100000-0000-4000-a000-000000000010',
  'Plano trimestral conferência licença', 'trimestral', 3, 200, 600, 3, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('96100000-0000-4000-a000-000000000012', 'Coach Conferência Licença', 'conferencia-licenca@example.test', 'senior',
        ARRAY['96100000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('96100000-0000-4000-a000-000000000021', 'Pessoa Licença Antes Do Fim', '11900009621'),
  ('96100000-0000-4000-a000-000000000022', 'Pessoa Sem Licença A', '11900009622'),
  ('96100000-0000-4000-a000-000000000023', 'Pessoa Licença Depois Do Fim', '11900009623'),
  ('96100000-0000-4000-a000-000000000024', 'Pessoa Sem Licença B', '11900009624'),
  ('96100000-0000-4000-a000-000000000025', 'Pessoa Licença Encerrada', '11900009625');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
)
SELECT ('96100000-0000-4000-a000-0000000001' || fixture.n)::uuid, 'ASS-9961' || fixture.n,
       ('96100000-0000-4000-a000-0000000000' || (20 + fixture.n::int))::uuid,
       '96100000-0000-4000-a000-000000000012', '96100000-0000-4000-a000-000000000011',
       '{"name":"Plano trimestral conferência licença","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"96100000-0000-4000-a000-000000000010"}'::jsonb,
       'active', current_date + fixture.end_offset - 90, current_date + fixture.end_offset,
       current_date + fixture.end_offset, current_date + fixture.end_offset - 90, 1,
       'pix', 'paid', false, false
FROM (VALUES ('01', 5), ('02', 5), ('03', -3), ('04', -3), ('05', 5)) AS fixture(n, end_offset);

-- Licenças sem data de volta (o gatilho põe o contrato em licença e não mexe no fim).
INSERT INTO public.assessment_leaves (contract_id, start_date, status) VALUES
  ('96100000-0000-4000-a000-000000000101', current_date - 20, 'active'),
  ('96100000-0000-4000-a000-000000000103', current_date - 20, 'active'),
  ('96100000-0000-4000-a000-000000000105', current_date - 2, 'active');

SELECT is(
  (SELECT count(*)::int FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = '96100000-0000-4000-a000-000000000101'),
  0,
  'open leave before the original end: the renewal is not reported as missing'
);
SELECT is(
  (SELECT issue_code FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = '96100000-0000-4000-a000-000000000102'),
  'renewal_not_created',
  'a normal contract near its end is still reported'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = '96100000-0000-4000-a000-000000000103'),
  0,
  'open leave after the original end: not reported as expired without renewal'
);
SELECT is(
  (SELECT issue_code FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = '96100000-0000-4000-a000-000000000104'),
  'expired_without_renewal',
  'a normal expired contract is still reported'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = '96100000-0000-4000-a000-000000000105'),
  0,
  'a contract with an open leave is not reported while the leave is open'
);

-- Encerrar a licença: os 3 dias parados (de 2 dias atrás até hoje) somam ao fim.
UPDATE public.assessment_leaves SET status = 'finished', end_date = current_date
WHERE contract_id = '96100000-0000-4000-a000-000000000105';

SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '96100000-0000-4000-a000-000000000105'),
  current_date + 8,
  'finishing the leave adds the stopped days to the end'
);
SELECT is(
  (SELECT issue_code FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = '96100000-0000-4000-a000-000000000105'),
  'renewal_not_created',
  'after the leave ends, a contract near its new end is reported again'
);

SELECT * FROM finish();
ROLLBACK;
