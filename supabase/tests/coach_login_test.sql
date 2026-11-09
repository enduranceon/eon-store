BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(57);

-- Fixtures fictícias.
--   Contas: A (coach CA), B (coach CB), I (coach inativo CI), N (conta sem coach),
--           ADM (administrador), X (conta livre para ligar a um coach).
--   Eventos: E1 (com grupo, responsável CA), E2 (só CB), E3 (sem grupo, CA e CB).
INSERT INTO auth.users (id, email) VALUES
  ('98100000-0000-4000-a000-0000000000a1', 'coach-a-login@example.test'),
  ('98100000-0000-4000-a000-0000000000b1', 'coach-b-login@example.test'),
  ('98100000-0000-4000-a000-0000000000c1', 'coach-i-login@example.test'),
  ('98100000-0000-4000-a000-0000000000d1', 'sem-coach-login@example.test'),
  ('98100000-0000-4000-a000-0000000000e1', 'admin-login@example.test'),
  ('98100000-0000-4000-a000-0000000000f1', 'livre-login@example.test');
INSERT INTO public.app_admins (user_id) VALUES ('98100000-0000-4000-a000-0000000000e1');

INSERT INTO public.assessment_coaches (id, name, email, role, active, auth_user_id) VALUES
  ('98100000-0000-4000-a000-000000000001', 'Coach A Login Teste', 'a-login@example.test', 'senior', true,  '98100000-0000-4000-a000-0000000000a1'),
  ('98100000-0000-4000-a000-000000000002', 'Coach B Login Teste', 'b-login@example.test', 'senior', true,  '98100000-0000-4000-a000-0000000000b1'),
  ('98100000-0000-4000-a000-000000000003', 'Coach Inativo Login Teste', 'i-login@example.test', 'senior', false, '98100000-0000-4000-a000-0000000000c1'),
  ('98100000-0000-4000-a000-000000000004', 'Coach Sem Conta Teste', 's-login@example.test', 'senior', true, NULL),
  ('98100000-0000-4000-a000-000000000005', 'Coach Sem Conta Dois Teste', 's2-login@example.test', 'senior', true, NULL);

INSERT INTO public.events (id, name, slug, event_date, status, whatsapp_group_enabled, internal_notes, description, public_notes) VALUES
  ('98100000-0000-4000-a000-000000000010', 'Evento Com Grupo Login Teste', 'evento-grupo-login-teste', current_date + 20, 'open', true, 'NOTA INTERNA SECRETA', 'Descrição pública', 'Aviso público'),
  ('98100000-0000-4000-a000-000000000011', 'Evento Do Outro Coach Teste', 'evento-outro-coach-teste', current_date + 21, 'open', true, NULL, NULL, NULL),
  ('98100000-0000-4000-a000-000000000012', 'Evento Sem Grupo Login Teste', 'evento-sem-grupo-login-teste', current_date + 22, 'open', false, NULL, NULL, NULL);
INSERT INTO public.event_coaches (event_id, coach_id) VALUES
  ('98100000-0000-4000-a000-000000000010', '98100000-0000-4000-a000-000000000001'),
  ('98100000-0000-4000-a000-000000000011', '98100000-0000-4000-a000-000000000002'),
  ('98100000-0000-4000-a000-000000000012', '98100000-0000-4000-a000-000000000001'),
  ('98100000-0000-4000-a000-000000000012', '98100000-0000-4000-a000-000000000002');
INSERT INTO public.event_registration_types (id, event_id, name, price) VALUES
  ('98100000-0000-4000-a000-000000000020', '98100000-0000-4000-a000-000000000010', 'Geral Teste', 987.65),
  ('98100000-0000-4000-a000-000000000021', '98100000-0000-4000-a000-000000000011', 'Geral Teste', 123.45),
  ('98100000-0000-4000-a000-000000000022', '98100000-0000-4000-a000-000000000012', 'Geral Teste', 55.5);
