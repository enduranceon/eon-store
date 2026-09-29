BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(71);

-- Acesso ----------------------------------------------------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
   WHERE oid = 'public.assessment_contract_plan_changes'::regclass),
  'plan changes keep RLS enabled'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'assessment_contract_plan_changes'
     AND ((policyname = 'app_admin_only' AND permissive = 'RESTRICTIVE' AND cmd = 'ALL')
       OR (policyname = 'app_admin_read' AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'))),
  2,
  'plan changes are readable only by app admins'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.assessment_contract_plan_changes', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.assessment_contract_plan_changes', 'SELECT,INSERT,UPDATE,DELETE'),
  'the browser cannot write plan changes and anon cannot read them'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.create_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.api_record_plan_change_manual_payment(uuid, uuid, date, numeric, jsonb, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.create_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.apply_due_assessment_plan_changes(uuid)', 'EXECUTE'),
  'plan change operations run only through the backend'
);

-- Fixtures fictícias ----------------------------------------------------------

INSERT INTO public.assessment_modalities (id, name) VALUES
  ('40000000-0000-4000-a000-000000000001', 'mudanca-plano-corrida-test'),
  ('40000000-0000-4000-a000-000000000002', 'mudanca-plano-triathlon-test');

INSERT INTO public.revenue_centers (id, name, type) VALUES
  ('40000000-0000-4000-a000-000000000041', 'Mudanca centro corrida', 'assessoria'),
  ('40000000-0000-4000-a000-000000000042', 'Mudanca centro triathlon', 'assessoria');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee, revenue_center_id
) VALUES
  ('40000000-0000-4000-a000-000000000011', '40000000-0000-4000-a000-000000000001',
   'Mudanca corrida semestral', 'semestral', 6, 200, 1200, 6, 0, '40000000-0000-4000-a000-000000000041'),
  ('40000000-0000-4000-a000-000000000012', '40000000-0000-4000-a000-000000000001',
   'Mudanca corrida semestral bis', 'semestral', 6, 200, 1200, 6, 0, NULL),
  ('40000000-0000-4000-a000-000000000013', '40000000-0000-4000-a000-000000000002',
   'Mudanca triathlon semestral', 'semestral', 6, 300, 1800, 6, 0, '40000000-0000-4000-a000-000000000042'),
  ('40000000-0000-4000-a000-000000000014', '40000000-0000-4000-a000-000000000001',
   'Mudanca corrida essencial semestral', 'semestral', 6, 185, 1110, 6, 0, NULL),
  ('40000000-0000-4000-a000-000000000015', '40000000-0000-4000-a000-000000000002',
   'Mudanca triathlon mensal', 'mensal', 1, 350, 350, 1, 0, NULL);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids) VALUES
  ('40000000-0000-4000-a000-000000000021', 'Coach mudanca corrida', 'mudanca-a@example.test', 'pleno',
   ARRAY['40000000-0000-4000-a000-000000000001'::uuid]),
  ('40000000-0000-4000-a000-000000000022', 'Coach mudanca triathlon', 'mudanca-b@example.test', 'pleno',
   ARRAY['40000000-0000-4000-a000-000000000001'::uuid, '40000000-0000-4000-a000-000000000002'::uuid]);

INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('40000000-0000-4000-a000-000000000031', 'Mudanca de plano um', '11900004031'),
  ('40000000-0000-4000-a000-000000000032', 'Mudanca de plano dois', '11900004032'),
  ('40000000-0000-4000-a000-000000000033', 'Mudanca de plano tres', '11900004033'),
  ('40000000-0000-4000-a000-000000000034', 'Mudanca de plano quatro', '11900004034'),
  ('40000000-0000-4000-a000-000000000035', 'Mudanca de plano cinco', '11900004035'),
  ('40000000-0000-4000-a000-000000000036', 'Mudanca de plano seis', '11900004036'),
  ('40000000-0000-4000-a000-000000000037', 'Mudanca de plano sete', '11900004037'),
  ('40000000-0000-4000-a000-000000000038', 'Mudanca de plano oito', '11900004038');

-- K1: datas do exemplo do documento. K2 a K7: 30 dias atrás a 150 dias à
-- frente (ciclo de 180 dias). K6 ainda não pago. O snapshot da venda não traz
-- o centro de receita (como nos contratos antigos).
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, payment_date, auto_renewal, renewal_generated
)
SELECT
  fixture.id, fixture.number, fixture.customer_id, fixture.coach_id,
  '40000000-0000-4000-a000-000000000011',
  '{"plan_id":"40000000-0000-4000-a000-000000000011","name":"Mudanca corrida semestral","period":"semestral","period_months":6,"price_total":1200,"price_monthly":200,"modality_id":"40000000-0000-4000-a000-000000000001"}'::jsonb,
  'active', fixture.start_date, fixture.end_date, fixture.end_date, fixture.start_date, 1,
  'pix', fixture.payment_status,
  CASE WHEN fixture.payment_status = 'paid' THEN fixture.start_date END,
  false, false
