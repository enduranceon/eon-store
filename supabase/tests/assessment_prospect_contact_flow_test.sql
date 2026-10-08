BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';
SELECT no_plan();

-- Fictional prospects walk the proposal message flow: first contact without a
-- link, the answer, the reminder, the closing message and the link deadline.
-- Sending stays manual; every step is a registration by the operator.
SELECT ok(has_function_privilege('service_role', 'public.register_assessment_prospect_contact(uuid,text,boolean,timestamptz,uuid)', 'EXECUTE'), 'backend can register contacts');
SELECT ok(NOT has_function_privilege('authenticated', 'public.register_assessment_prospect_contact(uuid,text,boolean,timestamptz,uuid)', 'EXECUTE'), 'browser cannot bypass the admin API');
SELECT ok(NOT has_function_privilege('anon', 'public.register_assessment_prospect_contact(uuid,text,boolean,timestamptz,uuid)', 'EXECUTE'), 'anonymous cannot register contacts');
SELECT ok(bool_and(NOT prosecdef AND 'search_path=""' = ANY(proconfig)), 'contact registration uses caller privileges and an empty search path')
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'register_assessment_prospect_contact';

INSERT INTO auth.users (id, email) VALUES ('82000000-0000-4000-a000-000000000001', 'proposta-admin@example.test');
INSERT INTO public.assessment_modalities (id, name) VALUES ('82000000-0000-4000-a000-000000000002', 'proposta-test-modality');
INSERT INTO public.assessment_plans (id, name, modality_id, period, period_months, price_monthly, price_total, max_installments, enrollment_fee)
VALUES ('82000000-0000-4000-a000-000000000003', 'Plano fictício da proposta', '82000000-0000-4000-a000-000000000002', 'mensal', 1, 300, 300, 1, 0),
       ('82000000-0000-4000-a000-000000000005', 'Outro plano fictício', '82000000-0000-4000-a000-000000000002', 'mensal', 1, 320, 320, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('82000000-0000-4000-a000-000000000004', 'Coach fictício da proposta', 'proposta-coach@example.test', 'senior', ARRAY['82000000-0000-4000-a000-000000000002'::uuid]);

CREATE FUNCTION pg_temp.prospect(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT (public.create_manual_assessment_prospect(
    'Pessoa Proposta ' || p_n, '519999982' || lpad(p_n::text, 2, '0'), NULL, NULL,
    '82000000-0000-4000-a000-000000000003', '82000000-0000-4000-a000-000000000004',
    1, NULL, 'proposta:test:' || p_n, '82000000-0000-4000-a000-000000000001', NULL, NULL
  )->'contract'->>'id')::uuid;
$$;
CREATE FUNCTION pg_temp.act(p_id uuid, p_action text, p_confirm boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.register_assessment_prospect_contact(
    p_id, p_action, p_confirm,
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_id),
    '82000000-0000-4000-a000-000000000001');
$$;
CREATE FUNCTION pg_temp.stage(p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT prospect_stage FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.proposal(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.prepare_assessment_prospect_proposal(
    p_id, 0, 0, 'https://www.asaas.com/i/ficticio' || left(p_id::text, 8), current_date + 1,
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_id),
    '82000000-0000-4000-a000-000000000001');
$$;
CREATE FUNCTION pg_temp.sent(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.mark_assessment_prospect_message_sent(
    p_id, (SELECT updated_at FROM public.assessment_contracts WHERE id = p_id),
    '82000000-0000-4000-a000-000000000001');
$$;
CREATE FUNCTION pg_temp.lose(p_id uuid, p_reason text, p_confirm boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.lose_assessment_prospect(
    p_id, p_reason, NULL, p_confirm,
    (SELECT updated_at FROM public.assessment_contracts WHERE id = p_id),
    '82000000-0000-4000-a000-000000000001');
$$;
CREATE TEMP TABLE ids(n integer PRIMARY KEY, id uuid);
GRANT ALL ON ids TO service_role;
CREATE TEMP TABLE financial_baseline AS SELECT count(*) AS payments FROM public.asaas_payments;
GRANT SELECT ON financial_baseline TO service_role;
CREATE FUNCTION pg_temp.c(p_n integer) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM ids WHERE n = p_n $$;

SET LOCAL ROLE service_role;
INSERT INTO ids SELECT n, pg_temp.prospect(n) FROM generate_series(1, 5) n;

-- 1. First contact moves the new prospect to "Aguardando resposta".
SELECT is(pg_temp.stage(pg_temp.c(1)), 'new', 'a manual prospect starts as new');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(1), 'first_contact')$$, 'the first contact is registered');
SELECT is(pg_temp.stage(pg_temp.c(1)), 'awaiting_reply', 'the card moves to awaiting reply');
SELECT ok((SELECT prospect_first_contact_at IS NOT NULL AND prospect_last_contact_at IS NOT NULL
  AND prospect_followup_sent_at IS NULL FROM public.assessment_contracts WHERE id = pg_temp.c(1)),
  'the first contact starts the clock');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.c(1) AND event_type = 'prospect_first_contact_sent'), 1, 'the first contact is in the history');
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.c(1), 'first_contact')$$, 'P0001', 'O primeiro contato é só para prospects novos',
  'the first contact is not registered twice');
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.c(1), 'conversation')$$, 'P0001', NULL,
  'a conversation is only registered while clarifying');

