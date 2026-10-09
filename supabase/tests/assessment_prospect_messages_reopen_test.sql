BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';
SELECT no_plan();

-- Textos da proposta em Modelos e regras e o "Retomar" de um prospect
-- arquivado. Pessoas, planos e links são fictícios; nada toca o Asaas.

-- 1. Modelos da jornada Propostas ------------------------------------------

SELECT is((SELECT count(*)::integer FROM public.communication_rules WHERE journey = 'proposal' AND active), 9,
  'os nove textos da proposta estão publicados e ativos');
SELECT is((SELECT count(*)::integer FROM public.communication_rules
  WHERE journey = 'proposal' AND (trigger_event <> 'manual' OR task_kind NOT IN ('prospect_contact', 'prospect_proposal'))), 0,
  'os textos da proposta usam só as etapas próprias');
SELECT is((SELECT count(*)::integer FROM public.communication_rules r,
    LATERAL (VALUES ('complete'), ('no_coach'), ('installments')) AS s(scenario)
  WHERE r.journey = 'proposal'
    AND public.render_communication_template(r.message_template, eon_private.prospect_message_sample_context(s.scenario)) ~ '\{[^{}]+\}'), 0,
  'todo texto padrão resolve as variáveis nos três cenários');
SELECT is(eon_private.prospect_message_money(1234.5), 'R$ 1.234,50', 'valor no formato brasileiro');
SELECT ok(eon_private.prospect_message_sample_context('no_coach')->>'com_coach' = 'na assessoria'
  AND eon_private.prospect_message_sample_context('complete')->>'o_coach' = 'o coach *Treinador Exemplo*',
  'frases do coach mudam quando não há coach');

SELECT throws_ok($$SELECT public.communication_model_command('save_draft', '22222222-2222-4222-8222-222222222222', jsonb_build_object(
    'base_version', 0,
    'rule', jsonb_build_object('slug', 'proposta-errada', 'name', 'Errado', 'journey', 'proposal', 'trigger_event', 'manual',
      'task_kind', 'charge_send', 'days_offset', 0, 'channel', 'whatsapp', 'message_template', 'Oi {nome}', 'active', false, 'order_index', 1)))$$,
  '22023', 'Modelo inválido', 'proposta não aceita etapa de outra jornada');
SELECT throws_ok($$SELECT public.communication_model_command('save_draft', '22222222-2222-4222-8222-222222222222', jsonb_build_object(
    'base_version', 0,
    'rule', jsonb_build_object('slug', 'cobranca-errada', 'name', 'Errado', 'journey', 'billing', 'trigger_event', 'charge_created',
      'task_kind', 'prospect_contact', 'days_offset', 0, 'channel', 'whatsapp', 'message_template', 'Oi {nome}', 'active', false, 'order_index', 1)))$$,
  '22023', 'Modelo inválido', 'outra jornada não aceita etapa da proposta');

CREATE TEMP TABLE model_state (key text PRIMARY KEY, value jsonb);
INSERT INTO model_state VALUES ('rule', (SELECT to_jsonb(r) FROM public.communication_rules r WHERE slug = 'proposal-follow-up'));
INSERT INTO model_state VALUES ('draft', public.communication_model_command('save_draft', '22222222-2222-4222-8222-222222222222', jsonb_build_object(
  'rule_id', (SELECT value->>'id' FROM model_state WHERE key = 'rule'),
  'base_version', (SELECT value->'template_version' FROM model_state WHERE key = 'rule'),
  'rule', (SELECT value || jsonb_build_object('message_template', E'Oi, {nome}! Posso te contar como são as primeiras semanas {com_coach}?\n\n{resumo_proposta}')
    FROM model_state WHERE key = 'rule'))));
INSERT INTO model_state VALUES ('simulation', public.communication_model_command('simulate', '22222222-2222-4222-8222-222222222222',
  jsonb_build_object('draft_id', (SELECT value->>'id' FROM model_state WHERE key = 'draft'))));
SELECT is((SELECT (value->>'can_publish')::boolean FROM model_state WHERE key = 'simulation'), true, 'texto editado com variáveis da proposta pode ser publicado');
SELECT is((SELECT jsonb_array_length(value->'scenarios') FROM model_state WHERE key = 'simulation'), 3, 'simulação mostra três prospects fictícios');
SELECT is((SELECT value->>'affected_label' FROM model_state WHERE key = 'simulation'), 'Prospects em negociação', 'impacto contado em prospects, não em casos');
SELECT ok((SELECT value->'scenarios'->0->>'message' FROM model_state WHERE key = 'simulation') LIKE '%com *Treinador Exemplo*%'
  AND (SELECT value->'scenarios'->1->>'message' FROM model_state WHERE key = 'simulation') LIKE '%semanas na assessoria%',
  'prévia troca a frase do coach conforme o cenário');
