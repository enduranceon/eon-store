BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL timezone='America/Sao_Paulo';
SELECT no_plan();

SELECT ok(has_function_privilege('service_role',
  'public.apply_communication_case_action(uuid,jsonb,text,uuid)','EXECUTE'),
  'server can execute the atomic action');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.apply_communication_case_action(uuid,jsonb,text,uuid)','EXECUTE'),
  'browser cannot execute the atomic action');
SELECT ok(NOT has_table_privilege('authenticated','public.communication_cases','UPDATE'),
  'browser cannot mutate case state');
SELECT is((SELECT value->>'enabled' FROM public.communication_settings WHERE key='cases_rollout'),
  'false','rollout starts disabled');

-- Fictitious store orders cover each approved overdue milestone.
INSERT INTO public.stock_orders(id,order_number,customer_name,customer_whatsapp,total_value,
  payment_status,due_date,asaas_payment_link,payment_message_sent_at)
SELECT ('b1000000-0000-4000-a000-00000000000'||n::text)::uuid,
  'EST-CASE-'||n,'Pessoa Exemplo '||n,'1199999000'||n,150,
  'charge_sent',current_date-n,'https://example.test/pay/'||n,
  now()-make_interval(days=>n+1)
FROM (VALUES(2),(3),(5),(7),(8)) x(n);
INSERT INTO public.stock_orders(id,order_number,customer_name,customer_whatsapp,total_value,
  payment_status,due_date,asaas_payment_link)
VALUES('b1000000-0000-4000-a000-000000000009','EST-CASE-9',
  'Pessoa Exemplo Parcial','11999990009',150,'partially_paid',current_date-8,
  'https://example.test/pay/9');

CREATE FUNCTION pg_temp.case_for(p_id uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.communication_cases
  WHERE source_type='stock' AND source_id=p_id AND purpose='billing' AND status='open'
  ORDER BY created_at DESC LIMIT 1;
$$;
CREATE FUNCTION pg_temp.suggest(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT suggestion FROM jsonb_to_record(public.get_communication_case(pg_temp.case_for(p_id)))
    AS x("case" jsonb,suggestion jsonb);
$$;
CREATE FUNCTION pg_temp.projection(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT "case" FROM jsonb_to_record(public.get_communication_case(pg_temp.case_for(p_id)))
    AS x("case" jsonb,suggestion jsonb);
$$;
CREATE FUNCTION pg_temp.order_id(p_n int) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('b1000000-0000-4000-a000-00000000000'||p_n::text)::uuid;
$$;

SELECT is((pg_temp.suggest(pg_temp.order_id(2))->>'eligible_at')::date,
  current_date+1,'D+2 schedules first overdue contact at D+3');
SELECT is(pg_temp.suggest(pg_temp.order_id(3))->>'rule_slug',
  'billing-charge-overdue','D+3 resolves to the first overdue model');
SELECT is(pg_temp.suggest(pg_temp.order_id(5))->>'rule_slug',
  'billing-charge-overdue-5d','D+5 resolves to its own model');
SELECT is(pg_temp.suggest(pg_temp.order_id(7))->>'rule_slug',
  'billing-charge-overdue-7d','D+7 resolves to its own model');
SELECT is(pg_temp.suggest(pg_temp.order_id(8))->>'rule_slug',
  'billing-charge-overdue-daily','D+8 resolves to daily model');
SELECT is((pg_temp.suggest(pg_temp.order_id(8))->>'proposed_next_action_at')::date,
  current_date+1,'after D+7 next contact is tomorrow');
SELECT is((eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type,c.source_id)
      || jsonb_build_object('source_status','finished','due_date',current_date-90),
    NULL,NULL)->>'blocked_reason'),
  NULL,'finished term with an open debt stays eligible at D+90')
FROM public.communication_cases c WHERE c.id=pg_temp.case_for(pg_temp.order_id(8));
SELECT is(pg_temp.suggest(pg_temp.order_id(9))->>'blocked_reason',
  'balance_review','partial payment without trustworthy open balance needs review');
SELECT ok((pg_temp.suggest(pg_temp.order_id(3))->>'message') LIKE '%Pessoa%',
  'production resolver renders the current source first name');
SELECT isnt(eon_private.communication_source_fingerprint(
    eon_private.communication_source_context('stock',pg_temp.order_id(3))),
  eon_private.communication_source_fingerprint(
    eon_private.communication_source_context('stock',pg_temp.order_id(3))
      || jsonb_build_object('pix_copy','0002010102112658EXAMPLE')),
  'adding a PIX payload invalidates the source fingerprint');
SELECT is((eon_private.communication_template_context(jsonb_build_object(
    'source_type','contract','person_name','Ana Exemplo','end_date',current_date-1,
    'community_link','https://example.test/community','modality_name','corrida',
    'coach_name','Coach Exemplo','items',jsonb_build_array(
      jsonb_build_object('name','Camisa','quantity',2))))->>'aviso_vencimento'),
  'seu plano venceu em '||to_char(current_date-1,'DD/MM'),
  'Pebinha receives the correct overdue renewal notice');
SELECT is((eon_private.communication_template_context(jsonb_build_object(
    'source_type','stock','person_name','Ana Exemplo','items',jsonb_build_array(
      jsonb_build_object('name','Camisa','quantity',2))))->>'itens'),
  '- Camisa x2','item tokens use the source item snapshot');
SELECT is((eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type,c.source_id)
      || jsonb_build_object('contact_phone','12'),NULL,NULL)->>'blocked_reason'),
  'missing_contact_phone','SQL rejects invalid phone even when UI validation is bypassed')
