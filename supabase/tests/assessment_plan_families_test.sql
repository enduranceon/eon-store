BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(37);

-- Modalidades, grupos, planos e coaches fictícios.
INSERT INTO public.assessment_modalities (id, name, active) VALUES
  ('8a000000-0000-4000-a000-0000000000a1', 'Corrida teste link', true),
  ('8a000000-0000-4000-a000-0000000000a2', 'Natação teste link', true);
INSERT INTO public.assessment_plan_families (id, modality_id, name, link_token, link_token_no_fee) VALUES
  ('8a000000-0000-4000-a000-0000000000f1', '8a000000-0000-4000-a000-0000000000a1', 'Corrida   Teste Link', 'linkcorridateste0001', 'semmatricula00000001');
INSERT INTO public.assessment_plan_families (id, modality_id, name, link_token) VALUES
  ('8a000000-0000-4000-a000-0000000000f2', '8a000000-0000-4000-a000-0000000000a1', 'Outro Grupo', 'linkoutrogrupo000001');
INSERT INTO public.assessment_plans
  (id, modality_id, family_id, name, period, period_months, price_monthly, price_total, max_installments, enrollment_fee, active, available_online)
VALUES
  ('8a000000-0000-4000-a000-0000000000b1', '8a000000-0000-4000-a000-0000000000a1', '8a000000-0000-4000-a000-0000000000f1',
   'Corrida Teste Link - Mensal', 'mensal', 1, 210, 210, 1, 39.90, true, false),
  ('8a000000-0000-4000-a000-0000000000b3', '8a000000-0000-4000-a000-0000000000a1', '8a000000-0000-4000-a000-0000000000f1',
   'Corrida Teste Link - Trimestral', 'trimestral', 3, 195, 585, 3, 39.90, true, false),
  ('8a000000-0000-4000-a000-0000000000b9', '8a000000-0000-4000-a000-0000000000a1', '8a000000-0000-4000-a000-0000000000f2',
   'Outro Grupo - Mensal', 'mensal', 1, 300, 300, 1, 0, true, false);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active, public_visible) VALUES
  ('8a000000-0000-4000-a000-0000000000c1', 'Coach Link Interno', 'coach-link@example.test', 'pleno',
   ARRAY['8a000000-0000-4000-a000-0000000000a1'::uuid], true, false),
  ('8a000000-0000-4000-a000-0000000000c2', 'Coach Link Natação', 'coach-link-2@example.test', 'pleno',
   ARRAY['8a000000-0000-4000-a000-0000000000a2'::uuid], true, true);

SELECT is(
  (SELECT name FROM public.assessment_plan_families WHERE id = '8a000000-0000-4000-a000-0000000000f1'),
  'Corrida Teste Link',
  'group names lose extra spaces'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_plans (modality_id, family_id, name, period, period_months, price_monthly, price_total, max_installments, active)
    VALUES ('8a000000-0000-4000-a000-0000000000a1', '8a000000-0000-4000-a000-0000000000f1', 'Outro mensal', 'mensal', 1, 220, 220, 1, true)$$,
  '22023', 'Este plano já tem uma duração ativa com esses meses',
  'a group has one active plan for each duration'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_plans (modality_id, family_id, name, period, period_months, price_monthly, price_total, max_installments, active)
    VALUES ('8a000000-0000-4000-a000-0000000000a2', '8a000000-0000-4000-a000-0000000000f1', 'Natação semestral', 'semestral', 6, 200, 1200, 6, true)$$,
  '22023', 'O grupo é de outra modalidade',
  'a duration belongs to a group of the same modality'
);
SELECT lives_ok(
  $$INSERT INTO public.assessment_plans (modality_id, family_id, name, period, period_months, price_monthly, price_total, max_installments, active)
    VALUES ('8a000000-0000-4000-a000-0000000000a1', '8a000000-0000-4000-a000-0000000000f1', 'Mensal antigo', 'mensal', 1, 190, 190, 1, false)$$,
  'an old inactive price can stay in the group'
);
UPDATE public.assessment_plan_families
SET link_token = 'trocadopelatela00001', link_token_no_fee = 'trocadopelatela00002',
    modality_id = '8a000000-0000-4000-a000-0000000000a2'
