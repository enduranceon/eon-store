BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(10);

-- Fixtures fictícias: três contratos com licença sem data de volta.
--   01 fim original já passou (há 5 dias), licença aberta há 30 dias:
--      ao encerrar hoje soma 31 dias, o fim vai para daqui a 26 dias e o contrato fica ativo
--   02 fim original daqui a 10 dias, licença aberta há 3 dias: soma 4 dias
--   03 fim muito antigo (há 60 dias), licença aberta há 20 dias: mesmo com 21 dias
--      somados o fim continua no passado, então vencido continua valendo
INSERT INTO auth.users (id, email)
VALUES ('96200000-0000-4000-a000-0000000000ff', 'finish-leave-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('96200000-0000-4000-a000-000000000010', 'encerrar-licenca-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '96200000-0000-4000-a000-000000000011', '96200000-0000-4000-a000-000000000010',
  'Plano semestral encerrar licença', 'semestral', 6, 185, 1110, 6, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('96200000-0000-4000-a000-000000000012', 'Coach Encerrar Licença', 'encerrar-licenca@example.test', 'senior',
        ARRAY['96200000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('96200000-0000-4000-a000-000000000021', 'Pessoa Volta Depois Do Fim', '11900009631'),
  ('96200000-0000-4000-a000-000000000022', 'Pessoa Volta Antes Do Fim', '11900009632'),
  ('96200000-0000-4000-a000-000000000023', 'Pessoa Fim Muito Antigo', '11900009633');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
)
SELECT ('96200000-0000-4000-a000-0000000001' || fixture.n)::uuid, 'ASS-9962' || fixture.n,
       ('96200000-0000-4000-a000-0000000000' || (20 + fixture.n::int))::uuid,
       '96200000-0000-4000-a000-000000000012', '96200000-0000-4000-a000-000000000011',
       '{"name":"Plano semestral encerrar licença","period":"semestral","period_months":6,"price_total":1110,"price_monthly":185,"modality_id":"96200000-0000-4000-a000-000000000010"}'::jsonb,
       'active', current_date + fixture.end_offset - 180, current_date + fixture.end_offset,
       current_date + fixture.end_offset, current_date + fixture.end_offset - 180, 1,
       'pix', 'paid', false, false
FROM (VALUES ('01', -5), ('02', 10), ('03', -60)) AS fixture(n, end_offset);

INSERT INTO public.assessment_leaves (contract_id, start_date, status) VALUES
  ('96200000-0000-4000-a000-000000000101', current_date - 30, 'active'),
  ('96200000-0000-4000-a000-000000000102', current_date - 3, 'active'),
  ('96200000-0000-4000-a000-000000000103', current_date - 20, 'active');

CREATE FUNCTION pg_temp.finish_leave(p_contract uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.finish_assessment_contract_leave(
    p_contract,
    (SELECT id FROM public.assessment_leaves WHERE contract_id = p_contract AND status = 'active'),
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_contract),
    '96200000-0000-4000-a000-0000000000ff');
$$;

-- 01: voltou depois do fim original.
SELECT lives_ok($$SELECT pg_temp.finish_leave('96200000-0000-4000-a000-000000000101')$$,
  'the leave ends after the original end date');
SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '96200000-0000-4000-a000-000000000101'),
  current_date + 26,
  'the stopped days are added to the end date');
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = '96200000-0000-4000-a000-000000000101'),
  'active',
  'the status follows the new end date, not the old one');
SELECT is(
  (SELECT payload->>'new_status' FROM public.assessment_contract_event
   WHERE contract_id = '96200000-0000-4000-a000-000000000101' AND event_type = 'leave_ended'),
  'active',
  'the leave_ended event records the active status');

-- 02: voltou antes do fim original.
SELECT lives_ok($$SELECT pg_temp.finish_leave('96200000-0000-4000-a000-000000000102')$$,
  'the leave ends before the original end date');
SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '96200000-0000-4000-a000-000000000102'),
  current_date + 14,
  'the 4 stopped days are added to the end date');
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = '96200000-0000-4000-a000-000000000102'),
  'active',
  'the contract stays active');

-- 03: mesmo com os dias somados o fim já passou.
SELECT lives_ok($$SELECT pg_temp.finish_leave('96200000-0000-4000-a000-000000000103')$$,
  'the leave ends on a contract that ended long ago');
SELECT is(
  (SELECT end_date FROM public.assessment_contracts WHERE id = '96200000-0000-4000-a000-000000000103'),
  current_date - 39,
  'the stopped days are still added');
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = '96200000-0000-4000-a000-000000000103'),
  'overdue',
  'a contract whose new end date is still in the past stays overdue');

SELECT * FROM finish();
ROLLBACK;
