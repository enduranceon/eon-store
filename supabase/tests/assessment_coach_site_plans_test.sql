BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(11);

-- Modalidades, planos e coach fictícios.
INSERT INTO public.assessment_modalities (id, name, active) VALUES
  ('86000000-0000-4000-a000-0000000000a1', 'Corrida teste site', true),
  ('86000000-0000-4000-a000-0000000000a2', 'Triathlon teste site', true);
INSERT INTO public.assessment_plans
  (id, modality_id, name, period, period_months, price_monthly, price_total, max_installments, active, available_online)
VALUES
  ('86000000-0000-4000-a000-0000000000b1', '86000000-0000-4000-a000-0000000000a1', 'Corrida Essencial Mensal', 'mensal', 1, 210, 210, 1, true, false),
  ('86000000-0000-4000-a000-0000000000b2', '86000000-0000-4000-a000-0000000000a1', 'Corrida Mensal', 'mensal', 1, 240, 240, 1, true, true),
  ('86000000-0000-4000-a000-0000000000b3', '86000000-0000-4000-a000-0000000000a1', 'Corrida Essencial Trimestral', 'trimestral', 3, 195, 585, 3, true, false),
  ('86000000-0000-4000-a000-0000000000b4', '86000000-0000-4000-a000-0000000000a1', 'Corrida antiga', 'mensal', 1, 150, 150, 1, false, false),
  ('86000000-0000-4000-a000-0000000000b5', '86000000-0000-4000-a000-0000000000a2', 'Triathlon Mensal', 'mensal', 1, 350, 350, 1, true, true);
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active, public_visible) VALUES
  ('86000000-0000-4000-a000-0000000000c1', 'Coach site fictício', 'coach-site@example.test', 'pleno',
   ARRAY['86000000-0000-4000-a000-0000000000a1'::uuid], true, true),
  ('86000000-0000-4000-a000-0000000000c2', 'Outro coach site fictício', 'coach-site-2@example.test', 'senior',
   ARRAY['86000000-0000-4000-a000-0000000000a1'::uuid], true, true);

SELECT lives_ok(
  $$INSERT INTO public.assessment_coach_site_plans (coach_id, modality_id, period_months, plan_id)
    VALUES ('86000000-0000-4000-a000-0000000000c1', '86000000-0000-4000-a000-0000000000a1', 1,
            '86000000-0000-4000-a000-0000000000b1')$$,
  'a coach can sell a plan that is not one of the general site plans'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_coach_site_plans (coach_id, modality_id, period_months, plan_id)
    VALUES ('86000000-0000-4000-a000-0000000000c1', '86000000-0000-4000-a000-0000000000a1', 1,
            '86000000-0000-4000-a000-0000000000b2')$$,
  '23505', NULL,
  'one plan per modality and duration'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_coach_site_plans (coach_id, modality_id, period_months, plan_id)
    VALUES ('86000000-0000-4000-a000-0000000000c1', '86000000-0000-4000-a000-0000000000a1', 6,
            '86000000-0000-4000-a000-0000000000b3')$$,
  '22023', 'O plano escolhido é de outra duração',
  'the plan must have the same duration'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_coach_site_plans (coach_id, modality_id, period_months, plan_id)
    VALUES ('86000000-0000-4000-a000-0000000000c1', '86000000-0000-4000-a000-0000000000a1', 1,
            '86000000-0000-4000-a000-0000000000b5')$$,
  '22023', 'O plano escolhido é de outra modalidade',
  'the plan must be of the same modality'
);
SELECT throws_ok(
  $$UPDATE public.assessment_coach_site_plans SET plan_id = '86000000-0000-4000-a000-0000000000b4'
    WHERE coach_id = '86000000-0000-4000-a000-0000000000c1' AND period_months = 1$$,
  '22023', 'Escolha um plano ativo',
  'an inactive plan cannot be chosen'
);
SELECT lives_ok(
  $$INSERT INTO public.assessment_coach_site_plans (coach_id, modality_id, period_months, plan_id)
    VALUES ('86000000-0000-4000-a000-0000000000c1', '86000000-0000-4000-a000-0000000000a1', 3,
            '86000000-0000-4000-a000-0000000000b3')$$,
  'another duration gets its own plan'
);
SELECT is(
  (SELECT count(*)::integer FROM public.assessment_coach_site_plans
   WHERE coach_id = '86000000-0000-4000-a000-0000000000c1'),
  2,
  'the coach has one plan for each chosen duration'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_coach_site_plans', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.assessment_coach_site_plans', 'INSERT'),
  'browsers cannot write, and anonymous visitors cannot read'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assessment_coach_site_plans'::regclass),
  'row level security is on'
);

-- Cadastro pelo site: o plano do coach vale para ele, não para outro coach.
CREATE FUNCTION pg_temp.submit_site(p_request uuid, p_coach uuid, p_phone text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.submit_public_assessment_prospect(
    p_request, 'Pessoa Site Fictícia', p_phone, 'pessoa-site@example.test', '52998224725',
    '86000000-0000-4000-a000-0000000000b1', p_coach, 'Florianópolis', '88000000', 'Rua Fictícia',
    '10', '', 'Centro', 'Florianópolis', 'SC', now(), 'https://example.test', '{}'::jsonb,
    'ip-hash-site', p_phone || '-hash', 'teste'
  )
$$;
GRANT EXECUTE ON FUNCTION pg_temp.submit_site(uuid, uuid, text) TO service_role;
SET LOCAL ROLE service_role;
SELECT is(
  pg_temp.submit_site('86000000-0000-4000-a000-0000000000d1', '86000000-0000-4000-a000-0000000000c1', '+5548999990301')->>'status',
  'created',
  'the site accepts the plan chosen for this coach'
);
SELECT throws_ok(
  $$SELECT pg_temp.submit_site('86000000-0000-4000-a000-0000000000d2', '86000000-0000-4000-a000-0000000000c2', '+5548999990302')$$,
  'P0002', 'Plano indisponível',
  'another coach cannot sell that plan on the site'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
