BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(29);

-- Fixtures fictícias: um evento com grupo, outro sem, dois coaches ativos e um
-- inativo, e inscrições paga, pendente e cancelada.
INSERT INTO auth.users (id, email)
VALUES ('97100000-0000-4000-a000-0000000000ff', 'evento-grupo-admin@example.test');
INSERT INTO public.assessment_coaches (id, name, email, role, active) VALUES
  ('97100000-0000-4000-a000-000000000001', 'Coach Evento A Teste', 'evento-a@example.test', 'senior', true),
  ('97100000-0000-4000-a000-000000000002', 'Coach Evento B Teste', 'evento-b@example.test', 'senior', true),
  ('97100000-0000-4000-a000-000000000003', 'Coach Evento Inativo Teste', 'evento-i@example.test', 'senior', false);
INSERT INTO public.events (id, name, slug, event_date, status) VALUES
  ('97100000-0000-4000-a000-000000000010', 'Evento Com Grupo Teste', 'evento-com-grupo-teste', current_date + 30, 'open'),
  ('97100000-0000-4000-a000-000000000011', 'Evento Sem Grupo Teste', 'evento-sem-grupo-teste', current_date + 30, 'open');
INSERT INTO public.event_registration_types (id, event_id, name, price) VALUES
  ('97100000-0000-4000-a000-000000000020', '97100000-0000-4000-a000-000000000010', 'Geral', 100),
  ('97100000-0000-4000-a000-000000000021', '97100000-0000-4000-a000-000000000011', 'Geral', 100);
INSERT INTO public.presale_customers (id, full_name, whatsapp) VALUES
  ('97100000-0000-4000-a000-000000000030', 'Pessoa Evento Teste', '11900009711');
INSERT INTO public.event_registrations (id, event_id, registration_type_id, customer_id, payment_status) VALUES
  ('97100000-0000-4000-a000-000000000040', '97100000-0000-4000-a000-000000000010', '97100000-0000-4000-a000-000000000020', '97100000-0000-4000-a000-000000000030', 'paid'),
  ('97100000-0000-4000-a000-000000000041', '97100000-0000-4000-a000-000000000010', '97100000-0000-4000-a000-000000000020', '97100000-0000-4000-a000-000000000030', 'pending'),
  ('97100000-0000-4000-a000-000000000042', '97100000-0000-4000-a000-000000000010', '97100000-0000-4000-a000-000000000020', '97100000-0000-4000-a000-000000000030', 'cancelled'),
  ('97100000-0000-4000-a000-000000000043', '97100000-0000-4000-a000-000000000011', '97100000-0000-4000-a000-000000000021', '97100000-0000-4000-a000-000000000030', 'paid');

-- Estrutura e acesso
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_coaches'::regclass),
  'event_coaches has RLS');
SELECT ok(NOT has_table_privilege('anon', 'public.event_coaches', 'SELECT'),
  'anonymous cannot read the responsible coaches');
