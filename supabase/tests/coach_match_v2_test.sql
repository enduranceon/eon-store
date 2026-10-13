BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

-- Fixtures are synthetic and the entire test is rolled back.
INSERT INTO auth.users (id, email) VALUES
  ('97100000-0000-4000-a000-000000000001', 'match-v2-admin@example.test');
INSERT INTO public.assessment_coaches (
  id, name, email, role, active, public_visible, modality_ids
) VALUES (
  '97100000-0000-4000-a000-000000000011',
  'Coach Match V2 Fictício',
  'match-v2-coach@example.test',
  'pleno', true, true,
  ARRAY(SELECT id FROM public.assessment_modalities WHERE active IS TRUE ORDER BY name LIMIT 2)
);

CREATE TEMP TABLE match_v2_results (key text PRIMARY KEY, value jsonb);
GRANT ALL ON match_v2_results TO service_role;

CREATE FUNCTION pg_temp.match_v1_answers() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"version":1,"focus_goals":["start","evolve"],"focus_levels":["beginner","regular"],"service_formats":["florianopolis","online"],"communication_style":"close","approach":"Acompanhamento fictício respeitando a rotina individual.","experience":"Experiência fictícia usada somente nos testes."}'::jsonb
$$;
CREATE FUNCTION pg_temp.match_v2_answers() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"version":2,"service_formats":["florianopolis","online"],"focus_goals":{"primary":"performance","secondary":"health"},"focus_levels":{"primary":"intermediate","secondary":"beginner"},"communication_style":{"primary":"balanced","secondary":"close"},"age_groups":{"primary":"age_31_50","secondary":"up_to_30"},"gender_preference":{"primary":"no_preference","secondary":null}}'::jsonb
$$;
GRANT EXECUTE ON FUNCTION pg_temp.match_v1_answers(), pg_temp.match_v2_answers() TO service_role;

-- The additive migration keeps v1 intact and gives v2 separate pointers.
SELECT ok(public.coach_match_answers_valid_v1(pg_temp.match_v1_answers()), 'v1 validator remains valid');
SELECT ok(public.coach_match_answers_valid(pg_temp.match_v1_answers()), 'dispatcher still accepts v1');
SELECT ok(public.coach_match_answers_valid_v2(pg_temp.match_v2_answers()), 'canonical v2 answers are valid');
SELECT ok(public.coach_match_answers_valid(pg_temp.match_v2_answers()), 'dispatcher accepts v2');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"notes":"must not exist"}'), 'v2 refuses free text or extra fields');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() - 'age_groups'), 'v2 refuses a missing criterion');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"version":"2"}'), 'v2 version must be numeric');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"service_formats":[]}'), 'at least one service format is required');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"service_formats":["online","online"]}'), 'service formats cannot repeat');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"focus_goals":{"primary":"performance","secondary":"performance"}}'), 'primary and secondary cannot repeat');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"focus_levels":{"primary":"elite","secondary":null}}'), 'unknown affinity is refused');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"focus_levels":{"primary":null,"secondary":null}}'), 'non-optional primary affinity cannot be null');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"communication_style":{"primary":"balanced"}}'), 'priority object requires both exact keys');
SELECT ok(public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"age_groups":{"primary":"no_preference","secondary":null}}'), 'age can have no preference');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"age_groups":{"primary":"no_preference","secondary":"age_31_50"}}'), 'no age preference is exclusive');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"gender_preference":{"primary":"female","secondary":"no_preference"}}'), 'no gender preference cannot be secondary');
SELECT ok(NOT public.coach_match_answers_valid_v2(pg_temp.match_v2_answers() || '{"gender_preference":{"primary":null,"secondary":null}}'), 'gender primary cannot be null');

SELECT has_column(
  'public', 'assessment_coach_match_state', 'latest_v2_submission_id',
  'v2 latest pointer exists'
);
SELECT has_column(
  'public', 'assessment_coach_match_state', 'published_v2_submission_id',
  'v2 published pointer exists'
);

SELECT ok(
  has_table_privilege('service_role', 'public.assessment_modalities', 'SELECT'),
  'service role can resolve canonical modalities through invoker RPCs'
);

SELECT ok(NOT proc.prosecdef, proc.proname || ' uses invoker security')
FROM pg_proc AS proc
JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
WHERE namespace.nspname = 'public'
  AND proc.proname IN (
    'coach_match_answers_valid_v1', 'coach_match_answers_valid_v2',
    'get_assessment_coach_match_admin_v2', 'load_assessment_coach_match_form_v2',
    'submit_assessment_coach_match_answers_v2',
    'review_assessment_coach_match_submission_v2',
    'list_approved_coach_match_profiles_v2'
  );

SELECT ok(NOT has_function_privilege(role_name, signature, 'EXECUTE'), role_name || ' cannot call ' || signature)
FROM unnest(ARRAY['anon','authenticated']) AS role_name
CROSS JOIN unnest(ARRAY[
  'public.coach_match_answers_valid_v1(jsonb)',
  'public.coach_match_answers_valid_v2(jsonb)',
  'public.get_assessment_coach_match_admin_v2(uuid)',
  'public.load_assessment_coach_match_form_v2(text)',
  'public.submit_assessment_coach_match_answers_v2(text,jsonb)',
  'public.review_assessment_coach_match_submission_v2(uuid,uuid,text,uuid)',
  'public.list_approved_coach_match_profiles_v2()'
]) AS signature;

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT public.list_approved_coach_match_profiles_v2()$$,
  '42501', NULL, 'raw v2 profiles cannot be read by a browser'
);
RESET ROLE;

