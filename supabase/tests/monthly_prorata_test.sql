BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(22);

-- Fixtures fictícias: plano mensal de R$ 210 e trimestral, contratos em
-- rascunho para o pro rata e um contrato ativo com pro rata para a renovação.
INSERT INTO auth.users (id, email) VALUES ('95000000-0000-4000-a000-0000000000ff', 'prorata-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('95000000-0000-4000-a000-000000000010', 'prorata-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES
  ('95000000-0000-4000-a000-000000000011', '95000000-0000-4000-a000-000000000010',
   'Plano mensal pro rata teste', 'mensal', 1, 210, 210, 1, 0),
  ('95000000-0000-4000-a000-000000000013', '95000000-0000-4000-a000-000000000010',
   'Plano trimestral pro rata teste', 'trimestral', 3, 200, 600, 3, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('95000000-0000-4000-a000-000000000012', 'Coach Pro Rata Teste', 'prorata-teste@example.test', 'senior',
        ARRAY['95000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf) VALUES
  ('95000000-0000-4000-a000-000000000021', 'Pessoa Pro Rata Um', '11900009501', '52998224725'),
  ('95000000-0000-4000-a000-000000000022', 'Pessoa Pro Rata Dois', '11900009502', '11144477735');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, manual_payment, payment_date, auto_renewal, renewal_generated, parent_contract_id
) VALUES
  -- A: mensal em rascunho, de 28/10 a 28/11.
  ('95000000-0000-4000-a000-000000000101', 'ASS-995101', '95000000-0000-4000-a000-000000000021',
   '95000000-0000-4000-a000-000000000012', '95000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal pro rata teste","period":"mensal","period_months":1,"price_total":210}'::jsonb,
   'draft', '2030-10-28', '2030-11-28', '2030-11-28', '2030-10-28', 1, 'pix', 'charge_sent', false, NULL, false, false, NULL),
  -- B: trimestral.
  ('95000000-0000-4000-a000-000000000102', 'ASS-995102', '95000000-0000-4000-a000-000000000021',
   '95000000-0000-4000-a000-000000000012', '95000000-0000-4000-a000-000000000013',
   '{"name":"Plano trimestral pro rata teste","period":"trimestral","period_months":3,"price_total":600}'::jsonb,
   'draft', '2030-10-28', '2031-01-28', '2031-01-28', '2030-10-28', 1, 'pix', 'pending', false, NULL, false, false, NULL),
  -- C: mensal já pago.
  ('95000000-0000-4000-a000-000000000103', 'ASS-995103', '95000000-0000-4000-a000-000000000022',
   '95000000-0000-4000-a000-000000000012', '95000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal pro rata teste","period":"mensal","period_months":1,"price_total":210}'::jsonb,
   'scheduled', '2030-10-28', '2030-11-28', '2030-11-28', '2030-10-28', 1, 'pix', 'paid', true, '2030-10-20', false, false, NULL),
  -- D: ativo com pro rata, termina amanhã (a renovação sai pelo processamento).
  ('95000000-0000-4000-a000-000000000104', 'ASS-995104', '95000000-0000-4000-a000-000000000022',
   '95000000-0000-4000-a000-000000000012', '95000000-0000-4000-a000-000000000011',
   jsonb_build_object('name', 'Plano mensal pro rata teste', 'period', 'mensal', 'period_months', 1,
     'price_total', 63, 'prorata', jsonb_build_object('cycle_day', extract(day FROM current_date + 1)::int,
       'days', 9, 'full_price_total', 210)),
   'active', current_date - 8, current_date + 1, current_date + 1, current_date - 8, 1, 'pix', 'paid', true, current_date - 8, false, false, NULL);

CREATE TEMP TABLE prorata_version ON COMMIT DROP AS
SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101';

-- Dia 7: de 28/10 a 07/11 são 10 dias = 210 ÷ 30 × 10 = 70.
SELECT lives_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', 7,
      (SELECT updated_at FROM prorata_version), '95000000-0000-4000-a000-0000000000ff')$$,
  'the pro rata is applied up to the cycle day'
);
SELECT results_eq(
  $$SELECT end_date, original_end_date, (plan_snapshot->>'price_total')::numeric,
           (plan_snapshot->'prorata'->>'days')::int, (plan_snapshot->'prorata'->>'full_price_total')::numeric,
           (plan_snapshot->'prorata'->>'cycle_day')::int
    FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'$$,
  $$VALUES ('2030-11-07'::date, '2030-11-07'::date, 70.00::numeric, 10, 210::numeric, 7)$$,
  'the first period ends on the cycle day with the proportional value'
);
SELECT results_eq(
  $$SELECT notes, created_by FROM public.assessment_contract_event
    WHERE contract_id = '95000000-0000-4000-a000-000000000101' AND event_type = 'prorata_applied'$$,
  $$VALUES ('Pro rata até 07/11/2030: 10 dias, R$ 70,00 (mensal R$ 210,00)'::text, '95000000-0000-4000-a000-0000000000ff'::uuid)$$,
  'the pro rata is in the contract history'
);
SELECT is(
  (SELECT plan_snapshot->>'price_total' FROM public.assessment_contract_plan_history
   WHERE contract_id = '95000000-0000-4000-a000-000000000101' AND change_type = 'original'),
  '70.00',
  'the plan history follows the contract'
);

-- Trocar o dia recalcula a partir do valor cheio.
SELECT lives_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', 15,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'), NULL)$$,
  'another cycle day can be chosen'
);
SELECT results_eq(
  $$SELECT end_date, (plan_snapshot->>'price_total')::numeric, (plan_snapshot->'prorata'->>'full_price_total')::numeric
    FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'$$,
  $$VALUES ('2030-11-15'::date, 126.00::numeric, 210::numeric)$$,
  'the new day is computed from the full monthly value'
);
SELECT lives_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', 1,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'), NULL)$$,
  'the first day of the next month works'
);
SELECT results_eq(
  $$SELECT end_date, (plan_snapshot->>'price_total')::numeric
    FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'$$,
  $$VALUES ('2030-11-01'::date, 28.00::numeric)$$,
  'four days cost four thirtieths'
);