FROM (VALUES
  ('40000000-0000-4000-a000-000000000101'::uuid, 'ASS-940001', '40000000-0000-4000-a000-000000000031'::uuid,
   '40000000-0000-4000-a000-000000000021'::uuid, '2026-09-01'::date, '2027-03-01'::date, 'paid'),
  ('40000000-0000-4000-a000-000000000102'::uuid, 'ASS-940002', '40000000-0000-4000-a000-000000000032'::uuid,
   '40000000-0000-4000-a000-000000000021'::uuid, current_date - 30, current_date + 150, 'paid'),
  ('40000000-0000-4000-a000-000000000103'::uuid, 'ASS-940003', '40000000-0000-4000-a000-000000000033'::uuid,
   '40000000-0000-4000-a000-000000000022'::uuid, current_date - 30, current_date + 150, 'paid'),
  ('40000000-0000-4000-a000-000000000104'::uuid, 'ASS-940004', '40000000-0000-4000-a000-000000000034'::uuid,
   '40000000-0000-4000-a000-000000000022'::uuid, current_date - 30, current_date + 150, 'paid'),
  ('40000000-0000-4000-a000-000000000105'::uuid, 'ASS-940005', '40000000-0000-4000-a000-000000000035'::uuid,
   '40000000-0000-4000-a000-000000000021'::uuid, current_date - 30, current_date + 150, 'paid'),
  ('40000000-0000-4000-a000-000000000106'::uuid, 'ASS-940006', '40000000-0000-4000-a000-000000000036'::uuid,
   '40000000-0000-4000-a000-000000000021'::uuid, current_date - 30, current_date + 150, 'pending'),
  ('40000000-0000-4000-a000-000000000107'::uuid, 'ASS-940007', '40000000-0000-4000-a000-000000000037'::uuid,
   '40000000-0000-4000-a000-000000000021'::uuid, current_date - 30, current_date + 150, 'paid')
) AS fixture(id, number, customer_id, coach_id, start_date, end_date, payment_status);

-- K8: contrato pago sem o preço da venda no snapshot.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
) VALUES (
  '40000000-0000-4000-a000-000000000108', 'ASS-940008', '40000000-0000-4000-a000-000000000038',
  '40000000-0000-4000-a000-000000000022', '40000000-0000-4000-a000-000000000011', NULL, 'active',
  current_date - 30, current_date + 150, current_date + 150, current_date - 30, 1,
  'pix', 'paid', false, false
);

CREATE TEMPORARY TABLE plan_change_results (
  name text PRIMARY KEY,
  result jsonb NOT NULL
);
GRANT SELECT, INSERT ON plan_change_results TO service_role;

CREATE FUNCTION pg_temp.error_of(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.error_of(text) TO service_role;

-- Matriz e prévia (exemplo do documento) ------------------------------------------

SELECT is(
  (SELECT jsonb_object_agg(to_plan_id, transition_type) FROM public.assessment_plan_transitions
   WHERE from_plan_id = '40000000-0000-4000-a000-000000000011'
     AND to_plan_id::text LIKE '40000000-%'),
  jsonb_build_object(
    '40000000-0000-4000-a000-000000000012', 'lateral',
    '40000000-0000-4000-a000-000000000013', 'upgrade',
    '40000000-0000-4000-a000-000000000014', 'downgrade'
  ),
  'the matrix classifies the fixture plans by price'
);

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES
  ('doc', public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2026-11-01', '40000000-0000-4000-a000-000000000022', NULL)),
  ('dec15', public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2026-12-15', '40000000-0000-4000-a000-000000000022', NULL)),
  ('small', public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2027-02-20', '40000000-0000-4000-a000-000000000022', NULL)),
  ('lateral', public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000012',
    '2026-11-01', NULL, NULL));
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('amount', result->'amount', 'remaining', result->'remaining_days',
     'cycle', result->'cycle_days', 'max', result->'max_installments', 'type', result->'change_type',
     'coach_changes', result->'coach_changes')
   FROM plan_change_results WHERE name = 'doc'),
  jsonb_build_object('amount', 397.79, 'remaining', 120, 'cycle', 181, 'max', 6,
    'type', 'upgrade', 'coach_changes', true),
  'the approved example: (1.800 - 1.200) x 120 / 181 = R$ 397,79, up to 6x'
);
SELECT is(
  (SELECT jsonb_build_object('amount', result->'amount', 'max', result->'max_installments')
   FROM plan_change_results WHERE name = 'dec15'),
  jsonb_build_object('amount', 251.93, 'max', 5),
  'R$ 251,93 splits in up to 5 installments of at least R$ 50'
);
SELECT is(
  (SELECT jsonb_build_object('amount', result->'amount', 'max', result->'max_installments')
   FROM plan_change_results WHERE name = 'small'),
  jsonb_build_object('amount', 29.83, 'max', 1),
  'below R$ 100 the difference is paid at once'
);
SELECT is(
  (SELECT jsonb_build_object('amount', result->'amount', 'status', result->'payment_status', 'type', result->'change_type')
   FROM plan_change_results WHERE name = 'lateral'),
  jsonb_build_object('amount', 0, 'status', 'not_required', 'type', 'lateral'),
  'a lateral change has no charge'
);

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000014',
    '2026-11-01', NULL, NULL)$$),
  'Downgrade só vale na renovação',
  'a downgrade is refused mid-cycle'
);
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000015',
    '2026-11-01', '40000000-0000-4000-a000-000000000022', NULL)$$),
  'No meio do ciclo, a mudança precisa ser para um plano do mesmo ciclo',
  'a plan of another cycle is refused'
);
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2026-11-01', NULL, NULL)$$),
  'O treinador atual não atende a modalidade do novo plano; escolha outro treinador',
  'a coach who does not serve the new modality must be replaced'
);
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2027-03-01', '40000000-0000-4000-a000-000000000022', NULL)$$),
  'A data efetiva precisa estar dentro do contrato, de 01/09/2026 a 28/02/2027',
  'the effective date must be inside the contract'
);
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000106', '40000000-0000-4000-a000-000000000013',
    current_date, '40000000-0000-4000-a000-000000000022', NULL)$$),
  'Mudança de plano só em contrato pago. Contrato sem pagamento usa "Ajustar plano"',
  'an unpaid contract uses the existing plan adjustment'
);
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000108', '40000000-0000-4000-a000-000000000013',
    current_date, NULL, NULL)$$),
  'O contrato não tem o preço da venda registrado; corrija o contrato antes da mudança',
  'a contract without the sale price cannot change plan (refund and ledger read it)'
);
RESET ROLE;

