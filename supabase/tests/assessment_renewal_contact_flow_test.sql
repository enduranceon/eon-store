BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';
SELECT no_plan();

-- Régua de contato da renovação com atletas fictícios: Pebinha, lembrete 2
-- dias depois, último dia do plano, encerramento 5 dias depois do fim,
-- "ainda pensando" com retorno em 2 dias, despedida e "não respondeu".

-- 1. Datas da régua (função pura) ------------------------------------------------
CREATE FUNCTION pg_temp.plan(p_step text, p_step_day date, p_response text,
  p_response_day date, p_follow_up date, p_end date) RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.assessment_renewal_contact_plan(p_step,
    (p_step_day + time '12:00') AT TIME ZONE 'America/Sao_Paulo', p_response,
    (p_response_day + time '11:00') AT TIME ZONE 'America/Sao_Paulo', p_follow_up,
    p_end, current_date);
$$;

SELECT is(pg_temp.plan(NULL, NULL, NULL, NULL, NULL, current_date + 9),
  jsonb_build_object('step', 'intent', 'eligible_at', current_date - 1), 'the Pebinha goes 10 days before the end');
SELECT is(pg_temp.plan(NULL, NULL, NULL, NULL, NULL, current_date + 20),
  jsonb_build_object('step', 'intent', 'eligible_at', current_date), 'a renewal pulled in early can get the Pebinha right away');
SELECT is(pg_temp.plan('intent', date '2026-11-10', NULL, NULL, NULL, date '2026-11-20'),
  '{"step":"reminder","eligible_at":"2026-11-12"}'::jsonb, 'no answer: reminder 2 days after the Pebinha');
SELECT is(pg_temp.plan('intent', date '2026-11-18', NULL, NULL, NULL, date '2026-11-20'),
  '{"step":"last_day","eligible_at":"2026-11-20"}'::jsonb, 'a late Pebinha skips the reminder');
SELECT is(pg_temp.plan('reminder', date '2026-11-12', NULL, NULL, NULL, date '2026-11-20'),
  '{"step":"last_day","eligible_at":"2026-11-20"}'::jsonb, 'after the reminder comes the last day of the plan');
SELECT is(pg_temp.plan('last_day', date '2026-11-20', NULL, NULL, NULL, date '2026-11-20'),
  '{"step":"closing","eligible_at":"2026-11-25"}'::jsonb, 'closing 5 days after the end');
SELECT is(pg_temp.plan('intent', date '2026-11-22', NULL, NULL, NULL, date '2026-11-20'),
  '{"step":"closing","eligible_at":"2026-11-25"}'::jsonb, 'a Pebinha after the end goes to the closing');
SELECT is(pg_temp.plan('closing', date '2026-11-25', NULL, NULL, NULL, date '2026-11-20'),
  '{"step":"close","eligible_at":"2026-11-25"}'::jsonb, 'after the closing, the renewal is closed as not renewed');
SELECT is(pg_temp.plan('intent', date '2026-11-10', 'thinking', date '2026-11-11', date '2026-11-13', date '2026-11-20'),
  '{"step":"thinking_ack","eligible_at":"2026-11-11"}'::jsonb, '"still thinking" gets an answer right away');
SELECT is(pg_temp.plan('thinking_ack', date '2026-11-11', 'thinking', date '2026-11-11', date '2026-11-13', date '2026-11-20'),
  '{"step":"thinking_return","eligible_at":"2026-11-13"}'::jsonb, 'and we come back 2 days later');
SELECT is(pg_temp.plan('thinking_return', date '2026-11-13', 'thinking', date '2026-11-11', NULL, date '2026-11-20'),
  '{"step":"last_day","eligible_at":"2026-11-20"}'::jsonb, 'still undecided: the last day of the plan');
SELECT is(pg_temp.plan('thinking_return', date '2026-11-21', 'thinking', date '2026-11-19', NULL, date '2026-11-20'),
  '{"step":"closing","eligible_at":"2026-11-25"}'::jsonb, 'undecided after the end: the closing');
SELECT is(pg_temp.plan('intent', date '2026-11-10', 'will_renew', date '2026-11-11', NULL, date '2026-11-20')->>'step',
  'none', 'a decision stops the cadence');
SELECT is(pg_temp.plan('intent', date '2026-11-10', NULL, NULL, date '2026-11-16', date '2026-11-20'),
  '{"step":"reminder","eligible_at":"2026-11-16"}'::jsonb, 'a follow-up set by hand holds the next step');

