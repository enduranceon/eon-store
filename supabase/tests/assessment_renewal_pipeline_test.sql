BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
-- As regras usam a data de São Paulo; o current_date das fixtures também.
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(82);

-- Acesso ----------------------------------------------------------------------

SELECT ok(
  has_function_privilege('service_role', 'public.transition_assessment_renewal_stage(uuid,text,timestamptz,text,uuid,text,date,text,text)', 'EXECUTE'),
  'service_role can move the renewal pipeline'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.transition_assessment_renewal_stage(uuid,text,timestamptz,text,uuid,text,date,text,text)', 'EXECUTE'),
  'the browser cannot call the pipeline transition directly'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.transition_assessment_renewal_stage(uuid,text,timestamptz,text,uuid,text,date,text,text)', 'EXECUTE'),
  'anonymous callers cannot move the pipeline'
);
SELECT ok(
  NOT (SELECT prosecdef FROM pg_catalog.pg_proc
       WHERE oid = 'public.transition_assessment_renewal_stage(uuid,text,timestamptz,text,uuid,text,date,text,text)'::regprocedure)
  AND (SELECT 'search_path=""' = ANY(proconfig) FROM pg_catalog.pg_proc
       WHERE oid = 'public.transition_assessment_renewal_stage(uuid,text,timestamptz,text,uuid,text,date,text,text)'::regprocedure),
  'the transition keeps caller privileges and an empty search path'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_renewal_pipeline_issues', 'SELECT'),
  'anonymous callers cannot read the pipeline checks'
);

-- Fixtures fictícias ----------------------------------------------------------

INSERT INTO public.assessment_modalities (id, name)
VALUES ('80000000-0000-4000-a000-000000000001', 'quadro-renovacao-test');

INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee
) VALUES
  ('80000000-0000-4000-a000-000000000011', '80000000-0000-4000-a000-000000000001',
   'Quadro mensal', 'mensal', 1, 200, 200, 1, 0),
  ('80000000-0000-4000-a000-000000000012', '80000000-0000-4000-a000-000000000001',
   'Quadro semestral', 'semestral', 6, 200, 1200, 6, 0);

INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES (
  '80000000-0000-4000-a000-000000000021', 'Coach do quadro', 'quadro@example.test', 'pleno',
  ARRAY['80000000-0000-4000-a000-000000000001'::uuid]
);

INSERT INTO public.payment_methods (id, group_name, name, kind, installments, credit_days_first)
VALUES ('80000000-0000-4000-a000-000000000031', 'Teste', 'PIX do quadro', 'pix', 1, 0);

