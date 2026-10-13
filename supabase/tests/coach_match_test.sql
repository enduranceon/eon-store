BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

-- Fictitious fixtures only. Every change, including test time travel, rolls back.
INSERT INTO auth.users (id, email) VALUES
  ('97000000-0000-4000-a000-000000000001', 'match-admin@example.test');
INSERT INTO public.assessment_coaches (id, name, email, role, active, public_visible) VALUES
  ('97000000-0000-4000-a000-000000000011', 'Match Coach Fictício', 'match-coach@example.test', 'pleno', true, true),
  ('97000000-0000-4000-a000-000000000012', 'Outro match fictício', 'match-other@example.test', 'pleno', true, true),
  ('97000000-0000-4000-a000-000000000013', 'Match inativo fictício', 'match-inactive@example.test', 'pleno', false, false),
  ('97000000-0000-4000-a000-000000000014', 'Match limite fictício', 'match-rate@example.test', 'pleno', true, true);

CREATE TEMP TABLE match_results (key text PRIMARY KEY, value jsonb);
GRANT ALL ON match_results TO service_role;
CREATE FUNCTION pg_temp.match_answers() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"version":1,"focus_goals":["start","evolve"],"focus_levels":["beginner","regular"],"service_formats":["florianopolis","online"],"communication_style":"close","approach":"Acompanhamento fictício respeitando a rotina individual.","experience":"Experiência fictícia usada somente nos testes."}'::jsonb
$$;
GRANT EXECUTE ON FUNCTION pg_temp.match_answers() TO service_role;

-- Existing financial data must remain byte-for-byte unchanged, not only counts.
CREATE FUNCTION pg_temp.match_financial_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  name text;
  digest text;
  snapshot jsonb := '{}'::jsonb;
