BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(36);

-- Acesso: painel admin lê, ninguém escreve pela API ----------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
   WHERE oid = 'public.tecnofit_archive_clients'::regclass),
  'archived clients keep RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
   WHERE oid = 'public.tecnofit_archive_receipts'::regclass),
  'archived receipts keep RLS enabled'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('tecnofit_archive_clients', 'tecnofit_archive_receipts')
     AND ((policyname = 'app_admin_only' AND permissive = 'RESTRICTIVE' AND cmd = 'ALL')
       OR (policyname = 'app_admin_read' AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'))
     AND roles = ARRAY['authenticated']::name[]),
  4,
  'both archive tables are readable only by app admins'
);
SELECT ok(
  (SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_catalog.pg_class
   WHERE oid = 'public.tecnofit_archive_people'::regclass),
  'the summary view applies the caller permissions'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.tecnofit_archive_clients', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.tecnofit_archive_receipts', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.tecnofit_archive_people', 'SELECT'),
  'anon has no access to the archive'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.tecnofit_archive_clients', 'SELECT')
  AND has_table_privilege('authenticated', 'public.tecnofit_archive_receipts', 'SELECT')
  AND has_table_privilege('authenticated', 'public.tecnofit_archive_people', 'SELECT'),
  'the admin panel can read the archive'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.tecnofit_archive_clients', 'INSERT,UPDATE,DELETE,TRUNCATE')
  AND NOT has_table_privilege('authenticated', 'public.tecnofit_archive_receipts', 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'the browser cannot change the archive'
);
SELECT ok(
  has_table_privilege('service_role', 'public.tecnofit_archive_people', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.tecnofit_archive_clients', 'INSERT,UPDATE,DELETE,TRUNCATE')
  AND NOT has_table_privilege('service_role', 'public.tecnofit_archive_receipts', 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'the API only reads the archive'
);

-- Fixtures fictícias ----------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('91000000-0000-4000-a000-000000000001', 'arquivo-admin@example.test'),
  ('91000000-0000-4000-a000-000000000002', 'arquivo-sem-acesso@example.test');
INSERT INTO public.app_admins (user_id) VALUES ('91000000-0000-4000-a000-000000000001');

INSERT INTO public.assessment_modalities (id, name)
VALUES ('91000000-0000-4000-a000-000000000011', 'arquivo-tecnofit-corrida-test');
INSERT INTO public.assessment_plans (
  id, modality_id, name, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee
) VALUES (
  '91000000-0000-4000-a000-000000000012', '91000000-0000-4000-a000-000000000011',
  'Arquivo corrida mensal', 'mensal', 1, 240, 240, 1, 0
);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids)
VALUES ('91000000-0000-4000-a000-000000000013', 'Coach arquivo', 'arquivo-coach@example.test', 'pleno',
  ARRAY['91000000-0000-4000-a000-000000000011'::uuid]);

INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('91000000-0000-4000-a000-000000000021', 'Arquivo voltou', '11900009121'),
  ('91000000-0000-4000-a000-000000000022', 'Arquivo so cadastro', '11900009122'),
  ('91000000-0000-4000-a000-000000000023', 'Arquivo venda anulada', '11900009123');

INSERT INTO public.assessment_contracts (
  id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, status,
  start_date, end_date, original_end_date, due_date, installments,
  payment_method, payment_status, auto_renewal, renewal_generated
) VALUES
  ('91000000-0000-4000-a000-000000000031', 'ASS-991001', '91000000-0000-4000-a000-000000000021',
   '91000000-0000-4000-a000-000000000013', '91000000-0000-4000-a000-000000000012',
   '{"name":"Arquivo corrida mensal","period":"mensal","period_months":1,"price_total":240,"price_monthly":240,"modality_id":"91000000-0000-4000-a000-000000000011"}'::jsonb,
   'active', '2026-09-01', '2026-10-01', '2026-10-01', '2026-09-01', 1, 'pix', 'paid', false, false),
  ('91000000-0000-4000-a000-000000000032', 'ASS-991002', '91000000-0000-4000-a000-000000000023',
   '91000000-0000-4000-a000-000000000013', '91000000-0000-4000-a000-000000000012',
   '{"name":"Arquivo corrida mensal","period":"mensal","period_months":1,"price_total":240,"price_monthly":240,"modality_id":"91000000-0000-4000-a000-000000000011"}'::jsonb,
   'voided', '2026-09-01', '2026-10-01', '2026-10-01', '2026-09-01', 1, 'pix', 'pending', false, false);

INSERT INTO public.tecnofit_archive_clients (tecnofit_code, full_name, tecnofit_status, customer_id, customer_link) VALUES
  (99001, 'ARQUIVO VOLTOU', 'Cancelado', '91000000-0000-4000-a000-000000000021', 'receipt'),
  (99002, 'ARQUIVO SAIU', 'Cancelado', NULL, NULL),
  (99003, 'ARQUIVO SO EVENTO', 'Sem Contrato', '91000000-0000-4000-a000-000000000022', 'name'),
  (99004, 'ARQUIVO VENDA ANULADA', 'Excluído', '91000000-0000-4000-a000-000000000023', 'manual');

INSERT INTO public.tecnofit_archive_receipts (
  tecnofit_code, receipt_number, kind, description, item_name, period_start, period_end,
  amount, payment_method, issued_at, origin, responsible, consultant, source_report
) VALUES
  (99001, 500, 'plan', 'CORRIDA - SEMESTRAL - Período: 10/01/2024 - 10/07/2024', 'CORRIDA - SEMESTRAL',
   '2024-01-10', '2024-07-10', 1000.00, 'Boleto', '2024-01-09 10:00-03', 'Sistema', 'Consultor A', 'Consultor A', 'relatorio_10'),
  (99001, 600, 'plan', 'CORRIDA - GOLD - SEMESTRAL - Período: 10/07/2024 - 10/01/2025', 'CORRIDA - GOLD - SEMESTRAL',
   '2024-07-10', '2025-01-10', 1100.00, 'PIX', '2024-07-08 09:00-03', 'Link de venda', '', '', 'relatorio_10'),
  (99001, 501, 'fee', 'TAXA DE MATRICULA', 'TAXA DE MATRICULA', NULL, NULL,
   99.00, 'Boleto', '2024-01-09 10:05-03', 'Sistema', '', '', 'relatorio_10'),
  -- O Tecnofit repete números de recibo entre clientes diferentes.
  (99002, 500, 'plan', 'CORRIDA - MENSAL - Período: 01/03/2025 - 01/04/2025', 'CORRIDA - MENSAL',
   '2025-03-01', '2025-04-01', 200.00, 'Cartão Crédito Online ( - 1x)', '2025-03-01 08:00-03', 'Sistema', '', '', 'relatorio_11'),
  (99002, 777, 'store', 'CAMISA CORRIDA', 'CAMISA CORRIDA', NULL, NULL,
   79.90, 'PIX', '2025-03-02 08:00-03', 'Sistema', '', '', 'relatorio_11'),
  (99003, 800, 'event', 'PASSAPORTE 1 - EON LEAGUE - CORRIDA', 'PASSAPORTE 1 - EON LEAGUE - CORRIDA', NULL, NULL,
   74.90, 'PIX', '2021-04-30 09:00-03', 'Sistema', '', '', 'relatorio_7'),
  (99004, 900, 'plan', 'CORRIDA - MENSAL - Período: 01/01/2026 - 01/02/2026', 'CORRIDA - MENSAL',
   '2026-01-01', '2026-02-01', 210.00, 'PIX Integrado', '2026-01-02 08:00-03', 'Sistema', '', '', 'relatorio_12');

-- Resumo por pessoa -------------------------------------------------------------

SELECT results_eq(
  $$SELECT plans_count, receipts_count, receipts_total, first_plan_start, last_plan_end, last_plan_name, has_eon_contract
    FROM public.tecnofit_archive_people WHERE tecnofit_code = 99001$$,
  $$VALUES (2, 3, 2199.00::numeric(12,2), '2024-01-10'::date, '2025-01-10'::date, 'CORRIDA - GOLD - SEMESTRAL'::text, true)$$,
  'a student who came back shows the Tecnofit history and the EON Store contract'
);
SELECT results_eq(
  $$SELECT plans_count, receipts_total, last_plan_end, has_eon_contract
    FROM public.tecnofit_archive_people WHERE tecnofit_code = 99002$$,
  $$VALUES (1, 279.90::numeric(12,2), '2025-04-01'::date, false)$$,
  'an ex-student without a link stays out of the EON Store'
);
SELECT results_eq(
  $$SELECT plans_count, receipts_count, last_plan_end, last_plan_name, has_eon_contract
    FROM public.tecnofit_archive_people WHERE tecnofit_code = 99003$$,
  $$VALUES (0, 1, NULL::date, NULL::text, false)$$,
  'a client with only an event and a registration without contract is not a student'
);
SELECT is(
  (SELECT has_eon_contract FROM public.tecnofit_archive_people WHERE tecnofit_code = 99004),
  false,
  'a voided sale does not count as a contract in the EON Store'
);
SELECT is(
  (SELECT min(first_receipt_at) FROM public.tecnofit_archive_people WHERE tecnofit_code = 99001),
  '2024-01-09 10:00-03'::timestamptz,
  'the first receipt date comes from the receipts'
);

-- Regras dos dados ---------------------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, amount, issued_at, source_report)
    VALUES (99001, 500, 'store', 'REPETIDO', 'REPETIDO', 1, now(), 'relatorio_10')$$,
  '23505', NULL, 'the same receipt cannot be loaded twice for a client'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, amount, issued_at, source_report)
    VALUES (99002, 901, 'plan', 'PLANO SEM PERIODO', 'PLANO SEM PERIODO', 1, now(), 'relatorio_10')$$,
  '23514', NULL, 'a plan needs its period'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, period_start, period_end, amount, issued_at, source_report)
    VALUES (99002, 902, 'store', 'LOJA COM PERIODO', 'LOJA COM PERIODO', '2025-01-01', '2025-02-01', 1, now(), 'relatorio_10')$$,
  '23514', NULL, 'only plans have a period'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, period_start, period_end, amount, issued_at, source_report)
    VALUES (99002, 903, 'plan', 'PERIODO INVERTIDO', 'PERIODO INVERTIDO', '2025-02-01', '2025-01-01', 1, now(), 'relatorio_10')$$,
  '23514', NULL, 'the period cannot end before it starts'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, amount, issued_at, source_report)
    VALUES (99002, 904, 'store', 'NEGATIVO', 'NEGATIVO', -1, now(), 'relatorio_10')$$,
  '23514', NULL, 'amounts are never negative'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, amount, issued_at, source_report)
    VALUES (99002, 905, 'gift', 'TIPO DESCONHECIDO', 'TIPO DESCONHECIDO', 1, now(), 'relatorio_10')$$,
  '23514', NULL, 'the receipt kind comes from a closed list'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, amount, issued_at, source_report)
    VALUES (99002, 906, 'store', 'RELATORIO', 'RELATORIO', 1, now(), 'planilha')$$,
  '23514', NULL, 'the source report keeps its Tecnofit name'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_receipts (tecnofit_code, receipt_number, kind, description, item_name, amount, issued_at, source_report)
    VALUES (99999, 907, 'store', 'SEM CLIENTE', 'SEM CLIENTE', 1, now(), 'relatorio_10')$$,
  '23503', NULL, 'every receipt belongs to an archived client'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_clients (tecnofit_code, full_name, tecnofit_status)
    VALUES (99005, 'STATUS NOVO', 'Ativo')$$,
  '23514', NULL, 'the Tecnofit status comes from the report list'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_clients (tecnofit_code, full_name, tecnofit_status, customer_link)
    VALUES (99006, 'VINCULO NOVO', 'Cancelado', 'chute')$$,
  '23514', NULL, 'the link reason comes from a closed list'
);
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_clients (tecnofit_code, full_name, tecnofit_status)
    VALUES (99007, '   ', 'Cancelado')$$,
  '23514', NULL, 'a client keeps a name'
);

