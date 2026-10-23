BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(16);

-- Fixtures fictícias: um aluno do plano mensal com renovação automática, o
-- contrato pago (com a fatura do mês passado) e a renovação aguardando o link.
INSERT INTO auth.users (id, email) VALUES ('92000000-0000-4000-a000-0000000000ff', 'assinatura-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('92000000-0000-4000-a000-000000000010', 'assinatura-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '92000000-0000-4000-a000-000000000011', '92000000-0000-4000-a000-000000000010',
  'Plano mensal assinatura teste', 'mensal', 1, 300, 300, 1, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('92000000-0000-4000-a000-000000000012', 'Coach Assinatura Teste', 'assinatura-teste@example.test', 'senior',
        ARRAY['92000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf) VALUES
  ('92000000-0000-4000-a000-000000000021', 'Pessoa Assinatura Teste', '11900009201', '52998224725');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id,
  external_payment_link, renewal_stage
) VALUES
  ('92000000-0000-4000-a000-000000000101', 'ASS-992101', '92000000-0000-4000-a000-000000000021',
   '92000000-0000-4000-a000-000000000012', '92000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal assinatura teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'active', current_date - 25, current_date + 5, current_date + 5, current_date - 25, 1,
   'pix', 'paid', true, true, NULL, 'https://www.asaas.com/i/abc123def456', NULL),
  ('92000000-0000-4000-a000-000000000102', 'ASS-992102', '92000000-0000-4000-a000-000000000021',
   '92000000-0000-4000-a000-000000000012', '92000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal assinatura teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'scheduled', current_date + 6, current_date + 36, current_date + 36, NULL, 1,
   'pix', 'awaiting_charge', true, false, '92000000-0000-4000-a000-000000000101', NULL, 'waiting_payment'),
  ('92000000-0000-4000-a000-000000000104', 'ASS-992104', '92000000-0000-4000-a000-000000000021',
   '92000000-0000-4000-a000-000000000012', '92000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal assinatura teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'finished', current_date - 60, current_date - 30, current_date - 30, current_date - 60, 1,
   'pix', 'paid', false, true, NULL, NULL, NULL),
  -- Renovação comum (não automática): a busca não mexe.
  ('92000000-0000-4000-a000-000000000103', 'ASS-992103', '92000000-0000-4000-a000-000000000021',
   '92000000-0000-4000-a000-000000000012', '92000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal assinatura teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'draft', current_date + 6, current_date + 36, current_date + 36, NULL, 1,
   'pix', 'awaiting_charge', false, false, '92000000-0000-4000-a000-000000000104', NULL, 'contact_pending');

-- Fatura ainda não gerada: só guarda o resultado para o card.
SELECT lives_ok(
  $$SELECT public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000102', 'sub_test123abc',
      'waiting_invoice', 'A fatura deste mês ainda não apareceu na assinatura', NULL, NULL)$$,
  'a lookup without invoice is recorded'
);
SELECT results_eq(
  $$SELECT asaas_subscription_id, subscription_link_status, external_payment_link IS NULL, payment_status
    FROM public.assessment_contracts WHERE id = '92000000-0000-4000-a000-000000000102'$$,
  $$VALUES ('sub_test123abc'::text, 'waiting_invoice'::text, true, 'awaiting_charge'::text)$$,
  'the card knows the invoice is not there yet, and nothing else changes'
);

-- Com a fatura do mês: vira cobrança externa como se tivesse sido colada.
CREATE TEMPORARY TABLE lookup_runs (name text PRIMARY KEY, result jsonb);
INSERT INTO lookup_runs
SELECT 'attached', public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000102', 'sub_test123abc',
  'attached', NULL,
  jsonb_build_object('link', 'https://www.asaas.com/i/next789xyz012', 'due_date', current_date + 6,
                     'payment_method', 'boleto', 'invoice_number', '4321'),
  '92000000-0000-4000-a000-0000000000ff');

