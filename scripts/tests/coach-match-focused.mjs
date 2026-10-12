/** Focused PostgreSQL-WASM regression check, not a replacement for full Supabase CI.
 * Uses only an in-memory database and minimal dummy operational tables.
 * Dependency: @electric-sql/pglite@0.3.14 installed in a temporary directory.
 * EON_MATCH_PGLITE_MODULE=/absolute/path/to/node_modules/@electric-sql/pglite/dist/index.js
 * node scripts/tests/coach-match-focused.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modulePath = process.env.EON_MATCH_PGLITE_MODULE;
if (!modulePath || !modulePath.startsWith('/')) {
  throw new Error('Set EON_MATCH_PGLITE_MODULE to the absolute path of temporary PGlite 0.3.14');
}
const { PGlite } = await import(pathToFileURL(modulePath).href);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const db = new PGlite();
const dummyTables = ['assessment_contracts','presale_customers','assessment_plans',
  'assessment_coach_site_plans','asaas_payments','presale_orders','stock_orders',
  'payout_monthly_closings','payout_monthly_statement_items'];
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA extensions;
    GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;
    -- Emulate Supabase's legacy defaults so missing REVOKEs are caught.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    CREATE TABLE public.assessment_coaches (
      id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
      role text NOT NULL, active boolean DEFAULT true, public_visible boolean DEFAULT true,
      modality_ids uuid[] DEFAULT '{}', updated_at timestamptz DEFAULT now(),
      CONSTRAINT assessment_coaches_public_requires_active CHECK (NOT public_visible OR active)
    );
    CREATE TABLE public.assessment_modalities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
      active boolean NOT NULL DEFAULT true
    );
    INSERT INTO public.assessment_modalities(name) VALUES ('corrida'), ('triathlon');
    -- Match clean/current Supabase ACLs for this existing dependency. The v2
    -- migration must explicitly restore the server-only read it introduces.
    REVOKE ALL ON TABLE public.assessment_modalities FROM service_role;
    ${dummyTables.map(name => `CREATE TABLE public.${name}(id uuid PRIMARY KEY, fixture text);
      INSERT INTO public.${name} VALUES (gen_random_uuid(), 'Preservar esta linha fictícia');`).join('\n')}
    -- Small pgTAP-compatible assertions; SQL failures abort this focused run.
    CREATE FUNCTION extensions.no_plan() RETURNS text LANGUAGE sql AS $$ SELECT 'focused assertions'::text $$;
    CREATE FUNCTION extensions.finish() RETURNS SETOF text LANGUAGE sql AS $$ SELECT 'finished'::text $$;
    CREATE FUNCTION extensions.ok(condition boolean, message text) RETURNS text LANGUAGE plpgsql AS $$
    BEGIN IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', message; END IF;
      RETURN 'ok ' || message; END $$;
    CREATE FUNCTION extensions.is(actual anyelement, expected anyelement, message text)
    RETURNS text LANGUAGE plpgsql AS $$ BEGIN
      IF actual IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'Assertion failed: %; actual %; expected %', message, actual, expected;
      END IF; RETURN 'ok ' || message; END $$;
    CREATE FUNCTION extensions.lives_ok(command text, message text) RETURNS text LANGUAGE plpgsql AS $$
    BEGIN EXECUTE command; RETURN 'ok ' || message;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Assertion failed: %; [%] %', message, SQLSTATE, SQLERRM;
    END $$;
    CREATE FUNCTION extensions.throws_ok(command text, expected_state text, expected_message text, message text)
    RETURNS text LANGUAGE plpgsql AS $$
    DECLARE actual_state text; actual_message text;
    BEGIN
      BEGIN EXECUTE command;
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE, actual_message=MESSAGE_TEXT;
      END;
      IF actual_state IS DISTINCT FROM expected_state OR
        (expected_message IS NOT NULL AND actual_message IS DISTINCT FROM expected_message) THEN
        RAISE EXCEPTION 'Assertion failed: %; actual [%] %; expected [%] %', message,
          actual_state, actual_message, expected_state, expected_message;
      END IF; RETURN 'ok ' || message;
    END $$;
    CREATE FUNCTION extensions.has_column(p_schema_name text, p_table_name text, p_column_name text, p_message text)
    RETURNS text LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema=p_schema_name AND c.table_name=p_table_name AND c.column_name=p_column_name) THEN
        RAISE EXCEPTION 'Assertion failed: %', p_message;
      END IF; RETURN 'ok ' || p_message;
    END $$;
  `);
  const migration = await readFile(resolve(root, 'supabase/migrations/20261011204104_coach_match_submissions.sql'), 'utf8');
  await db.exec(migration);
  const migrationV2 = await readFile(resolve(root, 'supabase/migrations/20261012191714_coach_match_profile_v2.sql'), 'utf8');
  await db.exec(migrationV2);
  const testFiles = ['coach_match_test.sql', 'coach_match_v2_test.sql'];
  const results = [];
  for (const filename of testFiles) {
    const tests = (await readFile(resolve(root, 'supabase/tests', filename), 'utf8'))
      .replace('CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;', '');
    results.push(...await db.exec(tests));
  }
  let assertions = 0;
  for (const result of results) {
    for (const row of result.rows || []) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.startsWith('ok ')) assertions += 1;
      }
    }
  }
  console.log(`PASS ${assertions} focused PostgreSQL assertions (minimal schema, in-memory PGlite).`);
  console.log('Full Supabase migration/pgTAP and multi-session concurrency checks remain required in CI.');
} finally {
  await db.close();
}
