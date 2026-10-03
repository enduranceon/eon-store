BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL timezone='America/Sao_Paulo';
SELECT no_plan();

SELECT ok(has_function_privilege('service_role',
  'public.search_communication_history(uuid,text,uuid,text,date,date,text,integer)','EXECUTE'),
  'server may search communication history');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.search_communication_history(uuid,text,uuid,text,date,date,text,integer)','EXECUTE'),
  'browser cannot query raw history RPC directly');

INSERT INTO public.presale_customers(id,full_name,whatsapp) VALUES
  ('c6000000-0000-4000-a000-000000000001','Pessoa Histórica','11999990001'),
  ('c6000000-0000-4000-a000-000000000002','Outra Pessoa','11999990002');
INSERT INTO public.stock_orders(id,order_number,customer_id,customer_name,customer_whatsapp,
  total_value,payment_status,due_date,asaas_payment_link,payment_message_sent_at)
VALUES
  ('b6000000-0000-4000-a000-000000000001','EST-HISTORY-1',
    'c6000000-0000-4000-a000-000000000001','Pessoa Histórica','11999990001',
    150,'charge_sent','2026-09-01','https://example.test/pay/1','2026-09-01T12:00:00Z'),
  ('b6000000-0000-4000-a000-000000000002','EST-HISTORY-2',
    'c6000000-0000-4000-a000-000000000001','Pessoa Histórica','11999990001',
    150,'paid','2026-08-01','https://example.test/pay/2','2026-08-01T12:00:00Z'),
  ('b6000000-0000-4000-a000-000000000003','EST-HISTORY-3',
    'c6000000-0000-4000-a000-000000000002','Outra Pessoa','11999990002',
    150,'paid','2026-08-01','https://example.test/pay/3','2026-08-01T12:00:00Z');

-- Append-only case history remains accessible far beyond old 120/200 caps.
INSERT INTO public.communication_case_events(case_id,event_type,created_at,payload)
SELECT c.id,'test_note','2026-09-15T15:00:00Z'::timestamptz+make_interval(secs=>n),
  jsonb_build_object('sequence',n)
FROM public.communication_cases c CROSS JOIN generate_series(1,205) n
WHERE c.source_type='stock' AND c.source_id='b6000000-0000-4000-a000-000000000001'
  AND c.purpose='billing';

CREATE TEMP TABLE history_page_1 AS SELECT public.search_communication_history(
  'c6000000-0000-4000-a000-000000000001',NULL,NULL,NULL,
  '2026-09-15','2026-09-15',NULL,100) AS result;
CREATE TEMP TABLE history_page_2 AS SELECT public.search_communication_history(
  'c6000000-0000-4000-a000-000000000001',NULL,NULL,NULL,
  '2026-09-15','2026-09-15',
  (SELECT result->>'next_cursor' FROM history_page_1),100) AS result;
CREATE TEMP TABLE history_page_3 AS SELECT public.search_communication_history(
  'c6000000-0000-4000-a000-000000000001',NULL,NULL,NULL,
  '2026-09-15','2026-09-15',
  (SELECT result->>'next_cursor' FROM history_page_2),100) AS result;
SELECT is((SELECT jsonb_array_length(result->'items') FROM history_page_1),100,
  'first person-period page contains 100 events');
SELECT is((SELECT jsonb_array_length(result->'items') FROM history_page_2),100,
  'second person-period page reaches beyond 200 events');
SELECT is((SELECT jsonb_array_length(result->'items') FROM history_page_3),5,
  'third page contains every remaining event');
SELECT is((SELECT result->>'next_cursor' FROM history_page_3),NULL,
  'last page has no cursor');

-- The unfiltered path enriches only one page, while retaining its keyset.
CREATE TEMP TABLE global_history_page_1 AS SELECT public.search_communication_history(
  NULL,NULL,NULL,NULL,'2026-09-15','2026-09-15',NULL,100) AS result;
CREATE TEMP TABLE global_history_page_2 AS SELECT public.search_communication_history(
  NULL,NULL,NULL,NULL,'2026-09-15','2026-09-15',
  (SELECT result->>'next_cursor' FROM global_history_page_1),100) AS result;
SELECT is((SELECT jsonb_array_length(result->'items') FROM global_history_page_1),100,
  'unfiltered first page has 100 historical events');
SELECT is((SELECT jsonb_array_length(result->'items') FROM global_history_page_2),100,
  'unfiltered cursor reaches the next 100 events');

-- A legacy communication event remains searchable even when the source has
-- no current case. 02:30 UTC is still Aug 1 in Sao Paulo.
INSERT INTO public.sales_status_events(order_type,order_id,previous_status,new_status,
  reason,metadata,actor_id,created_at)
VALUES
  ('stock','b6000000-0000-4000-a000-000000000002','charge_sent','charge_sent',
    'Cobrança enviada',jsonb_build_object('action','charge_sent','message','Mensagem legada'),
    'a6000000-0000-4000-a000-000000000001','2026-08-02T02:30:00Z'),
  ('stock','b6000000-0000-4000-a000-000000000003','charge_sent','charge_sent',
    'Cobrança enviada',jsonb_build_object('action','charge_sent','message','Outra mensagem'),
    'a6000000-0000-4000-a000-000000000001','2026-08-02T02:30:00Z');
SELECT is((public.search_communication_history(
  'c6000000-0000-4000-a000-000000000001',NULL,NULL,'Mensagem legada',
  '2026-08-01','2026-08-01',NULL,20)->'items'->0->>'origin'),
  'sales_history','legacy event is found by person, text and Sao Paulo date');
SELECT is(jsonb_array_length(public.search_communication_history(
  'c6000000-0000-4000-a000-000000000001','stock',
  'b6000000-0000-4000-a000-000000000002',NULL,
  '2026-08-01','2026-08-01',NULL,20)->'items'),1,
  'source filter finds a legacy event without a case');

-- The old financial history row and the new case event describe one action.
INSERT INTO public.communication_case_events(case_id,event_type,created_at,
  message_text,contact_date,payload)
SELECT c.id,'message_sent','2026-10-01T15:00:00Z','Mensagem única','2026-10-01',
  '{}'::jsonb FROM public.communication_cases c
WHERE c.source_type='stock' AND c.source_id='b6000000-0000-4000-a000-000000000001'
  AND c.purpose='billing';
INSERT INTO public.sales_status_events(order_type,order_id,previous_status,new_status,
  reason,metadata,actor_id,created_at)
SELECT 'stock','b6000000-0000-4000-a000-000000000001','charge_sent','charge_sent',
  'Cobrança enviada',jsonb_build_object('action','charge_sent',
    'communication_case_id',c.id,'message','Mensagem única'),
  'a6000000-0000-4000-a000-000000000001','2026-10-01T15:00:00Z'
FROM public.communication_cases c
WHERE c.source_type='stock' AND c.source_id='b6000000-0000-4000-a000-000000000001'
  AND c.purpose='billing';
SELECT is(jsonb_array_length(public.search_communication_history(
  'c6000000-0000-4000-a000-000000000001','stock',
  'b6000000-0000-4000-a000-000000000001',NULL,
  '2026-10-01','2026-10-01',NULL,20)->'items'),1,
  'linked legacy row does not duplicate the case event');

SELECT throws_ok($$SELECT public.search_communication_history(NULL,NULL,NULL,NULL,
  '2026-10-02','2026-10-01',NULL,20)$$,
  '22023','Filtro de histórico inválido','inverted date range is rejected');
SELECT * FROM finish();
ROLLBACK;
