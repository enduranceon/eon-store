// Real HTTP integration against a disposable native Supabase stack.
// Required environment:
//   EON_TEST_EPHEMERAL=1
//   EON_MATCH_STATUS_FILE=/absolute/path/to/local-status.json
//   EON_MATCH_STACK_ID=<exact 64-character lowercase hexadecimal native stack ID>
//   EON_MATCH_PG_MODULE=file:///absolute/path/to/node_modules/pg/lib/index.js
// Optional: EON_MATCH_REPORT_FILE=/absolute/path/to/redacted-results.json.
// The report otherwise goes beside the status file as coach-match-http-smoke-results.json.
// Run with node scripts/tests/coach-match-http-smoke.mjs after the full migration
// replay and local Edge Functions are ready. Use an OS network sandbox that
// allows loopback only; disable cron before replaying the original migrations.
// The local-status.json must come from this stack's supabase status JSON output.
// This script never links a hosted project, reads production env files, installs
// dependencies, or uses API mocks. All HTTP requests are fixed to 127.0.0.1:54321;
// PostgreSQL is fixed to 127.0.0.1:54322/postgres.
// Synthetic records remain in the disposable stack for diagnosis; stop that
// exact stack after collecting results. Output deliberately excludes credentials.
// The real submission cooldown makes a successful run take at least 60 seconds.
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://127.0.0.1:54321';
let stackId;
let reportPath;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const startedAt = new Date().toISOString();
const checks = [];
let db;
let stage = 'preflight';
let failure;

class SafeFailure extends Error {}
function ensure(condition, message) {
  if (!condition) throw new SafeFailure(message);
}
function equal(actual, expected, message) {
  ensure(isDeepStrictEqual(actual, expected), message);
}
function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, expected, label) {
  ensure(object(value), `${label}: expected an object`);
  equal(Object.keys(value).sort(), [...expected].sort(), `${label}: unexpected fields`);
}

// Accept the CLI's environment-map output, including common nested/camel-case
// representations. Never print the status file or any selected credential.
function statusValue(status, aliases, label) {
  const normalize = name => name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const alias of aliases) {
    const found = new Set();
    function visit(value, depth = 0) {
      if (depth > 12 || !value || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) {
        if (normalize(name) === normalize(alias) && typeof child === 'string' && child) found.add(child);
        else if (child && typeof child === 'object') visit(child, depth + 1);
      }
    }
    visit(status);
    ensure(found.size <= 1, `local status has conflicting ${label} fields`);
    if (found.size === 1) return [...found][0];
  }
  throw new SafeFailure(`local status is missing ${label}`);
}

