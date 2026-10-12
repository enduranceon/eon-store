-- Read-only post-migration release gate. A missing object or unsafe permission
-- produces no success row; the caller must require exactly one matching status.
WITH expected_tables(name) AS (
  VALUES ('assessment_coach_match_submissions'),
    ('assessment_coach_match_state'), ('assessment_coach_match_invites')
), match_tables AS (
  SELECT expected.name, relation.oid, relation.relrowsecurity, relation.relkind
  FROM expected_tables AS expected
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid AND relation.relname = expected.name
), expected_rpcs(signature) AS (
  VALUES ('public.coach_match_answers_valid(jsonb)'),
    ('public.get_assessment_coach_match_admin(uuid)'),
    ('public.issue_assessment_coach_match_invite(uuid,text,timestamptz,uuid)'),
    ('public.revoke_assessment_coach_match_invite(uuid,uuid)'),
    ('public.load_assessment_coach_match_form(text)'),
    ('public.submit_assessment_coach_match_answers(text,jsonb)'),
    ('public.review_assessment_coach_match_submission(uuid,uuid,text,uuid)'),
    ('public.list_public_coach_match_profiles()')
), match_rpcs AS (
  SELECT expected.signature, proc.oid, proc.prosecdef
  FROM expected_rpcs AS expected
  LEFT JOIN pg_catalog.pg_proc AS proc ON proc.oid = to_regprocedure(expected.signature)
)
SELECT 'coach_match_readback_ok' AS status
WHERE EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261011204104'
)
AND (SELECT count(*) = 3 FROM match_tables WHERE oid IS NOT NULL)
AND NOT EXISTS (
  SELECT 1 FROM match_tables
  WHERE oid IS NULL OR relkind <> 'r' OR NOT relrowsecurity
    OR has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege('service_role', oid, 'DELETE,TRUNCATE')
    OR NOT has_table_privilege('service_role', oid, 'SELECT')
    OR NOT has_table_privilege('service_role', oid, 'INSERT')
    OR NOT has_table_privilege('service_role', oid, 'UPDATE')
)
AND (SELECT count(*) = 8 FROM match_rpcs WHERE oid IS NOT NULL)
AND NOT EXISTS (
  SELECT 1 FROM match_rpcs
  WHERE oid IS NULL OR prosecdef
    OR has_function_privilege('anon', oid, 'EXECUTE')
    OR has_function_privilege('authenticated', oid, 'EXECUTE')
    OR NOT has_function_privilege('service_role', oid, 'EXECUTE')
);