SELECT results_eq(
  $$SELECT external_payment_link, due_date, payment_method, external_invoice_number, payment_status, subscription_link_status
    FROM public.assessment_contracts WHERE id = '92000000-0000-4000-a000-000000000102'$$,
  $$VALUES ('https://www.asaas.com/i/next789xyz012'::text, current_date + 6, 'boleto'::text, '4321'::text,
            'charge_sent'::text, 'attached'::text)$$,
  'the invoice link, due date and method are saved on the renewal'
);
SELECT is(
  (SELECT result->>'attached' FROM lookup_runs WHERE name = 'attached'),
  'true',
  'the call says the link was attached'
);
SELECT is(
  (SELECT payload->>'source' FROM public.assessment_contract_event
   WHERE contract_id = '92000000-0000-4000-a000-000000000102' AND event_type = 'external_charge_registered'),
  'asaas_subscription',
  'the contract history says the link came from the Asaas subscription'
);
SELECT is(
  (SELECT notes FROM public.assessment_contract_event
   WHERE contract_id = '92000000-0000-4000-a000-000000000102' AND event_type = 'external_charge_registered'),
  'Link da fatura buscado na assinatura do Asaas',
  'the history note explains it'
);

-- Já tem link: uma nova busca não mexe.
SELECT is(
  public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000102', 'sub_test123abc',
    'attached', NULL,
    jsonb_build_object('link', 'https://www.asaas.com/i/other00000001', 'due_date', current_date + 6,
                       'payment_method', 'pix', 'invoice_number', NULL),
    NULL)->>'reason',
  'not_eligible',
  'a renewal that already has its link is left alone'
);
SELECT is(
  (SELECT external_payment_link FROM public.assessment_contracts WHERE id = '92000000-0000-4000-a000-000000000102'),
  'https://www.asaas.com/i/next789xyz012',
  'the saved link stays'
);

-- Renovação comum não é assinatura.
SELECT is(
  public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000103', 'sub_test123abc',
    'waiting_invoice', NULL, NULL, NULL)->>'reason',
  'not_eligible',
  'a renewal without automatic renewal is not touched'
);

-- A mesma fatura não vai para dois contratos.
UPDATE public.assessment_contracts SET auto_renewal = true WHERE id = '92000000-0000-4000-a000-000000000103';
SELECT is(
  public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000103', 'sub_test123abc',
    'attached', NULL,
    jsonb_build_object('link', 'https://www.asaas.com/i/next789xyz012', 'due_date', current_date + 6,
                       'payment_method', 'pix', 'invoice_number', NULL),
    NULL)->>'reason',
  'invoice_in_use',
  'an invoice already used by another contract is not attached again'
);

-- Valor diferente: grava com aviso.
SELECT is(
  public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000103', 'sub_test123abc',
    'value_mismatch', 'No Asaas R$ 280,00; no contrato R$ 300,00',
    jsonb_build_object('link', 'https://www.asaas.com/i/third0000001', 'due_date', current_date + 6,
                       'payment_method', 'UNDEFINED', 'invoice_number', NULL),
    NULL)->>'attached',
  'true',
  'a different value still attaches the link'
);
SELECT results_eq(
  $$SELECT subscription_link_status, subscription_link_note, payment_method
    FROM public.assessment_contracts WHERE id = '92000000-0000-4000-a000-000000000103'$$,
  $$VALUES ('value_mismatch'::text, 'No Asaas R$ 280,00; no contrato R$ 300,00'::text, 'pix'::text)$$,
  'the warning is kept for the card and an unknown method falls back to PIX'
);

-- Entradas inválidas.
SELECT throws_ok(
  $$SELECT public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000102', NULL, 'whatever', NULL, NULL, NULL)$$,
  '22023', 'Resultado da busca inválido',
  'an unknown result is refused'
);
SELECT throws_ok(
  $$SELECT public.apply_assessment_subscription_lookup('92000000-0000-4000-a000-000000000102', 'sub_test123abc',
      'attached', NULL, jsonb_build_object('link', 'https://exemplo.test/fatura', 'due_date', current_date), NULL)$$,
  '22023', 'Fatura da assinatura inválida',
  'only an Asaas invoice link is accepted'
);
SELECT throws_ok(
  $$SELECT public.save_assessment_contract_external_charge('92000000-0000-4000-a000-000000000101',
      'https://www.asaas.com/i/abc123def456', current_date, 'pix', NULL, 'outra_origem', now(), NULL)$$,
  '22023', 'Origem da cobrança inválida',
  'the manual charge keeps refusing unknown origins'
);

-- Acesso.
SELECT ok(
  NOT has_function_privilege('anon', 'public.apply_assessment_subscription_lookup(uuid, text, text, text, jsonb, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.apply_assessment_subscription_lookup(uuid, text, text, text, jsonb, uuid)', 'EXECUTE'),
  'only the backend records subscription lookups'
);

SELECT * FROM finish();
ROLLBACK;