-- 2. Fixtures fictícias -----------------------------------------------------------------
INSERT INTO public.assessment_modalities (id, name)
VALUES ('84000000-0000-4000-a000-000000000001', 'renovacao-contato-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES ('84000000-0000-4000-a000-000000000011', '84000000-0000-4000-a000-000000000001',
  'Plano fictício trimestral', 'trimestral', 3, 200, 600, 3, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('84000000-0000-4000-a000-000000000021', 'Coach fictício da régua', 'regua@example.test',
  'pleno', ARRAY['84000000-0000-4000-a000-000000000001'::uuid]);
INSERT INTO public.presale_customers (id, full_name, whatsapp)
SELECT ('84000000-0000-4000-a000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  'Atleta fictício ' || n, '519000084' || lpad(n::text, 2, '0')
FROM generate_series(1, 6) AS n;

CREATE FUNCTION pg_temp.k(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('84000000-0000-4000-a000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
$$;
CREATE FUNCTION pg_temp.parent(p_n integer, p_end date) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.assessment_contracts (
    id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
    start_date, end_date, original_end_date, installments, payment_method,
    payment_status, payment_date, manual_payment, auto_renewal, renewal_generated
  ) VALUES (
    pg_temp.k(p_n), 'ASS-97' || lpad(p_n::text, 4, '0'),
    ('84000000-0000-4000-a000-0000000001' || lpad(p_n::text, 2, '0'))::uuid,
    '84000000-0000-4000-a000-000000000021', '84000000-0000-4000-a000-000000000011',
    '{"plan_id":"84000000-0000-4000-a000-000000000011","name":"Plano fictício trimestral","period":"trimestral","period_months":3,"price_total":600,"price_monthly":200,"modality_id":"84000000-0000-4000-a000-000000000001"}'::jsonb,
    'active', p_end - 89, p_end, p_end, 1, 'pix', 'paid', p_end - 89, true, false, false
  );
$$;
CREATE FUNCTION pg_temp.child(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.assessment_contracts WHERE parent_contract_id = pg_temp.k(p_n)
  ORDER BY created_at DESC, id LIMIT 1;
$$;
CREATE FUNCTION pg_temp.ver(p_id uuid) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT updated_at FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.act(p_id uuid, p_action text, p_key text, p_response text DEFAULT NULL,
  p_message text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.transition_assessment_renewal_stage(p_id, p_action, pg_temp.ver(p_id), p_key,
    '84000000-0000-4000-a000-000000000999', p_response, NULL, NULL, p_message);
$$;
CREATE FUNCTION pg_temp.step(p_n integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.assessment_renewal_contact_plan_for(pg_temp.child(p_n), current_date);
$$;
CREATE FUNCTION pg_temp.renewal_case(p_n integer) RETURNS public.communication_cases LANGUAGE sql AS $$
  SELECT c FROM public.communication_cases c
  WHERE c.source_type = 'contract' AND c.source_id = pg_temp.child(p_n)
    AND c.purpose = 'renewal' AND c.status = 'open'
  ORDER BY c.created_at DESC LIMIT 1;
$$;
CREATE FUNCTION pg_temp.suggest(p_n integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type, c.source_id), NULL, NULL)
  FROM public.communication_cases c WHERE c.id = (pg_temp.renewal_case(p_n)).id;
$$;

SELECT pg_temp.parent(1, current_date + 10);
SELECT pg_temp.parent(2, current_date + 9);
SELECT pg_temp.parent(3, current_date + 8);
SELECT pg_temp.parent(4, current_date + 7);
CREATE TEMP TABLE flow_results (name text PRIMARY KEY, result jsonb);
GRANT SELECT, INSERT ON flow_results TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO flow_results SELECT 'scan', public.process_internal_assessment_renewals(10, 5, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.assessment_contracts
  WHERE parent_contract_id IN (pg_temp.k(1), pg_temp.k(2), pg_temp.k(3), pg_temp.k(4))
    AND renewal_stage = 'contact_pending'), 4, 'the four renewals enter "Enviar mensagem"');
SELECT lives_ok($$SELECT eon_private.ensure_communication_case('contract', pg_temp.child(n), 'renewal')
  FROM generate_series(1, 4) n$$, 'the renewal cases are open in the Central');

-- 3. Pebinha com plano e data, e o lembrete 2 dias depois --------------------------------
SELECT is(pg_temp.suggest(1)->>'action_code', 'renewal_intent', 'the Central suggests the Pebinha');
SELECT is(pg_temp.suggest(1)->>'rule_slug', 'renewal-reminder-14d', 'with the Pebinha model');
SELECT ok(pg_temp.suggest(1)->>'message' LIKE '%seu plano Plano fictício trimestral vence em '
    || to_char(current_date + 10, 'DD/MM') || '%', 'the Pebinha names the plan and its last day');
SELECT is((pg_temp.suggest(1)->>'proposed_next_action_at')::date, current_date + 2,
  'after the Pebinha, the reminder is 2 days later');

SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.child(1), 'message_sent', 'renewal:flow:intent:0001',
  NULL, 'Mensagem fictícia do Pebinha.')$$, 'the Pebinha is registered from the board');
RESET ROLE;
SELECT ok((SELECT renewal_contact_step = 'intent' AND renewal_stage = 'waiting_response'
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)), 'the contract records the Pebinha step');
SELECT is((SELECT payload->>'step' FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.child(1) AND event_type = 'renewal_message_sent'), 'intent',
  'the history records which message was sent');
SELECT is(pg_temp.step(1), jsonb_build_object('step', 'reminder', 'eligible_at', current_date + 2,
  'end_date', current_date + 10, 'next_at', current_date + 10), 'next: reminder in 2 days, then the last day');
SELECT lives_ok($$SELECT eon_private.ensure_communication_case('contract', pg_temp.child(1), 'renewal')$$,
  'the case follows the renewal');
SELECT is((pg_temp.renewal_case(1)).next_action_at, current_date + 2, 'the Central brings the case back on the reminder day');
SELECT is(pg_temp.suggest(1)->>'action_code', 'renewal_reminder', 'the next message is the reminder');
SELECT is(pg_temp.suggest(1)->>'blocked_reason', 'not_due_yet', 'not before its day');
SELECT ok(pg_temp.suggest(1)->>'message' LIKE '%Passando de novo sobre a renovação%',
  'the reminder uses its own model');

-- 4. "Ainda pensando": combinado na hora e retorno em 2 dias ------------------------------
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.child(2), 'message_sent', 'renewal:flow:intent:0002',
  NULL, 'Mensagem fictícia do Pebinha.')$$, 'the Pebinha goes to athlete 2');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.child(2), 'register_response', 'renewal:flow:think:0002',
  'thinking')$$, '"still thinking" is registered');