-- Criar com data já vencida: aplica na hora ----------------------------------------

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k2_create', public.create_assessment_plan_change(
  '40000000-0000-4000-a000-000000000102', '40000000-0000-4000-a000-000000000013',
  current_date - 5, '40000000-0000-4000-a000-000000000022', 'Aluno quer triathlon',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000102'),
  '40000000-0000-4000-a000-000000000099'
));
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', status, 'payment_status', payment_status, 'amount', amount,
     'remaining', remaining_days, 'cycle', cycle_days, 'max', max_installments)
   FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('status', 'applied', 'payment_status', 'awaiting_charge', 'amount', 516.67,
    'remaining', 155, 'cycle', 180, 'max', 6),
  'a change dated in the past is applied at once and waits for its charge'
);
SELECT is(
  (SELECT jsonb_build_object('plan', plan_id, 'coach', coach_id,
     'sale_price', plan_snapshot->>'price_total')
   FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('plan', '40000000-0000-4000-a000-000000000013',
    'coach', '40000000-0000-4000-a000-000000000022', 'sale_price', '1200'),
  'the contract moves to the new plan and coach while the original sale stays'
);
SELECT is(
  (SELECT jsonb_agg(jsonb_build_object('plan', plan_id, 'from', valid_from, 'type', change_type) ORDER BY valid_from)
   FROM public.assessment_contract_plan_history WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_array(
    jsonb_build_object('plan', '40000000-0000-4000-a000-000000000011', 'from', current_date - 30, 'type', 'original'),
    jsonb_build_object('plan', '40000000-0000-4000-a000-000000000013', 'from', current_date - 5, 'type', 'upgrade')
  ),
  'the plan history gains the new segment at the effective date'
);
SELECT is(
  (SELECT jsonb_agg(jsonb_build_object('coach', coach_id, 'from', started_at, 'by_change', plan_change_id IS NOT NULL)
                    ORDER BY created_at)
   FROM public.assessment_contract_coach_history WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_array(
    jsonb_build_object('coach', '40000000-0000-4000-a000-000000000021', 'from', current_date - 30, 'by_change', false),
    jsonb_build_object('coach', '40000000-0000-4000-a000-000000000022', 'from', current_date - 5, 'by_change', true)
  ),
  'the coach history records the new coach from the effective date, not from today'
);
SELECT is(
  (SELECT array_agg(event_type ORDER BY created_at, event_type)
   FROM public.assessment_contract_event
   WHERE contract_id = '40000000-0000-4000-a000-000000000102'
     AND event_type LIKE 'plan_change%'),
  ARRAY['plan_change_applied', 'plan_change_created'],
  'creation and application are in the contract timeline'
);

-- Travas ------------------------------------------------------------------------------

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000102', '40000000-0000-4000-a000-000000000011',
    current_date + 10, NULL, NULL)$$),
  'Há uma mudança de plano com cobrança em aberto; registre o pagamento ou cancele a mudança antes',
  'a second change waits for the open charge'
);
RESET ROLE;