-- Desfazer volta ao mês cheio.
SELECT lives_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', NULL,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'), NULL)$$,
  'the pro rata can be removed'
);
SELECT results_eq(
  $$SELECT end_date, (plan_snapshot->>'price_total')::numeric, plan_snapshot ? 'prorata'
    FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'$$,
  $$VALUES ('2030-11-28'::date, 210::numeric, false)$$,
  'removing restores the full month'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_event
   WHERE contract_id = '95000000-0000-4000-a000-000000000101' AND event_type = 'prorata_removed'),
  1,
  'the removal is in the contract history'
);

-- Recusas.
SELECT throws_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', 28,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'), NULL)$$,
  'P0001', 'O contrato já começa no dia do ciclo; não há pro rata',
  'the start day itself is not a pro rata'
);
SELECT throws_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', 29,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000101'), NULL)$$,
  '22023', 'O dia do ciclo vai de 1 a 28',
  'cycle days that some months lack are refused'
);
SELECT throws_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000101', 7,
      '2000-01-01T00:00:00Z', NULL)$$,
  'P0001', NULL,
  'a stale version is refused'
);
SELECT throws_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000102', 7,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000102'), NULL)$$,
  'P0001', 'O pro rata vale só para plano mensal',
  'a quarterly plan is refused'
);
SELECT throws_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000103', 7,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000103'), NULL)$$,
  'P0001', 'O pro rata só pode ser ajustado antes do pagamento do contrato',
  'a paid contract is refused'
);

-- A renovação de um contrato com pro rata nasce cheia, do dia do ciclo ao dia do ciclo.
SELECT lives_ok(
  $$SELECT public.process_internal_assessment_renewals(10, 5, ARRAY['95000000-0000-4000-a000-000000000104'::uuid])$$,
  'the renewal job runs for the pro rata contract'
);
SELECT results_eq(
  $$SELECT start_date, end_date, (plan_snapshot->>'price_total')::numeric, plan_snapshot ? 'prorata'
    FROM public.assessment_contracts WHERE parent_contract_id = '95000000-0000-4000-a000-000000000104'$$,
  $$VALUES (current_date + 1, (current_date + 1 + interval '1 month')::date, 210::numeric, false)$$,
  'the renewal is a full month at the full value'
);
SELECT throws_ok(
  $$SELECT public.apply_assessment_contract_prorata('95000000-0000-4000-a000-000000000104', NULL,
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '95000000-0000-4000-a000-000000000104'), NULL)$$,
  'P0001', NULL,
  'a contract with its renewal created cannot change'
);

-- Conferência de assinaturas: o valor esperado é o mensal cheio.
UPDATE public.assessment_contracts
SET plan_snapshot = plan_snapshot || '{"price_total":70,"prorata":{"cycle_day":7,"days":10,"full_price_total":210}}'::jsonb,
    status = 'scheduled', start_date = current_date + 1, end_date = current_date + 11, original_end_date = current_date + 11
WHERE id = '95000000-0000-4000-a000-000000000101';
SELECT is(
  (SELECT expected_value FROM public.list_assessment_auto_renewal_candidates(ARRAY['95000000-0000-4000-a000-000000000101'::uuid])),
  210::numeric,
  'the subscription check expects the full monthly value'
);

-- Só o backend chama.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.apply_assessment_contract_prorata(uuid,integer,timestamptz,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.apply_assessment_contract_prorata(uuid,integer,timestamptz,uuid)', 'EXECUTE'),
  'the pro rata is not exposed to the browser'
);
SELECT ok(
  has_function_privilege('service_role', 'public.apply_assessment_contract_prorata(uuid,integer,timestamptz,uuid)', 'EXECUTE'),
  'the backend can apply the pro rata'
);

SELECT * FROM finish();
ROLLBACK;
