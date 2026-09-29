BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
-- As regras usam a data de São Paulo; o current_date das fixtures também.
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(40);

-- Acesso ----------------------------------------------------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
   WHERE oid = 'public.assessment_contract_refund_allocations'::regclass),
  'refund allocations keep RLS enabled'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.assessment_contract_refund_allocations', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.assessment_contract_refund_allocations', 'SELECT,INSERT,UPDATE,DELETE')
  AND has_table_privilege('service_role', 'public.assessment_contract_refund_allocations', 'SELECT,INSERT,DELETE'),
  'the browser cannot write refund allocations and anon cannot read them'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.register_assessment_contract_refund(uuid, date, text, numeric, jsonb, text, timestamptz, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.reopen_assessment_contract_refund(uuid, text, timestamptz, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.register_assessment_contract_refund(uuid, date, text, numeric, jsonb, text, timestamptz, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.reopen_assessment_contract_refund(uuid, text, timestamptz, uuid)', 'EXECUTE'),
  'refund registration runs only through the backend'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.assessment_contracts'::regclass
      AND tgname = 'trg_cleanup_asaas_payments_contract_status'
  ),
  'cancelling a contract no longer cancels its payment installments'
);
SELECT ok(
  to_regclass('eon_private.contract_installment_restore_backups') IS NOT NULL
  AND NOT has_table_privilege('service_role', 'eon_private.contract_installment_restore_backups', 'SELECT'),
  'restored installments keep a private backup'
);
SELECT is(
  ARRAY[eon_private.format_brl(1119.9), eon_private.format_brl(603.87), eon_private.format_brl(0.01)],
  ARRAY['R$ 1.119,90', 'R$ 603,87', 'R$ 0,01'],
  'money in messages is written in reais'
);

-- Fixtures fictícias ----------------------------------------------------------

INSERT INTO public.assessment_modalities (id, name) VALUES
  ('50000000-0000-4000-a000-000000000001', 'estorno-corrida-test');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee
) VALUES
  ('50000000-0000-4000-a000-000000000011', '50000000-0000-4000-a000-000000000001',
   'Estorno corrida trimestral', 'trimestral', 3, 360, 1080, 3, 39.90),
  ('50000000-0000-4000-a000-000000000012', '50000000-0000-4000-a000-000000000001',
   'Estorno corrida semestral', 'semestral', 6, 185, 1110, 6, 0);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids) VALUES
  ('50000000-0000-4000-a000-000000000021', 'Coach estorno', 'estorno@example.test', 'pleno',
   ARRAY['50000000-0000-4000-a000-000000000001'::uuid]);

INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('50000000-0000-4000-a000-000000000031', 'Estorno cartao um', '11900005031'),
  ('50000000-0000-4000-a000-000000000032', 'Estorno pix dois', '11900005032');

-- R1: trimestral de R$ 1.080 + R$ 39,90 de matrícula, cartão 3x de R$ 373,30.
-- Cancelado hoje com 52 de 93 dias restantes e sem multa: estorno R$ 603,87.
-- R2: semestral de R$ 1.110 no cartão 6x de R$ 185. Cancelado hoje com 125
-- de 185 dias restantes e multa de 15%: estorno R$ 637,50.
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments, enrollment_fee,
  payment_method, payment_status, payment_date, manual_payment, auto_renewal, renewal_generated
) VALUES
  ('50000000-0000-4000-a000-000000000101', 'ASS-950001', '50000000-0000-4000-a000-000000000031',
   '50000000-0000-4000-a000-000000000021', '50000000-0000-4000-a000-000000000011',
   '{"plan_id":"50000000-0000-4000-a000-000000000011","name":"Estorno corrida trimestral","period":"trimestral","period_months":3,"price_total":1080,"price_monthly":360,"modality_id":"50000000-0000-4000-a000-000000000001"}'::jsonb,
   'active', current_date - 41, current_date + 51, current_date + 51, current_date - 41, 3, 39.90,
   'card_3x', 'paid', current_date - 41, true, false, false),
  ('50000000-0000-4000-a000-000000000102', 'ASS-950002', '50000000-0000-4000-a000-000000000032',
   '50000000-0000-4000-a000-000000000021', '50000000-0000-4000-a000-000000000012',
   '{"plan_id":"50000000-0000-4000-a000-000000000012","name":"Estorno corrida semestral","period":"semestral","period_months":6,"price_total":1110,"price_monthly":185,"modality_id":"50000000-0000-4000-a000-000000000001"}'::jsonb,
   'active', current_date - 60, current_date + 124, current_date + 124, current_date - 60, 6, 0,
   'card_6x', 'paid', current_date - 60, true, false, false);