-- Cobrança externa (e reabrir) ------------------------------------------------------------

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(format($$SELECT public.save_assessment_plan_change_external_charge(
    %L, 'https://pagamento.example.test/upgrade', current_date + 3, 'card_7x', NULL, %L,
    '40000000-0000-4000-a000-000000000099')$$,
    (SELECT id FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
    (SELECT updated_at FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'))),
  'Parcelamento acima do permitido para este valor: até 6x, com parcela mínima de R$ 50',
  'the external charge respects the 6x / R$ 50 rule'
);
INSERT INTO plan_change_results
SELECT 'k2_charge', public.save_assessment_plan_change_external_charge(
  change.id, 'https://pagamento.example.test/upgrade', current_date + 3, 'card_6x', 'UP-1',
  change.updated_at, '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';
INSERT INTO plan_change_results
SELECT 'k2_reopen', public.save_assessment_plan_change_external_charge(
  change.id, 'https://pagamento.example.test/upgrade-2', current_date + 10, 'pix', 'UP-2',
  change.updated_at, '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', payment_status, 'method', charge_payment_method,
     'due', due_date, 'link', external_payment_link)
   FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('status', 'charge_sent', 'method', 'pix', 'due', current_date + 10,
    'link', 'https://pagamento.example.test/upgrade-2'),
  'reopening the charge keeps the change and takes the new due date and method'
);
SELECT is(
  (SELECT array_agg(event_type ORDER BY created_at, event_type)
   FROM public.assessment_contract_event
   WHERE contract_id = '40000000-0000-4000-a000-000000000102'
     AND event_type LIKE 'plan_change_charge%'),
  ARRAY['plan_change_charge_registered', 'plan_change_charge_updated'],
  'each charge registration is in the timeline'
);

-- Pagamento manual, extrato e desfazer ---------------------------------------------------

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(format($$SELECT public.api_record_plan_change_manual_payment(
    %L, (SELECT id FROM public.payment_methods WHERE internal_code = 'pix_manual'),
    current_date, 500, '[{"number":1,"due_date":"2026-10-01","credit_date":"2026-10-01","value":500}]'::jsonb,
    '40000000-0000-4000-a000-000000000099')$$,
    (SELECT id FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'))),
  'Informe o valor integral da diferença',
  'the payment must cover the whole difference'
);
SELECT is(
  pg_temp.error_of(format($$SELECT public.api_record_plan_change_manual_payment(
    %L, (SELECT id FROM public.payment_methods WHERE internal_code = 'card_7x'),
    current_date, 516.67, '[]'::jsonb, '40000000-0000-4000-a000-000000000099')$$,
    (SELECT id FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'))),
  'Parcelamento acima do permitido para este valor: até 6x, com parcela mínima de R$ 50',
  'the manual payment respects the 6x / R$ 50 rule'
);
INSERT INTO plan_change_results
SELECT 'k2_payment', public.api_record_plan_change_manual_payment(
  change.id,
  (SELECT id FROM public.payment_methods WHERE internal_code = 'card_6x'),
  current_date,
  516.67,
  (SELECT jsonb_agg(jsonb_build_object(
     'number', n, 'due_date', current_date + n * 30, 'credit_date', current_date + n * 30,
     'value', CASE WHEN n < 6 THEN 86.11 ELSE 86.12 END) ORDER BY n)
   FROM generate_series(1, 6) AS n),
  '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', payment_status, 'method', paid_payment_method, 'manual', manual_payment)
   FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('status', 'paid', 'method', 'card_6x', 'manual', true),
  'the difference is registered as paid'
);
SELECT is(
  (SELECT jsonb_build_object('rows', count(*), 'total', sum(value))
   FROM public.asaas_payments payment
   JOIN public.assessment_contract_plan_changes change ON change.id = payment.order_id
   WHERE payment.order_type = 'plan_change'
     AND change.contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('rows', 6, 'total', 516.67),
  'the upgrade payment is recorded apart from the contract installments'
);
SELECT is(
  (SELECT jsonb_build_object('rows', count(*), 'unit', min(business_unit), 'total', sum(gross_amount))
   FROM public.financial_movements movement
   JOIN public.assessment_contract_plan_changes change ON change.id = movement.order_id
   WHERE movement.order_type = 'plan_change'
     AND change.contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('rows', 6, 'unit', 'assessoria', 'total', 516.67),
  'the financial ledger shows the upgrade receipts as assessoria'
);
SELECT is(
  (SELECT jsonb_build_object(
     'sale', max(movement.revenue_center_id::text) FILTER (WHERE movement.order_type = 'contract'),
     'upgrade', max(movement.revenue_center_id::text) FILTER (WHERE movement.order_type = 'plan_change'))
   FROM public.financial_movements movement
   WHERE movement.order_id = '40000000-0000-4000-a000-000000000102'
      OR movement.order_id IN (SELECT id FROM public.assessment_contract_plan_changes
                               WHERE contract_id = '40000000-0000-4000-a000-000000000102')),
  jsonb_build_object('sale', '40000000-0000-4000-a000-000000000041',
    'upgrade', '40000000-0000-4000-a000-000000000042'),
  'the original sale stays in the sold plan revenue center; the upgrade goes to the new plan center'
);
SELECT is(
  pg_temp.error_of($$UPDATE public.assessment_contracts SET payment_status = 'pending'
    WHERE id = '40000000-0000-4000-a000-000000000102'$$),
  'O contrato tem mudança de plano; desfaça o pagamento da diferença e cancele a mudança antes de reabrir o pagamento do contrato',
  'the contract payment cannot reopen while it has a plan change'
);

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results
SELECT 'k2_undo', public.api_reopen_plan_change_manual_payment(
  change.id, '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', payment_status, 'method', paid_payment_method,
     'rows', (SELECT count(*) FROM public.asaas_payments p WHERE p.order_id = change.id))
   FROM public.assessment_contract_plan_changes change
   WHERE change.contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('status', 'charge_sent', 'method', NULL, 'rows', 0),
  'undoing the payment reopens the charge and removes the receipts'
);

-- Editar (não pago) ---------------------------------------------------------------------

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(format($$SELECT public.update_assessment_plan_change(
    %L, '40000000-0000-4000-a000-000000000013', current_date + 5, NULL, '  ', %L,
    '40000000-0000-4000-a000-000000000099')$$,
    (SELECT id FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
    (SELECT updated_at FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'))),
  'Informe o motivo da correção',
  'every correction needs a reason'
);
INSERT INTO plan_change_results
SELECT 'k2_edit', public.update_assessment_plan_change(
  change.id, '40000000-0000-4000-a000-000000000013', current_date + 5, NULL,
  'Aluno pediu para começar semana que vem', change.updated_at,
  '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', status, 'payment_status', payment_status, 'amount', amount,
     'link', external_payment_link, 'coach', to_coach_id)
   FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('status', 'scheduled', 'payment_status', 'awaiting_charge', 'amount', 483.33,
    'link', NULL, 'coach', '40000000-0000-4000-a000-000000000022'),
  'editing the date recalculates the difference and replaces the unpaid charge'
);
SELECT is(
  (SELECT jsonb_build_object('plan', plan_id, 'coach', coach_id)
   FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('plan', '40000000-0000-4000-a000-000000000011',
    'coach', '40000000-0000-4000-a000-000000000021'),
  'moving the date to the future puts the contract back on the current plan until then'
);
SELECT is(
  (SELECT valid_from FROM public.assessment_contract_plan_history
   WHERE contract_id = '40000000-0000-4000-a000-000000000102' AND change_type = 'upgrade'),
  current_date + 5,
  'the plan segment follows the edited date'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_coach_history
   WHERE contract_id = '40000000-0000-4000-a000-000000000102' AND plan_change_id IS NOT NULL
     AND started_at = current_date + 5),
  1,
  'the coach segment is moved in place'
);

-- Cancelar (não pago) --------------------------------------------------------------------

INSERT INTO public.payout_monthly_closings (id, competence, status)
VALUES ('40000000-0000-4000-a000-000000000201', date_trunc('month', current_date + 400)::date, 'pending_approval');
INSERT INTO public.payout_pending_repasse (
  contract_id, coach_id, source_type, reference_competence, amount, status,
  detected_in_closing_id, plan_change_id
)
SELECT '40000000-0000-4000-a000-000000000102', '40000000-0000-4000-a000-000000000022',
  'athlete_repasse', date_trunc('month', current_date + 400)::date, 12.34, 'open',
  '40000000-0000-4000-a000-000000000201', change.id
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results
SELECT 'k2_cancel', public.cancel_assessment_plan_change(
  change.id, 'Aluno desistiu', change.updated_at, '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000102';
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', status, 'payment_status', payment_status, 'reason', cancellation_reason)
   FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  jsonb_build_object('status', 'cancelled', 'payment_status', 'cancelled', 'reason', 'Aluno desistiu'),
  'an unpaid change can be cancelled with a reason'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_plan_history
   WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  1,
  'cancelling removes the plan segment'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_coach_history
   WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  1,
  'cancelling removes the coach segment when no approved closing covers it'
);
SELECT is(
  (SELECT status FROM public.payout_pending_repasse
   WHERE contract_id = '40000000-0000-4000-a000-000000000102'),
  'cancelled',
  'the pending payout difference is discarded'
);

-- Agendada: aplicação e trava de treinador -----------------------------------------------

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k3_create', public.create_assessment_plan_change(
  '40000000-0000-4000-a000-000000000103', '40000000-0000-4000-a000-000000000013',
  current_date + 20, NULL, NULL,
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000103'),
  '40000000-0000-4000-a000-000000000099'
));
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', change.status, 'amount', change.amount, 'contract_plan', contract.plan_id)
   FROM public.assessment_contract_plan_changes change
   JOIN public.assessment_contracts contract ON contract.id = change.contract_id
   WHERE change.contract_id = '40000000-0000-4000-a000-000000000103'),
  jsonb_build_object('status', 'scheduled', 'amount', 433.33,
    'contract_plan', '40000000-0000-4000-a000-000000000011'),
  'a future change is scheduled and the contract keeps its plan until the date'
);
SELECT is(
  pg_temp.error_of($$UPDATE public.assessment_contracts
    SET coach_id = '40000000-0000-4000-a000-000000000021'
    WHERE id = '40000000-0000-4000-a000-000000000103'$$),
  format('Há uma mudança de plano agendada para %s; edite ou cancele a mudança para trocar o treinador',
    to_char(current_date + 20, 'DD/MM/YYYY')),
  'a manual coach change waits for the scheduled plan change'
);
SELECT is(
  pg_temp.error_of($$UPDATE public.assessment_contracts
    SET end_date = current_date + 15
    WHERE id = '40000000-0000-4000-a000-000000000103'$$),
  format('A mudança de plano de %s ficaria fora do contrato; ajuste ou cancele a mudança antes',
    to_char(current_date + 20, 'DD/MM/YYYY')),
  'contract dates cannot leave a plan change outside'
);

-- Renovação criada com mudança agendada: sai no plano novo, preço cheio.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id
)
SELECT
  '40000000-0000-4000-a000-000000000113', 'ASS-940013', parent.customer_id, parent.coach_id,
  parent.plan_id, parent.plan_snapshot || '{"snapshot_source":"renewal_parent_snapshot"}'::jsonb,
  'draft', parent.end_date, parent.end_date + 180, parent.end_date + 180, parent.end_date, 1,
  'pix', 'pending', false, false, parent.id
FROM public.assessment_contracts parent
WHERE parent.id = '40000000-0000-4000-a000-000000000103';

SELECT is(
  (SELECT jsonb_build_object('plan', plan_id, 'snapshot_plan', plan_snapshot->>'plan_id',
     'price', plan_snapshot->>'price_total', 'source', plan_snapshot->>'snapshot_source')
   FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000113'),
  jsonb_build_object('plan', '40000000-0000-4000-a000-000000000013',
    'snapshot_plan', '40000000-0000-4000-a000-000000000013', 'price', '1800',
    'source', 'renewal_after_plan_change'),
  'the renewal follows the plan in effect at the end, at full table price'
);

-- Força a data para o passado e aplica pelas transições.
UPDATE public.assessment_contract_plan_history
SET valid_from = current_date - 1
WHERE contract_id = '40000000-0000-4000-a000-000000000103' AND change_type <> 'original';
UPDATE public.assessment_contract_plan_changes
SET effective_date = current_date - 1
WHERE contract_id = '40000000-0000-4000-a000-000000000103';

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k3_apply', public.apply_due_assessment_plan_changes(
  '40000000-0000-4000-a000-000000000099'));
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', change.status, 'contract_plan', contract.plan_id, 'contract_coach', contract.coach_id)
   FROM public.assessment_contract_plan_changes change
   JOIN public.assessment_contracts contract ON contract.id = change.contract_id
   WHERE change.contract_id = '40000000-0000-4000-a000-000000000103'),
  jsonb_build_object('status', 'applied', 'contract_plan', '40000000-0000-4000-a000-000000000013',
    'contract_coach', '40000000-0000-4000-a000-000000000022'),
  'the daily transitions apply a change whose date arrived'
);
SELECT ok(
  (SELECT result->'changed' @> jsonb_build_array(jsonb_build_object('id', '40000000-0000-4000-a000-000000000103'))
   FROM plan_change_results WHERE name = 'k3_apply'),
  'the transitions report the applied contract'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_coach_history
   WHERE contract_id = '40000000-0000-4000-a000-000000000103'),
  1,
  'keeping the same coach adds no coach segment'
);

-- Cancelamento do contrato com mudança paga: estorno inclui a parte não usada ----------------

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k4_create', public.create_assessment_plan_change(
  '40000000-0000-4000-a000-000000000104', '40000000-0000-4000-a000-000000000013',
  current_date - 10, NULL, NULL,
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000104'),
  '40000000-0000-4000-a000-000000000099'
));
INSERT INTO plan_change_results
SELECT 'k4_payment', public.api_record_plan_change_manual_payment(
  change.id, (SELECT id FROM public.payment_methods WHERE internal_code = 'pix_manual'),
  current_date, change.amount,
  jsonb_build_array(jsonb_build_object('number', 1, 'due_date', current_date,
    'credit_date', current_date, 'value', change.amount)),
  '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000104';
INSERT INTO plan_change_results VALUES ('k4_cancel_contract', public.cancel_assessment_contract(
  '40000000-0000-4000-a000-000000000104', current_date, 20, 'Mudou de cidade',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000104'),
  '40000000-0000-4000-a000-000000000099'
));
RESET ROLE;

SELECT is(
  (SELECT amount FROM public.assessment_contract_plan_changes
   WHERE contract_id = '40000000-0000-4000-a000-000000000104'),
  533.33::numeric(12,2),
  'the paid upgrade of 160 days is R$ 533,33'
);
SELECT is(
  (SELECT jsonb_build_object('fee', cancellation_fee, 'refund', refund_amount)
   FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000104'),
  jsonb_build_object(
    'fee', round(round(1200::numeric * 151 / 181 + 533.33::numeric * 151 / 161, 2) * 20 / 100, 2),
    'refund', round(1200::numeric * 151 / 181 + 533.33::numeric * 151 / 161, 2)
      - round(round(1200::numeric * 151 / 181 + 533.33::numeric * 151 / 161, 2) * 20 / 100, 2)
  ),
  'the refund and the fee include the unused part of the paid upgrade'
);
SELECT is(
  (SELECT (result->'upgrade_unused_value')::numeric FROM plan_change_results WHERE name = 'k4_cancel_contract'),
  round(533.33::numeric * 151 / 161, 2),
  'the cancellation reports the unused upgrade value'
);
SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(format($$SELECT public.api_reopen_plan_change_manual_payment(
    %L, '40000000-0000-4000-a000-000000000099')$$,
    (SELECT id FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000104'))),
  'O contrato foi cancelado e o estorno já contou este upgrade; o pagamento da diferença não pode ser desfeito',
  'the upgrade payment stays once the contract refund counted it'
);
RESET ROLE;

-- Cancelamento do contrato com mudança não paga: a mudança é cancelada ---------------------

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k7_create', public.create_assessment_plan_change(
  '40000000-0000-4000-a000-000000000107', '40000000-0000-4000-a000-000000000013',
  current_date - 5, '40000000-0000-4000-a000-000000000022', NULL,
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000107'),
  '40000000-0000-4000-a000-000000000099'
));
RESET ROLE;

-- Renovação de contrato com mudança aplicada: plano e treinador do fim do contrato.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id
)
SELECT
  '40000000-0000-4000-a000-000000000117', 'ASS-940017', parent.customer_id, parent.coach_id,
  parent.plan_id, parent.plan_snapshot,
  'draft', parent.end_date, parent.end_date + 180, parent.end_date + 180, parent.end_date, 1,
  'pix', 'pending', false, false, parent.id
FROM public.assessment_contracts parent
WHERE parent.id = '40000000-0000-4000-a000-000000000107';

SELECT is(
  (SELECT jsonb_build_object('plan', plan_id, 'coach', coach_id, 'price', plan_snapshot->>'price_total')
   FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000117'),
  jsonb_build_object('plan', '40000000-0000-4000-a000-000000000013',
    'coach', '40000000-0000-4000-a000-000000000022', 'price', '1800'),
  'an automatic-style renewal copying the original sale is moved to the new plan'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_plan_history
   WHERE contract_id = '40000000-0000-4000-a000-000000000117'),
  1,
  'the renewal starts its own plan history'
);

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000107', '40000000-0000-4000-a000-000000000012',
    current_date + 10, NULL, NULL)$$),
  'O contrato já tem renovação criada; a mudança de plano entra na renovação',
  'a renewal draft blocks new changes'
);
RESET ROLE;

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k7_cancel_contract', public.cancel_assessment_contract(
  '40000000-0000-4000-a000-000000000107', current_date, 0, 'Encerrou',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000107'),
  '40000000-0000-4000-a000-000000000099'
));
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', status, 'reason', cancellation_reason)
   FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000107'),
  jsonb_build_object('status', 'cancelled', 'reason', 'Contrato cancelado'),
  'an unpaid change is cancelled with the contract'
);
SELECT is(
  (SELECT refund_amount FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000107'),
  round(1200::numeric * 151 / 181, 2),
  'an unpaid upgrade adds nothing to the refund'
);

-- Fechamento aprovado cobre dias do treinador novo: o cancelamento preserva esses dias --------

SET LOCAL ROLE service_role;
INSERT INTO plan_change_results VALUES ('k5_create', public.create_assessment_plan_change(
  '40000000-0000-4000-a000-000000000105', '40000000-0000-4000-a000-000000000013',
  current_date - 5, '40000000-0000-4000-a000-000000000022', NULL,
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000105'),
  '40000000-0000-4000-a000-000000000099'
));
RESET ROLE;

INSERT INTO public.payout_monthly_closings (id, competence, status)
VALUES ('40000000-0000-4000-a000-000000000202', date_trunc('month', current_date - 5)::date, 'approved');

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(format($$SELECT public.update_assessment_plan_change(
    %L, '40000000-0000-4000-a000-000000000013', current_date + 40, NULL, 'Outra data', %L,
    '40000000-0000-4000-a000-000000000099')$$,
    (SELECT id FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000105'),
    (SELECT updated_at FROM public.assessment_contract_plan_changes WHERE contract_id = '40000000-0000-4000-a000-000000000105'))),
  'A mudança já tem dias em fechamento de repasse aprovado e não pode ser editada',
  'a change with approved days cannot be edited'
);
INSERT INTO plan_change_results
SELECT 'k5_cancel', public.cancel_assessment_plan_change(
  change.id, 'Não pagou', change.updated_at, '40000000-0000-4000-a000-000000000099')
FROM public.assessment_contract_plan_changes change
WHERE change.contract_id = '40000000-0000-4000-a000-000000000105';
RESET ROLE;

SELECT is(
  (SELECT jsonb_agg(jsonb_build_object('coach', coach_id, 'from', started_at) ORDER BY created_at)
   FROM public.assessment_contract_coach_history WHERE contract_id = '40000000-0000-4000-a000-000000000105'),
  jsonb_build_array(
    jsonb_build_object('coach', '40000000-0000-4000-a000-000000000021', 'from', current_date - 30),
    jsonb_build_object('coach', '40000000-0000-4000-a000-000000000022', 'from', current_date - 5),
    jsonb_build_object('coach', '40000000-0000-4000-a000-000000000021',
      'from', (date_trunc('month', current_date - 5) + interval '1 month')::date)
  ),
  'the new coach keeps the approved days and the previous coach returns from the first open day'
);
SELECT is(
  (SELECT coach_id FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000105'),
  CASE WHEN current_date >= (date_trunc('month', current_date - 5) + interval '1 month')::date
    THEN '40000000-0000-4000-a000-000000000021'::uuid
    ELSE '40000000-0000-4000-a000-000000000022'::uuid
  END,
  'the contract coach follows the coach history for today'
);
SELECT is(
  (SELECT plan_id FROM public.assessment_contracts WHERE id = '40000000-0000-4000-a000-000000000105'),
  '40000000-0000-4000-a000-000000000011'::uuid,
  'the contract is back on the previous plan'
);

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000105', '40000000-0000-4000-a000-000000000013',
    current_date - 5, '40000000-0000-4000-a000-000000000022', NULL)$$),
  format('A data efetiva cai num mês com fechamento de repasse aprovado; escolha a partir de %s',
    to_char((date_trunc('month', current_date - 5) + interval '1 month')::date, 'DD/MM/YYYY')),
  'a new change cannot start inside an approved closing'
);
RESET ROLE;