INSERT INTO public.presale_customers (id, full_name, whatsapp, email) VALUES
  ('98100000-0000-4000-a000-000000000030', 'Ana Pessoa Teste', '11900009801', 'ana.pessoa@example.test'),
  ('98100000-0000-4000-a000-000000000031', 'Beto Pessoa Teste', '11900009802', 'beto.pessoa@example.test'),
  ('98100000-0000-4000-a000-000000000032', 'Caio Pessoa Teste', '11900009803', 'caio.pessoa@example.test'),
  ('98100000-0000-4000-a000-000000000033', 'Duda Pessoa Teste', '11900009804', 'duda.pessoa@example.test');
-- E1: R1 paga, R2 ainda não paga, R3 cancelada, R4 paga que não quer entrar no grupo.
-- E2: R5 paga (de outro coach). E3: R6 paga (evento sem grupo).
INSERT INTO public.event_registrations
  (id, event_id, registration_type_id, customer_id, payment_status, customer_link_confirmed_at,
   asaas_payment_link, external_payment_link, internal_notes, payment_method, whatsapp_group_status) VALUES
  ('98100000-0000-4000-a000-000000000041', '98100000-0000-4000-a000-000000000010', '98100000-0000-4000-a000-000000000020', '98100000-0000-4000-a000-000000000030', 'paid', now(), 'https://asaas.example.test/secreto', 'https://externo.example.test/secreto', 'OBS INTERNA SECRETA', 'pix', 'pending'),
  ('98100000-0000-4000-a000-000000000042', '98100000-0000-4000-a000-000000000010', '98100000-0000-4000-a000-000000000020', '98100000-0000-4000-a000-000000000031', 'pending', now(), NULL, NULL, NULL, NULL, 'pending'),
  ('98100000-0000-4000-a000-000000000043', '98100000-0000-4000-a000-000000000010', '98100000-0000-4000-a000-000000000020', '98100000-0000-4000-a000-000000000032', 'cancelled', now(), NULL, NULL, NULL, NULL, 'pending'),
  ('98100000-0000-4000-a000-000000000044', '98100000-0000-4000-a000-000000000010', '98100000-0000-4000-a000-000000000020', '98100000-0000-4000-a000-000000000033', 'paid', now(), NULL, NULL, NULL, 'pix', 'declined'),
  ('98100000-0000-4000-a000-000000000045', '98100000-0000-4000-a000-000000000011', '98100000-0000-4000-a000-000000000021', '98100000-0000-4000-a000-000000000030', 'paid', now(), NULL, NULL, NULL, 'pix', 'pending'),
  ('98100000-0000-4000-a000-000000000046', '98100000-0000-4000-a000-000000000012', '98100000-0000-4000-a000-000000000022', '98100000-0000-4000-a000-000000000031', 'paid', now(), NULL, NULL, NULL, 'pix', 'pending');