RESET ROLE;
SELECT is((SELECT renewal_follow_up_at FROM public.assessment_contracts WHERE id = pg_temp.child(2)),
  current_date + 2, 'the return is set 2 days ahead');
SELECT is(pg_temp.step(2)->>'step', 'thinking_ack', 'the "combinado" message is due now');
SELECT lives_ok($$SELECT eon_private.ensure_communication_case('contract', pg_temp.child(2), 'renewal')$$,
  'the case follows the answer');
SELECT is(pg_temp.suggest(2)->>'rule_slug', 'renewal-thinking-ack', 'the Central offers the "combinado" text');
SELECT is(pg_temp.suggest(2)->>'blocked_reason', NULL, 'and it can be sent today');
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.child(2), 'message_sent', 'renewal:flow:ack:0002',
  NULL, 'Combinado, mensagem fictícia.')$$, 'the "combinado" message is registered');
RESET ROLE;
SELECT ok((SELECT renewal_contact_step = 'thinking_ack' AND renewal_follow_up_at = current_date + 2
  FROM public.assessment_contracts WHERE id = pg_temp.child(2)), 'the return date is kept');
SELECT is(pg_temp.step(2)->>'step', 'thinking_return', 'next: the return');
SELECT is((pg_temp.step(2)->>'eligible_at')::date, current_date + 2, 'on the agreed day');

-- 5. Encerramento sem resposta: "Não renovou" com o motivo próprio ------------------------
CREATE TEMP TABLE close_ids AS SELECT pg_temp.child(3) AS id;
GRANT SELECT ON close_ids TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO flow_results SELECT 'nr_prepare', public.prepare_assessment_renewal_resolution(
  (SELECT id FROM close_ids), 'non_renewal', 'no_response', 'Atleta não respondeu à renovação',
  pg_temp.ver((SELECT id FROM close_ids)), 'pending', NULL, false, NULL, false,
  'renewal:flow:noresponse', '84000000-0000-4000-a000-000000000999');
