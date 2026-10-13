BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(18);

-- Modalidades e coaches fictícios.
INSERT INTO public.assessment_modalities (id, name, active) VALUES
  ('87000000-0000-4000-a000-0000000000a1', 'Corrida teste fila', true),
  ('87000000-0000-4000-a000-0000000000a2', 'Natação teste fila', true);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active, public_visible) VALUES
  ('87000000-0000-4000-a000-0000000000c1', 'Coach fila fictício', 'coach-fila@example.test', 'pleno',
   ARRAY['87000000-0000-4000-a000-0000000000a1'::uuid], true, true),
  ('87000000-0000-4000-a000-0000000000c2', 'Coach interno fictício', 'coach-fila-2@example.test', 'senior',
   ARRAY['87000000-0000-4000-a000-0000000000a1'::uuid], true, false);

SELECT ok(
  (SELECT accepting_new_students FROM public.assessment_coaches
   WHERE id = '87000000-0000-4000-a000-0000000000c1'),
  'coaches keep receiving new students until the team says otherwise'
);

INSERT INTO public.assessment_coach_waitlist (id, coach_id, modality_id, full_name, whatsapp) VALUES
  ('87000000-0000-4000-a000-0000000000e1', '87000000-0000-4000-a000-0000000000c1',
   '87000000-0000-4000-a000-0000000000a1', 'Pessoa Fila Fictícia', '+5548999990401');
SELECT is(
  (SELECT source || '/' || status FROM public.assessment_coach_waitlist
   WHERE id = '87000000-0000-4000-a000-0000000000e1'),
  'internal/waiting',
  'a manual entry starts as internal and waiting'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_coach_waitlist (coach_id, modality_id, full_name, whatsapp)
    VALUES ('87000000-0000-4000-a000-0000000000c1', '87000000-0000-4000-a000-0000000000a2',
            'Outra Pessoa Fictícia', '+5548999990402')$$,
  '22023', 'O coach não atende esta modalidade',
  'the modality must be one the coach serves'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_coach_waitlist (coach_id, full_name, whatsapp)
    VALUES ('87000000-0000-4000-a000-0000000000c1', 'Pessoa Fila Fictícia', '+5548999990401')$$,
  '22023', 'Esta pessoa já está na lista de espera deste coach',
  'a person waits only once for the same coach'
);

UPDATE public.assessment_coach_waitlist
SET status = 'closed', closed_reason = 'Desistiu', source = 'site'
WHERE id = '87000000-0000-4000-a000-0000000000e1';
SELECT is(
  (SELECT source || '/' || status || '/' || closed_reason FROM public.assessment_coach_waitlist
   WHERE id = '87000000-0000-4000-a000-0000000000e1'),
  'internal/closed/Desistiu',
  'closing keeps the reason and the origin cannot change'
);
SELECT lives_ok(
  $$INSERT INTO public.assessment_coach_waitlist (coach_id, full_name, whatsapp)
    VALUES ('87000000-0000-4000-a000-0000000000c1', 'Pessoa Fila Fictícia', '+5548999990401')$$,
  'after closing, the person can join the list again'
);
SELECT throws_ok(
  $$UPDATE public.assessment_coach_waitlist SET status = 'waiting'
    WHERE id = '87000000-0000-4000-a000-0000000000e1'$$,
  '22023', 'Esta pessoa já está na lista de espera deste coach',
  'reopening an old entry cannot duplicate an open one'
);
DELETE FROM public.assessment_coach_waitlist
WHERE coach_id = '87000000-0000-4000-a000-0000000000c1' AND source = 'internal'
  AND id <> '87000000-0000-4000-a000-0000000000e1';