WHERE id = '8a000000-0000-4000-a000-0000000000f1';
SELECT is(
  (SELECT link_token || '/' || link_token_no_fee || '/' || modality_id::text FROM public.assessment_plan_families WHERE id = '8a000000-0000-4000-a000-0000000000f1'),
  'linkcorridateste0001/semmatricula00000001/8a000000-0000-4000-a000-0000000000a1',
  'the link and the modality of a group do not change after creation'
);
INSERT INTO public.assessment_plan_families (id, modality_id, name)
VALUES ('8a000000-0000-4000-a000-0000000000f3', '8a000000-0000-4000-a000-0000000000a2', 'Grupo Novo');
SELECT ok(
  (SELECT link_token ~ '^[a-z0-9]{20}$' FROM public.assessment_plan_families WHERE id = '8a000000-0000-4000-a000-0000000000f3'),
  'a new group gets its own secret link'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_plan_families', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.assessment_plan_families', 'INSERT')
  AND NOT has_function_privilege('anon', 'public.submit_plan_link_prospect(text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, text, text, text, date, text)', 'EXECUTE'),
  'browsers cannot read the links nor call the link function'
);

-- O que a página do link mostra.
SET LOCAL ROLE service_role;
SELECT is(
  (SELECT jsonb_build_object(
     'name', l->'family'->>'name',
     'months', (SELECT jsonb_agg(o->'period_months') FROM jsonb_array_elements(l->'options') o),
     'coach', l->'coach'->>'name')
   FROM (SELECT public.get_plan_link('linkcorridateste0001', '8a000000-0000-4000-a000-0000000000c1') AS l) x),
  jsonb_build_object('name', 'Corrida Teste Link', 'months', jsonb_build_array(1, 3), 'coach', 'Coach Link Interno'),
  'the link shows the active durations and the chosen coach'
);
SELECT is(
  (SELECT jsonb_array_length(l->'coaches') FROM (SELECT public.get_plan_link('linkcorridateste0001', NULL) AS l) x),
  1,
  'without a coach in the link, the coaches of the modality are listed'
);
SELECT is(public.get_plan_link('linkerrado0000000001', NULL), NULL, 'an unknown link shows nothing');
SELECT is(
  (SELECT jsonb_build_object(
     'fees', (SELECT jsonb_agg((o->>'enrollment_fee')::numeric) FROM jsonb_array_elements(l->'options') o),
     'no_fee', l->'no_enrollment_fee')
   FROM (SELECT public.get_plan_link('linkcorridateste0001', NULL) AS l) x),
  jsonb_build_object('fees', jsonb_build_array(39.90, 39.90), 'no_fee', false),
  'the regular link shows the enrollment fee'
);
SELECT is(
  (SELECT jsonb_build_object(
     'fees', (SELECT jsonb_agg((o->>'enrollment_fee')::numeric) FROM jsonb_array_elements(l->'options') o),
     'no_fee', l->'no_enrollment_fee')
   FROM (SELECT public.get_plan_link('semmatricula00000001', NULL) AS l) x),
  jsonb_build_object('fees', jsonb_build_array(0, 0), 'no_fee', true),
  'the link without fee hides the enrollment fee'
);
RESET ROLE;

-- Cadastro pelo link.
CREATE FUNCTION pg_temp.send(p_token text, p_request uuid, p_plan uuid, p_coach uuid, p_cpf text, p_name text DEFAULT 'pessoa link fictícia')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.submit_plan_link_prospect(
    p_token, p_request, p_plan, p_coach, p_name, '+5548999990601', 'link@example.test', p_cpf,
    'online', '88000000', 'Rua Fictícia', '10', '', 'Centro', 'Florianópolis', 'SC', now(),
    'ip-hash-link', 'phone-hash-link-' || p_cpf, 'teste'
  )
$$;
GRANT EXECUTE ON FUNCTION pg_temp.send(text, uuid, uuid, uuid, text, text) TO service_role;
SET LOCAL ROLE service_role;