BEGIN
  FOREACH name IN ARRAY ARRAY['assessment_contracts','presale_customers','assessment_plans',
    'assessment_coach_site_plans','asaas_payments','presale_orders','stock_orders',
    'payout_monthly_closings','payout_monthly_statement_items'] LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(row_value, chr(10) ORDER BY row_value), '''')) FROM (SELECT to_jsonb(t)::text AS row_value FROM public.%I t) rows', name) INTO digest;
    snapshot := snapshot || jsonb_build_object(name, digest);
  END LOOP;
  RETURN snapshot;
END
$$;
INSERT INTO match_results VALUES ('financial_before', pg_temp.match_financial_snapshot());
INSERT INTO match_results VALUES ('coach_before', (SELECT to_jsonb(c) FROM assessment_coaches c
  WHERE id = '97000000-0000-4000-a000-000000000011'));

-- Defense in depth: RLS AND explicit grants. No browser may bypass Edge auth.
SELECT ok(c.relrowsecurity, c.relname || ' has RLS')
FROM pg_class c WHERE c.oid IN ('public.assessment_coach_match_submissions'::regclass,
  'public.assessment_coach_match_invites'::regclass, 'public.assessment_coach_match_state'::regclass);
SELECT ok(NOT has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE'), r || ' has no direct DML on ' || t)
FROM unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest(ARRAY[
  'public.assessment_coach_match_submissions','public.assessment_coach_match_invites','public.assessment_coach_match_state']) t;
SELECT ok(NOT has_table_privilege('service_role', t, 'DELETE'), 'service_role cannot delete match history: ' || t)
FROM unnest(ARRAY['public.assessment_coach_match_submissions','public.assessment_coach_match_invites','public.assessment_coach_match_state']) t;
SELECT ok(NOT p.prosecdef, p.proname || ' uses invoker security')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('get_assessment_coach_match_admin',
  'issue_assessment_coach_match_invite','revoke_assessment_coach_match_invite',
  'load_assessment_coach_match_form','submit_assessment_coach_match_answers',
  'review_assessment_coach_match_submission','list_public_coach_match_profiles','coach_match_answers_valid');
SELECT ok(NOT has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
FROM unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest(ARRAY[
  'public.get_assessment_coach_match_admin(uuid)',
  'public.issue_assessment_coach_match_invite(uuid,text,timestamptz,uuid)',
  'public.revoke_assessment_coach_match_invite(uuid,uuid)',
  'public.load_assessment_coach_match_form(text)',
  'public.submit_assessment_coach_match_answers(text,jsonb)',
  'public.review_assessment_coach_match_submission(uuid,uuid,text,uuid)',
  'public.list_public_coach_match_profiles()']) f;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.assessment_coach_match_submissions$$, '42501', NULL, 'anon cannot read drafts');
SELECT throws_ok($$SELECT public.list_public_coach_match_profiles()$$, '42501', NULL, 'public profile RPC requires the backend');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.get_assessment_coach_match_admin('97000000-0000-4000-a000-000000000011')$$,
  '42501', NULL, 'a logged-in browser still cannot bypass the admin gate');
RESET ROLE;

-- The database validates the same versioned whitelist as the HTTP contract.
SELECT ok(public.coach_match_answers_valid(pg_temp.match_answers()), 'canonical answers are valid');
SELECT ok(NOT public.coach_match_answers_valid(NULL), 'SQL NULL is invalid');
SELECT ok(NOT public.coach_match_answers_valid('null'::jsonb), 'JSON null is invalid');
SELECT ok(NOT public.coach_match_answers_valid('[]'::jsonb), 'array payload is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() - 'approach'), 'missing required field is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"private_note":"secret"}'), 'unknown field is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"version":2}'), 'unknown contract version is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"version":"1"}'), 'version must be a number');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"focus_goals":[]}'), 'empty focus choices are invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"focus_goals":["start","start"]}'), 'duplicate choices are invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"focus_goals":["start","evolve","race"]}'), 'more than two choices are invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"focus_goals":["made-up"]}'), 'unknown goal is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"focus_levels":["elite"]}'), 'unknown level is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"service_formats":["elsewhere"]}'), 'unknown service format is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || '{"communication_style":"fast"}'), 'unknown communication style is invalid');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || jsonb_build_object('approach', repeat('a',29))), 'approach minimum is enforced');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || jsonb_build_object('approach', repeat('a',321))), 'approach maximum is enforced');
SELECT ok(NOT public.coach_match_answers_valid(pg_temp.match_answers() || jsonb_build_object('experience', repeat('a',321))), 'experience maximum is enforced');
SELECT ok(public.coach_match_answers_valid(pg_temp.match_answers() || jsonb_build_object('approach', repeat('á',320))), 'length uses characters, including Portuguese accents');

SET LOCAL ROLE service_role;
INSERT INTO match_results VALUES ('empty_admin', public.get_assessment_coach_match_admin('97000000-0000-4000-a000-000000000011'));
SELECT is((SELECT value->>'latest' FROM match_results WHERE key='empty_admin'), NULL, 'new coach has no latest submission');
SELECT is((SELECT value->>'published' FROM match_results WHERE key='empty_admin'), NULL, 'new coach has no published submission');
SELECT throws_ok($$SELECT public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000099', repeat('a',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001')$$, 'PT404', NULL, 'unknown coach cannot receive a link');
SELECT throws_ok($$SELECT public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000013', repeat('a',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001')$$, 'PT404', NULL, 'inactive coach cannot receive a link');
SELECT throws_ok($$SELECT public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('a',64), now()-interval '1 second', '97000000-0000-4000-a000-000000000001')$$, 'PT400', NULL, 'already expired links are refused');
SELECT throws_ok($$SELECT public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('a',64), now()+interval '32 days', '97000000-0000-4000-a000-000000000001')$$, 'PT400', NULL, 'link lifetime is bounded');
SELECT throws_ok($$SELECT public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('a',64), now()+interval '1 day', NULL)$$, 'PT400', NULL, 'link requires admin attribution');
INSERT INTO match_results VALUES ('invite_a', public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('a',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001'));
SELECT is(public.load_assessment_coach_match_form(repeat('a',64))#>>'{coach,name}', 'Match Coach Fictício', 'valid token loads only its coach');
SELECT throws_ok($$SELECT public.load_assessment_coach_match_form(repeat('f',64))$$, 'PT410', NULL, 'unknown token is unavailable');
INSERT INTO match_results VALUES ('invite_other', public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000012', repeat('b',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001'));
SELECT throws_ok($$SELECT public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('b',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001')$$, '23505', NULL, 'duplicate hash fails after entering replacement transaction');
SELECT lives_ok($$SELECT public.load_assessment_coach_match_form(repeat('a',64))$$, 'failed replacement rolls back revocation of the old link');
SELECT throws_ok($$SELECT public.revoke_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='invite_other'))$$, 'PT404', NULL, 'one coach cannot revoke another coach link');
INSERT INTO match_results VALUES ('invite_new', public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('c',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001'));
SELECT throws_ok($$SELECT public.load_assessment_coach_match_form(repeat('a',64))$$, 'PT410', NULL, 'successful replacement revokes old token');
SELECT is((SELECT count(*)::integer FROM public.assessment_coach_match_invites WHERE coach_id='97000000-0000-4000-a000-000000000011' AND revoked_at IS NULL), 1, 'exactly one current invite remains');
SELECT throws_ok($$SELECT public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers() || '{"version":2}')$$, 'PT400', NULL, 'bad answer never becomes a submission');
INSERT INTO match_results VALUES ('first', public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers()));
SELECT is((SELECT value->>'received' FROM match_results WHERE key='first'), 'true', 'submission acknowledges receipt');
SELECT is((SELECT count(*)::integer FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 0, 'pending answers are not public');
SELECT is(public.load_assessment_coach_match_form(repeat('c',64))#>'{latest,answers}', pg_temp.match_answers(), 'coach can see its latest submitted draft');
SELECT throws_ok($$SELECT public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers())$$, 'PT429', NULL, 'immediate second submission hits cooldown');
SELECT throws_ok($$SELECT public.review_assessment_coach_match_submission('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='first'), 'published', '97000000-0000-4000-a000-000000000001')$$, 'PT400', NULL, 'review accepts only approved or rejected decisions');
SELECT is(public.review_assessment_coach_match_submission('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='first'), 'approved', '97000000-0000-4000-a000-000000000001')->>'status', 'approved', 'latest pending draft can be approved');
SELECT is((SELECT count(*)::integer FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 1, 'approved coach has exactly one public profile');
SELECT is((SELECT answers FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), pg_temp.match_answers(), 'public answers equal the approved revision');
SELECT throws_ok($$SELECT public.review_assessment_coach_match_submission('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='first'), 'rejected', '97000000-0000-4000-a000-000000000001')$$, 'PT409', NULL, 'review cannot be applied twice');
RESET ROLE;

-- Advance only fictitious submission timestamps; no actual waiting or clock changes.
UPDATE public.assessment_coach_match_submissions SET submitted_at=now()-interval '2 minutes' WHERE coach_id='97000000-0000-4000-a000-000000000011';
UPDATE public.assessment_coach_match_invites SET last_submitted_at=now()-interval '2 minutes' WHERE coach_id='97000000-0000-4000-a000-000000000011';
SET LOCAL ROLE service_role;
INSERT INTO match_results VALUES ('second', public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers() || '{"communication_style":"balanced"}'));
SELECT is((SELECT answers->>'communication_style' FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 'close', 'new pending draft does not overwrite approved public profile');
SELECT is(public.get_assessment_coach_match_admin('97000000-0000-4000-a000-000000000011')#>>'{published,id}', (SELECT value->>'id' FROM match_results WHERE key='first'), 'admin retrieves published revision separately from pending');
SELECT is(public.review_assessment_coach_match_submission('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='second'), 'rejected', '97000000-0000-4000-a000-000000000001')->>'status', 'rejected', 'new draft can be rejected');
SELECT is((SELECT answers->>'communication_style' FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 'close', 'rejection preserves previous approval');
RESET ROLE;
UPDATE public.assessment_coach_match_submissions SET submitted_at=now()-interval '3 minutes' WHERE coach_id='97000000-0000-4000-a000-000000000011';
UPDATE public.assessment_coach_match_invites SET last_submitted_at=now()-interval '3 minutes' WHERE coach_id='97000000-0000-4000-a000-000000000011';
SET LOCAL ROLE service_role;
INSERT INTO match_results VALUES ('third', public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers() || '{"communication_style":"balanced"}'));
RESET ROLE;
UPDATE public.assessment_coach_match_submissions SET submitted_at=now()-interval '4 minutes' WHERE coach_id='97000000-0000-4000-a000-000000000011';
UPDATE public.assessment_coach_match_invites SET last_submitted_at=now()-interval '4 minutes' WHERE coach_id='97000000-0000-4000-a000-000000000011';
SET LOCAL ROLE service_role;
INSERT INTO match_results VALUES ('fourth', public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers() || '{"communication_style":"autonomy"}'));
SELECT is((SELECT status FROM assessment_coach_match_submissions WHERE id=(SELECT (value->>'id')::uuid FROM match_results WHERE key='third')), 'superseded', 'new draft supersedes only older pending draft');
SELECT throws_ok($$SELECT public.review_assessment_coach_match_submission('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='third'), 'approved', '97000000-0000-4000-a000-000000000001')$$, 'PT409', NULL, 'stale admin cannot approve superseded draft');
SELECT is(public.review_assessment_coach_match_submission('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='fourth'), 'approved', '97000000-0000-4000-a000-000000000001')->>'status', 'approved', 'latest replacement can be approved');
SELECT is((SELECT answers->>'communication_style' FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 'autonomy', 'only newly approved answer becomes public');
SELECT is((SELECT count(*)::integer FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 1, 'historical approvals do not duplicate public profiles');
SELECT is((SELECT revision::integer FROM public.assessment_coach_match_state WHERE coach_id='97000000-0000-4000-a000-000000000011'), 4, 'monotonic revision records all accepted submissions');
SELECT is((SELECT count(DISTINCT revision)::integer FROM public.assessment_coach_match_submissions WHERE coach_id='97000000-0000-4000-a000-000000000011'), 4, 'each submission has a unique coach revision');
RESET ROLE;

-- Removing visibility never publishes hidden/inactive coaches.
UPDATE public.assessment_coaches SET public_visible=false WHERE id='97000000-0000-4000-a000-000000000011';
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 0, 'hidden coach is excluded even with approval');
RESET ROLE;
-- The existing coach schema forbids making an inactive coach public.
SELECT throws_ok($$UPDATE public.assessment_coaches SET public_visible=true, active=false WHERE id='97000000-0000-4000-a000-000000000011'$$,
  '23514', NULL, 'existing coach constraint refuses an inactive public profile');
UPDATE public.assessment_coaches SET public_visible=false, active=false WHERE id='97000000-0000-4000-a000-000000000011';
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.list_public_coach_match_profiles() WHERE coach_id='97000000-0000-4000-a000-000000000011'), 0, 'inactive coach is excluded even with approval');
RESET ROLE;
UPDATE public.assessment_coaches SET active=true, public_visible=true WHERE id='97000000-0000-4000-a000-000000000011';

SET LOCAL ROLE service_role;
SELECT is(public.revoke_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='invite_new'))->>'revoked', 'true', 'admin revokes current link');
SELECT is(public.revoke_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', (SELECT (value->>'id')::uuid FROM match_results WHERE key='invite_new'))->>'revoked', 'true', 'revocation is idempotent');
SELECT throws_ok($$SELECT public.submit_assessment_coach_match_answers(repeat('c',64), pg_temp.match_answers())$$, 'PT410', NULL, 'revoked link cannot submit');
INSERT INTO match_results VALUES ('expiry', public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000011', repeat('d',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001'));
RESET ROLE;
UPDATE public.assessment_coach_match_invites SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=repeat('d',64);
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.load_assessment_coach_match_form(repeat('d',64))$$, 'PT410', NULL, 'expired link cannot load');
SELECT throws_ok($$SELECT public.submit_assessment_coach_match_answers(repeat('d',64), pg_temp.match_answers())$$, 'PT410', NULL, 'expired link cannot submit');
RESET ROLE;

-- Hourly limit survives token rotation and is per coach, not per link.
INSERT INTO public.assessment_coach_match_state (coach_id, revision) VALUES ('97000000-0000-4000-a000-000000000014', 8);
INSERT INTO public.assessment_coach_match_submissions (coach_id, revision, answers, status, submitted_at)
SELECT '97000000-0000-4000-a000-000000000014', n, pg_temp.match_answers(), 'superseded', now()-interval '2 minutes'*n FROM generate_series(1,8) n;
SET LOCAL ROLE service_role;
INSERT INTO match_results VALUES ('rate_invite', public.issue_assessment_coach_match_invite('97000000-0000-4000-a000-000000000014', repeat('e',64), now()+interval '1 day', '97000000-0000-4000-a000-000000000001'));
SELECT throws_ok($$SELECT public.submit_assessment_coach_match_answers(repeat('e',64), pg_temp.match_answers())$$, 'PT429', NULL, 'ninth hourly submission is refused even through a new invite');
SELECT is((SELECT count(*)::integer FROM assessment_coach_match_submissions WHERE coach_id='97000000-0000-4000-a000-000000000014'), 8, 'rate-limited submit makes no partial write');
RESET ROLE;

-- Admin snapshots must never leak token hashes, even in the invite list.
SELECT ok(NOT (public.get_assessment_coach_match_admin('97000000-0000-4000-a000-000000000011')::text LIKE '%token_hash%'), 'admin snapshot does not include token hashes');
SELECT is(pg_temp.match_financial_snapshot(), (SELECT value FROM match_results WHERE key='financial_before'), 'match workflow leaves all financial snapshots unchanged');
SELECT is((SELECT to_jsonb(c)-'updated_at' FROM assessment_coaches c WHERE id='97000000-0000-4000-a000-000000000011'),
  (SELECT value-'updated_at' FROM match_results WHERE key='coach_before'), 'match does not mutate the operational coach record');

SELECT * FROM finish();
ROLLBACK;
