BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(13);

-- "Não renovar" na renovação que já começou (plano mensal). Fixtures fictícias.
INSERT INTO public.assessment_modalities (id, name)
VALUES ('94000000-0000-4000-a000-000000000010', 'nao-renova-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '94000000-0000-4000-a000-000000000011', '94000000-0000-4000-a000-000000000010',
  'Plano mensal não renova teste', 'mensal', 1, 300, 300, 1, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('94000000-0000-4000-a000-000000000012', 'Coach Não Renova Teste', 'nao-renova-teste@example.test', 'senior',
        ARRAY['94000000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp, cpf) VALUES
  ('94000000-0000-4000-a000-000000000021', 'Pessoa Não Renova Um',   '11900009401', '52998224725'),
  ('94000000-0000-4000-a000-000000000022', 'Pessoa Não Renova Dois', '11900009402', '11144477735'),
  ('94000000-0000-4000-a000-000000000023', 'Pessoa Não Renova Três', '11900009403', '39053344705');

-- Contratos de origem e anteriores.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id
) VALUES
  -- P1: contrato anterior da renovação em andamento (já terminou).
  ('94000000-0000-4000-a000-000000000101', 'ASS-994101', '94000000-0000-4000-a000-000000000021',
   '94000000-0000-4000-a000-000000000012', '94000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal não renova teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'finished', current_date - 47, current_date - 17, current_date - 17, current_date - 47, 1,
   'pix', 'paid', true, true, NULL),
  -- P2: contrato anterior da renovação que ainda não começou.
  ('94000000-0000-4000-a000-000000000103', 'ASS-994103', '94000000-0000-4000-a000-000000000023',
   '94000000-0000-4000-a000-000000000012', '94000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal não renova teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'finished', current_date - 25, current_date + 5, current_date + 5, current_date - 25, 1,
   'pix', 'paid', true, true, NULL),
  -- O: contrato de origem (sem contrato anterior), automática desligada.
  ('94000000-0000-4000-a000-000000000104', 'ASS-994104', '94000000-0000-4000-a000-000000000022',
   '94000000-0000-4000-a000-000000000012', '94000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal não renova teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'active', current_date - 10, current_date + 20, current_date + 20, current_date - 10, 1,
   'pix', 'paid', false, false, NULL);

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated, parent_contract_id
) VALUES
  -- C1: renovação mensal em andamento, cobrança enviada e automática ligada.
  ('94000000-0000-4000-a000-000000000102', 'ASS-994102', '94000000-0000-4000-a000-000000000021',
   '94000000-0000-4000-a000-000000000012', '94000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal não renova teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'active', current_date - 17, current_date + 13, current_date + 13, current_date - 17, 1,
   'pix', 'charge_sent', true, false, '94000000-0000-4000-a000-000000000101'),
  -- S1: renovação agendada (vigência ainda não começou).
  ('94000000-0000-4000-a000-000000000105', 'ASS-994105', '94000000-0000-4000-a000-000000000023',
   '94000000-0000-4000-a000-000000000012', '94000000-0000-4000-a000-000000000011',
   '{"name":"Plano mensal não renova teste","period":"mensal","period_months":1,"price_total":300}'::jsonb,
   'scheduled', current_date + 5, current_date + 35, current_date + 35, current_date + 5, 1,
   'pix', 'charge_sent', false, false, '94000000-0000-4000-a000-000000000103');

SELECT is(
  (SELECT renewal_stage FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000102'),
  'waiting_payment',
  'fixture: the running renewal waits for payment'
);

-- Renovação que já começou, com a cobrança em aberto e a automática ligada.
SELECT lives_ok(
  $$SELECT public.mark_assessment_contract_non_renewal(
      '94000000-0000-4000-a000-000000000102',
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000102'),
      NULL)$$,
  'a started renewal with an open charge can be marked as non-renewal'
);
SELECT results_eq(
  $$SELECT status, cancellation_reason, cancellation_date = end_date, auto_renewal,
           renewal_generated, payment_status, renewal_stage
    FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000102'$$,
  $$VALUES ('active'::text, 'Não renovou'::text, true, false, true,
            'charge_sent'::text, 'waiting_payment'::text)$$,
  'it stays active to the end, turns the automatic renewal off and keeps this month charge and stage'
);
SELECT results_eq(
  $$SELECT payload->>'source', payload->>'enabled'
    FROM public.assessment_contract_event
    WHERE contract_id = '94000000-0000-4000-a000-000000000102' AND event_type = 'auto_renewal_changed'$$,
  $$VALUES ('non_renewal'::text, 'false'::text)$$,
  'turning the automatic renewal off is in the contract history'
);
SELECT results_eq(
  $$SELECT payload->>'status_after', payload->>'auto_renewal_disabled'
    FROM public.assessment_contract_event
    WHERE contract_id = '94000000-0000-4000-a000-000000000102' AND event_type = 'renewal_declined'$$,
  $$VALUES ('active'::text, 'true'::text)$$,
  'the non-renewal is in the contract history'
);
SELECT ok(
  (public.mark_assessment_contract_non_renewal(
     '94000000-0000-4000-a000-000000000102', NULL, NULL)->>'unchanged')::boolean,
  'registering it again changes nothing'
);

-- A próxima renovação não nasce, nem a manual nem a automática.
SELECT lives_ok(
  $$SELECT public.process_internal_assessment_renewals(15, 5, ARRAY['94000000-0000-4000-a000-000000000102'::uuid])$$,
  'the renewal job runs for the contract'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contracts
   WHERE parent_contract_id = '94000000-0000-4000-a000-000000000102'),
  0,
  'no renewal is created after the non-renewal'
);
SELECT is(
  (SELECT count(*)::int FROM public.list_assessment_auto_renewal_candidates(
     ARRAY['94000000-0000-4000-a000-000000000102'::uuid])),
  0,
  'a non-renewal is not offered "Ligar automática" in the subscription check'
);

-- Renovação que ainda não começou continua indo pela resolução da renovação.
SELECT throws_ok(
  $$SELECT public.mark_assessment_contract_non_renewal(
      '94000000-0000-4000-a000-000000000105',
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000105'),
      NULL)$$,
  'P0001', 'Use a resolução da renovação para esta venda',
  'a renewal that has not started still goes through the renewal resolution'
);

-- Contrato de origem segue funcionando; sem automática, não registra mudança nela.
SELECT lives_ok(
  $$SELECT public.mark_assessment_contract_non_renewal(
      '94000000-0000-4000-a000-000000000104',
      (SELECT updated_at FROM public.assessment_contracts WHERE id = '94000000-0000-4000-a000-000000000104'),
      NULL)$$,
  'a first contract can still be marked as non-renewal'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_event
   WHERE contract_id = '94000000-0000-4000-a000-000000000104' AND event_type = 'auto_renewal_changed'),
  0,
  'no automatic renewal change is logged when it was already off'
);
SELECT results_eq(
  $$SELECT payload->>'auto_renewal_disabled'
    FROM public.assessment_contract_event
    WHERE contract_id = '94000000-0000-4000-a000-000000000104' AND event_type = 'renewal_declined'$$,
  $$VALUES ('false'::text)$$,
  'the non-renewal of a first contract keeps the previous behavior'
);

SELECT * FROM finish();
ROLLBACK;
