BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(15);

-- Fixtures fictícias: planos mensal e trimestral e contratos em cada situação
-- que a conferência de assinaturas precisa separar.
INSERT INTO auth.users (id, email) VALUES ('93000000-0000-4000-a000-0000000000ff', 'conferencia-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('93000000-0000-4000-a000-000000000010', 'conferencia-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES
  ('93000000-0000-4000-a000-000000000011', '93000000-0000-4000-a000-000000000010',
   'Plano mensal conferência teste', 'mensal', 1, 300, 300, 1, 0),
  ('93000000-0000-4000-a000-000000000013', '93000000-0000-4000-a000-000000000010',
   'Plano trimestral conferência teste', 'trimestral', 3, 280, 840, 3, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('93000000-0000-4000-a000-000000000012', 'Coach Conferência Teste', 'conferencia-teste@example.test', 'senior',
        ARRAY['93000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf, cnpj) VALUES
  ('93000000-0000-4000-a000-000000000021', 'Pessoa Conferência Um', '11900009301', '52998224725', NULL),
  ('93000000-0000-4000-a000-000000000022', 'Pessoa Conferência Dois', '11900009302', '11144477735', NULL);

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id,
  manual_discount, asaas_subscription_id
)
SELECT
  fixture.id::uuid, fixture.contract_number, fixture.customer_id::uuid,
  '93000000-0000-4000-a000-000000000012', fixture.plan_id::uuid,
  CASE WHEN fixture.plan_id = '93000000-0000-4000-a000-000000000013'
    THEN '{"name":"Plano trimestral conferência teste","period":"trimestral","period_months":3,"price_total":840}'::jsonb
    ELSE '{"name":"Plano mensal conferência teste","period":"mensal","period_months":1,"price_total":300}'::jsonb
  END,
  fixture.status, current_date + fixture.start_offset, current_date + fixture.end_offset,
  current_date + fixture.end_offset, current_date + fixture.start_offset, 1,
  'pix', fixture.payment_status, fixture.auto_renewal, false, fixture.parent_id::uuid,
  fixture.discount, fixture.subscription_id
FROM (VALUES
  -- A: mensal atual, sem renovação, com desconto → entra (valor 280).
  ('93000000-0000-4000-a000-000000000101', 'ASS-993101', '93000000-0000-4000-a000-000000000021',
   '93000000-0000-4000-a000-000000000011', 'active', -20, 10, 'paid', false, NULL, 20, NULL),
  -- B: mensal com renovação em aberto → fica de fora; a renovação C entra.
  ('93000000-0000-4000-a000-000000000102', 'ASS-993102', '93000000-0000-4000-a000-000000000021',
   '93000000-0000-4000-a000-000000000011', 'active', -25, 5, 'paid', false, NULL, 0, NULL),
  -- D: mensal cuja renovação foi anulada → entra.
  ('93000000-0000-4000-a000-000000000104', 'ASS-993104', '93000000-0000-4000-a000-000000000022',
   '93000000-0000-4000-a000-000000000011', 'overdue', -28, 2, 'paid', false, NULL, 0, NULL),
  -- E: já automática → fora.
  ('93000000-0000-4000-a000-000000000106', 'ASS-993106', '93000000-0000-4000-a000-000000000021',
   '93000000-0000-4000-a000-000000000011', 'active', -10, 20, 'paid', true, NULL, 0, NULL),
  -- F: trimestral → fora.
  ('93000000-0000-4000-a000-000000000107', 'ASS-993107', '93000000-0000-4000-a000-000000000021',
   '93000000-0000-4000-a000-000000000013', 'active', -10, 80, 'paid', false, NULL, 0, NULL),
  -- G: rascunho → fora.
  ('93000000-0000-4000-a000-000000000108', 'ASS-993108', '93000000-0000-4000-a000-000000000021',
   '93000000-0000-4000-a000-000000000011', 'draft', 5, 35, 'awaiting_charge', false, NULL, 0, NULL),
  -- H: terminou há mais de 30 dias → fora.
  ('93000000-0000-4000-a000-000000000109', 'ASS-993109', '93000000-0000-4000-a000-000000000022',
   '93000000-0000-4000-a000-000000000011', 'overdue', -70, -40, 'paid', false, NULL, 0, NULL),
  -- I: contrato da pessoa dois que já guarda uma assinatura.
  ('93000000-0000-4000-a000-000000000110', 'ASS-993110', '93000000-0000-4000-a000-000000000022',
   '93000000-0000-4000-a000-000000000011', 'finished', -100, -70, 'paid', true, NULL, 0, 'sub_outra9999')
) AS fixture(id, contract_number, customer_id, plan_id, status, start_offset, end_offset,
             payment_status, auto_renewal, parent_id, discount, subscription_id);

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id
) VALUES
  ('93000000-0000-4000-a000-000000000103', 'ASS-993103', '93000000-0000-4000-a000-000000000021',
   '93000000-0000-4000-a000-000000000012', '93000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal conferência teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'scheduled', current_date + 5, current_date + 35, current_date + 35, current_date + 5, 1,
   'pix', 'charge_sent', false, false, '93000000-0000-4000-a000-000000000102'),
  ('93000000-0000-4000-a000-000000000105', 'ASS-993105', '93000000-0000-4000-a000-000000000022',
   '93000000-0000-4000-a000-000000000012', '93000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal conferência teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'voided', current_date + 2, current_date + 32, current_date + 32, NULL, 1,
   'pix', 'cancelled', false, false, '93000000-0000-4000-a000-000000000104');

CREATE TEMP TABLE fixture_ids ON COMMIT DROP AS
SELECT array_agg(id) AS ids FROM public.assessment_contracts WHERE contract_number LIKE 'ASS-9931%';

SELECT results_eq(
  $$SELECT contract_number FROM public.list_assessment_auto_renewal_candidates((SELECT ids FROM fixture_ids))
    ORDER BY contract_number$$,
  $$VALUES ('ASS-993101'::text), ('ASS-993103'::text), ('ASS-993104'::text)$$,
  'only current monthly contracts without automatic renewal are listed'
);
SELECT results_eq(
  $$SELECT customer_name, cpf, expected_value
    FROM public.list_assessment_auto_renewal_candidates(ARRAY['93000000-0000-4000-a000-000000000101'::uuid])$$,
  $$VALUES ('Pessoa Conferência Um'::text, '52998224725'::text, 280::numeric)$$,
  'the candidate carries the person and the expected value'
);

-- Ligar a automática.
SELECT throws_ok(
  $$SELECT public.enable_assessment_auto_renewal_from_subscription(
      '93000000-0000-4000-a000-000000000101', 'pay_errado', NULL)$$,
  '22023', 'Assinatura do Asaas inválida',
  'a subscription id is required'
);
SELECT throws_ok(
  $$SELECT public.enable_assessment_auto_renewal_from_subscription(
      '93000000-0000-4000-a000-000000000107', 'sub_tri12345', NULL)$$,
  'P0001', NULL,
  'a quarterly contract is refused'
);
SELECT throws_ok(
  $$SELECT public.enable_assessment_auto_renewal_from_subscription(
      '93000000-0000-4000-a000-000000000102', 'sub_pai12345', NULL)$$,
  'P0001', NULL,
  'a contract whose renewal is open is refused'
);
SELECT throws_ok(
  $$SELECT public.enable_assessment_auto_renewal_from_subscription(
      '93000000-0000-4000-a000-000000000101', 'sub_outra9999', NULL)$$,
  'P0001', 'Esta assinatura do Asaas já está no contrato de outra pessoa',
  'a subscription stored for another person is refused'
);
SELECT lives_ok(
  $$SELECT public.enable_assessment_auto_renewal_from_subscription(
      '93000000-0000-4000-a000-000000000101', 'sub_umteste123', '93000000-0000-4000-a000-0000000000ff')$$,
  'the automatic renewal is enabled with the checked subscription'
);
SELECT results_eq(
  $$SELECT auto_renewal, asaas_subscription_id FROM public.assessment_contracts
    WHERE id = '93000000-0000-4000-a000-000000000101'$$,
  $$VALUES (true, 'sub_umteste123'::text)$$,
  'the contract keeps the subscription'
);
SELECT results_eq(
  $$SELECT payload->>'source', payload->>'subscription_id', notes, created_by
    FROM public.assessment_contract_event
    WHERE contract_id = '93000000-0000-4000-a000-000000000101' AND event_type = 'auto_renewal_changed'$$,
  $$VALUES ('asaas_subscription_check'::text, 'sub_umteste123'::text,
            'Renovação automática ativada pela assinatura do Asaas'::text,
            '93000000-0000-4000-a000-0000000000ff'::uuid)$$,
  'the change is in the contract history'
);
SELECT ok(
  (public.enable_assessment_auto_renewal_from_subscription(
     '93000000-0000-4000-a000-000000000101', 'sub_umteste123', NULL)->>'unchanged')::boolean,
  'enabling again changes nothing'
);
SELECT is(
  (SELECT count(*)::int FROM public.list_assessment_auto_renewal_candidates((SELECT ids FROM fixture_ids))
   WHERE contract_number = 'ASS-993101'),
  0,
  'the enabled contract leaves the list'
);
SELECT lives_ok(
  $$SELECT public.enable_assessment_auto_renewal_from_subscription(
      '93000000-0000-4000-a000-000000000104', 'sub_outra9999', NULL)$$,
  'the same person can reuse a subscription stored on an older contract'
);

-- Só o backend chama.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.list_assessment_auto_renewal_candidates(uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.list_assessment_auto_renewal_candidates(uuid[])', 'EXECUTE'),
  'the list is not exposed to the browser'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.enable_assessment_auto_renewal_from_subscription(uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.enable_assessment_auto_renewal_from_subscription(uuid,text,uuid)', 'EXECUTE'),
  'enabling is not exposed to the browser'
);
SELECT ok(
  has_function_privilege('service_role', 'public.enable_assessment_auto_renewal_from_subscription(uuid,text,uuid)', 'EXECUTE'),
  'the backend can enable'
);

SELECT * FROM finish();
ROLLBACK;
