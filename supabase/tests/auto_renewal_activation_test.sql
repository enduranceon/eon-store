BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(6);

-- Fixtures fictícias: três renovações automáticas que começam hoje.
-- 1) anterior sempre manual (a automática foi ligada na renovação);
-- 2) anterior automático que teve a automática desligada depois (desistiu);
-- 3) igual à 1, ativada pelas transições das telas.
INSERT INTO auth.users (id, email) VALUES ('94000000-0000-4000-a000-0000000000ff', 'ativacao-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('94000000-0000-4000-a000-000000000010', 'ativacao-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '94000000-0000-4000-a000-000000000011', '94000000-0000-4000-a000-000000000010',
  'Plano mensal ativação teste', 'mensal', 1, 300, 300, 1, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('94000000-0000-4000-a000-000000000012', 'Coach Ativação Teste', 'ativacao-teste@example.test', 'senior',
        ARRAY['94000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf) VALUES
  ('94000000-0000-4000-a000-000000000021', 'Pessoa Ativação Um', '11900009401', '52998224725'),
  ('94000000-0000-4000-a000-000000000022', 'Pessoa Ativação Dois', '11900009402', '11144477735'),
  ('94000000-0000-4000-a000-000000000023', 'Pessoa Ativação Três', '11900009403', '39053344705');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id
)
SELECT
  fixture.id::uuid, fixture.contract_number, fixture.customer_id::uuid,
  '94000000-0000-4000-a000-000000000012', '94000000-0000-4000-a000-000000000011',
  '{"name":"Plano mensal ativação teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
  fixture.status, current_date + fixture.start_offset, current_date + fixture.end_offset,
  current_date + fixture.end_offset, current_date + fixture.start_offset, 1,
  'pix', 'paid', fixture.auto_renewal, fixture.parent_id IS NULL, fixture.parent_id::uuid
FROM (VALUES
  ('94000000-0000-4000-a000-000000000101', 'ASS-994101', '94000000-0000-4000-a000-000000000021', 'active', -30, 0, false, NULL),
  ('94000000-0000-4000-a000-000000000102', 'ASS-994102', '94000000-0000-4000-a000-000000000021', 'scheduled', 0, 30, true, '94000000-0000-4000-a000-000000000101'),
  ('94000000-0000-4000-a000-000000000103', 'ASS-994103', '94000000-0000-4000-a000-000000000022', 'active', -30, 0, true, NULL),
  ('94000000-0000-4000-a000-000000000104', 'ASS-994104', '94000000-0000-4000-a000-000000000022', 'scheduled', 0, 30, true, '94000000-0000-4000-a000-000000000103'),
  ('94000000-0000-4000-a000-000000000105', 'ASS-994105', '94000000-0000-4000-a000-000000000023', 'active', -30, 0, false, NULL),
  ('94000000-0000-4000-a000-000000000106', 'ASS-994106', '94000000-0000-4000-a000-000000000023', 'scheduled', 0, 30, true, '94000000-0000-4000-a000-000000000105')
) AS fixture(id, contract_number, customer_id, status, start_offset, end_offset, auto_renewal, parent_id);

-- A pessoa dois desistiu: a automática do contrato anterior foi desligada
-- depois de a renovação nascer.
SELECT lives_ok(
  $$SELECT public.set_assessment_contract_auto_renewal(
      '94000000-0000-4000-a000-000000000103', false,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000103'),
      '94000000-0000-4000-a000-0000000000ff')$$,
  'the previous contract has its automatic renewal turned off'
);

SELECT lives_ok(
  $$SELECT public.apply_assessment_contract_transitions('94000000-0000-4000-a000-0000000000ff')$$,
  'the screen transitions run'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000106'),
  'active',
  'the screen transitions start an automatic renewal whose previous contract was always manual'
);

SELECT lives_ok(
  $$SELECT public.process_internal_assessment_renewals(10, 5, NULL)$$,
  'the daily renewal job runs'
);
SELECT results_eq(
  $$SELECT contract_number, status FROM public.assessment_contracts
    WHERE id IN ('94000000-0000-4000-a000-000000000101', '94000000-0000-4000-a000-000000000102')
    ORDER BY contract_number$$,
  $$VALUES ('ASS-994101'::text, 'finished'::text), ('ASS-994102'::text, 'active'::text)$$,
  'the daily job starts the renewal made automatic by itself and finishes the previous contract'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000104'),
  'scheduled',
  'a renewal whose previous contract turned the automatic renewal off does not start'
);

SELECT * FROM finish();
ROLLBACK;