-- 2. Reminder, then questions: the clock starts again.
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(1), 'follow_up')$$, 'the reminder is registered');
SELECT ok((SELECT prospect_followup_sent_at IS NOT NULL FROM public.assessment_contracts WHERE id = pg_temp.c(1)),
  'the reminder date is saved');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(1), 'has_questions')$$, 'an answer with questions is registered');
SELECT is(pg_temp.stage(pg_temp.c(1)), 'clarifying', 'the card moves to clarifying');
SELECT ok((SELECT prospect_followup_sent_at IS NULL FROM public.assessment_contracts WHERE id = pg_temp.c(1)),
  'answering restarts the reminder clock');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(1), 'follow_up')$$, 'a reminder can follow a stalled conversation');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(1), 'conversation')$$, 'a new conversation is registered');
SELECT ok((SELECT prospect_followup_sent_at IS NULL FROM public.assessment_contracts WHERE id = pg_temp.c(1)),
  'a conversation restarts the clock');
SELECT throws_ok($$SELECT public.register_assessment_prospect_contact(pg_temp.c(1), 'conversation', false,
  now() - interval '1 day', '82000000-0000-4000-a000-000000000001')$$, 'P0001', NULL, 'a stale card cannot register a contact');
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.c(1), 'call')$$, '22023', NULL, 'unknown actions are rejected');

-- 3. Closing without a link archives as "no response".
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(1), 'closing')$$, 'the closing message is registered');
SELECT is((SELECT prospect_stage || ':' || status || ':' || prospect_loss_reason_code FROM public.assessment_contracts WHERE id = pg_temp.c(1)),
  'lost:voided:no_response', 'closing without a link archives as no response');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.c(1) AND event_type IN ('prospect_closing_sent', 'prospect_lost')), 2,
  'the closing and the archive are in the history');
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.c(1), 'follow_up')$$, 'P0001', 'Este prospect não está mais em negociação',
  'an archived prospect takes no more messages');

-- 4. Questions straight from "Novos", then the proposal with a link.
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(2), 'has_questions')$$, 'a new prospect can start with questions');
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.c(2), 'first_contact')$$, 'P0001', NULL, 'no first contact after the conversation began');
SELECT lives_ok($$SELECT pg_temp.proposal(pg_temp.c(2))$$, 'the proposal can be prepared from clarifying');
SELECT is(pg_temp.stage(pg_temp.c(2)), 'proposal_ready', 'the proposal is ready');
SELECT throws_ok($$SELECT pg_temp.act(pg_temp.c(2), 'closing')$$, 'P0001', NULL, 'no closing before the link is sent');
SELECT lives_ok($$SELECT pg_temp.sent(pg_temp.c(2))$$, 'the link message is sent');
SELECT ok((SELECT prospect_payment_reminder_sent_at IS NULL FROM public.assessment_contracts WHERE id = pg_temp.c(2)),
  'the first send is not a reminder');