INSERT INTO public.asaas_payments (
  id, asaas_payment_id, source, installment_number, total_installments, billing_type,
  status, value, net_value, due_date, credit_date, payment_date, description,
  external_reference, order_id, order_type
)
SELECT
  fixture.id, 'manual_test_' || fixture.id::text, 'manual', fixture.number, fixture.total, 'CREDIT',
  'CONFIRMED', fixture.value, fixture.value, fixture.credit_date, fixture.credit_date, fixture.paid_on,
  'Pagamento manual - teste', fixture.contract_number, fixture.contract_id, 'contract'
FROM (VALUES
  ('50000000-0000-4000-a000-000000000201'::uuid, 1, 3, 373.30, current_date - 36, current_date - 41, 'ASS-950001', '50000000-0000-4000-a000-000000000101'::uuid),
  ('50000000-0000-4000-a000-000000000202'::uuid, 2, 3, 373.30, current_date - 6, current_date - 41, 'ASS-950001', '50000000-0000-4000-a000-000000000101'::uuid),
  ('50000000-0000-4000-a000-000000000203'::uuid, 3, 3, 373.30, current_date + 24, current_date - 41, 'ASS-950001', '50000000-0000-4000-a000-000000000101'::uuid),
  ('50000000-0000-4000-a000-000000000211'::uuid, 1, 6, 185.00, current_date - 30, current_date - 60, 'ASS-950002', '50000000-0000-4000-a000-000000000102'::uuid),
  ('50000000-0000-4000-a000-000000000212'::uuid, 2, 6, 185.00, current_date, current_date - 60, 'ASS-950002', '50000000-0000-4000-a000-000000000102'::uuid),
  ('50000000-0000-4000-a000-000000000213'::uuid, 3, 6, 185.00, current_date + 30, current_date - 60, 'ASS-950002', '50000000-0000-4000-a000-000000000102'::uuid),
  ('50000000-0000-4000-a000-000000000214'::uuid, 4, 6, 185.00, current_date + 60, current_date - 60, 'ASS-950002', '50000000-0000-4000-a000-000000000102'::uuid),
  ('50000000-0000-4000-a000-000000000215'::uuid, 5, 6, 185.00, current_date + 90, current_date - 60, 'ASS-950002', '50000000-0000-4000-a000-000000000102'::uuid),
  ('50000000-0000-4000-a000-000000000216'::uuid, 6, 6, 185.00, current_date + 120, current_date - 60, 'ASS-950002', '50000000-0000-4000-a000-000000000102'::uuid)
) AS fixture(id, number, total, value, credit_date, paid_on, contract_number, contract_id);

CREATE TEMPORARY TABLE refund_results (
  name text PRIMARY KEY,
  result jsonb NOT NULL
);
GRANT SELECT, INSERT ON refund_results TO service_role;

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

CREATE FUNCTION pg_temp.register_sql(
  p_contract_id uuid,
  p_date date,
  p_method text,
  p_amount numeric,
  p_allocations jsonb,
  p_notes text
)
RETURNS text
LANGUAGE sql
AS $$
  SELECT format(
    'SELECT public.register_assessment_contract_refund(%L, %L, %L, %s, %L, %L, %L, %L)',
    p_contract_id, p_date, p_method, p_amount, p_allocations, p_notes,
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_contract_id),
    '50000000-0000-4000-a000-000000000099'
  );
$$;
GRANT EXECUTE ON FUNCTION pg_temp.register_sql(uuid, date, text, numeric, jsonb, text) TO service_role;

-- Cancelamento: as parcelas continuam ----------------------------------------------