INSERT INTO flow_results SELECT 'nr_claim', public.claim_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid FROM flow_results WHERE name = 'nr_prepare'));
INSERT INTO flow_results SELECT 'nr_record', public.record_assessment_renewal_external_result(
  (SELECT (result->>'operation_id')::uuid FROM flow_results WHERE name = 'nr_prepare'),
  (SELECT (result->>'lease_token')::uuid FROM flow_results WHERE name = 'nr_claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb);
INSERT INTO flow_results SELECT 'nr_complete', public.complete_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid FROM flow_results WHERE name = 'nr_prepare'),
  (SELECT (result->>'lease_token')::uuid FROM flow_results WHERE name = 'nr_claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb);
RESET ROLE;
SELECT is((SELECT result->>'status' FROM flow_results WHERE name = 'nr_complete'), 'completed',
  '"no answer" closes through the safe resolution');
SELECT ok((SELECT renewal_stage = 'not_renewed' AND renewal_response_code IS NULL
  FROM public.assessment_contracts WHERE id = (SELECT id FROM close_ids)),
  'it goes to "Não renovou" without pretending the athlete answered');
SELECT throws_ok($$SELECT public.prepare_assessment_renewal_resolution(
  pg_temp.child(4), 'non_renewal', 'no_response', 'Outro texto',
  pg_temp.ver(pg_temp.child(4)), 'pending', NULL, false, NULL, false,
  'renewal:flow:badtext', '84000000-0000-4000-a000-000000000999')$$, '22023', NULL,
  'the reason text stays canonical');

-- 6. Despedida de quem não renova --------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.act((SELECT id FROM close_ids), 'farewell_sent',
  'renewal:flow:farewell:0003', NULL, 'Despedida fictícia.')$$, 'the farewell is registered');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.assessment_contract_event
  WHERE contract_id = (SELECT id FROM close_ids) AND event_type = 'renewal_farewell_sent'
    AND payload->>'step' = 'farewell'), 1, 'it stays in the contract history');
SELECT is((SELECT renewal_stage FROM public.assessment_contracts WHERE id = (SELECT id FROM close_ids)),
  'not_renewed', 'and does not change the outcome');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.child(4), 'farewell_sent', 'renewal:flow:farewell:0004',
  NULL, 'Despedida fictícia.')$$, 'P0001', NULL, 'no farewell while the renewal is open');
RESET ROLE;

-- 7. Primeira cobrança da renovação: "renovação confirmada" -------------------------------
CREATE FUNCTION pg_temp.billing(p_id uuid, p_extra jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT eon_private.communication_case_suggestion(
    jsonb_populate_record(NULL::public.communication_cases, jsonb_build_object(
      'id', '84000000-0000-4000-a000-000000000777', 'source_type', 'contract',
      'source_id', p_id, 'purpose', 'billing', 'status', 'open', 'hold_kind', 'none',
      'next_action_at', current_date)),
    eon_private.communication_source_context('contract', p_id) || p_extra, NULL, NULL);
$$;
SELECT is(pg_temp.billing(pg_temp.child(4), jsonb_build_object('payment_status', 'charge_sent',
    'payment_link', 'https://example.test/pay/renovacao', 'due_date', current_date + 8, 'balance', 600,
    'payment_message_sent_at', NULL))->>'rule_slug',
  'billing-renewal-confirmed', 'a renewal charge starts with "renovação confirmada"');
SELECT ok(pg_temp.billing(pg_temp.child(4), jsonb_build_object('payment_status', 'charge_sent',
    'payment_link', 'https://example.test/pay/renovacao', 'due_date', current_date + 8, 'balance', 600,
    'payment_message_sent_at', NULL))->>'message' LIKE '%Sua renovação%está confirmada%',
  'with the confirmation text');
SELECT is(pg_temp.billing(pg_temp.k(4), jsonb_build_object('payment_status', 'charge_sent',
    'payment_link', 'https://example.test/pay/novo', 'due_date', current_date + 8, 'balance', 600,
    'payment_message_sent_at', NULL))->>'rule_slug',
  'billing-charge-send', 'a first contract keeps the usual charge');

-- 8. A trava do navegador cobre o passo de contato ---------------------------------------
SELECT ok(pg_get_functiondef('eon_private.guard_assessment_renewal_stage_columns()'::regprocedure)
  LIKE '%renewal_contact_step%', 'only the server records the contact step');

SELECT * FROM finish();
ROLLBACK;