FROM public.communication_cases c WHERE c.id=pg_temp.case_for(pg_temp.order_id(3));
SELECT is((eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type,c.source_id)
      || jsonb_build_object('payment_link','javascript:alert(1)'),NULL,NULL)->>'blocked_reason'),
  'invalid_payment_link','SQL rejects unsafe payment links')
FROM public.communication_cases c WHERE c.id=pg_temp.case_for(pg_temp.order_id(3));
SELECT is((eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type,c.source_id),
    (SELECT to_jsonb(r)||jsonb_build_object('message_template','OVERRIDE {nome_completo}',
      'order_index',0) FROM public.communication_rules r
      WHERE slug='billing-charge-overdue'),NULL)->>'message'),
  'OVERRIDE Pessoa Exemplo 3'||E'\n\nLink de pagamento:\nhttps://example.test/pay/3',
  'simulation override uses the same production resolver and payment method')
FROM public.communication_cases c WHERE c.id=pg_temp.case_for(pg_temp.order_id(3));
SELECT ok((eon_private.communication_case_suggestion(c,
    eon_private.communication_source_context(c.source_type,c.source_id)
      || jsonb_build_object('payment_link',NULL,'pix_copy','000201PIXONLY'),
    NULL,NULL)->>'message') LIKE '%PIX Copia e Cola:%000201PIXONLY%',
  'PIX-only billing suggestion includes the source payment method')
FROM public.communication_cases c WHERE c.id=pg_temp.case_for(pg_temp.order_id(5));

-- Rollout is reversible, but activating it requires a complete backfill.
UPDATE public.communication_settings
  SET value=jsonb_build_object('enabled',true,'enabled_at',now()) WHERE key='cases_rollout';
CREATE TEMP TABLE case_results(name text PRIMARY KEY,result jsonb);
GRANT SELECT,INSERT,UPDATE ON case_results TO service_role;

SET LOCAL ROLE service_role;
INSERT INTO case_results VALUES ('before',public.get_communication_case(
  pg_temp.case_for(pg_temp.order_id(3))));
INSERT INTO case_results VALUES ('send',public.apply_communication_case_action(
  pg_temp.case_for(pg_temp.order_id(3)),
  jsonb_build_object('action','message_sent','expected_version',
    ((SELECT result->'case'->>'version' FROM case_results WHERE name='before')::bigint),
    'expected_source_fingerprint',
    (SELECT result->'case'->>'source_fingerprint' FROM case_results WHERE name='before'),
    'expected_rule_version',
    ((SELECT result->'suggestion'->>'rule_version' FROM case_results WHERE name='before')::int),
    'source_ui','sql_test','channel','whatsapp','confirmed_external_send',true,
    'message','Oi, pessoa exemplo. Enviei no WhatsApp.'),
  'case:test:send0001','a1000000-0000-4000-a000-000000000001'));