try {
  ensure(process.env.EON_TEST_EPHEMERAL === '1', 'EON_TEST_EPHEMERAL=1 is required');
  const statusPath = process.env.EON_MATCH_STATUS_FILE;
  ensure(typeof statusPath === 'string' && isAbsolute(statusPath),
    'EON_MATCH_STATUS_FILE must be an absolute path to this local stack status JSON');
  stackId = process.env.EON_MATCH_STACK_ID;
  ensure(typeof stackId === 'string' && /^[0-9a-f]{64}$/.test(stackId),
    'EON_MATCH_STACK_ID must be the exact 64-character lowercase hexadecimal native stack ID');
  const pgModuleSetting = process.env.EON_MATCH_PG_MODULE;
  ensure(typeof pgModuleSetting === 'string' && pgModuleSetting.startsWith('file:///'),
    'EON_MATCH_PG_MODULE must be an absolute local file URL for an existing pg module');
  const pgModuleUrl = new URL(pgModuleSetting);
  ensure(pgModuleUrl.protocol === 'file:' && !pgModuleUrl.host && !pgModuleUrl.search && !pgModuleUrl.hash &&
    isAbsolute(fileURLToPath(pgModuleUrl)),
  'EON_MATCH_PG_MODULE must identify an absolute local file without URL options');
  const requestedReport = process.env.EON_MATCH_REPORT_FILE ??
    join(dirname(statusPath), 'coach-match-http-smoke-results.json');
  ensure(isAbsolute(requestedReport), 'EON_MATCH_REPORT_FILE must be an absolute path');
  ensure(resolve(requestedReport) !== resolve(statusPath) &&
    resolve(requestedReport) !== resolve(fileURLToPath(pgModuleUrl)),
  'the results file must not overwrite the local status or pg module');
  reportPath = requestedReport;
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  ensure(object(status) && status.runtime === 'native' && status.id === stackId,
    'local status does not identify the expected disposable native stack');
  const apiUrl = new URL(statusValue(status, ['API_URL', 'PROJECT_URL', 'SUPABASE_URL'], 'API URL'));
  ensure(apiUrl.origin === API && ['/', ''].includes(apiUrl.pathname) &&
    !apiUrl.username && !apiUrl.password && !apiUrl.search && !apiUrl.hash,
  'refusing API target other than exact http://127.0.0.1:54321');
  const dbUrl = new URL(statusValue(status, ['DB_URL', 'DATABASE_URL', 'POSTGRES_URL'], 'database URL'));
  ensure(['postgres:', 'postgresql:'].includes(dbUrl.protocol) && dbUrl.hostname === '127.0.0.1' &&
    dbUrl.port === '54322' && dbUrl.pathname === '/postgres' && decodeURIComponent(dbUrl.username) === 'postgres' &&
    !dbUrl.search && !dbUrl.hash && dbUrl.password,
  'refusing database target other than exact postgres@127.0.0.1:54322/postgres');
  const anonKey = statusValue(status, ['ANON_KEY', 'SUPABASE_ANON_KEY', 'PUBLISHABLE_KEY'], 'local anonymous key');
  const serviceKey = statusValue(status, ['SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SECRET_KEY'], 'local service key');
  ensure(anonKey !== serviceKey, 'local public and service keys must differ');

  const pgModule = await import(pgModuleUrl.href);
  const pg = pgModule.default ?? pgModule;
  ensure(typeof pg.Client === 'function', 'EON_MATCH_PG_MODULE does not export a pg Client');
  db = new pg.Client({
    host: '127.0.0.1', port: 54322, database: 'postgres', user: 'postgres',
    password: decodeURIComponent(dbUrl.password), ssl: false,
    connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000,
    application_name: 'eon_match_local_real_http_smoke', options: '',
  });
  await db.connect();
  const identity = (await db.query(`
    SELECT inet_server_addr()::text AS address, inet_server_port() AS port,
      current_database() AS database, current_user AS username,
      EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
        WHERE version = '20261011204104') AS match_migration,
      EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
        WHERE version = '20261012191714') AS match_v2_migration
  `)).rows[0];
  ensure(identity.database === 'postgres' && identity.username === 'postgres' && identity.match_migration === true &&
    identity.match_v2_migration === true,
    'database identity or recorded match migration does not match the local fixture target');
  // This exact native stack's localhost TCP gateway connects to Postgres over a
  // Unix socket, for which PostgreSQL deliberately reports both fields as null.
  // The pg client still has its literal 127.0.0.1:54322 destination above.
  ensure((identity.address === '127.0.0.1' && identity.port === 54322) ||
    (status.runtime === 'native' && status.id === stackId && identity.address === null && identity.port === null),
  'database transport does not match the expected local/native stack');
  const cronSetting = (await db.query('SHOW cron.launch_active_jobs')).rows[0];
  ensure(cronSetting?.['cron.launch_active_jobs'] === 'off',
    'cron must be disabled before replaying migrations or writing local fixtures');
  const tables = ['assessment_coach_match_state', 'assessment_coach_match_submissions', 'assessment_coach_match_invites'];
  const schemaCheck = (await db.query(`
    SELECT count(*)::int AS count, bool_and(c.relrowsecurity) AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])
  `, [tables])).rows[0];
  equal(schemaCheck, { count: 3, rls: true }, 'match tables or RLS are missing');
  pass('exact local API/database target and migrated RLS schema verified');

  async function request(path, { method = 'GET', body, bearer, service = false } = {}) {
    ensure(path.startsWith('/') && !path.startsWith('//'), 'invalid relative request path');
    const url = new URL(path, API);
    ensure(url.origin === API && !url.username && !url.password, 'refusing nonlocal HTTP request');
    const headers = { apikey: service ? serviceKey : anonKey };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (service) headers.Authorization = `Bearer ${serviceKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new SafeFailure(`${stage}: local HTTP connection failed or timed out`);
    }
    const raw = await response.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch { throw new SafeFailure(`${stage}: local API returned non-JSON (HTTP ${response.status})`); }
    }
    return { status: response.status, payload, headers: response.headers };
  }
  function expect(response, expected, label) {
    ensure((Array.isArray(expected) ? expected : [expected]).includes(response.status),
      `${label}: unexpected HTTP ${response.status}`);
    return response.payload;
  }
  async function data(path, options, label) {
    const response = await request(path, options);
    const body = expect(response, 200, label);
    ensure(object(body) && Object.hasOwn(body, 'data'), `${label}: missing data envelope`);
    return body.data;
  }
  const runId = randomUUID();
  const coachId = randomUUID();
  const coachName = `Coach ficticio HTTP ${runId.slice(0, 8)}`;
  const password = `Local-${randomBytes(24).toString('base64url')}!9`;
  async function newUser(label) {
    const email = `match-${label}-${runId}@example.test`;
    const created = expect(await request('/auth/v1/admin/users', {
      method: 'POST', service: true, body: { email, password, email_confirm: true },
    }), [200, 201], `create synthetic ${label} auth user`);
    const user = created?.user ?? created;
    ensure(UUID.test(user?.id) && user.email === email, `synthetic ${label} auth identity mismatch`);
    const session = expect(await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password },
    }), 200, `login synthetic ${label}`);
    ensure(typeof session?.access_token === 'string' && session.user?.id === user.id,
      `synthetic ${label} session mismatch`);
    const verified = expect(await request('/auth/v1/user', { bearer: session.access_token }), 200, `verify ${label} session`);
    equal(verified.id, user.id, `verified ${label} identity mismatch`);
    return { id: user.id, token: session.access_token };
  }
  stage = 'synthetic Auth and database setup';
  const admin = await newUser('admin');
  const ordinary = await newUser('ordinary');
  await db.query('INSERT INTO public.app_admins(user_id, created_by) VALUES ($1, NULL)', [admin.id]);
  const modalityId = (await db.query(`SELECT id FROM public.assessment_modalities
    WHERE active IS TRUE ORDER BY name,id LIMIT 1`)).rows[0]?.id;
  ensure(UUID.test(modalityId), 'local fixture has no active canonical modality');
  await db.query(`INSERT INTO public.assessment_coaches(id,name,email,role,active,public_visible,modality_ids)
    VALUES($1,$2,$3,'pleno',true,true,ARRAY[$4::uuid])`,
  [coachId, coachName, `match-coach-${runId}@example.test`, modalityId]);
  for (const [label, user, expected] of [['admin', admin, true], ['ordinary', ordinary, false]]) {
    const result = expect(await request('/rest/v1/rpc/is_app_admin', {
      method: 'POST', bearer: user.token, body: {},
    }), 200, `verify ${label} allowlist`);
    equal(result, expected, `${label} allowlist result mismatch`);
  }
  pass('real local Auth login and administrator allowlist separation');

  const adminPath = `/functions/v1/coach-match-admin/coach-match/${coachId}`;
  const adminV2Path = `${adminPath}?profile_version=2`;
  const formPath = '/functions/v1/coach-match-form';
  const publicPath = '/functions/v1/public-coach-match';
  const adminOptions = { bearer: admin.token };
  const answers = {
    version: 2, service_formats: ['florianopolis', 'online'],
    focus_goals: { primary: 'performance', secondary: 'health' },
    focus_levels: { primary: 'intermediate', secondary: 'beginner' },
    communication_style: { primary: 'balanced', secondary: 'close' },
    age_groups: { primary: 'age_31_50', secondary: 'up_to_30' },
    gender_preference: { primary: 'no_preference', secondary: null },
  };
  const revisedAnswers = { ...answers,
    communication_style: { primary: 'autonomy', secondary: 'balanced' } };
  const formBody = (action, token, extra = {}) => ({ action, token, profile_version: 2, ...extra });
  async function adminSnapshot() {
    const snapshot = await data(adminV2Path, adminOptions, 'admin snapshot');
    equal(snapshot.coach?.id, coachId, 'admin snapshot returned an unexpected coach');
    ensure(Array.isArray(snapshot.invites), 'admin snapshot missing invites');
    for (const invite of snapshot.invites) {
      ensure(!Object.hasOwn(invite, 'token') && !Object.hasOwn(invite, 'token_hash'),
        'admin snapshot exposes invitation credential fields');
    }
    return snapshot;
  }
  async function publicProfile() {
    const response = await request(publicPath);
    equal(response.headers.get('cache-control'), 'no-store', 'public match response is unexpectedly cacheable');
    const body = expect(response, 200, 'public profile catalog');
    ensure(Array.isArray(body?.data), 'public profile catalog is not an array');
    for (const profile of body.data) {
      keys(profile, ['coach_id', 'answers', 'reviewed_at'], 'public profile');
    }
    const matches = body.data.filter(row => row.coach_id === coachId);
    ensure(matches.length <= 1, 'public catalog has duplicate synthetic coach profiles');
    return matches[0] ?? null;
  }

  stage = 'admin authorization';
  for (const [label, bearer] of [['anonymous', undefined], ['non-admin', ordinary.token]]) {
    expect(await request(adminV2Path, { bearer }), [401, 403], `${label} admin read denial`);
    expect(await request(`${adminPath}/invite`, { method: 'POST', bearer, body: {} }), [401, 403], `${label} invite denial`);
    expect(await request(`${adminPath}/review?profile_version=2`, { method: 'POST', bearer,
      body: { submission_id: randomUUID(), decision: 'approved' } }), [401, 403], `${label} review denial`);
  }
  const empty = await adminSnapshot();
  ensure(empty.latest === null && empty.published === null && empty.invites.length === 0,
    'unauthorized requests changed the fresh coach match state');
  equal(await publicProfile(), null, 'empty coach profile was published');
  pass('anonymous/non-admin reads and mutations rejected with 401/403');

  stage = 'invitation and first submission';
  const invite = await data(`${adminPath}/invite`, { ...adminOptions, method: 'POST', body: {} }, 'create invitation');
  ensure(UUID.test(invite?.id) && TOKEN.test(invite?.token), 'invitation response has invalid credential shape');
  const hashed = createHash('sha256').update(invite.token).digest('hex');
  const stored = (await db.query(`SELECT token_hash,created_by FROM public.assessment_coach_match_invites
    WHERE id=$1 AND coach_id=$2`, [invite.id, coachId])).rows[0];
  ensure(stored?.token_hash === hashed && stored.created_by === admin.id, 'stored invitation digest or issuer mismatch');
  const legacyLoaded = await data(formPath, {
    method: 'POST', body: { action: 'load', token: invite.token },
  }, 'load invitation through legacy default');
  equal(legacyLoaded.latest, null, 'legacy default unexpectedly selected the v2 profile');
  const loaded = await data(formPath, {
    method: 'POST', body: formBody('load', invite.token),
  }, 'load invitation');
  keys(loaded, ['coach', 'latest', 'expires_at'], 'public form load');
  keys(loaded.coach, ['name', 'modalities'], 'public form coach');
  equal(loaded.coach.name, coachName, 'public form coach name mismatch');
  ensure(Array.isArray(loaded.coach.modalities) && loaded.coach.modalities.some(row => row.id === modalityId),
    'public form is missing canonical coach modalities');
  equal(loaded.latest, null, 'fresh form unexpectedly contains prior answers');
  const submitted = await data(formPath, {
    method: 'POST', body: formBody('submit', invite.token, { answers }),
  }, 'submit first answers');
  ensure(submitted?.received === true && UUID.test(submitted.id) && Number.isFinite(Date.parse(submitted.submitted_at)),
    'first submission acknowledgement invalid');
  expect(await request(formPath, {
    method: 'POST', body: formBody('submit', invite.token, { answers }),
  }), 429,
    'immediate resubmission rate limit');
  let snapshot = await adminSnapshot();
  ensure(snapshot.latest?.id === submitted.id && snapshot.latest.status === 'pending' && snapshot.published === null,
    'first submission is not pending exclusively');
  equal(snapshot.latest.answers, answers, 'pending answers changed unexpectedly');
  equal(await publicProfile(), null, 'pending answers leaked through public endpoint');
  pass('invitation hash, public form, pending submission and real 429 rate limit');

  stage = 'approval and private scoring profile';
  const approved = await data(`${adminPath}/review?profile_version=2`, { ...adminOptions, method: 'POST',
    body: { submission_id: submitted.id, decision: 'approved' } }, 'approve first submission');
  ensure(approved?.id === submitted.id && approved.status === 'approved', 'approval acknowledgement mismatch');
  snapshot = await adminSnapshot();
  ensure(snapshot.latest?.status === 'approved' && snapshot.published?.id === submitted.id &&
    snapshot.published.reviewed_by === admin.id, 'published snapshot or reviewer mismatch');
  const rawApproved = (await db.query(`SELECT answers FROM public.list_approved_coach_match_profiles_v2()
    WHERE coach_id=$1`, [coachId])).rows[0];
  equal(rawApproved?.answers, answers, 'internal approved v2 answers mismatch');
  equal(await publicProfile(), null, 'public GET exposed raw v2 demographic affinities');
  const prefill = await data(formPath, {
    method: 'POST', body: formBody('load', invite.token),
  }, 'load saved answers');
  equal(prefill.latest?.answers, answers, 'public form does not prefill submitted answers');
  pass('admin approval keeps v2 private for server-side scoring and form prefills saved answers');

  stage = 'direct browser table and RPC authorization';
  const deniedCodes = new Set(['42501', 'PGRST202', 'PGRST205']);
  function directDenied(response, label) {
    expect(response, [401, 403, 404], label);
    ensure(deniedCodes.has(response.payload?.code), `${label}: not an explicit privilege/schema-exposure denial`);
  }
  const rpcInputs = {
    coach_match_answers_valid: { p_answers: answers },
    coach_match_answers_valid_v1: { p_answers: answers },
    coach_match_answers_valid_v2: { p_answers: answers },
    get_assessment_coach_match_admin: { p_coach_id: coachId },
    get_assessment_coach_match_admin_v2: { p_coach_id: coachId },
    issue_assessment_coach_match_invite: { p_coach_id: coachId, p_token_hash: randomBytes(32).toString('hex'),
      p_expires_at: new Date(Date.now() + 86400000).toISOString(), p_created_by: admin.id },
    revoke_assessment_coach_match_invite: { p_coach_id: coachId, p_invite_id: invite.id },
    load_assessment_coach_match_form: { p_token_hash: hashed },
    load_assessment_coach_match_form_v2: { p_token_hash: hashed },
    submit_assessment_coach_match_answers: { p_token_hash: hashed, p_answers: answers },
    submit_assessment_coach_match_answers_v2: { p_token_hash: hashed, p_answers: answers },
    review_assessment_coach_match_submission: { p_coach_id: coachId, p_submission_id: submitted.id,
      p_decision: 'rejected', p_reviewed_by: admin.id },
    review_assessment_coach_match_submission_v2: { p_coach_id: coachId, p_submission_id: submitted.id,
      p_decision: 'rejected', p_reviewed_by: admin.id },
    list_public_coach_match_profiles: {},
    list_approved_coach_match_profiles_v2: {},
  };
  const inserts = {
    assessment_coach_match_state: { coach_id: coachId },
    assessment_coach_match_submissions: { coach_id: coachId, revision: 900000, answers },
    assessment_coach_match_invites: { coach_id: coachId, token_hash: randomBytes(32).toString('hex'),
      expires_at: new Date(Date.now() + 86400000).toISOString() },
  };
  // Admin is also the authenticated database role; its allowlist membership
  // must not provide direct access to this backend-only module.
  for (const [label, bearer] of [['anonymous', undefined], ['authenticated-non-admin', ordinary.token], ['authenticated-admin', admin.token]]) {
    for (const table of tables) {
      directDenied(await request(`/rest/v1/${table}?select=coach_id&coach_id=eq.${coachId}`, { bearer }), `${label} ${table} SELECT`);
      directDenied(await request(`/rest/v1/${table}`, { method: 'POST', bearer, body: inserts[table] }), `${label} ${table} INSERT`);
      directDenied(await request(`/rest/v1/${table}?coach_id=eq.${coachId}`, {
        method: 'PATCH', bearer, body: { coach_id: coachId },
      }), `${label} ${table} UPDATE`);
      directDenied(await request(`/rest/v1/${table}?coach_id=eq.${coachId}`, { method: 'DELETE', bearer }), `${label} ${table} DELETE`);
    }
    for (const [name, body] of Object.entries(rpcInputs)) {
      directDenied(await request(`/rest/v1/rpc/${name}`, { method: 'POST', bearer, body }), `${label} ${name} EXECUTE`);
    }
  }
  const counts = (await db.query(`SELECT
    (SELECT count(*)::int FROM public.assessment_coach_match_submissions WHERE coach_id=$1) AS submissions,
    (SELECT count(*)::int FROM public.assessment_coach_match_invites WHERE coach_id=$1) AS invites`, [coachId])).rows[0];
  equal(counts, { submissions: 1, invites: 1 }, 'denied direct requests changed fixture rows');
  equal(await publicProfile(), null, 'denied direct requests exposed a v2 public profile');
  pass('all three tables and fifteen RPCs deny direct anon/authenticated access, including admin');

  stage = 'second submission after the real cooldown';
  const waitMs = Math.max(0, Date.parse(submitted.submitted_at) + 61500 - Date.now());
  ensure(waitMs <= 65000, 'server submission timestamp is unexpectedly far in the future');
  if (waitMs) {
    console.log('WAIT real submission cooldown (at most 65 seconds; no fixture timestamp changes)');
    await delay(waitMs);
  }
  const second = await data(formPath, { method: 'POST', body: {
    ...formBody('submit', invite.token, { answers: revisedAnswers }),
  } }, 'submit revised answers');
  ensure(second?.received === true && UUID.test(second.id) && second.id !== submitted.id, 'second submission acknowledgement invalid');
  snapshot = await adminSnapshot();
  ensure(snapshot.latest?.id === second.id && snapshot.latest.status === 'pending' && snapshot.published?.id === submitted.id,
    'new pending version displaced the approved version');
  equal(await publicProfile(), null, 'pending update exposed a raw v2 public profile');
  expect(await request(`${adminPath}/review?profile_version=2`, { ...adminOptions, method: 'POST',
    body: { submission_id: submitted.id, decision: 'approved' } }), 409, 'stale approval rejection');
  const rejected = await data(`${adminPath}/review?profile_version=2`, { ...adminOptions, method: 'POST',
    body: { submission_id: second.id, decision: 'rejected' } }, 'reject revised answers');
  ensure(rejected?.id === second.id && rejected.status === 'rejected', 'rejection acknowledgement mismatch');
  snapshot = await adminSnapshot();
  ensure(snapshot.latest?.id === second.id && snapshot.latest.status === 'rejected' && snapshot.published?.id === submitted.id,
    'rejecting the update displaced the approved version');
  equal(await publicProfile(), null, 'rejected update exposed a raw v2 public profile');
  pass('resubmission and rejection preserve prior approval; stale approval returns 409');

  stage = 'invitation revocation';
  const revoked = await data(`${adminPath}/revoke`, { ...adminOptions, method: 'POST',
    body: { invite_id: invite.id } }, 'revoke invitation');
  equal(revoked?.revoked, true, 'revocation acknowledgement mismatch');
  expect(await request(formPath, {
    method: 'POST', body: formBody('load', invite.token),
  }), 410, 'revoked invitation load');
  expect(await request(formPath, {
    method: 'POST', body: formBody('submit', invite.token, { answers }),
  }), 410, 'revoked invitation submit');
  equal(await publicProfile(), null, 'revocation exposed a raw v2 public profile');
  snapshot = await adminSnapshot();
  ensure(snapshot.invites.some(row => row.id === invite.id && row.revoked_at), 'admin snapshot does not show revocation');
  pass('revocation invalidates both load and submit while preserving publication');

  stage = 'public visibility';
  await db.query('UPDATE public.assessment_coaches SET public_visible=false WHERE id=$1', [coachId]);
  equal((await db.query(`SELECT count(*)::int AS count FROM public.list_approved_coach_match_profiles_v2()
    WHERE coach_id=$1`, [coachId])).rows[0].count, 0, 'hidden synthetic coach remains in internal matcher input');
  await db.query('UPDATE public.assessment_coaches SET public_visible=true WHERE id=$1', [coachId]);
  equal((await db.query(`SELECT count(*)::int AS count FROM public.list_approved_coach_match_profiles_v2()
    WHERE coach_id=$1`, [coachId])).rows[0].count, 1, 'restoring synthetic visibility lost the approved v2 profile');
  equal(await publicProfile(), null, 'restoring visibility exposed raw v2 data on public GET');
  pass('internal matcher input honors coach visibility without exposing raw v2 data');
} catch (error) {
  failure = error instanceof SafeFailure ? error.message : `${stage}: unexpected ${error?.name || 'Error'} (details redacted)`;
  console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
  const report = {
    ok: !failure, started_at: startedAt, finished_at: new Date().toISOString(),
    target: { api: API, database: '127.0.0.1:54322/postgres', native_stack_id: stackId },
    mode: 'real-http-no-mocks', checks, ...(failure ? { failure } : {}),
    fixtures: 'synthetic @example.test users and one coach; retained only in disposable local stack',
  };
  let reportWritten = false;
  if (reportPath) {
    try {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      reportWritten = true;
    } catch {
      console.error('FAIL unable to write the redacted local results file');
      process.exitCode = 1;
    }
  }
  if (!failure && reportWritten) console.log(`PASS completed ${checks.length} integration groups; credentials omitted from output`);
}
