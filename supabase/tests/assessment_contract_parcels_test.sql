BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(71);

-- Acesso ----------------------------------------------------------------------

SELECT ok(
  has_function_privilege('service_role', 'public.import_assessment_contract_parcels(uuid,jsonb,timestamptz,uuid)', 'EXECUTE'),
  'service_role can import the parcels'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.import_assessment_contract_parcels(uuid,jsonb,timestamptz,uuid)', 'EXECUTE'),
  'the browser cannot import parcels directly'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.record_assessment_contract_parcel_payment(uuid,uuid,date,date,timestamptz,uuid)', 'EXECUTE'),
  'the browser cannot record a parcel payment directly'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_contract_parcels', 'SELECT'),
  'anonymous callers cannot read the parcels'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.assessment_contract_parcels', 'INSERT'),
  'the browser cannot write parcels directly'
);

-- Fixtures fictícias ----------------------------------------------------------
--   k(0) contrato pai pago; k(1) renovação com link; k(2) contrato comum;
--   k(3) contrato rascunho de prospect.

INSERT INTO auth.users (id, email)
VALUES ('96400000-0000-4000-a000-0000000000ff', 'parcels-admin@example.test');
INSERT INTO public.assessment_modalities (id, name)
VALUES ('96400000-0000-4000-a000-000000000010', 'carne-parcelas-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES (
  '96400000-0000-4000-a000-000000000011', '96400000-0000-4000-a000-000000000010',
  'Plano trimestral carnê', 'trimestral', 3, 200, 600, 3, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('96400000-0000-4000-a000-000000000012', 'Coach Carnê', 'carne@example.test', 'senior',
        ARRAY['96400000-0000-4000-a000-000000000010'::uuid]);
INSERT INTO public.payment_methods (id, group_name, name, kind, installments, credit_days_first)
VALUES ('96400000-0000-4000-a000-000000000031', 'Teste', 'PIX do carnê', 'pix', 1, 0);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('96400000-0000-4000-a000-000000000021', 'Pessoa Carnê Renovação', '11900009641'),
  ('96400000-0000-4000-a000-000000000022', 'Pessoa Carnê Comum', '11900009642'),
  ('96400000-0000-4000-a000-000000000023', 'Pessoa Carnê Prospect', '11900009643');

CREATE FUNCTION pg_temp.k(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('96400000-0000-4000-a000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
$$;
CREATE FUNCTION pg_temp.ver(p_n integer) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT updated_at FROM public.assessment_contracts WHERE id = pg_temp.k(p_n);
$$;
CREATE FUNCTION pg_temp.pid(p_n integer, p_number integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.assessment_contract_parcels
  WHERE contract_id = pg_temp.k(p_n) AND installment_number = p_number;
$$;
-- Parcelas como a api-v1 as entrega (lidas do Asaas): p_paid são os números
-- que o Asaas já mostra como pagos.
CREATE FUNCTION pg_temp.carne(
  p_code text, p_total numeric, p_n integer, p_first date,
  p_paid integer[] DEFAULT '{}', p_dup_number boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_agg(jsonb_build_object(
    'installment_number', CASE WHEN p_dup_number AND g = p_n THEN p_n - 1 ELSE g END,
    'value', round(p_total / p_n, 2),
    'due_date', (p_first + (g - 1) * 30)::text,
    'asaas_payment_id', 'pay_' || p_code || g,
    'asaas_installment_id', 'ins-' || p_code,
    'billing_type', 'BOLETO',
    'asaas_status', CASE WHEN g = ANY (p_paid) THEN 'CONFIRMED' ELSE 'PENDING' END,
    'invoice_url', 'https://www.asaas.com/i/' || p_code || g,
    'paid_date', CASE WHEN g = ANY (p_paid) THEN (current_date - 1)::text END,
    'credit_date', CASE WHEN g = ANY (p_paid) THEN current_date::text END
  ) ORDER BY g)
  FROM generate_series(1, p_n) AS g;
$$;
CREATE FUNCTION pg_temp.imp(p_n integer, p_parcels jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.import_assessment_contract_parcels(
    pg_temp.k(p_n), p_parcels, pg_temp.ver(p_n), '96400000-0000-4000-a000-0000000000ff');
$$;
CREATE FUNCTION pg_temp.syn(p_n integer, p_parcels jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.sync_assessment_contract_parcels(
    pg_temp.k(p_n), p_parcels, '96400000-0000-4000-a000-0000000000ff');
$$;
CREATE FUNCTION pg_temp.rec(
  p_n integer, p_number integer, p_date date DEFAULT current_date - 1, p_credit date DEFAULT current_date
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.record_assessment_contract_parcel_payment(
    pg_temp.k(p_n), pg_temp.pid(p_n, p_number), p_date, p_credit, pg_temp.ver(p_n),
    '96400000-0000-4000-a000-0000000000ff');
$$;
CREATE FUNCTION pg_temp.undo(p_n integer, p_number integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.reopen_assessment_contract_parcel_payment(
    pg_temp.k(p_n), pg_temp.pid(p_n, p_number), pg_temp.ver(p_n),
    '96400000-0000-4000-a000-0000000000ff');
$$;

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, payment_date, manual_payment, auto_renewal, renewal_generated
) VALUES (
  pg_temp.k(0), 'ASS-996400', '96400000-0000-4000-a000-000000000021',
  '96400000-0000-4000-a000-000000000012', '96400000-0000-4000-a000-000000000011',
  '{"name":"Plano trimestral carnê","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"96400000-0000-4000-a000-000000000010"}'::jsonb,
  'active', current_date - 80, current_date + 10, current_date + 10, current_date - 80, 1,
  'pix', 'paid', current_date - 80, true, false, true
);
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated,
  parent_contract_id, external_payment_link, external_invoice_number
) VALUES (
  pg_temp.k(1), 'ASS-996401', '96400000-0000-4000-a000-000000000021',
  '96400000-0000-4000-a000-000000000012', '96400000-0000-4000-a000-000000000011',
  '{"name":"Plano trimestral carnê","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"96400000-0000-4000-a000-000000000010"}'::jsonb,
  'scheduled', current_date + 11, current_date + 101, current_date + 101, current_date + 4, 3,
  'card_3x', 'charge_sent', false, false,
  pg_temp.k(0), 'https://www.asaas.com/i/carnelink1', 'FAT-1'
);
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
) VALUES (
  pg_temp.k(2), 'ASS-996402', '96400000-0000-4000-a000-000000000022',
  '96400000-0000-4000-a000-000000000012', '96400000-0000-4000-a000-000000000011',
  '{"name":"Plano trimestral carnê","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"96400000-0000-4000-a000-000000000010"}'::jsonb,
  'active', current_date - 5, current_date + 85, current_date + 85, current_date + 2, 1,
  'pix', 'charge_sent', false, false
);
INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated,
  prospect_stage, prospect_message_sent_at
) VALUES (
  pg_temp.k(3), 'ASS-996403', '96400000-0000-4000-a000-000000000023',
  '96400000-0000-4000-a000-000000000012', '96400000-0000-4000-a000-000000000011',
  '{"name":"Plano trimestral carnê","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"96400000-0000-4000-a000-000000000010"}'::jsonb,
  'draft', current_date + 3, current_date + 93, current_date + 93, current_date + 3, 1,
  'pix', 'pending', false, false,
  'payment_link_sent', now()
);

SELECT is(
  (SELECT renewal_stage FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'waiting_payment',
  'fixture: the renewal waits for payment before the carnê'
);

-- Importar --------------------------------------------------------------------

-- Um link de parcela que já é o link de outro contrato barra a importação.
UPDATE public.assessment_contracts
SET external_payment_link = 'https://www.asaas.com/i/carnex1'
WHERE id = pg_temp.k(2);
SELECT throws_like(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carnex', 600, 3, current_date + 5))$$,
  '%link destas parcelas já está no contrato ASS-996402%',
  'a parcel link already used as the link of another contract is refused'
);

SELECT throws_like(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carne1', 600, 1, current_date + 5))$$,
  '%de 2 a 24 parcelas%',
  'a single parcel is not a carnê'
);
SELECT throws_like(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carne1', 570, 3, current_date + 5))$$,
  '%soma das parcelas (R$ 570,00) é diferente do valor do contrato (R$ 600,00)%',
  'parcels that do not add up to the contract are refused with both values'
);
SELECT throws_like(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carne1', 600, 3, current_date + 5, '{}', true))$$,
  '%numeradas de 1 até o total%',
  'repeated parcel numbers are refused'
);
SELECT throws_like(
  $$SELECT public.import_assessment_contract_parcels(
      pg_temp.k(1), pg_temp.carne('carne1', 600, 3, current_date + 5),
      now() - interval '1 hour', '96400000-0000-4000-a000-0000000000ff')$$,
  '%alterado por outra ação%',
  'a stale contract version is refused'
);
SELECT lives_ok(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carne1', 600, 3, current_date + 5))$$,
  'the three parcels are imported'
);
SELECT is(
  (SELECT payment_method FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'carne_boleto_pix',
  'the contract shows the carnê as its payment form'
);
SELECT is(
  (SELECT due_date FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  current_date + 5,
  'the contract due date follows the first parcel'
);
SELECT is(
  (SELECT payment_status FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'charge_sent',
  'importing does not change the payment status'
);
SELECT is(
  (SELECT external_payment_link FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'https://www.asaas.com/i/carne11',
  'the contract link is the link of the first open parcel'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_parcels WHERE contract_id = pg_temp.k(1)),
  3,
  'three parcels are stored'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id = pg_temp.k(1) AND event_type = 'parcels_imported'
      AND payload->>'previous_payment_method' = 'card_3x'
  ),
  'the import is in the contract history with the previous payment method'
);
SELECT throws_like(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carne1', 600, 3, current_date + 5))$$,
  '%já tem as parcelas importadas%',
  'importing twice is refused'
);
SELECT throws_like(
  $$SELECT pg_temp.imp(2, pg_temp.carne('carne1', 600, 3, current_date + 5))$$,
  '%já estão no contrato ASS-996401%',
  'the same Asaas parcels cannot be in two contracts'
);

-- Atualizar -------------------------------------------------------------------

SELECT is(
  (SELECT jsonb_array_length(
     pg_temp.syn(1, pg_temp.carne('carne1', 600, 3, current_date + 5, '{1}')
       || jsonb_build_array(jsonb_build_object(
         'installment_number', 4, 'value', 10, 'due_date', current_date::text,
         'asaas_payment_id', 'pay_outsider1', 'asaas_installment_id', 'ins-carne1',
         'asaas_status', 'PENDING'))
     )->'unknown_payment_ids')),
  1,
  'a parcel the contract does not know is reported, not stored'
);
SELECT is(
  (SELECT asaas_status FROM public.assessment_contract_parcels WHERE id = pg_temp.pid(1, 1)),
  'CONFIRMED',
  'the Asaas status of the paid parcel is updated'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_parcels WHERE contract_id = pg_temp.k(1)),
  3,
  'syncing does not add parcels'
);

-- Registrar -------------------------------------------------------------------

SELECT throws_like(
  $$SELECT pg_temp.rec(1, 2)$$,
  '%ainda não consta como paga no Asaas%',
  'a parcel that is not paid in Asaas cannot be recorded'
);
SELECT throws_like(
  $$SELECT pg_temp.rec(1, 1, current_date + 1, current_date + 2)$$,
  '%não pode estar no futuro%',
  'a future payment date is refused'
);
SELECT throws_like(
  $$SELECT pg_temp.rec(1, 1, current_date - 1, current_date - 2)$$,
  '%crédito não pode ser antes%',
  'a credit date before the payment date is refused'
);
SELECT lives_ok(
  $$SELECT pg_temp.rec(1, 1)$$,
  'the first parcel is recorded'
);
SELECT is(
  (SELECT payment_status FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'partially_paid',
  'the contract is partially paid after the first parcel'
);
SELECT is(
  (SELECT count(*)::int FROM public.asaas_payments
   WHERE order_id = pg_temp.k(1) AND order_type = 'contract' AND source = 'manual'
     AND status = 'CONFIRMED' AND installment_number = 1 AND total_installments = 3
     AND value = 200 AND installment_group_id = 'ins-carne1'
     AND credit_date = current_date AND payment_date = current_date - 1),
  1,
  'one confirmed manual line with the real dates is created for the parcel'
);
SELECT ok(
  (SELECT payment_row_id IS NOT NULL FROM public.assessment_contract_parcels WHERE id = pg_temp.pid(1, 1)),
  'the parcel points to its payment line'
);
SELECT is(
  (SELECT due_date FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  current_date + 35,
  'the contract due date moves to the next unrecorded parcel'
);
SELECT is(
  (SELECT external_payment_link FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'https://www.asaas.com/i/carne12',
  'the contract link moves to the next open parcel, not the paid one'
);
SELECT is(
  (SELECT payment_date FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  current_date - 1,
  'the contract payment date is the first parcel date'
);
SELECT is(
  eon_private.communication_open_balance('contract', pg_temp.k(1), 'partially_paid', 600),
  400::numeric,
  'the Central balance of a partially paid carnê is the sum of the open parcels'
);
SELECT is(
  (SELECT renewal_stage FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'renewed',
  'the renewal counts as renewed on the first recorded parcel'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id = pg_temp.k(1) AND event_type = 'parcel_payment_recorded'
      AND payload->>'recorded_parcels' = '1'
  ),
  'the parcel payment is in the contract history'
);
SELECT is(
  (SELECT pg_temp.rec(1, 1)->>'unchanged'),
  'true',
  'recording the same parcel again changes nothing'
);
SELECT is(
  (SELECT count(*)::int FROM public.asaas_payments
   WHERE order_id = pg_temp.k(1) AND source = 'manual'),
  1,
  'no duplicated payment line'
);

-- Regras que não podem apagar as linhas por parcela ---------------------------

SELECT throws_like(
  $$SELECT public.api_record_manual_payment(
      'contract', pg_temp.k(1), '96400000-0000-4000-a000-000000000031', current_date, 600,
      jsonb_build_array(jsonb_build_object(
        'number', 1, 'due_date', current_date::text, 'credit_date', current_date::text, 'value', 600)),
      '96400000-0000-4000-a000-0000000000ff')$$,
  '%tem parcelas do Asaas (carnê)%',
  'the full manual payment is refused on a contract with a carnê'
);
SELECT throws_like(
  $$SELECT public.api_reopen_manual_payment(
      'contract', pg_temp.k(1), '96400000-0000-4000-a000-0000000000ff')$$,
  '%tem parcelas do Asaas (carnê)%',
  'reopening the whole manual payment is refused on a contract with a carnê'
);
SELECT throws_like(
  $$SELECT public.save_assessment_contract_external_charge(
      pg_temp.k(1), 'https://www.asaas.com/i/carnelink9', current_date + 9, 'pix', NULL,
      'contract_detail', pg_temp.ver(1), '96400000-0000-4000-a000-0000000000ff')$$,
  '%parcelas importadas do Asaas%',
  'the external charge cannot be replaced under a carnê'
);
SELECT throws_like(
  $$SELECT public.remove_assessment_contract_external_charge(
      pg_temp.k(1), pg_temp.ver(1), '96400000-0000-4000-a000-0000000000ff')$$,
  '%parcelas importadas do Asaas%',
  'the external charge cannot be removed under a carnê'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_renewal_pipeline_issues
   WHERE contract_id = pg_temp.k(1) AND issue_code = 'renewed_without_payment'),
  0,
  'renewed with a recorded parcel is not reported as renewed without payment'
);

-- Fechar o carnê --------------------------------------------------------------

SELECT is(
  (SELECT jsonb_array_length(
     pg_temp.syn(1, pg_temp.carne('carne1', 600, 3, current_date + 5, '{1,2,3}'))->'missing_payment_ids')),
  0,
  'all parcels are still listed by Asaas'
);
SELECT is(
  (SELECT pg_temp.rec(1, 2)->>'payment_status'),
  'partially_paid',
  'two of three parcels is still partially paid'
);
SELECT is(
  (SELECT pg_temp.rec(1, 3)->>'payment_status'),
  'paid',
  'the last parcel closes the contract as paid'
);
SELECT is(
  eon_private.communication_open_balance('contract', pg_temp.k(1), 'paid', 600),
  0::numeric,
  'a paid carnê has no balance for the Central'
);
SELECT is(
  (SELECT sum(value) FROM public.asaas_payments
   WHERE order_id = pg_temp.k(1) AND source = 'manual' AND status = 'CONFIRMED'),
  600::numeric,
  'the three lines add up to the contract total'
);
SELECT is(
  (SELECT renewal_stage FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'renewed',
  'the renewal stays renewed when the carnê is complete'
);
SELECT throws_like(
  $$SELECT public.remove_assessment_contract_parcels(
      pg_temp.k(1), pg_temp.ver(1), '96400000-0000-4000-a000-0000000000ff')$$,
  '%parcela com pagamento registrado%',
  'the carnê cannot be removed while a parcel is recorded'
);

-- Desfazer ---------------------------------------------------------------------

SELECT is(
  (SELECT pg_temp.undo(1, 3)->>'payment_status'),
  'partially_paid',
  'undoing the last parcel goes back to partially paid'
);
SELECT is(
  (SELECT count(*)::int FROM public.asaas_payments WHERE order_id = pg_temp.k(1) AND source = 'manual'),
  2,
  'the payment line of the undone parcel is gone'
);
SELECT lives_ok(
  $$SELECT pg_temp.undo(1, 2)$$,
  'the second parcel is undone'
);
SELECT is(
  (SELECT renewal_stage FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'renewed',
  'the renewal stays renewed while one parcel is still recorded'
);
SELECT is(
  (SELECT pg_temp.undo(1, 1)->>'payment_status'),
  'charge_sent',
  'with no parcel recorded the contract goes back to charge sent'
);
SELECT ok(
  (SELECT payment_date IS NULL AND NOT manual_payment
   FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'the payment date and the manual flag are cleared'
);
SELECT is(
  (SELECT renewal_stage FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'waiting_payment',
  'the renewal goes back to waiting for payment'
);
SELECT is(
  (SELECT count(*)::int FROM public.asaas_payments WHERE order_id = pg_temp.k(1) AND source = 'manual'),
  0,
  'no payment line is left'
);

-- Remover o carnê --------------------------------------------------------------

SELECT lives_ok(
  $$SELECT public.remove_assessment_contract_parcels(
      pg_temp.k(1), pg_temp.ver(1), '96400000-0000-4000-a000-0000000000ff')$$,
  'the imported carnê is removed'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contract_parcels WHERE contract_id = pg_temp.k(1)),
  0,
  'no parcel is left'
);
SELECT ok(
  (SELECT payment_method = 'card_3x' AND installments = 3 AND due_date = current_date + 4
     AND external_payment_link = 'https://www.asaas.com/i/carnelink1'
   FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'payment form, installments, due date and link are back to what they were'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.assessment_contract_event
    WHERE contract_id = pg_temp.k(1) AND event_type = 'parcels_removed'
  ),
  'the removal is in the contract history'
);

-- Cancelar com parcela registrada ----------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.imp(1, pg_temp.carne('carne1', 600, 3, current_date + 5, '{1}'))$$,
  'the carnê is imported again with a parcel already paid in Asaas'
);
SELECT lives_ok(
  $$SELECT pg_temp.rec(1, 1)$$,
  'and its first parcel is recorded'
);
UPDATE public.assessment_contracts
SET status = 'cancelled', cancellation_reason = 'Teste de carnê', cancellation_date = current_date + 30
WHERE id = pg_temp.k(1);
SELECT is(
  (SELECT payment_status FROM public.assessment_contracts WHERE id = pg_temp.k(1)),
  'partially_paid',
  'cancelling keeps the partially paid status when money was received'
);
SELECT is(
  (SELECT count(*)::int FROM public.asaas_payments
   WHERE order_id = pg_temp.k(1) AND source = 'manual' AND status = 'CONFIRMED'),
  1,
  'the received parcel is not marked as cancelled'
);

-- Prospect --------------------------------------------------------------------

SELECT lives_ok(
  $$SELECT pg_temp.imp(3, pg_temp.carne('carne3', 600, 2, current_date + 3, '{1}'))$$,
  'a prospect contract gets its carnê'
);
SELECT is(
  (SELECT prospect_stage FROM public.assessment_contracts WHERE id = pg_temp.k(3)),
  'payment_link_sent',
  'importing the carnê does not convert the prospect'
);
SELECT lives_ok(
  $$SELECT pg_temp.rec(3, 1)$$,
  'the first parcel of the prospect is recorded'
);
SELECT is(
  (SELECT prospect_stage FROM public.assessment_contracts WHERE id = pg_temp.k(3)),
  'converted',
  'the prospect converts on the first recorded parcel'
);
SELECT is(
  (SELECT status FROM public.assessment_contracts WHERE id = pg_temp.k(3)),
  'scheduled',
  'the contract is scheduled for its start date'
);

SELECT * FROM finish();
ROLLBACK;