SET LOCAL ROLE service_role;
INSERT INTO match_v2_results VALUES (
  'invite',
  public.issue_assessment_coach_match_invite(
    '97100000-0000-4000-a000-000000000011', repeat('7',64),
    now()+interval '1 day', '97100000-0000-4000-a000-000000000001'
  )
);
SELECT is(
  public.load_assessment_coach_match_form_v2(repeat('7',64))#>>'{coach,name}',
  'Coach Match V2 Fictício', 'existing invitation loads the v2 form'
);
SELECT is(
  jsonb_array_length(public.load_assessment_coach_match_form_v2(repeat('7',64))#>'{coach,modalities}'),
  (SELECT LEAST(count(*), 2)::integer FROM assessment_modalities WHERE active IS TRUE),
  'form returns canonical coach modalities as read-only context'
);
SELECT throws_ok(
  $$SELECT public.submit_assessment_coach_match_answers_v2(repeat('7',64), pg_temp.match_v1_answers())$$,
  'PT400', NULL, 'v2 submit never accepts a legacy payload'
);
SELECT throws_ok(
  $$SELECT public.submit_assessment_coach_match_answers(repeat('7',64), pg_temp.match_v2_answers())$$,
  'PT400', NULL, 'legacy submit never accepts a v2 payload'
);

-- A pending v1 row and a pending v2 row can coexist during the reversible rollout.
INSERT INTO match_v2_results VALUES (
  'v1_pending',
  public.submit_assessment_coach_match_answers(repeat('7',64), pg_temp.match_v1_answers())
);
UPDATE public.assessment_coach_match_invites
SET last_submitted_at = now()-interval '2 minutes'
WHERE token_hash = repeat('7',64);
INSERT INTO match_v2_results VALUES (
  'v2_pending',
  public.submit_assessment_coach_match_answers_v2(repeat('7',64), pg_temp.match_v2_answers())
);
SELECT is(
  (SELECT count(*)::integer FROM assessment_coach_match_submissions
    WHERE coach_id='97100000-0000-4000-a000-000000000011' AND status='pending'),
  2, 'one v1 and one v2 pending revision can coexist'
);
SELECT is(
  public.get_assessment_coach_match_admin_v2('97100000-0000-4000-a000-000000000011')#>'{latest,answers}',
  pg_temp.match_v2_answers(), 'v2 admin snapshot reads only the v2 latest pointer'
);
SELECT is(
  public.get_assessment_coach_match_admin('97100000-0000-4000-a000-000000000011')#>'{latest,answers}',
  pg_temp.match_v1_answers(), 'v1 admin snapshot still reads the v1 latest pointer'
);

-- Even an accidentally contaminated legacy pointer cannot review or publish
-- demographic v2 affinities through a v1 RPC.
UPDATE public.assessment_coach_match_state
SET latest_submission_id = (
  SELECT (value->>'id')::uuid FROM match_v2_results WHERE key='v2_pending'
)
WHERE coach_id='97100000-0000-4000-a000-000000000011';
SELECT throws_ok(
  format(
    $$SELECT public.review_assessment_coach_match_submission(%L,%L,'approved',%L)$$,
    '97100000-0000-4000-a000-000000000011',
    (SELECT value->>'id' FROM match_v2_results WHERE key='v2_pending'),
    '97100000-0000-4000-a000-000000000001'
  ),
  'PT409', NULL, 'legacy review refuses a v2 submission'
);
UPDATE public.assessment_coach_match_state
SET latest_submission_id = (
  SELECT (value->>'id')::uuid FROM match_v2_results WHERE key='v1_pending'
)
WHERE coach_id='97100000-0000-4000-a000-000000000011';

SELECT is(
  public.review_assessment_coach_match_submission_v2(
    '97100000-0000-4000-a000-000000000011',
    (SELECT (value->>'id')::uuid FROM match_v2_results WHERE key='v2_pending'),
    'approved', '97100000-0000-4000-a000-000000000001'
  )->>'status',
  'approved', 'v2 latest revision can be approved'
);
SELECT is(
  (SELECT answers FROM public.list_approved_coach_match_profiles_v2()
    WHERE coach_id='97100000-0000-4000-a000-000000000011'),
  pg_temp.match_v2_answers(), 'approved v2 profile is available only to server-side matching'
);
UPDATE public.assessment_coach_match_state
SET published_submission_id = (
  SELECT (value->>'id')::uuid FROM match_v2_results WHERE key='v2_pending'
)
WHERE coach_id='97100000-0000-4000-a000-000000000011';
SELECT is(
  (SELECT count(*)::integer FROM public.list_public_coach_match_profiles()
    WHERE coach_id='97100000-0000-4000-a000-000000000011'),
  0, 'legacy public catalog refuses raw v2 affinities even with a contaminated pointer'
);
UPDATE public.assessment_coach_match_state
SET published_submission_id = NULL
WHERE coach_id='97100000-0000-4000-a000-000000000011';
SELECT is(
  public.get_assessment_coach_match_admin_v2('97100000-0000-4000-a000-000000000011')#>>'{published,id}',
  (SELECT value->>'id' FROM match_v2_results WHERE key='v2_pending'),
  'v2 published pointer is independent'
);
SELECT is(
  public.get_assessment_coach_match_admin('97100000-0000-4000-a000-000000000011')#>>'{published,id}',
  NULL, 'approving v2 does not change the v1 published pointer'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