-- Licenças -----------------------------------------------------------------------------

INSERT INTO public.assessment_leaves (contract_id, start_date, end_date, days, reason, status)
VALUES ('40000000-0000-4000-a000-000000000101', '2026-12-01', '2026-12-20', 20, 'Viagem', 'finished');

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2026-12-10', '40000000-0000-4000-a000-000000000022', NULL)$$),
  'A data efetiva cai dentro de uma licença; escolha um dia depois do retorno',
  'the effective date never falls inside a leave'
);
RESET ROLE;

INSERT INTO public.assessment_leaves (contract_id, start_date, end_date, days, reason, status)
VALUES ('40000000-0000-4000-a000-000000000101', '2027-01-10', NULL, NULL, 'Lesão', 'active');

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of($$SELECT public.preview_assessment_plan_change(
    '40000000-0000-4000-a000-000000000101', '40000000-0000-4000-a000-000000000013',
    '2026-11-01', '40000000-0000-4000-a000-000000000022', NULL)$$),
  'Aluno em licença sem data de volta; registre o retorno antes da mudança',
  'a leave without return date blocks the change'
);
RESET ROLE;

-- Invariantes -------------------------------------------------------------------------

SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contracts AS contract
   WHERE (SELECT count(*) FROM public.assessment_contract_plan_history AS history
          WHERE history.contract_id = contract.id AND history.change_type = 'original') <> 1),
  0,
  'every contract still has exactly one original plan row'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_plan_changes AS change
   WHERE change.status <> 'cancelled'
     AND NOT EXISTS (SELECT 1 FROM public.assessment_contract_plan_history AS history
                     WHERE history.plan_change_id = change.id)),
  0,
  'every active change has its plan segment'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_plan_changes AS change
   WHERE change.status = 'cancelled'
     AND EXISTS (SELECT 1 FROM public.assessment_contract_plan_history AS history
                 WHERE history.plan_change_id = change.id)),
  0,
  'no cancelled change keeps a plan segment'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contract_plan_changes (
      contract_id, change_type, effective_date, from_plan_id, to_plan_id, to_plan_snapshot,
      from_coach_id, to_coach_id, from_price, to_price, cycle_days, remaining_days, amount,
      max_installments, payment_status)
    VALUES ('40000000-0000-4000-a000-000000000101', 'upgrade', '2026-10-01',
      '40000000-0000-4000-a000-000000000011', '40000000-0000-4000-a000-000000000013', '{}',
      '40000000-0000-4000-a000-000000000021', '40000000-0000-4000-a000-000000000022',
      1200, 1800, 181, 151, 0, 1, 'awaiting_charge')$$,
  '23514',
  NULL,
  'a change without amount cannot wait for a charge'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contract_plan_changes (
      contract_id, change_type, effective_date, from_plan_id, to_plan_id, to_plan_snapshot,
      from_coach_id, to_coach_id, from_price, to_price, cycle_days, remaining_days, amount,
      max_installments, payment_status)
    VALUES ('40000000-0000-4000-a000-000000000101', 'upgrade', '2026-10-01',
      '40000000-0000-4000-a000-000000000011', '40000000-0000-4000-a000-000000000013', '{}',
      '40000000-0000-4000-a000-000000000021', '40000000-0000-4000-a000-000000000022',
      1200, 1800, 181, 151, 500, 7, 'awaiting_charge')$$,
  '23514',
  NULL,
  'a change allows at most 6 installments'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.asaas_payments
    WHERE order_type = 'contract'
      AND order_id IN ('40000000-0000-4000-a000-000000000102', '40000000-0000-4000-a000-000000000104')
      AND description LIKE 'Mudança de plano%'
  ),
  'upgrade receipts never land on the contract installments'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_event
   WHERE contract_id IN ('40000000-0000-4000-a000-000000000102', '40000000-0000-4000-a000-000000000105')
     AND event_type IN ('plan_change_updated', 'plan_change_cancelled')
     AND nullif(btrim(notes), '') IS NOT NULL),
  3,
  'each correction records its reason in the timeline'
);

SELECT * FROM finish();
ROLLBACK;