INSERT INTO public.presale_customers (id, full_name, whatsapp)
SELECT ('80000000-0000-4000-a000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'Atleta do quadro ' || n,
       '119000081' || lpad(n::text, 2, '0')
FROM generate_series(1, 20) AS n;

CREATE FUNCTION pg_temp.snap(p_months integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN p_months = 1
    THEN '{"plan_id":"80000000-0000-4000-a000-000000000011","name":"Quadro mensal","period":"mensal","period_months":1,"price_total":200,"price_monthly":200,"modality_id":"80000000-0000-4000-a000-000000000001"}'::jsonb
    ELSE '{"plan_id":"80000000-0000-4000-a000-000000000012","name":"Quadro semestral","period":"semestral","period_months":6,"price_total":1200,"price_monthly":200,"modality_id":"80000000-0000-4000-a000-000000000001"}'::jsonb
  END;
$$;
CREATE FUNCTION pg_temp.parent(
  p_n integer, p_months integer, p_status text, p_start date, p_end date, p_auto boolean
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.assessment_contracts (
    id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
    start_date, end_date, original_end_date, installments, payment_method,
    payment_status, payment_date, manual_payment, auto_renewal, renewal_generated
  ) VALUES (
    ('80000000-0000-4000-a000-0000000002' || lpad(p_n::text, 2, '0'))::uuid,
    'ASS-98' || lpad(p_n::text, 4, '0'),
    ('80000000-0000-4000-a000-0000000001' || lpad(p_n::text, 2, '0'))::uuid,
    '80000000-0000-4000-a000-000000000021',
    CASE WHEN p_months = 1 THEN '80000000-0000-4000-a000-000000000011'::uuid
      ELSE '80000000-0000-4000-a000-000000000012'::uuid END,
    pg_temp.snap(p_months), p_status, p_start, p_end, p_end, 1, 'pix',
    'paid', p_start, true, p_auto, false
  );
$$;
CREATE FUNCTION pg_temp.k(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('80000000-0000-4000-a000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
$$;
CREATE FUNCTION pg_temp.child(p_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.assessment_contracts
  WHERE parent_contract_id = pg_temp.k(p_n)
  ORDER BY created_at DESC, id
  LIMIT 1;
$$;
CREATE FUNCTION pg_temp.stage(p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT renewal_stage FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.ver(p_id uuid) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT updated_at FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.act(
  p_id uuid, p_action text, p_key text,
  p_response text DEFAULT NULL, p_follow_up date DEFAULT NULL,
  p_notes text DEFAULT NULL, p_message text DEFAULT NULL
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.transition_assessment_renewal_stage(
    p_id, p_action, pg_temp.ver(p_id), p_key,
    '80000000-0000-4000-a000-000000000999',
    p_response, p_follow_up, p_notes, p_message
  );
$$;

-- K1 semestral manual vence em 10 dias (entra); K2 em 11 (ainda não).
SELECT pg_temp.parent(1, 6, 'active', current_date - 172, current_date + 10, false);
SELECT pg_temp.parent(2, 6, 'active', current_date - 171, current_date + 11, false);
-- K3 mensal automática vence em 5 dias (entra); K4 em 6 (ainda não).
SELECT pg_temp.parent(3, 1, 'active', current_date - 25, current_date + 5, true);
SELECT pg_temp.parent(4, 1, 'active', current_date - 24, current_date + 6, true);
-- K5: automática legada em plano semestral; segue o fluxo manual.
ALTER TABLE public.assessment_contracts DISABLE TRIGGER trg_enforce_monthly_auto_renewal;
SELECT pg_temp.parent(5, 6, 'active', current_date - 174, current_date + 8, true);
ALTER TABLE public.assessment_contracts ENABLE TRIGGER trg_enforce_monthly_auto_renewal;
-- K6 venceu há 40 dias sem renovação (rotina parada).
SELECT pg_temp.parent(6, 1, 'overdue', current_date - 70, current_date - 40, false);
-- K7, K8, K9 e K10 mensais manuais perto do fim.
SELECT pg_temp.parent(7, 1, 'active', current_date - 27, current_date + 3, false);
SELECT pg_temp.parent(8, 1, 'active', current_date - 26, current_date + 4, false);
SELECT pg_temp.parent(9, 1, 'active', current_date - 21, current_date + 9, false);
SELECT pg_temp.parent(10, 1, 'active', current_date - 28, current_date + 2, false);

CREATE TEMPORARY TABLE pipeline_results (name text PRIMARY KEY, result jsonb);
GRANT SELECT, INSERT ON pipeline_results TO service_role;

-- Rotina diária ---------------------------------------------------------------

SET LOCAL ROLE service_role;
INSERT INTO pipeline_results
SELECT 'scan', public.process_internal_assessment_renewals(10, 5, NULL);
RESET ROLE;

SELECT is((SELECT (result->>'drafts_created')::int FROM pipeline_results WHERE name = 'scan'), 7,
  'manual renewals inside ten days become drafts');
SELECT is((SELECT (result->>'automatic_renewals_scheduled')::int FROM pipeline_results WHERE name = 'scan'), 1,
  'the monthly automatic renewal is scheduled five days before');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = pg_temp.child(1)), 'draft',
  'the semiannual renewal waits for the athlete');
SELECT is(pg_temp.stage(pg_temp.child(1)), 'contact_pending',
  'a manual renewal enters the board in "Enviar mensagem"');
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.child(1) AND event_type = 'renewal_pipeline_entered'
    AND payload->>'stage_after' = 'contact_pending'
), 'the board entry is recorded in the renewal history');
SELECT is((SELECT count(*)::int FROM public.assessment_contracts WHERE parent_contract_id = pg_temp.k(2)), 0,
  'a manual renewal eleven days ahead is not created yet');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = pg_temp.child(3)), 'scheduled',
  'the monthly automatic renewal is scheduled');
SELECT is(pg_temp.stage(pg_temp.child(3)), 'waiting_payment',
  'the monthly automatic renewal goes straight to "Aguardando pagamento"');
SELECT ok((SELECT auto_renewal
    AND asaas_charge_id IS NULL AND asaas_payment_link IS NULL AND external_payment_link IS NULL
  FROM public.assessment_contracts WHERE id = pg_temp.child(3)),
  'the automatic renewal does not create a charge');
SELECT is((SELECT count(*)::int FROM public.assessment_contracts WHERE parent_contract_id = pg_temp.k(4)), 0,
  'a monthly automatic renewal six days ahead is not created yet');
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = pg_temp.child(5)), 'draft',
  'a legacy automatic semiannual contract follows the manual flow');