INSERT INTO case_results VALUES ('replay',public.apply_communication_case_action(
  pg_temp.case_for(pg_temp.order_id(3)),
  jsonb_build_object('action','message_sent','expected_version',
    ((SELECT result->'case'->>'version' FROM case_results WHERE name='before')::bigint),
    'expected_source_fingerprint',
    (SELECT result->'case'->>'source_fingerprint' FROM case_results WHERE name='before'),
    'expected_rule_version',
    ((SELECT result->'suggestion'->>'rule_version' FROM case_results WHERE name='before')::int),
    'source_ui','sql_test','channel','whatsapp','confirmed_external_send',true,
    'message','Oi, pessoa exemplo. Enviei no WhatsApp.'),
  'case:test:send0001','a1000000-0000-4000-a000-000000000001'));
RESET ROLE;

SELECT is((SELECT result->>'replayed' FROM case_results WHERE name='replay'),
  'true','retry with the same payload reuses the committed result');
SELECT is((SELECT count(*)::int FROM public.communication_case_events
    WHERE case_id=pg_temp.case_for(pg_temp.order_id(3)) AND event_type='message_sent'),
  1,'retry does not create a second contact');
SELECT is(pg_temp.suggest(pg_temp.order_id(3))->>'blocked_reason',
  'already_contacted_today','same-day contact is blocked');
SELECT ok(EXISTS(SELECT 1 FROM public.sales_status_events WHERE order_type='stock'
  AND order_id=pg_temp.order_id(3) AND metadata->>'communication_case_id'
    =pg_temp.case_for(pg_temp.order_id(3))::text),
  'domain history retains the case reference');

SELECT throws_ok($$SELECT public.apply_communication_case_action(
  pg_temp.case_for(pg_temp.order_id(3)),
  jsonb_build_object('action','message_sent','expected_version',1,
    'expected_source_fingerprint','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'expected_rule_version',1,'source_ui','sql_test','channel','whatsapp',
    'confirmed_external_send',true,'message','Different body'),
  'case:test:send0001','a1000000-0000-4000-a000-000000000001')$$,
  'P0001','Chave de idempotência reutilizada com dados diferentes',
  'same key cannot silently accept different content');

-- A changed payment blocks an already opened panel and closes the case.
CREATE TEMP TABLE stale_panel AS SELECT public.get_communication_case(
  pg_temp.case_for(pg_temp.order_id(5))) AS result;
UPDATE public.stock_orders SET payment_status='paid',updated_date=now()
  WHERE id=pg_temp.order_id(5);
SELECT is((SELECT status FROM public.communication_cases
  WHERE source_id=pg_temp.order_id(5) AND purpose='billing'),
  'resolved','source payment resolves the contact case without touching finance');
SELECT throws_ok($$SELECT public.apply_communication_case_action(
  (SELECT (result->'case'->>'id')::uuid FROM stale_panel),
  jsonb_build_object('action','message_sent','expected_version',
    (SELECT (result->'case'->>'version')::bigint FROM stale_panel),
    'expected_source_fingerprint',
    (SELECT result->'case'->>'source_fingerprint' FROM stale_panel),
    'expected_rule_version',
    (SELECT (result->'suggestion'->>'rule_version')::int FROM stale_panel),
    'source_ui','sql_test','channel','whatsapp','confirmed_external_send',true,
    'message','Já pagou'),
  'case:test:stale0001','a1000000-0000-4000-a000-000000000001')$$,
  'P0001',NULL,'stale dialog cannot record a paid source');

-- New charge creates a distinct obligation and retains the old history.
UPDATE public.stock_orders SET asaas_charge_id='CHARGE-EXAMPLE-OLD'
  WHERE id=pg_temp.order_id(7);
UPDATE public.stock_orders SET asaas_charge_id='CHARGE-EXAMPLE-NEW'
  WHERE id=pg_temp.order_id(7);
SELECT is((SELECT count(*)::int FROM public.communication_cases
  WHERE source_id=pg_temp.order_id(7) AND purpose='billing'),3,
  'replacement charge creates a new case and retains earlier obligations');
SELECT is((SELECT count(*)::int FROM public.communication_cases
  WHERE source_id=pg_temp.order_id(7) AND purpose='billing' AND status='open'),1,
  'only current charge remains open');
UPDATE public.stock_orders SET asaas_charge_id='CHARGE-EXAMPLE-OLD'
  WHERE id=pg_temp.order_id(7);