SELECT is(
  pg_temp.send('linkcorridateste0001', '8a000000-0000-4000-a000-0000000000d1', '8a000000-0000-4000-a000-0000000000b3',
               '8a000000-0000-4000-a000-0000000000c1', '52998224725')->>'status',
  'created',
  'the link creates a prospect even with a coach who is not on the site'
);
SELECT is(
  (SELECT prospect_stage || '/' || status || '/' || (plan_snapshot->>'snapshot_source') FROM public.assessment_contracts
   WHERE id = (SELECT contract_id FROM public.assessment_prospect_submissions WHERE request_id = '8a000000-0000-4000-a000-0000000000d1')),
  'new/draft/plan_link',
  'the prospect starts as new on the board'
);
SELECT is(
  (SELECT source || '/' || submitted_full_name FROM public.assessment_prospect_submissions WHERE request_id = '8a000000-0000-4000-a000-0000000000d1'),
  'plan_link/pessoa link fictícia',
  'the submission keeps what the person typed and comes from the link'
);
SELECT is(
  (SELECT full_name FROM public.presale_customers WHERE cpf = '52998224725'),
  'Pessoa Link Fictícia',
  'the customer name follows the standard'
);
SELECT is(
  pg_temp.send('linkcorridateste0001', '8a000000-0000-4000-a000-0000000000d1', '8a000000-0000-4000-a000-0000000000b3',
               '8a000000-0000-4000-a000-0000000000c1', '52998224725')->>'status',
  'duplicate',
  'sending the same form again does not create another prospect'
);
SELECT is(
  pg_temp.send('semmatricula00000001', '8a000000-0000-4000-a000-0000000000d7', '8a000000-0000-4000-a000-0000000000b1',
               '8a000000-0000-4000-a000-0000000000c1', '11144477735', 'pessoa sem matricula')->>'status',
  'created',
  'the link without fee also creates the prospect'
);
SELECT is(
  (SELECT enrollment_fee || '/' || (plan_snapshot->>'enrollment_fee_waived') || '/' || (notes LIKE '%sem taxa de matrícula%')::text
   FROM public.assessment_contracts
   WHERE id = (SELECT contract_id FROM public.assessment_prospect_submissions
               WHERE request_id = '8a000000-0000-4000-a000-0000000000d7')),
  '0.00/true/true',
  'the prospect from the link without fee has no enrollment fee'
);
SELECT throws_ok(
  $$SELECT pg_temp.send('linkerrado0000000001', '8a000000-0000-4000-a000-0000000000d2', '8a000000-0000-4000-a000-0000000000b3',
                        '8a000000-0000-4000-a000-0000000000c1', '11144477735')$$,
  'P0002', 'Link indisponível',
  'an unknown link is refused'
);
SELECT throws_ok(
  $$SELECT pg_temp.send('linkcorridateste0001', '8a000000-0000-4000-a000-0000000000d3', '8a000000-0000-4000-a000-0000000000b9',
                        '8a000000-0000-4000-a000-0000000000c1', '11144477735')$$,
  'P0002', 'Plano indisponível',
  'a plan from another group cannot be chosen through this link'
);
SELECT throws_ok(
  $$SELECT pg_temp.send('linkcorridateste0001', '8a000000-0000-4000-a000-0000000000d4', '8a000000-0000-4000-a000-0000000000b1',
                        '8a000000-0000-4000-a000-0000000000c2', '11144477735')$$,
  'P0002', 'Treinador indisponível para este plano',
  'the coach must serve the modality of the plan'
);
RESET ROLE;

UPDATE public.assessment_plan_families SET link_enabled = false WHERE id = '8a000000-0000-4000-a000-0000000000f1';
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT pg_temp.send('linkcorridateste0001', '8a000000-0000-4000-a000-0000000000d5', '8a000000-0000-4000-a000-0000000000b1',
                        '8a000000-0000-4000-a000-0000000000c1', '11144477735')$$,
  'P0002', 'Link indisponível',
  'a turned-off link stops accepting people'
);
RESET ROLE;

-- O cadastro do site continua exigindo coach visível no site.
SELECT throws_ok(
  $$INSERT INTO public.assessment_prospect_submissions (request_id, customer_id, contract_id, plan_id, coach_id,
      submitted_full_name, submitted_whatsapp, submitted_cpf, terms_accepted_at, ip_hash)
    SELECT '8a000000-0000-4000-a000-0000000000d6', customer_id, contract_id, plan_id, coach_id,
      'Pessoa Site', '+5548999990601', '52998224725', now(), 'ip'
    FROM public.assessment_prospect_submissions WHERE request_id = '8a000000-0000-4000-a000-0000000000d1'$$,
  'P0002', 'Treinador indisponível para este plano no site',
  'site submissions still require a coach shown on the site'
);