-- Apagar a pessoa da EON Store só desfaz o vínculo; o arquivo fica.
DELETE FROM public.presale_customers WHERE id = '91000000-0000-4000-a000-000000000022';
SELECT results_eq(
  $$SELECT customer_id, receipts_count FROM public.tecnofit_archive_people WHERE tecnofit_code = 99003$$,
  $$VALUES (NULL::uuid, 1)$$,
  'deleting the EON Store person keeps the archived client and receipts'
);

-- Quem lê ------------------------------------------------------------------------

-- Em produção o painel já lê contratos direto; no banco de teste a permissão
-- só existe nesta transação e some no ROLLBACK.
GRANT SELECT ON public.assessment_contracts TO authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.tecnofit_archive_people), 0,
  'a signed-in account outside the allowlist sees no archived client');
SELECT is((SELECT count(*)::integer FROM public.tecnofit_archive_receipts), 0,
  'a signed-in account outside the allowlist sees no archived receipt');
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.tecnofit_archive_people WHERE tecnofit_code >= 99001), 4,
  'an admin sees every archived client');
SELECT is((SELECT count(*)::integer FROM public.tecnofit_archive_receipts WHERE tecnofit_code >= 99001), 7,
  'an admin sees every archived receipt');
SELECT is((SELECT has_eon_contract FROM public.tecnofit_archive_people WHERE tecnofit_code = 99001), true,
  'an admin sees who already has a contract in the EON Store');
SELECT throws_ok(
  $$UPDATE public.tecnofit_archive_clients SET full_name = 'OUTRO' WHERE tecnofit_code = 99002$$,
  '42501', NULL, 'an admin cannot edit the archive from the browser'
);
SELECT throws_ok(
  $$DELETE FROM public.tecnofit_archive_receipts WHERE tecnofit_code = 99002$$,
  '42501', NULL, 'an admin cannot delete archived receipts from the browser'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT count(*) FROM public.tecnofit_archive_people$$,
  '42501', NULL, 'anon cannot read the archive summary'
);
SELECT throws_ok(
  $$SELECT count(*) FROM public.tecnofit_archive_receipts$$,
  '42501', NULL, 'anon cannot read archived receipts'
);
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.tecnofit_archive_people WHERE tecnofit_code >= 99001), 4,
  'the API can read the archive');
SELECT throws_ok(
  $$INSERT INTO public.tecnofit_archive_clients (tecnofit_code, full_name, tecnofit_status) VALUES (99008, 'API', 'Cancelado')$$,
  '42501', NULL, 'the API cannot add archived clients'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