SELECT is((SELECT count(*)::int FROM public.communication_cases
  WHERE source_id=pg_temp.order_id(7) AND purpose='billing' AND status='open'),1,
  'reverting the charge does not leave the obligation without an open case');
SELECT is((SELECT obligation_key FROM public.communication_cases
  WHERE source_id=pg_temp.order_id(7) AND purpose='billing' AND status='open'),
  'charge:'||md5('CHARGE-EXAMPLE-OLD'),
  'previous charge case reopens when it becomes the current obligation again');
SELECT ok(EXISTS(SELECT 1 FROM public.communication_case_events e
  JOIN public.communication_cases c ON c.id=e.case_id
  WHERE c.source_id=pg_temp.order_id(7) AND c.obligation_key='charge:'||md5('CHARGE-EXAMPLE-OLD')
    AND e.event_type='case_reopened' AND e.payload->>'previous_resolution_reason'='source_superseded'),
  'reactivation keeps an audit event with its previous resolution');

-- Keyset history includes old domain records and has no 120/200-row cap.
INSERT INTO public.communication_case_events(case_id,event_type,created_at,payload)
SELECT pg_temp.case_for(pg_temp.order_id(8)),'test_note',now()+make_interval(secs=>n),
  jsonb_build_object('sequence',n) FROM generate_series(1,205) n;
CREATE TEMP TABLE history_page_1 AS SELECT public.list_communication_case_events(
  pg_temp.case_for(pg_temp.order_id(8)),NULL,100) AS result;
CREATE TEMP TABLE history_page_2 AS SELECT public.list_communication_case_events(
  pg_temp.case_for(pg_temp.order_id(8)),
  (SELECT result->>'next_cursor' FROM history_page_1),100) AS result;
SELECT is((SELECT jsonb_array_length(result->'items') FROM history_page_1),100,
  'first history page contains 100 events');
SELECT is((SELECT jsonb_array_length(result->'items') FROM history_page_2),100,
  'second history page reaches beyond the old 120-item cutoff');
SELECT ok((SELECT result->>'next_cursor' IS NOT NULL FROM history_page_2),
  'history exposes a cursor beyond 200 events');

-- A human review keeps the case blocked until explicitly completed.
CREATE TEMP TABLE review_before AS SELECT public.get_communication_case(
  pg_temp.case_for(pg_temp.order_id(8))) AS result;
GRANT SELECT ON review_before TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO case_results VALUES('review_requested',public.apply_communication_case_action(
  pg_temp.case_for(pg_temp.order_id(8)),
  jsonb_build_object('action','review_requested','expected_version',
    (SELECT (result->'case'->>'version')::bigint FROM review_before),
    'expected_source_fingerprint',
    (SELECT result->'case'->>'source_fingerprint' FROM review_before),
    'source_ui','sql_test','reason','Cliente informou pagamento ainda não conciliado',
    'next_action_at',current_date+2),
  'case:test:review01','a1000000-0000-4000-a000-000000000001'));
RESET ROLE;
SELECT is(pg_temp.suggest(pg_temp.order_id(8))->>'blocked_reason',
  'review_requested','review request persists as a send block');

CREATE TEMP TABLE review_after AS SELECT public.get_communication_case(
  pg_temp.case_for(pg_temp.order_id(8))) AS result;
GRANT SELECT ON review_after TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO case_results VALUES('review_completed',public.apply_communication_case_action(
  pg_temp.case_for(pg_temp.order_id(8)),
  jsonb_build_object('action','review_completed','expected_version',
    (SELECT (result->'case'->>'version')::bigint FROM review_after),
    'expected_source_fingerprint',
    (SELECT result->'case'->>'source_fingerprint' FROM review_after),
    'source_ui','sql_test','note','Conferi com Financeiro: saldo segue em aberto'),
  'case:test:review02','a1000000-0000-4000-a000-000000000001'));
RESET ROLE;
SELECT is(pg_temp.suggest(pg_temp.order_id(8))->>'blocked_reason',
  NULL,'review completion clears the human block after source revalidation');
SELECT ok(EXISTS(SELECT 1 FROM public.communication_case_events
  WHERE case_id=pg_temp.case_for(pg_temp.order_id(8)) AND event_type='review_completed'
    AND notes='Conferi com Financeiro: saldo segue em aberto'),
  'review completion is preserved in immutable history');

SELECT * FROM finish();
ROLLBACK;