-- Nascimento e gênero no cadastro pelo link (opcionais no servidor) -------------
CREATE FUNCTION pg_temp.send_profile(p_request uuid, p_cpf text, p_birth date, p_gender text, p_name text DEFAULT 'pessoa perfil fictícia')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.submit_plan_link_prospect(
    'linkcorridateste0001', p_request, '8a000000-0000-4000-a000-0000000000b3', '8a000000-0000-4000-a000-0000000000c1',
    p_name, '+5548999990602', 'perfil@example.test', p_cpf,
    'online', '88000000', 'Rua Fictícia', '10', '', 'Centro', 'Florianópolis', 'SC', now(),
    'ip-hash-link-profile-' || p_request::text, 'phone-hash-link-profile-' || p_request::text, 'teste',
    p_birth, p_gender
  )
$$;
GRANT EXECUTE ON FUNCTION pg_temp.send_profile(uuid, text, date, text, text) TO service_role;
-- Um teste acima desliga o link; religa para os casos abaixo.
UPDATE public.assessment_plan_families SET link_enabled = true WHERE id = '8a000000-0000-4000-a000-0000000000f1';
SET LOCAL ROLE service_role;

SELECT is(
  pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e1', '39053344705', '1990-03-12', ' Feminino ')->>'status',
  'created',
  'the link accepts birth date and gender'
);
SELECT is(
  (SELECT birth_date::text || '|' || gender FROM public.presale_customers WHERE cpf = '39053344705'),
  '1990-03-12|feminino',
  'a new customer from the link gets the submitted birth date and gender'
);
SELECT is(
  (SELECT submitted_birth_date::text || '|' || submitted_gender
   FROM public.assessment_prospect_submissions WHERE request_id = '8a000000-0000-4000-a000-0000000000e1'),
  '1990-03-12|feminino',
  'the receipt keeps the submitted birth date and gender'
);
SELECT is(
  pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e1', '39053344705', '1990-03-12', 'feminino')->>'status',
  'duplicate',
  'a same-key retry with the same profile is idempotent'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e1', '39053344705', '1991-03-12', 'feminino')$$,
  'P0001', 'Esta chave de envio já foi usada com outros dados',
  'a retry cannot change the birth date'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e1', '39053344705', '1990-03-12', 'masculino')$$,
  'P0001', 'Esta chave de envio já foi usada com outros dados',
  'a retry cannot change the gender'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e2', '45317828791', (current_date + 2), NULL)$$,
  '22023', 'Data de nascimento inválida',
  'a future birth date is rejected'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e3', '45317828791', '1899-12-31', NULL)$$,
  '22023', 'Data de nascimento inválida',
  'a birth date before 1900 is rejected'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e4', '45317828791', NULL, 'invalido')$$,
  '22023', 'Gênero inválido',
  'an unknown gender is rejected'
);
SELECT is(
  (SELECT submitted_birth_date IS NULL AND submitted_gender IS NULL
   FROM public.assessment_prospect_submissions WHERE request_id = '8a000000-0000-4000-a000-0000000000d1'),
  true,
  'a page without birth date and gender still works and stays empty'
);
SELECT is(
  pg_temp.send_profile('8a000000-0000-4000-a000-0000000000e5', '52998224725', '1985-05-05', 'masculino')->>'status',
  'created',
  'a customer that already exists can send the form again'
);
SELECT is(
  (SELECT birth_date IS NULL AND gender IS NULL FROM public.presale_customers WHERE cpf = '52998224725'),
  true,
  'the link never fills the profile of an existing customer'
);
SELECT is(
  (SELECT submitted_birth_date::text || '|' || submitted_gender
   FROM public.assessment_prospect_submissions WHERE request_id = '8a000000-0000-4000-a000-0000000000e5'),
  '1985-05-05|masculino',
  'the profile sent for an existing customer stays in the receipt for review'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