SELECT lives_ok($$SELECT pg_temp.sent(pg_temp.c(2))$$, 'the payment reminder is a resend');
SELECT ok((SELECT prospect_payment_reminder_sent_at IS NOT NULL FROM public.assessment_contracts WHERE id = pg_temp.c(2)),
  'the payment reminder date is saved');

-- 5. Closing with a link keeps it active for two more days.
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(2), 'closing')$$, 'the closing with link is registered');
SELECT is((SELECT prospect_stage FROM public.assessment_contracts WHERE id = pg_temp.c(2)), 'payment_link_sent',
  'the link stays open until the deadline');
SELECT is((SELECT prospect_close_deadline FROM public.assessment_contracts WHERE id = pg_temp.c(2)),
  (now() AT TIME ZONE 'America/Sao_Paulo')::date + 2, 'the final deadline is two days later');
SELECT lives_ok($$SELECT pg_temp.sent(pg_temp.c(2))$$, 'a new send after the closing is allowed');
SELECT ok((SELECT prospect_closing_sent_at IS NULL AND prospect_close_deadline IS NULL FROM public.assessment_contracts WHERE id = pg_temp.c(2)),
  'resending the link removes the deadline');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(2), 'closing')$$, 'the closing can be sent again');
SELECT throws_ok($$SELECT pg_temp.lose(pg_temp.c(2), 'no_response')$$, 'P0001',
  'Confirme que o link externo foi cancelado antes de encerrar o prospect', 'archiving asks for the cancelled link');
SELECT lives_ok($$SELECT pg_temp.lose(pg_temp.c(2), 'no_response', true)$$, 'archiving after the deadline works');
SELECT is(pg_temp.stage(pg_temp.c(2)), 'lost', 'the unpaid proposal is archived');

-- 6. New loss reasons and the manual-prospect guard.
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(3), 'first_contact')$$, 'first contact for the wrong-number case');
SELECT throws_ok($$SELECT public.create_manual_assessment_prospect('Pessoa Proposta 3', '51999998203', NULL, NULL,
  '82000000-0000-4000-a000-000000000003', '82000000-0000-4000-a000-000000000004', 1, NULL, 'proposta:test:dup',
  '82000000-0000-4000-a000-000000000001', NULL, NULL)$$, 'P0001', 'Este cliente já possui um prospect em negociação',
  'a prospect awaiting reply blocks a duplicate');
SELECT lives_ok($$SELECT pg_temp.lose(pg_temp.c(3), 'invalid_contact')$$, 'wrong number is a loss reason');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(4), 'has_questions')$$, 'questions for the other-service case');
SELECT lives_ok($$SELECT pg_temp.lose(pg_temp.c(4), 'other_service')$$, 'another service is a loss reason');

-- 7. A plan change clears the old link closing, not the first contact.
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(5), 'first_contact')$$, 'first contact before the plan change');
SELECT lives_ok($$SELECT pg_temp.proposal(pg_temp.c(5))$$, 'proposal before the plan change');
SELECT lives_ok($$SELECT pg_temp.sent(pg_temp.c(5))$$, 'link sent before the plan change');
SELECT lives_ok($$SELECT pg_temp.act(pg_temp.c(5), 'closing')$$, 'closing before the plan change');
RESET ROLE;
UPDATE public.assessment_contracts SET plan_id = '82000000-0000-4000-a000-000000000005' WHERE id = pg_temp.c(5);
SELECT is((SELECT prospect_stage || ':' || (prospect_closing_sent_at IS NULL)::text || ':' || (prospect_close_deadline IS NULL)::text
  || ':' || (prospect_first_contact_at IS NOT NULL)::text FROM public.assessment_contracts WHERE id = pg_temp.c(5)),
  'new:true:true:true', 'the plan change resets the link closing and keeps the first contact');
SELECT throws_ok($$UPDATE public.assessment_contracts SET prospect_stage = 'awaiting_reply', prospect_last_contact_at = NULL
  WHERE id = pg_temp.c(5)$$, '23514', NULL, 'awaiting reply always has a contact date');
SELECT is((SELECT count(*) FROM public.asaas_payments), (SELECT payments FROM financial_baseline),
  'no payment record is created by the message flow');

SELECT * FROM finish();
ROLLBACK;