SET LOCAL ROLE service_role;
INSERT INTO refund_results VALUES ('r1_cancel', public.cancel_assessment_contract(
  '50000000-0000-4000-a000-000000000101', current_date, 0, 'Mudou de cidade',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  '50000000-0000-4000-a000-000000000099'
));
INSERT INTO refund_results VALUES ('r2_cancel', public.cancel_assessment_contract(
  '50000000-0000-4000-a000-000000000102', current_date, 15, 'Lesão',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000102'),
  '50000000-0000-4000-a000-000000000099'
));
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', status, 'refund', refund_amount, 'refund_status', refund_status)
   FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_object('status', 'cancelled', 'refund', 603.87, 'refund_status', 'pending'),
  'the card contract cancelled with 52 of 93 days left refunds R$ 603,87'
);
SELECT is(
  (SELECT jsonb_build_object('fee', cancellation_fee, 'refund', refund_amount)
   FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000102'),
  jsonb_build_object('fee', 112.50, 'refund', 637.50),
  'the second contract keeps a 15% fee: R$ 750,00 - R$ 112,50 = R$ 637,50'
);
SELECT is(
  (SELECT count(*)::integer FROM public.asaas_payments
   WHERE order_id IN ('50000000-0000-4000-a000-000000000101', '50000000-0000-4000-a000-000000000102')
     AND status = 'CONFIRMED'),
  9,
  'the installments already paid stay as payments after the cancellation'
);

-- Validações --------------------------------------------------------------------

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'card_asaas', 603.87, '[]', NULL)),
  'No estorno no cartão, informe quanto foi estornado em cada parcela',
  'a card refund needs the amount of each installment'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'card_asaas', 603.87,
    '[{"payment_id":"50000000-0000-4000-a000-000000000202","value":373.30,"already_credited":true},
      {"payment_id":"50000000-0000-4000-a000-000000000203","value":226.70,"already_credited":false}]', NULL)),
  'A soma das parcelas (R$ 600,00) precisa ser igual ao valor devolvido (R$ 603,87)',
  'the installments must add up to the refund'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'card_asaas', 603.87,
    '[{"payment_id":"50000000-0000-4000-a000-000000000203","value":603.87,"already_credited":false}]', NULL)),
  'Na parcela 3, o estorno vai de R$ 0,01 até R$ 373,30',
  'an installment cannot refund more than its value'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'card_asaas', 185.00,
    '[{"payment_id":"50000000-0000-4000-a000-000000000211","value":185,"already_credited":true}]', 'Parcela errada')),
  'A parcela não é deste contrato',
  'an installment of another contract is refused'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'pix', 603.87,
    '[{"payment_id":"50000000-0000-4000-a000-000000000203","value":603.87,"already_credited":false}]', NULL)),
  'As parcelas só são informadas no estorno no cartão',
  'a PIX refund has no installments'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'pix', 600.00, NULL, NULL)),
  'O estorno calculado é R$ 603,87; informe na observação o motivo do valor diferente',
  'a different amount needs a reason'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'pix', 1200.00, NULL, 'Devolução total')),
  'O estorno não pode passar do valor pago (R$ 1.119,90)',
  'the refund cannot exceed what was paid'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date + 1, 'pix', 603.87, NULL, NULL)),
  'Informe a data do estorno (hoje ou antes)',
  'a refund in the future is refused'
);
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date - 42, 'pix', 603.87, NULL, NULL)),
  format('O estorno não pode ser antes do pagamento (%s)', to_char(current_date - 41, 'DD/MM/YYYY')),
  'a refund before the payment is refused'
);
SELECT is(
  pg_temp.error_of(format(
    'SELECT public.register_assessment_contract_refund(%L, %L, %L, 603.87, NULL, NULL, %L, %L)',
    '50000000-0000-4000-a000-000000000101', current_date, 'pix', '2020-01-01 00:00:00+00',
    '50000000-0000-4000-a000-000000000099')),
  'O contrato foi alterado por outra ação. Atualize a página e tente novamente',
  'a stale screen cannot register the refund'
);
RESET ROLE;

-- Cartão pelo Asaas: parcela 2 inteira (já tinha caído) e parte da 3 -------------------

