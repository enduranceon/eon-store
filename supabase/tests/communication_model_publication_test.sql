BEGIN;
SELECT plan(20);

CREATE TEMP TABLE model_test_state (key text PRIMARY KEY, value jsonb);
INSERT INTO model_test_state VALUES ('original', (
  SELECT to_jsonb(r) FROM public.communication_rules r WHERE slug='billing-charge-overdue'
));
INSERT INTO model_test_state VALUES ('draft', public.communication_model_command('save_draft',
  '22222222-2222-4222-8222-222222222222',jsonb_build_object(
    'rule_id',(SELECT value->>'id' FROM model_test_state WHERE key='original'),
    'base_version',(SELECT value->'template_version' FROM model_test_state WHERE key='original'),
    'rule',(SELECT value || '{"message_template":"Oi {nome}, saldo {valor} para {numero}","name":"Teste fictício de publicação"}'::jsonb FROM model_test_state WHERE key='original')
  )));

SELECT is((SELECT message_template FROM public.communication_rules WHERE slug='billing-charge-overdue'),
  (SELECT value->>'message_template' FROM model_test_state WHERE key='original'),'salvar rascunho não publica o texto');
SELECT is((SELECT template_version FROM public.communication_rules WHERE slug='billing-charge-overdue'),
  (SELECT (value->>'template_version')::integer FROM model_test_state WHERE key='original'),'rascunho não incrementa a versão publicada');
SELECT throws_ok($$SELECT public.communication_model_command('publish','22222222-2222-4222-8222-222222222222',jsonb_build_object('draft_id',(SELECT value->>'id' FROM model_test_state WHERE key='draft')))$$,
  'P0001','Simule o rascunho atual antes de publicar','publicar sem simular é recusado');

INSERT INTO model_test_state VALUES ('simulation',public.communication_model_command('simulate',
  '22222222-2222-4222-8222-222222222222',jsonb_build_object('draft_id',(SELECT value->>'id' FROM model_test_state WHERE key='draft'))));
SELECT is((SELECT (value->>'can_publish')::boolean FROM model_test_state WHERE key='simulation'),true,'simulação válida libera publicação explícita');
SELECT is((SELECT jsonb_array_length(value->'scenarios') FROM model_test_state WHERE key='simulation'),3,'simulação contém saldo integral, parcial e pago');
SELECT ok((SELECT value->'scenarios'->1->>'message' FROM model_test_state WHERE key='simulation') LIKE '%120%', 'prévia parcial usa saldo restante');
SELECT ok((SELECT value->'scenarios'->1->>'message' FROM model_test_state WHERE key='simulation') NOT LIKE '%{%', 'renderer compartilhado resolveu tokens da prévia');

INSERT INTO model_test_state VALUES ('published',public.communication_model_command('publish',
  '22222222-2222-4222-8222-222222222222',jsonb_build_object(
    'draft_id',(SELECT value->>'id' FROM model_test_state WHERE key='draft'),
    'expected_updated_at',(SELECT value->>'updated_at' FROM model_test_state WHERE key='draft'),
    'simulation_fingerprint',(SELECT value->>'simulation_fingerprint' FROM model_test_state WHERE key='simulation'))));
SELECT is((SELECT message_template FROM public.communication_rules WHERE slug='billing-charge-overdue'),
  'Oi {nome}, saldo {valor} para {numero}','publicação coloca o texto revisado em uso');
SELECT is((SELECT template_version FROM public.communication_rules WHERE slug='billing-charge-overdue'),
  (SELECT (value->>'template_version')::integer+1 FROM model_test_state WHERE key='original'),'publicação incrementa uma versão');
SELECT is((SELECT snapshot->>'message_template' FROM public.communication_rule_versions
  WHERE rule_id=(SELECT (value->>'id')::uuid FROM model_test_state WHERE key='original')
  AND version=(SELECT (value->>'template_version')::integer FROM model_test_state WHERE key='original')),
  (SELECT value->>'message_template' FROM model_test_state WHERE key='original'),'versão anterior conserva texto original');
SELECT is(public.communication_model_command('publish','22222222-2222-4222-8222-222222222222',jsonb_build_object(
  'draft_id',(SELECT value->>'id' FROM model_test_state WHERE key='draft'),
  'expected_updated_at',(SELECT value->>'updated_at' FROM model_test_state WHERE key='draft'),
  'simulation_fingerprint',(SELECT value->>'simulation_fingerprint' FROM model_test_state WHERE key='simulation'))),
  (SELECT value FROM model_test_state WHERE key='published'),'repetir publicação retorna resultado anterior');
SELECT is((SELECT template_version FROM public.communication_rules WHERE slug='billing-charge-overdue'),
  (SELECT (value->>'template_version')::integer+1 FROM model_test_state WHERE key='original'),'repetição não cria versão extra');
SELECT throws_ok($$UPDATE public.communication_rule_versions SET snapshot='{}' WHERE rule_slug='billing-charge-overdue'$$,
  '42501','O histórico de comunicação é imutável','histórico não aceita reescrita');
SELECT ok(NOT has_function_privilege('authenticated','public.communication_model_command(text,uuid,jsonb)','EXECUTE'),'navegador não chama publicação diretamente');
SELECT ok(NOT has_table_privilege('authenticated','public.communication_rules','UPDATE'),'navegador não edita texto publicado');
SELECT throws_ok($$SELECT public.communication_model_command('get_config',NULL,'{}')$$,
  '42501','Operador obrigatório','ação exige operador auditável');

INSERT INTO model_test_state VALUES ('invalid_draft',public.communication_model_command('save_draft',
  '22222222-2222-4222-8222-222222222222',jsonb_build_object(
    'rule_id',(SELECT id FROM public.communication_rules WHERE slug='billing-charge-overdue'),
    'base_version',(SELECT template_version FROM public.communication_rules WHERE slug='billing-charge-overdue'),
    'rule',(SELECT to_jsonb(r) || '{"message_template":"Valor {variavel_inexistente}"}'::jsonb FROM public.communication_rules r WHERE slug='billing-charge-overdue'))));
SELECT is((public.communication_model_command('simulate','22222222-2222-4222-8222-222222222222',jsonb_build_object(
  'draft_id',(SELECT value->>'id' FROM model_test_state WHERE key='invalid_draft')))->>'can_publish')::boolean,false,'variável desconhecida bloqueia publicação');
SELECT throws_ok($$SELECT public.communication_model_command('save_draft','22222222-2222-4222-8222-222222222222',jsonb_build_object(
  'rule_id',(SELECT value->>'id' FROM model_test_state WHERE key='original'),'base_version',(SELECT value->'template_version' FROM model_test_state WHERE key='original'),
  'rule',(SELECT value FROM model_test_state WHERE key='original')))$$,
  'P0001','O modelo mudou. Atualize antes de editar.','versão antiga não substitui edição concorrente');
SELECT throws_ok($$SELECT public.communication_model_command('save_draft','22222222-2222-4222-8222-222222222222',
  '{"policy":{"pre_due_enabled":true,"pre_due_offset":0,"daily_after":1},"base_policy_version":1}')$$,
  '22023','Política pré-vencimento inválida','cadência aprovada não é alterada por campos extras');
SELECT is((SELECT pre_due_enabled FROM public.communication_cadence_policies WHERE slug='billing_overdue'),false,'aviso pré-vencimento inicia desativado');

SELECT * FROM finish();
ROLLBACK;