SELECT ok((SELECT value->'scenarios'->2->>'message' FROM model_state WHERE key = 'simulation') LIKE '%3x de R$ 300,00%'
  AND (SELECT value->'scenarios'->2->>'message' FROM model_state WHERE key = 'simulation') LIKE '%Matrícula: R$ 100,00%',
  'prévia do resumo traz parcelas e matrícula');

INSERT INTO model_state VALUES ('published', public.communication_model_command('publish', '22222222-2222-4222-8222-222222222222', jsonb_build_object(
  'draft_id', (SELECT value->>'id' FROM model_state WHERE key = 'draft'),
  'expected_updated_at', (SELECT value->>'updated_at' FROM model_state WHERE key = 'draft'),
  'simulation_fingerprint', (SELECT value->>'simulation_fingerprint' FROM model_state WHERE key = 'simulation'))));
SELECT ok((SELECT message_template FROM public.communication_rules WHERE slug = 'proposal-follow-up') LIKE 'Oi, {nome}! Posso te contar%',
  'publicação coloca o texto novo em uso');
SELECT is((SELECT template_version FROM public.communication_rules WHERE slug = 'proposal-follow-up'),
  (SELECT (value->>'template_version')::integer + 1 FROM model_state WHERE key = 'rule'), 'publicação registra nova versão');

INSERT INTO model_state VALUES ('bad_draft', public.communication_model_command('save_draft', '22222222-2222-4222-8222-222222222222', jsonb_build_object(
  'rule_id', (SELECT id FROM public.communication_rules WHERE slug = 'proposal-closing'),
  'base_version', (SELECT template_version FROM public.communication_rules WHERE slug = 'proposal-closing'),
  'rule', (SELECT to_jsonb(r) || '{"message_template":"Oi {nome}, vence {data_inexistente}"}'::jsonb FROM public.communication_rules r WHERE slug = 'proposal-closing'))));
INSERT INTO model_state VALUES ('bad_simulation', public.communication_model_command('simulate', '22222222-2222-4222-8222-222222222222',
  jsonb_build_object('draft_id', (SELECT value->>'id' FROM model_state WHERE key = 'bad_draft'))));
SELECT is((SELECT (value->>'can_publish')::boolean FROM model_state WHERE key = 'bad_simulation'), false, 'variável que o quadro não conhece bloqueia a publicação');
SELECT is((SELECT jsonb_array_length(value->'warnings') FROM model_state WHERE key = 'bad_simulation'), 1, 'o aviso de variável aparece uma vez');

INSERT INTO model_state VALUES ('off_draft', public.communication_model_command('save_draft', '22222222-2222-4222-8222-222222222222', jsonb_build_object(
  'rule_id', (SELECT id FROM public.communication_rules WHERE slug = 'proposal-payment-closing'),
  'base_version', (SELECT template_version FROM public.communication_rules WHERE slug = 'proposal-payment-closing'),
  'rule', (SELECT to_jsonb(r) || '{"active":false}'::jsonb FROM public.communication_rules r WHERE slug = 'proposal-payment-closing'))));
INSERT INTO model_state VALUES ('off_simulation', public.communication_model_command('simulate', '22222222-2222-4222-8222-222222222222',
  jsonb_build_object('draft_id', (SELECT value->>'id' FROM model_state WHERE key = 'off_draft'))));
SELECT ok((SELECT value->'warnings'->>0 FROM model_state WHERE key = 'off_simulation') LIKE '%volta a usar o texto padrão%',
  'desligar o único modelo do passo avisa que o quadro usa o padrão');

-- 2. Retomar um prospect arquivado -----------------------------------------

SELECT ok(has_function_privilege('service_role', 'public.reopen_assessment_prospect(uuid,timestamptz,uuid)', 'EXECUTE'), 'backend pode retomar prospects');
SELECT ok(NOT has_function_privilege('authenticated', 'public.reopen_assessment_prospect(uuid,timestamptz,uuid)', 'EXECUTE'), 'navegador não retoma sem a API de admin');
SELECT ok(NOT has_function_privilege('anon', 'public.reopen_assessment_prospect(uuid,timestamptz,uuid)', 'EXECUTE'), 'anônimo não retoma prospects');
SELECT ok(bool_and(NOT prosecdef AND 'search_path=""' = ANY(proconfig)), 'retomar usa os privilégios de quem chama e search path vazio')
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'reopen_assessment_prospect';

