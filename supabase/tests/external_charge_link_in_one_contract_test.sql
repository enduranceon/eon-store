BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(9);

-- Fixtures fictícias: dois contratos mensais da mesma pessoa (A e B) e um terceiro
-- anulado (C) que ainda guarda um link.
INSERT INTO auth.users (id, email)
VALUES ('96300000-0000-4000-a000-0000000000ff', 'link-unique-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('96300000-0000-4000-a000-000000000010', 'link-unico-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES ('96300000-0000-4000-a000-000000000011', '96300000-0000-4000-a000-000000000010',
  'Plano Link Único Teste', 'mensal', 1, 210, 210, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('96300000-0000-4000-a000-000000000012', 'Coach Link Único Teste', 'link-unico@example.test', 'senior',
        ARRAY['96300000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp)
VALUES ('96300000-0000-4000-a000-000000000021', 'Pessoa Link Único Teste', '11900009641');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
)
SELECT ('96300000-0000-4000-a000-0000000001' || fixture.n)::uuid, 'ASS-9963' || fixture.n,
       '96300000-0000-4000-a000-000000000021',
       '96300000-0000-4000-a000-000000000012', '96300000-0000-4000-a000-000000000011',
       '{"name":"Plano Link Único Teste","period":"mensal","period_months":1,"price_total":210,"price_monthly":210,"modality_id":"96300000-0000-4000-a000-000000000010"}'::jsonb,
       'scheduled', current_date + fixture.start_offset, current_date + fixture.start_offset + 30,
       current_date + fixture.start_offset + 30, current_date + fixture.start_offset, 1,
       'pix', 'pending', false, false
FROM (VALUES ('01', 1), ('02', 2)) AS fixture(n, start_offset);

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated,
  external_payment_link, cancellation_reason
) VALUES (
  '96300000-0000-4000-a000-000000000103', 'ASS-996303', '96300000-0000-4000-a000-000000000021',
  '96300000-0000-4000-a000-000000000012', '96300000-0000-4000-a000-000000000011',
  '{"name":"Plano Link Único Teste","period":"mensal","period_months":1,"price_total":210,"price_monthly":210,"modality_id":"96300000-0000-4000-a000-000000000010"}'::jsonb,
  'voided', current_date + 3, current_date + 33, current_date + 33, current_date + 3, 1,
  'pix', 'cancelled', false, false,
  'https://example.test/pay/voided', 'Contrato anterior em licença sem data de volta'
);

CREATE FUNCTION pg_temp.save(p_contract uuid, p_link text, p_due date) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.save_assessment_contract_external_charge(
    p_contract, p_link, p_due, 'pix', NULL, 'contract_detail',
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_contract),
    '96300000-0000-4000-a000-0000000000ff');
$$;

SELECT lives_ok(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000101', 'https://example.test/pay/one', current_date + 1)$$,
  'the first contract takes the link');

-- O mesmo link em outro contrato é recusado, com o número do contrato que já o usa.
SELECT throws_like(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000102', 'https://example.test/pay/one', current_date + 2)$$,
  '%já está no contrato ASS-996301%',
  'the same link in another contract is refused and names the contract');
SELECT throws_like(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000102', 'https://example.test/pay/one/', current_date + 2)$$,
  '%já está no contrato ASS-996301%',
  'a trailing slash does not hide the repeated link');
SELECT is(
  (SELECT external_payment_link FROM public.assessment_contracts
   WHERE id = '96300000-0000-4000-a000-000000000102'),
  NULL,
  'the refused link was not saved');

-- O próprio contrato pode salvar de novo o mesmo link (outro vencimento).
SELECT lives_ok(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000101', 'https://example.test/pay/one', current_date + 2)$$,
  'the same contract can save its own link again with another due date');

-- Link de contrato anulado está livre.
SELECT lives_ok(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000102', 'https://example.test/pay/voided', current_date + 2)$$,
  'the link of a voided contract can be used');

-- Link próprio, diferente de todos.
SELECT lives_ok(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000102', 'https://example.test/pay/two', current_date + 2)$$,
  'a contract can change to a link nobody else uses');

-- Repetido de antes (gravado direto): mudar o vencimento sem mudar o link continua possível.
UPDATE public.assessment_contracts
SET external_payment_link = 'https://example.test/pay/one'
WHERE id = '96300000-0000-4000-a000-000000000102';
SELECT lives_ok(
  $$SELECT pg_temp.save('96300000-0000-4000-a000-000000000102', 'https://example.test/pay/one', current_date + 3)$$,
  'a contract that already holds a repeated link can still change its due date');
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_event
   WHERE contract_id = '96300000-0000-4000-a000-000000000101'
     AND event_type IN ('external_charge_registered', 'external_charge_updated')),
  2,
  'the contract history keeps the registered link and the due date change');

SELECT * FROM finish();
ROLLBACK;
