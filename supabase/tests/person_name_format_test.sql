BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(10);

SELECT is(
  eon_private.format_person_name('  CAIO DOS SANTOS  DE CAMPOS '),
  'Caio dos Santos de Campos',
  'capital initials, Portuguese particles in lower case and spaces trimmed'
);
SELECT is(
  eon_private.format_person_name('maria-clara d''ávila e souza'),
  'Maria-Clara D''Ávila e Souza',
  'hyphen, apostrophe and accents'
);
SELECT is(
  eon_private.format_person_name('pedro henrique ii'),
  'Pedro Henrique II',
  'roman numerals stay in capitals'
);
SELECT is(
  eon_private.format_person_name(eon_private.format_person_name('JOÃO DA SILVA')),
  'João da Silva',
  'formatting twice gives the same name'
);

-- Pessoas fictícias.
INSERT INTO public.presale_customers (id, full_name)
VALUES ('88000000-0000-4000-a000-0000000000f1', 'ANA PESSOA DA SILVA');
SELECT is(
  (SELECT full_name FROM public.presale_customers WHERE id = '88000000-0000-4000-a000-0000000000f1'),
  'Ana Pessoa da Silva',
  'a new customer is saved with the standard name'
);
UPDATE public.presale_customers SET full_name = 'ana pessoa dos santos'
WHERE id = '88000000-0000-4000-a000-0000000000f1';
SELECT is(
  (SELECT full_name FROM public.presale_customers WHERE id = '88000000-0000-4000-a000-0000000000f1'),
  'Ana Pessoa dos Santos',
  'editing the name keeps the standard'
);

INSERT INTO public.assessment_modalities (id, name, active)
VALUES ('88000000-0000-4000-a000-0000000000a1', 'Corrida teste nome', true);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active, public_visible)
VALUES ('88000000-0000-4000-a000-0000000000c1', 'COACH NOME FICTÍCIO', 'coach-nome@example.test', 'pleno',
        ARRAY['88000000-0000-4000-a000-0000000000a1'::uuid], true, true);
INSERT INTO public.presale_trainers (name) VALUES ('treinador nome fictício');
SELECT ok(
  (SELECT name FROM public.assessment_coaches WHERE id = '88000000-0000-4000-a000-0000000000c1') = 'Coach Nome Fictício'
  AND EXISTS (SELECT 1 FROM public.presale_trainers WHERE name = 'Treinador Nome Fictício'),
  'coaches and store trainers follow the same standard'
);

-- Lista de espera pelo site: o reenvio com o nome em minúsculas é o mesmo envio.
CREATE FUNCTION pg_temp.join_list(p_request uuid, p_name text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.submit_public_coach_waitlist(
    p_request, '88000000-0000-4000-a000-0000000000c1', NULL, p_name, '+5548999990501',
    NULL, NULL, NULL, NULL, '{}'::jsonb, 'ip-hash-nome', 'phone-hash-nome'
  )
$$;
GRANT EXECUTE ON FUNCTION pg_temp.join_list(uuid, text) TO service_role;
SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.join_list('88000000-0000-4000-a000-0000000000d1', 'bia fila fictícia')->>'status',
  'created',
  'the site sends a lower-case name'
);
SELECT is(
  pg_temp.join_list('88000000-0000-4000-a000-0000000000d1', 'bia fila fictícia')->>'status',
  'duplicate',
  'sending the same form again is still recognized'
);
RESET ROLE;

SELECT ok(
  NOT has_table_privilege('authenticated', 'eon_private.person_name_format_backup_20261013', 'SELECT')
  AND NOT has_table_privilege('anon', 'eon_private.person_name_format_backup_20261013', 'SELECT'),
  'the copy of the old names is not readable from the browser'
);

SELECT * FROM finish();
ROLLBACK;