UPDATE public.assessment_coach_waitlist SET status = 'waiting'
WHERE id = '87000000-0000-4000-a000-0000000000e1';
SELECT is(
  (SELECT closed_reason FROM public.assessment_coach_waitlist
   WHERE id = '87000000-0000-4000-a000-0000000000e1'),
  NULL,
  'reopening clears the closing reason'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_coach_waitlist', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.assessment_coach_waitlist', 'INSERT')
  AND NOT has_function_privilege('anon', 'public.submit_public_coach_waitlist(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.submit_public_coach_waitlist(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, text, text)', 'EXECUTE'),
  'browsers cannot read or write the list, nor call the site function'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assessment_coach_waitlist'::regclass),
  'row level security is on'
);

-- Envio pelo site.
CREATE FUNCTION pg_temp.join_list(p_request uuid, p_coach uuid, p_name text, p_phone text, p_region text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.submit_public_coach_waitlist(
    p_request, p_coach, '87000000-0000-4000-a000-0000000000a1', p_name, p_phone,
    'fila@example.test', p_region, 'Prefiro treinar de manhã', 'https://example.test/coach',
    '{"utm_source":"teste"}'::jsonb, 'ip-hash-fila', p_phone || '-hash'
  )
$$;
GRANT EXECUTE ON FUNCTION pg_temp.join_list(uuid, uuid, text, text, text) TO service_role;
INSERT INTO eon_private.public_form_rate_limits (ip_hash, phone_hash)
SELECT 'ip-hash-limite', '+5548999990409-hash' FROM generate_series(1, 4);
SET LOCAL ROLE service_role;

SELECT is(
  pg_temp.join_list('87000000-0000-4000-a000-0000000000d1', '87000000-0000-4000-a000-0000000000c1',
                    'Pessoa Site Fila', '+5548999990403', 'online')->>'status',
  'created',
  'the site puts the person on the coach list'
);
SELECT is(
  (SELECT source || '/' || status || '/' || region FROM public.assessment_coach_waitlist
   WHERE request_id = '87000000-0000-4000-a000-0000000000d1'),
  'site/waiting/online',
  'the entry is marked as coming from the site'
);
SELECT is(
  pg_temp.join_list('87000000-0000-4000-a000-0000000000d1', '87000000-0000-4000-a000-0000000000c1',
                    'Pessoa Site Fila', '+5548999990403', 'online')->>'status',
  'duplicate',
  'sending the same form again does not create a second entry'
);
SELECT throws_ok(
  $$SELECT pg_temp.join_list('87000000-0000-4000-a000-0000000000d1', '87000000-0000-4000-a000-0000000000c1',
                             'Outro Nome Fila', '+5548999990403', 'online')$$,
  'P0001', 'Esta chave de envio já foi usada com outros dados',
  'a reused send key with other data is refused'
);
SELECT is(
  pg_temp.join_list('87000000-0000-4000-a000-0000000000d2', '87000000-0000-4000-a000-0000000000c1',
                    'Pessoa Site Fila', '+5548999990403', NULL)->>'status',
  'duplicate',
  'a person already waiting for this coach is not added twice'
);
SELECT throws_ok(
  $$SELECT pg_temp.join_list('87000000-0000-4000-a000-0000000000d3', '87000000-0000-4000-a000-0000000000c2',
                             'Pessoa Site Fila', '+5548999990404', NULL)$$,
  'P0002', 'Coach indisponível',
  'a coach hidden from the site has no public list'
);
SELECT throws_ok(
  $$SELECT pg_temp.join_list('87000000-0000-4000-a000-0000000000d4', '87000000-0000-4000-a000-0000000000c1',
                             'Pessoa Site Fila', '+5548999990405', 'lua')$$,
  '22023', 'Dados obrigatórios inválidos',
  'only the regions the site uses are accepted'
);
SELECT throws_ok(
  $$SELECT pg_temp.join_list('87000000-0000-4000-a000-0000000000d5', '87000000-0000-4000-a000-0000000000c1',
                             'Pessoa Limite Fila', '+5548999990409', NULL)$$,
  'P0001', 'Este telefone já enviou vários cadastros hoje',
  'the same attempt limit as the site enrollment applies'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