SET LOCAL ROLE service_role;
INSERT INTO refund_results
SELECT 'r1_register', public.register_assessment_contract_refund(
  '50000000-0000-4000-a000-000000000101', current_date, 'card_asaas', 603.87,
  '[{"payment_id":"50000000-0000-4000-a000-000000000202","value":373.30,"already_credited":true},
    {"payment_id":"50000000-0000-4000-a000-000000000203","value":230.57,"already_credited":false}]',
  'Estornado no painel do Asaas',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  '50000000-0000-4000-a000-000000000099');
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', refund_status, 'method', refund_method, 'date', refund_date,
     'amount', refund_amount, 'calculated', refund_calculated_amount)
   FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_object('status', 'done', 'method', 'card_asaas', 'date', current_date,
    'amount', 603.87, 'calculated', 603.87),
  'the refund is registered as done by card through Asaas'
);
SELECT is(
  (SELECT jsonb_agg(jsonb_build_object('installment', (metadata->>'installment_number')::integer, 'gross', gross_amount)
     ORDER BY (metadata->>'installment_number')::integer)
   FROM public.financial_movements
   WHERE source_table = 'asaas_payments' AND order_id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_array(
    jsonb_build_object('installment', 1, 'gross', 373.30),
    jsonb_build_object('installment', 2, 'gross', 373.30),
    jsonb_build_object('installment', 3, 'gross', 142.73)
  ),
  'installments already received stay whole; the one still to come receives R$ 142,73'
);
SELECT is(
  (SELECT jsonb_build_object('amount', gross_amount, 'on', occurred_on, 'method', payment_method)
   FROM public.financial_movements
   WHERE source = 'contract_refund' AND order_id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_object('amount', 373.30, 'on', current_date, 'method', 'card_asaas'),
  'only the refund of the installment already received leaves the balance'
);
SELECT is(
  (SELECT sum(signed_net_amount) FROM public.financial_movements
   WHERE order_id = '50000000-0000-4000-a000-000000000101'),
  516.03::numeric,
  'the contract nets R$ 516,03, as Asaas shows after the refund'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_movements
   WHERE order_id = '50000000-0000-4000-a000-000000000101' AND is_legacy),
  0,
  'no legacy lump receipt appears for the cancelled contract'
);
SELECT is(
  (SELECT jsonb_build_object('status', status, 'method', method, 'amount', amount, 'calculated', calculated_amount)
   FROM public.refunds_overview WHERE source_id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_object('status', 'done', 'method', 'card_asaas', 'amount', 603.87, 'calculated', 603.87),
  'the refund center shows the method'
);
SELECT is(
  (SELECT jsonb_build_object('method', payload->>'method', 'allocations', jsonb_array_length(payload->'allocations'))
   FROM public.assessment_contract_event
   WHERE contract_id = '50000000-0000-4000-a000-000000000101' AND event_type = 'refund_completed'),
  jsonb_build_object('method', 'card_asaas', 'allocations', 2),
  'the timeline records the method and the installments'
);

SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(pg_temp.register_sql('50000000-0000-4000-a000-000000000101', current_date, 'pix', 603.87, NULL, NULL)),
  'Este contrato não possui estorno pendente',
  'a registered refund cannot be registered again'
);
SELECT is(
  pg_temp.error_of(format(
    'SELECT public.reopen_assessment_contract_refund(%L, %L, %L, %L)',
    '50000000-0000-4000-a000-000000000101', '  ',
    (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
    '50000000-0000-4000-a000-000000000099')),
  'Informe o motivo',
  'undoing the registration needs a reason'
);
RESET ROLE;

-- Desfazer o registro ---------------------------------------------------------------------

SET LOCAL ROLE service_role;
INSERT INTO refund_results
SELECT 'r1_reopen', public.reopen_assessment_contract_refund(
  '50000000-0000-4000-a000-000000000101', 'Parcelas registradas erradas',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  '50000000-0000-4000-a000-000000000099');
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object('status', refund_status, 'method', refund_method, 'date', refund_date,
     'amount', refund_amount, 'allocations',
     (SELECT count(*) FROM public.assessment_contract_refund_allocations WHERE contract_id = contract.id))
   FROM public.assessment_contracts AS contract WHERE id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_object('status', 'pending', 'method', NULL, 'date', NULL, 'amount', 603.87, 'allocations', 0),
  'undoing returns the refund to pending with the calculated amount'
);
SELECT is(
  (SELECT jsonb_build_object(
     'installment_3', (SELECT gross_amount FROM public.financial_movements
                       WHERE source_id = '50000000-0000-4000-a000-000000000203'),
     'refund_rows', (SELECT count(*) FROM public.financial_movements
                     WHERE source = 'contract_refund' AND order_id = '50000000-0000-4000-a000-000000000101'))),
  jsonb_build_object('installment_3', 373.30, 'refund_rows', 0),
  'after undoing, the installments are whole again and no refund leaves the balance'
);
SELECT is(
  (SELECT notes FROM public.assessment_contract_event
   WHERE contract_id = '50000000-0000-4000-a000-000000000101' AND event_type = 'refund_reopened'),
  'Parcelas registradas erradas',
  'the timeline records why the registration was undone'
);
SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.error_of(format(
    'SELECT public.reopen_assessment_contract_refund(%L, %L, %L, %L)',
    '50000000-0000-4000-a000-000000000101', 'De novo',
    (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
    '50000000-0000-4000-a000-000000000099')),
  'Este estorno não está registrado como feito',
  'a pending refund has nothing to undo'
);

-- Valor diferente, com motivo, e registrar de novo ------------------------------------------

INSERT INTO refund_results
SELECT 'r1_register_again', public.register_assessment_contract_refund(
  '50000000-0000-4000-a000-000000000101', current_date, 'card_asaas', 373.30,
  '[{"payment_id":"50000000-0000-4000-a000-000000000203","value":373.30,"already_credited":false}]',
  'Combinado com o aluno: só a última parcela',
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  '50000000-0000-4000-a000-000000000099');
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object(
     'amount', refund_amount, 'calculated', refund_calculated_amount,
     'installment_3_rows', (SELECT count(*) FROM public.financial_movements
                            WHERE source_id = '50000000-0000-4000-a000-000000000203'),
     'refund_rows', (SELECT count(*) FROM public.financial_movements
                     WHERE source = 'contract_refund' AND order_id = '50000000-0000-4000-a000-000000000101'))
   FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000101'),
  jsonb_build_object('amount', 373.30, 'calculated', 603.87, 'installment_3_rows', 0, 'refund_rows', 0),
  'a whole installment refunded before it arrives leaves the cash flow with no outflow'
);