SELECT ok(NOT (SELECT auto_renewal FROM public.assessment_contracts WHERE id = pg_temp.child(5)),
  'its renewal does not carry the automatic flag');
SELECT is(pg_temp.stage(pg_temp.child(6)), 'contact_pending',
  'a contract that expired 40 days ago still gets its renewal on the board');

SET LOCAL ROLE service_role;
INSERT INTO pipeline_results
SELECT 'repeat', public.process_internal_assessment_renewals(10, 5, NULL);
RESET ROLE;

SELECT is((SELECT (result->>'processed')::int FROM pipeline_results WHERE name = 'repeat'), 0,
  'running the routine again changes nothing');
SELECT is((SELECT count(*)::int FROM public.assessment_contracts
  WHERE parent_contract_id IN (SELECT pg_temp.k(n) FROM generate_series(1, 10) AS n)), 8,
  'running the routine again does not duplicate renewals');

-- Mensagem, resposta, follow-up e mudança -------------------------------------

SET LOCAL ROLE service_role;
SELECT throws_ok(
  format($$SELECT public.transition_assessment_renewal_stage(%L, 'message_sent', %L, 'rs:test:stale01', '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.child(1), now() - interval '1 day'),
  'P0001',
  'A renovação foi alterada por outra ação. Atualize a página e tente novamente',
  'a stale version is rejected'
);
INSERT INTO pipeline_results
SELECT 'message', pg_temp.act(pg_temp.child(1), 'message_sent', 'rs:test:message01', NULL, NULL, NULL, 'Oi! Mensagem de teste.');
RESET ROLE;

SELECT is(pg_temp.stage(pg_temp.child(1)), 'waiting_response',
  'after the message the card waits for the decision');
SELECT ok((SELECT renewal_last_contact_at IS NOT NULL FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  'the last contact is recorded');
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.child(1) AND event_type = 'renewal_message_sent'
    AND created_by = '80000000-0000-4000-a000-000000000999'
    AND payload->>'stage_before' = 'contact_pending'
    AND payload->>'stage_after' = 'waiting_response'
), 'the message is recorded with who sent it and the stages');

SET LOCAL ROLE service_role;
INSERT INTO pipeline_results
SELECT 'message_replay', public.transition_assessment_renewal_stage(
  pg_temp.child(1), 'message_sent',
  (SELECT (result->'contract'->>'updated_at')::timestamptz FROM pipeline_results WHERE name = 'message') - interval '1 day',
  'rs:test:message01', '80000000-0000-4000-a000-000000000999');
RESET ROLE;

SELECT is((SELECT result->>'replayed' FROM pipeline_results WHERE name = 'message_replay'), 'true',
  'a repeated request with the same key returns the first result');
SELECT is((SELECT count(*)::int FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.child(1) AND event_type = 'renewal_message_sent'), 1,
  'a repeated request does not duplicate the message event');

SET LOCAL ROLE service_role;
SELECT throws_ok(
  format($$SELECT pg_temp.act(%L, 'set_follow_up', 'rs:test:message01', NULL, current_date + 1)$$, pg_temp.child(1)),
  '22023', 'A chave de idempotência já foi usada em outra ação',
  'a key cannot be reused for another action'
);
SELECT throws_ok(
  format($$SELECT pg_temp.act(%L, 'register_response', 'rs:test:notrenew1', 'not_renewing')$$, pg_temp.child(1)),
  '22023', 'Para "Não vou renovar", use o encerramento da renovação',
  '"Não vou renovar" goes through the safe resolution'
);
SELECT lives_ok(
  format($$SELECT pg_temp.act(%L, 'register_response', 'rs:test:thinking1', 'thinking', current_date + 3)$$, pg_temp.child(1)),
  'the athlete is still thinking'
);
RESET ROLE;

SELECT ok((SELECT renewal_stage = 'waiting_response'
    AND renewal_response_code = 'thinking'
    AND renewal_follow_up_at = current_date + 3
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  '"Ainda estou pensando" keeps the card waiting with a follow-up date');

SET LOCAL ROLE service_role;
SELECT throws_ok(
  format($$SELECT pg_temp.act(%L, 'set_follow_up', 'rs:test:pastfu01', NULL, current_date - 1)$$, pg_temp.child(1)),
  '22023', 'Informe um follow-up a partir de hoje',
  'a follow-up in the past is rejected'
);
SELECT lives_ok(
  format($$SELECT pg_temp.act(%L, 'register_response', 'rs:test:change001', 'change_plan_or_coach')$$, pg_temp.child(1)),
  'the athlete wants to change plan or coach'
);
RESET ROLE;

SELECT ok((SELECT renewal_stage = 'waiting_response' AND renewal_response_code = 'change_plan_or_coach'
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  'a change request keeps the card waiting, without churn');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  format($$SELECT pg_temp.act(%L, 'change_resolved', 'rs:test:resolved1')$$, pg_temp.child(1)),
  'the change is resolved'
);
RESET ROLE;

SELECT ok((SELECT renewal_stage = 'charge_pending' AND renewal_follow_up_at IS NULL
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  'after the change the card goes to "Enviar cobrança"');

SET LOCAL ROLE service_role;
SELECT throws_ok(
  format($$SELECT pg_temp.act(%L, 'change_resolved', 'rs:test:resolved2')$$, pg_temp.child(1)),
  'P0001', 'Não há mudança de plano ou treinador pendente nesta renovação',
  'a change cannot be resolved twice'
);
SELECT throws_ok(
  format($$SELECT pg_temp.act(%L, 'message_sent', 'rs:test:latemsg1')$$, pg_temp.child(1)),
  'P0001', 'A mensagem de renovação só pode ser registrada antes da decisão do atleta',
  'the intent message is not accepted after the decision'
);

-- Cobrança, pagamento e pagamento desfeito ------------------------------------

SELECT lives_ok(
  format($$SELECT public.save_assessment_contract_external_charge(%L, 'https://pagamento.example.test/r1', current_date + 10, 'pix', NULL, 'renewals_page', %L, '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.child(1), pg_temp.ver(pg_temp.child(1))),
  'the external charge is registered on the draft'
);
RESET ROLE;

SELECT ok((SELECT status = 'scheduled' AND renewal_stage = 'waiting_payment'
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  'registering the charge opens the sale and moves the card to "Aguardando pagamento"');
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.child(1) AND event_type = 'renewal_stage_changed'
    AND payload->>'action' = 'sale_opened'
    AND payload->>'stage_before' = 'charge_pending'
), 'the automatic move is recorded with its cause');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  format($$SELECT public.api_record_manual_payment('contract', %L, '80000000-0000-4000-a000-000000000031', current_date, 1200, jsonb_build_array(jsonb_build_object('number', 1, 'due_date', current_date, 'credit_date', current_date, 'value', 1200)), '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.child(1)),
  'the payment is recorded by the financial flow'
);
RESET ROLE;

SELECT is(pg_temp.stage(pg_temp.child(1)), 'renewed',
  'a confirmed payment moves the card to "Renovou" in the database');
SELECT ok((SELECT payment_status = 'paid' AND renewal_resolved_at IS NOT NULL
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  'the renewal records when it was resolved');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  format($$SELECT public.api_reopen_manual_payment('contract', %L, '80000000-0000-4000-a000-000000000999')$$, pg_temp.child(1)),
  'the payment is undone'
);
RESET ROLE;

SELECT ok((SELECT renewal_stage = 'waiting_payment' AND renewal_resolved_at IS NULL
  FROM public.assessment_contracts WHERE id = pg_temp.child(1)),
  'an undone payment brings the card back to "Aguardando pagamento"');
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.child(1) AND event_type = 'renewal_stage_changed'
    AND payload->>'action' = 'payment_reverted'
), 'the undone payment is recorded on the renewal');

-- "Vou renovar" e aprovação ---------------------------------------------------

SET LOCAL ROLE service_role;
SELECT lives_ok(
  format($$SELECT pg_temp.act(%L, 'register_response', 'rs:test:willrenew', 'will_renew')$$, pg_temp.child(10)),
  'an answer can be recorded before the message when the athlete writes first'
);
RESET ROLE;
SELECT is(pg_temp.stage(pg_temp.child(10)), 'charge_pending',
  '"Sim, vou renovar" moves the card to "Enviar cobrança"');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  format($$SELECT public.activate_assessment_contract_renewal(%L, %L, '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.child(10), pg_temp.ver(pg_temp.child(10))),
  'the renewal is approved'
);
RESET ROLE;
SELECT ok((SELECT status = 'scheduled' AND renewal_stage = 'waiting_payment'
  FROM public.assessment_contracts WHERE id = pg_temp.child(10)),
  'an approved renewal waits for payment');

-- A data não tira o card do quadro ---------------------------------------------

SELECT lives_ok(
  $$SELECT public.apply_assessment_contract_transitions('80000000-0000-4000-a000-000000000999')$$,
  'the daily transitions run'
);
SET LOCAL ROLE service_role;
INSERT INTO pipeline_results
SELECT 'repeat2', public.process_internal_assessment_renewals(10, 5, NULL);
RESET ROLE;
SELECT ok((SELECT status = 'draft' AND renewal_stage = 'contact_pending'
  FROM public.assessment_contracts WHERE id = pg_temp.child(6)),
  'a renewal 40 days past the end date stays in "Enviar mensagem"');

-- Não renovou, venda descartada e contrato anterior cancelado -------------------

SET LOCAL ROLE service_role;
INSERT INTO pipeline_results
SELECT 'nr_prepare', public.prepare_assessment_renewal_resolution(
  pg_temp.child(7), 'non_renewal', 'customer_declined', 'Atleta decidiu não renovar',
  pg_temp.ver(pg_temp.child(7)), 'pending', NULL, false, NULL, false,
  'renewal:pipeline:nonrenewal', '80000000-0000-4000-a000-000000000999');
INSERT INTO pipeline_results
SELECT 'nr_claim', public.claim_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid FROM pipeline_results WHERE name = 'nr_prepare'));
INSERT INTO pipeline_results
SELECT 'nr_record', public.record_assessment_renewal_external_result(
  (SELECT (result->>'operation_id')::uuid FROM pipeline_results WHERE name = 'nr_prepare'),
  (SELECT (result->>'lease_token')::uuid FROM pipeline_results WHERE name = 'nr_claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb);
INSERT INTO pipeline_results
SELECT 'nr_complete', public.complete_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid FROM pipeline_results WHERE name = 'nr_prepare'),
  (SELECT (result->>'lease_token')::uuid FROM pipeline_results WHERE name = 'nr_claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb);
RESET ROLE;

SELECT is((SELECT result->>'status' FROM pipeline_results WHERE name = 'nr_complete'), 'completed',
  'the safe resolution completes');
SELECT ok((SELECT renewal_stage = 'not_renewed' AND renewal_response_code = 'not_renewing'
    AND renewal_resolved_at IS NOT NULL
  FROM public.assessment_contracts WHERE id = pg_temp.child(7)),
  'a real non-renewal goes to "Não renovou"');
SELECT is((SELECT cancellation_reason FROM public.assessment_contracts WHERE id = pg_temp.k(7)), 'Não renovou',
  'the previous contract records the non-renewal');

SET LOCAL ROLE service_role;
INSERT INTO pipeline_results
SELECT 'dc_prepare', public.prepare_assessment_renewal_resolution(
  pg_temp.child(8), 'discard', 'created_in_error', 'Renovação criada por engano',
  pg_temp.ver(pg_temp.child(8)), 'pending', NULL, false, NULL, false,
  'renewal:pipeline:discard01', '80000000-0000-4000-a000-000000000999');
INSERT INTO pipeline_results
SELECT 'dc_claim', public.claim_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid FROM pipeline_results WHERE name = 'dc_prepare'));
INSERT INTO pipeline_results
SELECT 'dc_record', public.record_assessment_renewal_external_result(
  (SELECT (result->>'operation_id')::uuid FROM pipeline_results WHERE name = 'dc_prepare'),
  (SELECT (result->>'lease_token')::uuid FROM pipeline_results WHERE name = 'dc_claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb);
INSERT INTO pipeline_results
SELECT 'dc_complete', public.complete_assessment_renewal_resolution(
  (SELECT (result->>'operation_id')::uuid FROM pipeline_results WHERE name = 'dc_prepare'),
  (SELECT (result->>'lease_token')::uuid FROM pipeline_results WHERE name = 'dc_claim'),
  '{"provider":"none","outcome":"not_required"}'::jsonb);
RESET ROLE;

SELECT ok((SELECT renewal_stage = 'discarded' AND renewal_response_code IS NULL
  FROM public.assessment_contracts
  WHERE parent_contract_id = pg_temp.k(8) AND status = 'voided'),
  'a sale created by mistake is discarded without counting as churn');
SELECT ok(NULLIF(btrim((SELECT cancellation_reason FROM public.assessment_contracts WHERE id = pg_temp.k(8))), '') IS NULL,
  'discarding does not mark the previous contract as a non-renewal');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  format($$SELECT public.cancel_assessment_contract(%L, current_date, 0, 'Solicitação da atleta', %L, '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.k(9), pg_temp.ver(pg_temp.k(9))),
  'the previous contract is cancelled'
);
RESET ROLE;
SELECT ok((SELECT status = 'voided' AND renewal_stage = 'discarded'
  FROM public.assessment_contracts WHERE parent_contract_id = pg_temp.k(9)),
  'the clean renewal of a cancelled contract leaves the board without a non-renewal');

-- Só o servidor muda a etapa ---------------------------------------------------

INSERT INTO auth.users (id, email)
VALUES ('80000000-0000-4000-a000-000000000998', 'quadro-admin@example.test');
INSERT INTO public.app_admins (user_id) VALUES ('80000000-0000-4000-a000-000000000998');
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.assessment_contracts', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.assessment_contracts', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.assessment_contracts', 'UPDATE'),
  'the browser cannot write contracts directly'
);
-- Segunda camada: mesmo que alguém volte a liberar escrita do navegador, a
-- etapa continua só no servidor. A liberação abaixo existe só neste teste e
-- some no ROLLBACK.
GRANT SELECT, UPDATE ON public.assessment_contracts TO authenticated;
CREATE POLICY renewal_pipeline_test_update ON public.assessment_contracts
  AS PERMISSIVE FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON pipeline_results TO authenticated;
INSERT INTO pipeline_results VALUES
  ('guard_stage_sql', to_jsonb(format(
    $$UPDATE public.assessment_contracts SET renewal_stage = 'renewed' WHERE id = %L$$, pg_temp.child(6)))),
  ('guard_notes_sql', to_jsonb(format(
    $$UPDATE public.assessment_contracts SET notes = 'Observação do teste' WHERE id = %L$$, pg_temp.child(6))));
SELECT set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-a000-000000000998","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  (SELECT result #>> '{}' FROM pipeline_results WHERE name = 'guard_stage_sql'),
  '42501', 'A etapa da renovação só pode ser alterada pelas ações de Renovações',
  'an admin browser cannot write the stage directly'
);
SELECT lives_ok(
  (SELECT result #>> '{}' FROM pipeline_results WHERE name = 'guard_notes_sql'),
  'other fields keep working for the admin'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT is(pg_temp.stage(pg_temp.child(6)), 'contact_pending',
  'the blocked write left the stage untouched');

-- Renovação automática só em plano mensal --------------------------------------

SET LOCAL ROLE service_role;
SELECT throws_ok(
  format($$SELECT public.set_assessment_contract_auto_renewal(%L, true, %L, '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.k(2), pg_temp.ver(pg_temp.k(2))),
  'P0001', 'A renovação automática só vale para plano mensal',
  'automatic renewal cannot be turned on for a semiannual plan'
);
SELECT lives_ok(
  format($$SELECT public.set_assessment_contract_auto_renewal(%L, false, %L, '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.k(4), pg_temp.ver(pg_temp.k(4))),
  'automatic renewal can be turned off'
);
SELECT lives_ok(
  format($$SELECT public.set_assessment_contract_auto_renewal(%L, true, %L, '80000000-0000-4000-a000-000000000999')$$,
    pg_temp.k(4), pg_temp.ver(pg_temp.k(4))),
  'automatic renewal can be turned on for a monthly plan'
);
RESET ROLE;

UPDATE public.assessment_contracts
SET plan_id = '80000000-0000-4000-a000-000000000012', plan_snapshot = pg_temp.snap(6)
WHERE id = pg_temp.k(4);
SELECT ok(NOT (SELECT auto_renewal FROM public.assessment_contracts WHERE id = pg_temp.k(4)),
  'a plan change to semiannual turns automatic renewal off');
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_contract_event
  WHERE contract_id = pg_temp.k(4) AND event_type = 'auto_renewal_changed'
    AND payload->>'reason' = 'plan_not_monthly'
), 'the automatic switch-off is recorded with its reason');
SELECT throws_ok(
  $$SELECT pg_temp.parent(11, 6, 'active', current_date, current_date + 180, true)$$,
  'P0001', 'A renovação automática só vale para plano mensal',
  'a new semiannual contract cannot start as automatic'
);

-- Conferência -------------------------------------------------------------------

SELECT pg_temp.parent(12, 1, 'active', current_date - 25, current_date + 5, false);
SELECT pg_temp.parent(13, 1, 'overdue', current_date - 33, current_date - 3, false);
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_renewal_pipeline_issues
  WHERE contract_id = pg_temp.k(12) AND issue_code = 'renewal_not_created'
), 'a renewal missing inside the window is flagged');
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_renewal_pipeline_issues
  WHERE contract_id = pg_temp.k(13) AND issue_code = 'expired_without_renewal'
), 'an expired contract without renewal is flagged');

ALTER TABLE public.assessment_contracts DISABLE TRIGGER trg_sync_assessment_renewal_stage;
UPDATE public.assessment_contracts SET payment_status = 'paid', payment_date = current_date
WHERE id = pg_temp.child(10);
ALTER TABLE public.assessment_contracts ENABLE TRIGGER trg_sync_assessment_renewal_stage;
SELECT ok(EXISTS (
  SELECT 1 FROM public.assessment_renewal_pipeline_issues
  WHERE contract_id = pg_temp.child(10) AND issue_code = 'paid_but_open_stage'
), 'a paid renewal outside "Renovou" is flagged for review');

-- Etapa inicial das renovações que já existiam ---------------------------------

ALTER TABLE public.assessment_contracts DROP CONSTRAINT assessment_contracts_renewal_stage_scope_check;
ALTER TABLE public.assessment_contracts DISABLE TRIGGER trg_sync_assessment_renewal_stage;
ALTER TABLE public.assessment_contracts DISABLE TRIGGER assessment_contract_log_renewal_pipeline_entry;

SELECT pg_temp.parent(14, 1, 'active', current_date - 25, current_date + 5, false);
SELECT pg_temp.parent(15, 1, 'active', current_date - 25, current_date + 5, false);
SELECT pg_temp.parent(16, 1, 'active', current_date - 25, current_date + 5, false);
SELECT pg_temp.parent(17, 1, 'finished', current_date - 40, current_date - 10, false);
SELECT pg_temp.parent(18, 1, 'finished', current_date - 40, current_date - 10, false);
SELECT pg_temp.parent(19, 1, 'finished', current_date - 40, current_date - 10, false);
UPDATE public.assessment_contracts SET renewal_generated = true
WHERE id IN (pg_temp.k(14), pg_temp.k(15), pg_temp.k(16), pg_temp.k(17), pg_temp.k(19));
UPDATE public.assessment_contracts
SET cancellation_reason = 'Não renovou', cancellation_date = end_date
WHERE id = pg_temp.k(18);

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, installments, payment_method,
  payment_status, payment_date, manual_payment, auto_renewal, renewal_generated,
  parent_contract_id, external_payment_link, cancellation_reason, created_at
) VALUES
  -- rascunho sem mensagem
  ('80000000-0000-4000-a000-000000000314', 'ASS-983014', '80000000-0000-4000-a000-000000000114',
   '80000000-0000-4000-a000-000000000021', '80000000-0000-4000-a000-000000000011', pg_temp.snap(1),
   'draft', current_date + 5, current_date + 35, current_date + 35, 1, 'pix',
   'pending', NULL, false, false, false, pg_temp.k(14), NULL, NULL, now() - interval '2 days'),
  -- rascunho com mensagem de renovação já enviada
  ('80000000-0000-4000-a000-000000000315', 'ASS-983015', '80000000-0000-4000-a000-000000000115',
   '80000000-0000-4000-a000-000000000021', '80000000-0000-4000-a000-000000000011', pg_temp.snap(1),
   'draft', current_date + 5, current_date + 35, current_date + 35, 1, 'pix',
   'pending', NULL, false, false, false, pg_temp.k(15), NULL, NULL, now() - interval '2 days'),
  -- agendada com cobrança enviada
  ('80000000-0000-4000-a000-000000000316', 'ASS-983016', '80000000-0000-4000-a000-000000000116',
   '80000000-0000-4000-a000-000000000021', '80000000-0000-4000-a000-000000000011', pg_temp.snap(1),
   'scheduled', current_date + 5, current_date + 35, current_date + 35, 1, 'pix',
   'charge_sent', NULL, false, false, false, pg_temp.k(16), 'https://pagamento.example.test/legado', NULL, now() - interval '2 days'),
  -- paga há dois dias
  ('80000000-0000-4000-a000-000000000317', 'ASS-983017', '80000000-0000-4000-a000-000000000117',
   '80000000-0000-4000-a000-000000000021', '80000000-0000-4000-a000-000000000011', pg_temp.snap(1),
   'active', current_date - 10, current_date + 20, current_date + 20, 1, 'pix',
   'paid', current_date - 2, true, false, false, pg_temp.k(17), NULL, NULL, now() - interval '20 days'),
  -- anulada com "Não renovou" no contrato anterior
  ('80000000-0000-4000-a000-000000000318', 'ASS-983018', '80000000-0000-4000-a000-000000000118',
   '80000000-0000-4000-a000-000000000021', '80000000-0000-4000-a000-000000000011', pg_temp.snap(1),
   'voided', current_date - 10, current_date + 20, current_date + 20, 1, 'pix',
   'cancelled', NULL, false, false, false, pg_temp.k(18), NULL, 'Venda não concretizada (cliente nunca pagou)', now() - interval '20 days'),
  -- anulada por engano
  ('80000000-0000-4000-a000-000000000319', 'ASS-983019', '80000000-0000-4000-a000-000000000119',
   '80000000-0000-4000-a000-000000000021', '80000000-0000-4000-a000-000000000011', pg_temp.snap(1),
   'voided', current_date - 10, current_date + 20, current_date + 20, 1, 'pix',
   'cancelled', NULL, false, false, false, pg_temp.k(19), NULL, 'Venda criada por engano', now() - interval '20 days');

INSERT INTO public.assessment_contract_event (contract_id, event_type, payload, created_at)
VALUES (pg_temp.k(15), 'renewal_message_sent', '{"source":"communication_center"}'::jsonb, now() - interval '1 day');

ALTER TABLE public.assessment_contracts ENABLE TRIGGER trg_sync_assessment_renewal_stage;
ALTER TABLE public.assessment_contracts ENABLE TRIGGER assessment_contract_log_renewal_pipeline_entry;

INSERT INTO pipeline_results SELECT 'backfill', eon_private.backfill_assessment_renewal_stages();

SELECT is(pg_temp.stage('80000000-0000-4000-a000-000000000314'), 'contact_pending',
  'a draft without a message starts in "Enviar mensagem"');
SELECT ok((SELECT renewal_stage = 'waiting_response' AND renewal_last_contact_at IS NOT NULL
  FROM public.assessment_contracts WHERE id = '80000000-0000-4000-a000-000000000315'),
  'a draft whose message was already sent starts in "Aguardando decisão"');
SELECT is(pg_temp.stage('80000000-0000-4000-a000-000000000316'), 'waiting_payment',
  'an open sale starts in "Aguardando pagamento"');
SELECT ok((SELECT renewal_stage = 'renewed'
    AND renewal_resolved_at = ((current_date - 2) + time '12:00') AT TIME ZONE 'America/Sao_Paulo'
  FROM public.assessment_contracts WHERE id = '80000000-0000-4000-a000-000000000317'),
  'a paid renewal starts in "Renovou", dated by its payment');
SELECT is(pg_temp.stage('80000000-0000-4000-a000-000000000318'), 'not_renewed',
  'a voided renewal with a recorded non-renewal starts in "Não renovou"');
SELECT is(pg_temp.stage('80000000-0000-4000-a000-000000000319'), 'discarded',
  'a sale voided by mistake is not counted as an exit');
SELECT is((SELECT count(*)::int FROM eon_private.assessment_renewal_stage_backfill
  WHERE contract_id::text LIKE '80000000-0000-4000-a000-0000000003%'), 6,
  'every classified renewal keeps a copy of its previous state');
SELECT ok((SELECT renewal_response_code IS NULL
  FROM public.assessment_contracts WHERE id = '80000000-0000-4000-a000-000000000315'),
  'the backfill does not invent an athlete answer');

INSERT INTO pipeline_results SELECT 'backfill_again', eon_private.backfill_assessment_renewal_stages();
SELECT is((SELECT result FROM pipeline_results WHERE name = 'backfill_again'), '{}'::jsonb,
  'the backfill is idempotent');

SELECT lives_ok(
  $$ALTER TABLE public.assessment_contracts ADD CONSTRAINT assessment_contracts_renewal_stage_scope_check
    CHECK (
      CASE
        WHEN parent_contract_id IS NULL THEN renewal_stage IS NULL
        ELSE renewal_stage IS NOT NULL AND renewal_entered_at IS NOT NULL AND renewal_stage_updated_at IS NOT NULL
      END
    )$$,
  'after the backfill every renewal has a stage'
);

SELECT * FROM finish();
ROLLBACK;