-- Verificação de varredura: devolve, em texto, o que o usuário atual consegue ler.
-- Roda como o papel pedido (authenticated com a conta informada) e volta ao papel original.
CREATE FUNCTION pg_temp.readable_as(p_user UUID, p_role TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  cnt BIGINT;
  found TEXT[] := '{}';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  FOR r IN
    SELECT c.oid::regclass::text AS rel
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM %s', r.rel) INTO cnt;
      IF cnt > 0 THEN found := found || (r.rel || '=' || cnt); END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- sem permissão ou erro: nada foi lido
    END;
  END LOOP;
  RESET ROLE;
  RETURN array_to_string(found, ', ');
END;
$$;

-- ===== Quem é coach =====
SELECT is(public.coach_id_for_user('98100000-0000-4000-a000-0000000000a1'), '98100000-0000-4000-a000-000000000001'::uuid, 'the linked active coach is found by account');
SELECT is(public.coach_id_for_user('98100000-0000-4000-a000-0000000000b1'), '98100000-0000-4000-a000-000000000002'::uuid, 'another coach has their own account');
SELECT is(public.coach_id_for_user('98100000-0000-4000-a000-0000000000c1'), NULL, 'an inactive coach loses access');
SELECT is(public.coach_id_for_user('98100000-0000-4000-a000-0000000000d1'), NULL, 'an account without a coach has no access');
SELECT is(public.coach_id_for_user(NULL), NULL, 'no account means no coach');
SELECT is(public.coach_me('98100000-0000-4000-a000-0000000000a1')->>'name', 'Coach A Login Teste', 'the coach sees their own name');
SELECT throws_like($$SELECT public.coach_me('98100000-0000-4000-a000-0000000000d1')$$, '%não tem acesso de coach%', 'an account without a coach is refused');
SELECT throws_like($$SELECT public.coach_list_events('98100000-0000-4000-a000-0000000000c1')$$, '%não tem acesso de coach%', 'an inactive coach cannot list events');
SELECT throws_like($$SELECT public.coach_get_event('98100000-0000-4000-a000-0000000000e1', '98100000-0000-4000-a000-000000000010')$$, '%não tem acesso de coach%', 'an administrator account is not a coach');

-- ===== Só os eventos em que é responsável =====
SELECT is(
  (SELECT array_agg(x->>'id' ORDER BY x->>'id') FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x),
  ARRAY['98100000-0000-4000-a000-000000000010', '98100000-0000-4000-a000-000000000012'],
  'the coach lists only the events they are responsible for');
SELECT is(
  (SELECT array_agg(x->>'id') FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000b1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000010'),
  NULL, 'the other coach does not see an event that is not theirs');

SELECT is(
  (SELECT x->>'registered' FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000010'),
  '3', 'registered counts exclude cancelled');
SELECT is(
  (SELECT x->>'paid' FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000010'),
  '2', 'paid is counted');
SELECT is(
  (SELECT x->>'not_paid' FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000010'),
  '1', 'not paid is counted');
SELECT is(
  (SELECT (x->>'group_missing') || '/' || (x->>'group_declined') FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000010'),
  '1/1', 'group counts show who is missing and who declined');
SELECT is(
  (SELECT x->'group_added' FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000012'),
  'null'::jsonb, 'an event without a group has no group counts');

SELECT throws_like($$SELECT public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000011')$$, '%Evento não encontrado%', 'an event of another coach is not found');
SELECT throws_like($$SELECT public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-0000000000aa')$$, '%Evento não encontrado%', 'a missing event gives the same answer, so nothing is revealed');

-- ===== O que o coach recebe: lista fixa, sem dinheiro =====
SELECT is(
  (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')) k),
  ARRAY['event', 'registrations', 'summary'], 'the event answer has only the expected parts');
SELECT is(
  (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'event') k),
  ARRAY['address', 'description', 'end_date', 'end_time', 'event_date', 'id', 'location', 'map_url', 'name', 'public_notes', 'start_time', 'status', 'whatsapp_group_enabled'],
  'the event fields are a fixed list');
SELECT is(
  (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'registrations'->0) k),
  ARRAY['id', 'payment', 'person_name', 'registration_number', 'type_name', 'whatsapp', 'whatsapp_group_status'],
  'the registration fields are a fixed list');
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['987.65', '123.45', '55.5', 'price', 'amount', 'asaas', 'secreto', 'SECRETA', 'externo', 'internal', 'revenue', 'ana.pessoa@', 'cpf', 'invoice'])
      AS forbidden(term)
    WHERE position(lower(forbidden.term) IN lower(
      public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')::text)) > 0
  ),
  'nothing about money, charges, e-mail or internal notes reaches the coach');

SELECT is(
  (SELECT x->>'payment' FROM jsonb_array_elements(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'registrations') x WHERE x->>'id' = '98100000-0000-4000-a000-000000000041'),
  'paid', 'a paid registration shows as paid');
SELECT is(
  (SELECT x->>'payment' FROM jsonb_array_elements(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'registrations') x WHERE x->>'id' = '98100000-0000-4000-a000-000000000042'),
  'not_paid', 'a pending registration shows as not paid');
SELECT is(
  (SELECT x->>'payment' FROM jsonb_array_elements(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'registrations') x WHERE x->>'id' = '98100000-0000-4000-a000-000000000043'),
  'cancelled', 'a cancelled registration shows as cancelled');
SELECT is(
  (SELECT x->>'whatsapp' FROM jsonb_array_elements(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'registrations') x WHERE x->>'id' = '98100000-0000-4000-a000-000000000041'),
  '11900009801', 'the WhatsApp of a paid person is shown, to add them to the group');
SELECT is(
  (SELECT x->'whatsapp' FROM jsonb_array_elements(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'registrations') x WHERE x->>'id' = '98100000-0000-4000-a000-000000000042'),
  'null'::jsonb, 'the WhatsApp of someone who has not paid is not shown');
SELECT is(
  (SELECT x->'whatsapp' FROM jsonb_array_elements(public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000012')->'registrations') x LIMIT 1),
  'null'::jsonb, 'an event without a group never shows the WhatsApp');
SELECT is(
  public.coach_get_event('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000010')->'summary'->>'cancelled',
  '1', 'the summary counts the cancelled registration apart');

-- ===== O coach marca o grupo =====
SELECT is(
  public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000041', 'added')->>'whatsapp_group_status',
  'added', 'the responsible coach marks a paid person as in the group');
SELECT is(
  (SELECT whatsapp_group_updated_by FROM public.event_registrations WHERE id = '98100000-0000-4000-a000-000000000041'),
  '98100000-0000-4000-a000-0000000000a1'::uuid, 'the coach account is recorded as who marked it');
SELECT is(
  (SELECT x->>'group_added' FROM jsonb_array_elements(public.coach_list_events('98100000-0000-4000-a000-0000000000a1')) x WHERE x->>'id' = '98100000-0000-4000-a000-000000000010'),
  '1', 'the list reflects the new mark');
SELECT throws_like($$SELECT public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000045', 'added')$$, '%Inscrição não encontrada%', 'the coach cannot mark a registration of another coach''s event');
SELECT throws_like($$SELECT public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000b1', '98100000-0000-4000-a000-000000000041', 'declined')$$, '%Inscrição não encontrada%', 'the other coach cannot mark it either');
SELECT throws_like($$SELECT public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-0000000000cc', 'added')$$, '%Inscrição não encontrada%', 'a missing registration gives the same answer');
SELECT throws_like($$SELECT public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000042', 'added')$$, '%Só inscrição paga%', 'an unpaid person cannot be marked');
SELECT throws_like($$SELECT public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000a1', '98100000-0000-4000-a000-000000000046', 'added')$$, '%não tem grupo no WhatsApp%', 'an event without a group does not track it');
SELECT throws_like($$SELECT public.coach_set_registration_whatsapp_group('98100000-0000-4000-a000-0000000000d1', '98100000-0000-4000-a000-000000000041', 'added')$$, '%não tem acesso de coach%', 'an account without a coach cannot mark');
SELECT is(
  (SELECT whatsapp_group_status FROM public.event_registrations WHERE id = '98100000-0000-4000-a000-000000000045'),
  'pending', 'the refused marks changed nothing');

-- ===== Dados para criar o acesso =====
SELECT is(public.coach_access_target('98100000-0000-4000-a000-000000000004')->>'email', 's-login@example.test', 'the admin side reads the coach e-mail to create the login');
SELECT is((public.coach_access_target('98100000-0000-4000-a000-000000000004')->>'active')::boolean, true, 'the admin side reads whether the coach is active');
SELECT throws_like($$SELECT public.coach_access_target('98100000-0000-4000-a000-0000000000dd')$$, '%Coach não encontrado%', 'an unknown coach is refused');

-- ===== Ligar e desligar a conta =====
SELECT is(
  public.link_coach_auth_user('98100000-0000-4000-a000-000000000004', '98100000-0000-4000-a000-0000000000f1', '98100000-0000-4000-a000-0000000000e1')->>'auth_user_id',
  '98100000-0000-4000-a000-0000000000f1', 'a free account is linked to a coach');
SELECT is(public.coach_id_for_user('98100000-0000-4000-a000-0000000000f1'), '98100000-0000-4000-a000-000000000004'::uuid, 'the linked account now works as that coach');
SELECT throws_like($$SELECT public.link_coach_auth_user('98100000-0000-4000-a000-000000000004', '98100000-0000-4000-a000-0000000000d1', '98100000-0000-4000-a000-0000000000e1')$$, '%já tem acesso%', 'a coach with access is not linked twice');
SELECT throws_ok($$SELECT public.link_coach_auth_user('98100000-0000-4000-a000-000000000005', '98100000-0000-4000-a000-0000000000f1', '98100000-0000-4000-a000-0000000000e1')$$, '23505', NULL, 'an account cannot belong to two coaches');
SELECT throws_like($$SELECT public.link_coach_auth_user('98100000-0000-4000-a000-000000000003', '98100000-0000-4000-a000-0000000000d1', '98100000-0000-4000-a000-0000000000e1')$$, '%inativo%', 'an inactive coach gets no access');
SELECT throws_like($$SELECT public.unlink_coach_auth_user('98100000-0000-4000-a000-0000000000dd', '98100000-0000-4000-a000-0000000000e1')$$, '%Coach não encontrado%', 'unlinking an unknown coach is refused');
SELECT is(public.unlink_coach_auth_user('98100000-0000-4000-a000-000000000004', '98100000-0000-4000-a000-0000000000e1'), '98100000-0000-4000-a000-0000000000f1'::uuid, 'unlinking returns the account that was linked');
SELECT is(public.coach_id_for_user('98100000-0000-4000-a000-0000000000f1'), NULL, 'after unlinking the account has no access');

-- Conta de administrador não vira conta de coach (coach sem conta, ativo).
SELECT throws_like($$SELECT public.link_coach_auth_user('98100000-0000-4000-a000-000000000004', '98100000-0000-4000-a000-0000000000e1', '98100000-0000-4000-a000-0000000000e1')$$, '%administrador%', 'an administrator account cannot be a coach account');

-- ===== Permissões: só o servidor executa =====
SELECT is(
  (SELECT count(*)::int FROM unnest(ARRAY[
    'public.coach_id_for_user(uuid)', 'public.require_coach_for_user(uuid)', 'public.coach_me(uuid)',
    'public.coach_list_events(uuid)', 'public.coach_get_event(uuid,uuid)', 'public.coach_access_target(uuid)',
    'public.coach_set_registration_whatsapp_group(uuid,uuid,text)',
    'public.link_coach_auth_user(uuid,uuid,uuid)', 'public.unlink_coach_auth_user(uuid,uuid)'
  ]) AS f
  WHERE has_function_privilege('service_role', f, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
    AND NOT has_function_privilege('anon', f, 'EXECUTE')),
  9, 'the nine coach functions run only for the server');

-- ===== Isolamento: quem está logado e não é administrador não lê nem grava nada =====
SELECT cmp_ok((SELECT count(*)::int FROM public.presale_customers), '>', 0, 'sanity: the fixtures exist (the sweep is not empty)');
SELECT is(pg_temp.readable_as('98100000-0000-4000-a000-0000000000a1', 'authenticated'), '',
  'a logged-in coach reads no row of any table or view');
SELECT is(pg_temp.readable_as('98100000-0000-4000-a000-0000000000d1', 'authenticated'), '',
  'a logged-in account that is not a coach reads no row of any table or view');
SELECT is(
  (SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
     AND (has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
       OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE'))),
  NULL, 'a logged-in user cannot write to any table');
SELECT is(
  (SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
  NULL, 'no SECURITY DEFINER function of the public schema is open to a logged-in user');

SELECT * FROM finish();
ROLLBACK;