SELECT ok(NOT has_table_privilege('authenticated', 'public.event_coaches', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.event_coaches', 'DELETE'),
  'the browser cannot write the responsible coaches');
SELECT ok(has_function_privilege('service_role', 'public.set_event_coaches(uuid,uuid[],uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.set_event_coaches(uuid,uuid[],uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.set_event_coaches(uuid,uuid[],uuid)', 'EXECUTE'),
  'only the server can set the responsible coaches');
SELECT ok(has_function_privilege('service_role', 'public.set_event_registration_whatsapp_group(uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.set_event_registration_whatsapp_group(uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.set_event_registration_whatsapp_group(uuid,text,uuid)', 'EXECUTE'),
  'only the server can set the WhatsApp group situation');
SELECT is((SELECT whatsapp_group_enabled FROM public.events WHERE id = '97100000-0000-4000-a000-000000000010'),
  false, 'an event starts without a WhatsApp group');
SELECT is((SELECT whatsapp_group_status FROM public.event_registrations WHERE id = '97100000-0000-4000-a000-000000000040'),
  'pending', 'a registration starts as not added to the group');

SET LOCAL ROLE service_role;

-- Responsáveis do evento
SELECT is(
  (SELECT jsonb_array_length(public.set_event_coaches(
    '97100000-0000-4000-a000-000000000010',
    ARRAY['97100000-0000-4000-a000-000000000001', '97100000-0000-4000-a000-000000000002']::uuid[],
    '97100000-0000-4000-a000-0000000000ff')->'coach_ids')),
  2, 'two responsible coaches can be set');
SELECT is((SELECT count(*)::int FROM public.event_coaches WHERE event_id = '97100000-0000-4000-a000-000000000010'),
  2, 'both are stored');
SELECT is(
  (SELECT created_by FROM public.event_coaches
   WHERE event_id = '97100000-0000-4000-a000-000000000010' AND coach_id = '97100000-0000-4000-a000-000000000001'),
  '97100000-0000-4000-a000-0000000000ff'::uuid, 'who assigned the coach is recorded');

SELECT is(
  (SELECT jsonb_array_length(public.set_event_coaches(
    '97100000-0000-4000-a000-000000000010',
    ARRAY['97100000-0000-4000-a000-000000000001', '97100000-0000-4000-a000-000000000001']::uuid[],
    '97100000-0000-4000-a000-0000000000ff')->'coach_ids')),
  1, 'setting again replaces the list and repeated ids count once');
SELECT is(
  (SELECT coach_id FROM public.event_coaches WHERE event_id = '97100000-0000-4000-a000-000000000010'),
  '97100000-0000-4000-a000-000000000001'::uuid, 'the coach left out was removed');

SELECT throws_like(
  $$SELECT public.set_event_coaches('97100000-0000-4000-a000-000000000010',
    ARRAY['97100000-0000-4000-a000-000000000003']::uuid[], '97100000-0000-4000-a000-0000000000ff')$$,
  '%inativo%', 'an inactive coach cannot be newly assigned');
SELECT throws_like(
  $$SELECT public.set_event_coaches('97100000-0000-4000-a000-000000000010',
    ARRAY['97100000-0000-4000-a000-0000000000aa']::uuid[], '97100000-0000-4000-a000-0000000000ff')$$,
  '%Coach não encontrado%', 'an unknown coach is refused');
SELECT throws_like(
  $$SELECT public.set_event_coaches('97100000-0000-4000-a000-0000000000bb',
    ARRAY[]::uuid[], '97100000-0000-4000-a000-0000000000ff')$$,
  '%Evento não encontrado%', 'an unknown event is refused');
SELECT throws_like(
  $$SELECT public.set_event_coaches('97100000-0000-4000-a000-000000000010',
    ARRAY[]::uuid[], NULL)$$,
  '%Operador inválido%', 'the operator is required');
SELECT is((SELECT count(*)::int FROM public.event_coaches WHERE event_id = '97100000-0000-4000-a000-000000000010'),
  1, 'the refused calls changed nothing');

-- Coach que ficou inativo depois de ser responsável continua na lista.
RESET ROLE;
INSERT INTO public.event_coaches (event_id, coach_id) VALUES
  ('97100000-0000-4000-a000-000000000011', '97100000-0000-4000-a000-000000000003');
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT public.set_event_coaches('97100000-0000-4000-a000-000000000011',
    ARRAY['97100000-0000-4000-a000-000000000003', '97100000-0000-4000-a000-000000000001']::uuid[],
    '97100000-0000-4000-a000-0000000000ff')$$,
  'a coach who became inactive can stay as responsible');
SELECT is(
  (SELECT jsonb_array_length(public.set_event_coaches(
    '97100000-0000-4000-a000-000000000011', ARRAY[]::uuid[], '97100000-0000-4000-a000-0000000000ff')->'coach_ids')),
  0, 'an empty list removes every responsible coach');

-- Grupo do WhatsApp
SELECT throws_like(
  $$SELECT public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000043', 'added', '97100000-0000-4000-a000-0000000000ff')$$,
  '%não tem grupo no WhatsApp%', 'an event without a group does not track it');

RESET ROLE;
UPDATE public.events SET whatsapp_group_enabled = true WHERE id = '97100000-0000-4000-a000-000000000010';
SET LOCAL ROLE service_role;

SELECT is(
  public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000040', 'added', '97100000-0000-4000-a000-0000000000ff')->>'whatsapp_group_status',
  'added', 'a paid registration can be marked as in the group');
SELECT is(
  (SELECT whatsapp_group_updated_by FROM public.event_registrations WHERE id = '97100000-0000-4000-a000-000000000040'),
  '97100000-0000-4000-a000-0000000000ff'::uuid, 'who marked it is recorded');
SELECT isnt(
  (SELECT whatsapp_group_updated_at FROM public.event_registrations WHERE id = '97100000-0000-4000-a000-000000000040'),
  NULL, 'when it was marked is recorded');
SELECT is(
  public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000040', 'declined', '97100000-0000-4000-a000-0000000000ff')->>'whatsapp_group_status',
  'declined', 'a paid registration can be marked as not wanting to join');
SELECT is(
  public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000040', 'pending', '97100000-0000-4000-a000-0000000000ff')->>'whatsapp_group_status',
  'pending', 'it can go back to not added');

SELECT throws_like(
  $$SELECT public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000041', 'added', '97100000-0000-4000-a000-0000000000ff')$$,
  '%Só inscrição paga%', 'an unpaid registration cannot be marked as in the group');
SELECT throws_like(
  $$SELECT public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000042', 'pending', '97100000-0000-4000-a000-0000000000ff')$$,
  '%cancelada ou reembolsada%', 'a cancelled registration is not tracked');
SELECT throws_like(
  $$SELECT public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-000000000040', 'maybe', '97100000-0000-4000-a000-0000000000ff')$$,
  '%Situação do grupo inválida%', 'an unknown situation is refused');
SELECT throws_like(
  $$SELECT public.set_event_registration_whatsapp_group('97100000-0000-4000-a000-0000000000cc', 'added', '97100000-0000-4000-a000-0000000000ff')$$,
  '%Inscrição não encontrada%', 'an unknown registration is refused');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