-- PIX: as parcelas do cartão seguem e o estorno é uma saída -------------------------------

SET LOCAL ROLE service_role;
INSERT INTO refund_results
SELECT 'r2_register', public.register_assessment_contract_refund(
  '50000000-0000-4000-a000-000000000102', current_date, 'pix', 637.50, NULL, NULL,
  (SELECT updated_at FROM public.assessment_contracts WHERE id = '50000000-0000-4000-a000-000000000102'),
  '50000000-0000-4000-a000-000000000099');
RESET ROLE;

SELECT is(
  (SELECT jsonb_build_object(
     'receipts', (SELECT sum(gross_amount) FROM public.financial_movements
                  WHERE source_table = 'asaas_payments' AND order_id = '50000000-0000-4000-a000-000000000102'),
     'refund', (SELECT gross_amount FROM public.financial_movements
                WHERE source = 'contract_refund' AND order_id = '50000000-0000-4000-a000-000000000102'),
     'method', (SELECT payment_method FROM public.financial_movements
                WHERE source = 'contract_refund' AND order_id = '50000000-0000-4000-a000-000000000102'))),
  jsonb_build_object('receipts', 1110.00, 'refund', 637.50, 'method', 'pix'),
  'with PIX the six card installments keep arriving and the refund is one outflow'
);
SELECT is(
  (SELECT sum(signed_net_amount) FROM public.financial_movements
   WHERE order_id = '50000000-0000-4000-a000-000000000102'),
  472.50::numeric,
  'the PIX contract nets R$ 1.110,00 - R$ 637,50'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contract_refund_allocations
   WHERE contract_id = '50000000-0000-4000-a000-000000000102'),
  0,
  'a PIX refund has no installment split'
);

-- Reabrir o pagamento de uma parcela estornada é bloqueado -----------------------------------

SELECT is(
  pg_temp.error_of($$DELETE FROM public.asaas_payments WHERE id = '50000000-0000-4000-a000-000000000203'$$),
  'update or delete on table "asaas_payments" violates foreign key constraint "assessment_contract_refund_allocations_payment_id_fkey" on table "assessment_contract_refund_allocations"',
  'an installment with a registered refund cannot be deleted'
);

-- Invariantes -------------------------------------------------------------------------------

SELECT is(
  (SELECT count(*)::integer
   FROM public.assessment_contracts AS contract
   WHERE contract.refund_status = 'done'
     AND contract.refund_method IN ('card_asaas', 'card_machine')
     AND contract.refund_amount IS DISTINCT FROM (
       SELECT sum(allocation.value)
       FROM public.assessment_contract_refund_allocations AS allocation
       WHERE allocation.contract_id = contract.id
     )),
  0,
  'every card refund is split exactly across its installments'
);
SELECT is(
  (SELECT count(*)::integer
   FROM public.assessment_contract_refund_allocations AS allocation
   JOIN public.asaas_payments AS payment ON payment.id = allocation.payment_id
   WHERE allocation.value > payment.value),
  0,
  'no installment is refunded above its value'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_contracts
   WHERE refund_status = 'done' AND refund_method IS NULL
     AND id IN ('50000000-0000-4000-a000-000000000101', '50000000-0000-4000-a000-000000000102')),
  0,
  'every refund registered here has a method'
);

SELECT * FROM finish();
ROLLBACK;