INSERT INTO auth.users (id, email) VALUES ('83000000-0000-4000-a000-000000000001', 'retomar-admin@example.test');
INSERT INTO public.assessment_modalities (id, name) VALUES ('83000000-0000-4000-a000-000000000002', 'retomar-test-modality');
INSERT INTO public.assessment_plans (id, name, modality_id, period, period_months, price_monthly, price_total, max_installments, enrollment_fee)
VALUES ('83000000-0000-4000-a000-000000000003', 'Plano fictício do retomar', '83000000-0000-4000-a000-000000000002', 'mensal', 1, 300, 300, 1, 0);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('83000000-0000-4000-a000-000000000004', 'Coach fictício do retomar', 'retomar-coach@example.test', 'senior', ARRAY['83000000-0000-4000-a000-000000000002'::uuid]);

CREATE FUNCTION pg_temp.prospect(p_n integer, p_key text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
  SELECT (public.create_manual_assessment_prospect(
    'Pessoa Retomar ' || p_n, '519999983' || lpad(p_n::text, 2, '0'), NULL, NULL,
    '83000000-0000-4000-a000-000000000003', '83000000-0000-4000-a000-000000000004',
    1, NULL, coalesce(p_key, 'retomar:test:' || p_n), '83000000-0000-4000-a000-000000000001', NULL, NULL
  )->'contract'->>'id')::uuid;
$$;
CREATE FUNCTION pg_temp.version(p_id uuid) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT updated_at FROM public.assessment_contracts WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.reopen(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.reopen_assessment_prospect(p_id, pg_temp.version(p_id), '83000000-0000-4000-a000-000000000001');
$$;
CREATE FUNCTION pg_temp.lose(p_id uuid, p_confirm boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.lose_assessment_prospect(p_id, 'price', 'Achou caro', p_confirm, pg_temp.version(p_id),
    '83000000-0000-4000-a000-000000000001');
$$;
CREATE TEMP TABLE ids(n integer PRIMARY KEY, id uuid);
GRANT ALL ON ids TO service_role;
CREATE TEMP TABLE financial_baseline AS SELECT count(*) AS payments FROM public.asaas_payments;

-- Prospect 1: recebeu o link, não pagou e foi arquivado com o link cancelado.
INSERT INTO ids VALUES (1, pg_temp.prospect(1));
SELECT public.prepare_assessment_prospect_proposal((SELECT id FROM ids WHERE n = 1), 0, 0, 'https://www.asaas.com/i/ficticioretomar',
  (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1, pg_temp.version((SELECT id FROM ids WHERE n = 1)), '83000000-0000-4000-a000-000000000001');
SELECT public.mark_assessment_prospect_message_sent((SELECT id FROM ids WHERE n = 1), pg_temp.version((SELECT id FROM ids WHERE n = 1)),
  '83000000-0000-4000-a000-000000000001');
SELECT pg_temp.lose((SELECT id FROM ids WHERE n = 1), true);

SELECT throws_ok(format($$SELECT public.reopen_assessment_prospect(%L, now() - interval '1 day', '83000000-0000-4000-a000-000000000001')$$,
  (SELECT id FROM ids WHERE n = 1)), 'P0001', 'O prospect foi alterado. Atualize a página e tente novamente', 'versão antiga não retoma');
SELECT throws_ok(format($$SELECT public.reopen_assessment_prospect(%L, %L, NULL)$$,
  (SELECT id FROM ids WHERE n = 1), pg_temp.version((SELECT id FROM ids WHERE n = 1))), '42501', 'Operador obrigatório', 'retomar exige operador');

SELECT lives_ok(format($$SELECT pg_temp.reopen(%L)$$, (SELECT id FROM ids WHERE n = 1)), 'prospect arquivado volta para o quadro');
SELECT is((SELECT row(status, payment_status, prospect_stage)::text FROM public.assessment_contracts WHERE id = (SELECT id FROM ids WHERE n = 1)),
  '(draft,pending,clarifying)', 'volta em Tirando dúvidas, sem cobrança aberta');
SELECT ok((SELECT prospect_lost_at IS NULL AND prospect_loss_reason_code IS NULL AND prospect_loss_notes IS NULL
    AND external_payment_link IS NULL AND prospect_message_sent_at IS NULL AND payment_message_sent_at IS NULL
    AND prospect_proposal_ready_at IS NULL AND prospect_close_deadline IS NULL
    AND prospect_reopened_at IS NOT NULL AND prospect_last_contact_at = prospect_reopened_at
  FROM public.assessment_contracts WHERE id = (SELECT id FROM ids WHERE n = 1)),
  'o card recomeça: sem perda, sem link antigo e relógio de hoje');
SELECT is((SELECT payload->>'previous_external_payment_link' FROM public.assessment_contract_event
  WHERE contract_id = (SELECT id FROM ids WHERE n = 1) AND event_type = 'prospect_reopened'),
  'https://www.asaas.com/i/ficticioretomar', 'o link cancelado fica guardado no histórico');
SELECT is((SELECT payload->>'loss_reason_code' FROM public.assessment_contract_event
  WHERE contract_id = (SELECT id FROM ids WHERE n = 1) AND event_type = 'prospect_reopened'), 'price', 'o motivo da perda fica no histórico');
SELECT is((SELECT count(*)::integer FROM public.assessment_contract_event
  WHERE contract_id = (SELECT id FROM ids WHERE n = 1) AND event_type IN ('prospect_lost', 'prospect_proposal_prepared', 'prospect_payment_message_sent')), 3,
  'o histórico anterior continua');
SELECT throws_ok(format($$SELECT pg_temp.reopen(%L)$$, (SELECT id FROM ids WHERE n = 1)),
  'P0001', 'Só um prospect arquivado como não convertido pode ser retomado', 'prospect aberto não é retomado de novo');

-- Depois de retomado, segue o fluxo normal: lembrete e nova proposta.
SELECT lives_ok(format($$SELECT public.register_assessment_prospect_contact(%L, 'follow_up', false, pg_temp.version(%L), '83000000-0000-4000-a000-000000000001')$$,
  (SELECT id FROM ids WHERE n = 1), (SELECT id FROM ids WHERE n = 1)), 'o lembrete funciona depois de retomar');
SELECT lives_ok(format($$SELECT public.prepare_assessment_prospect_proposal(%L, 0, 0, 'https://www.asaas.com/i/ficticionovo', %L, pg_temp.version(%L), '83000000-0000-4000-a000-000000000001')$$,
  (SELECT id FROM ids WHERE n = 1), (now() AT TIME ZONE 'America/Sao_Paulo')::date + 2, (SELECT id FROM ids WHERE n = 1)),
  'uma nova proposta com link pode ser preparada');

-- Prospect 2: arquivado e, depois, a pessoa abriu outra proposta.
INSERT INTO ids VALUES (2, pg_temp.prospect(2));
SELECT pg_temp.lose((SELECT id FROM ids WHERE n = 2));
INSERT INTO ids VALUES (3, pg_temp.prospect(2, 'retomar:test:2b'));
SELECT throws_like(format($$SELECT pg_temp.reopen(%L)$$, (SELECT id FROM ids WHERE n = 2)),
  'Esta pessoa já tem outra proposta aberta%', 'não abre duas negociações para a mesma pessoa');

-- Prospect 4: arquivado e, depois, a pessoa virou aluna por outra proposta.
INSERT INTO ids VALUES (4, pg_temp.prospect(4));
SELECT pg_temp.lose((SELECT id FROM ids WHERE n = 4));
UPDATE public.assessment_contracts SET created_at = created_at - interval '10 days' WHERE id = (SELECT id FROM ids WHERE n = 4);
INSERT INTO ids VALUES (5, pg_temp.prospect(4, 'retomar:test:4b'));
UPDATE public.assessment_contracts SET payment_status = 'paid', payment_date = current_date, manual_payment = true
WHERE id = (SELECT id FROM ids WHERE n = 5);
SELECT is((SELECT status FROM public.assessment_contracts WHERE id = (SELECT id FROM ids WHERE n = 5)), 'active', 'a outra proposta virou contrato ativo');
SELECT throws_like(format($$SELECT pg_temp.reopen(%L)$$, (SELECT id FROM ids WHERE n = 4)),
  'Esta pessoa já virou aluna depois desta proposta%', 'quem já virou aluno não volta como prospect antigo');

-- Prospect convertido não é retomado.
SELECT throws_ok(format($$SELECT pg_temp.reopen(%L)$$, (SELECT id FROM ids WHERE n = 5)),
  'P0001', 'Só um prospect arquivado como não convertido pode ser retomado', 'prospect convertido não é retomado');

SELECT is((SELECT count(*) FROM public.asaas_payments), (SELECT payments FROM financial_baseline), 'nada foi lançado em pagamentos');

SELECT * FROM finish();
ROLLBACK;
