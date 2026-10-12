import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoachMatchClient, CoachMatchError } from './coach-match-client.js';

function setup(response = { data: { ok: true } }, status = 200, session = { data: { session: { access_token: 'fake-admin-session' } } }) {
  const calls = [];
  let sessionReads = 0;
  const client = createCoachMatchClient({
    supabaseUrl: 'https://isolated.example.test/', publicKey: 'fake-public-key',
    getSession: async () => { sessionReads += 1; return session; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(response), { status }); },
  });
  return { client, calls, sessionReads: () => sessionReads };
}

test('todas as operações de admin usam exclusivamente coach-match-admin e sessão autenticada', async () => {
  const { client, calls } = setup();
  await client.get('coach-1');
  await client.issueInvite('coach-1');
  await client.revokeInvite('coach-1', 'invite-1');
  await client.review('coach-1', 'submission-1', 'approved');
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/functions/v1/coach-match-admin/coach-match/coach-1',
    '/functions/v1/coach-match-admin/coach-match/coach-1/invite',
    '/functions/v1/coach-match-admin/coach-match/coach-1/revoke',
    '/functions/v1/coach-match-admin/coach-match/coach-1/review',
  ]);
  assert.deepEqual(calls.map(call => new URL(call.url).search), [
    '?profile_version=2',
    '',
    '',
    '?profile_version=2',
  ]);
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'POST', 'POST', 'POST']);
  assert.deepEqual(JSON.parse(calls[2].options.body), { invite_id: 'invite-1' });
  assert.deepEqual(JSON.parse(calls[3].options.body), { submission_id: 'submission-1', decision: 'approved' });
  assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer fake-admin-session'));
  assert.ok(calls.every(call => call.options.headers['X-Coach-Match-Version'] === undefined));
});

test('cliente v2 usa indicador simples que a Edge v1 pode ignorar sem preflight novo', async () => {
  const { client, calls, sessionReads } = setup();
  await client.publicRequest('load', 'fake-coach-token');
  await client.publicRequest('submit', 'fake-coach-token', { version: 2 });
  assert.equal(sessionReads(), 0);
  for (const call of calls) {
    assert.equal(call.url, 'https://isolated.example.test/functions/v1/coach-match-form');
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: 'load', token: 'fake-coach-token', profile_version: 2,
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: 'submit', token: 'fake-coach-token', profile_version: 2, answers: { version: 2 },
  });
});

test('sem sessão administrativa não faz request ou fallback público', async () => {
  const { client, calls } = setup(undefined, 200, { data: { session: null } });
  await assert.rejects(() => client.issueInvite('coach'), error => error instanceof CoachMatchError && error.status === 401);
  assert.equal(calls.length, 0);
});

test('propaga conflito e limite de envio em vez de mascarar como formulário vazio', async () => {
  for (const status of [409, 429]) {
    const { client, calls } = setup({ error: 'Atualize antes de continuar', code: 'conflict' }, status);
    await assert.rejects(() => client.review('coach', 'old', 'approved'), error => error.status === status && error.message === 'Atualize antes de continuar');
    assert.equal(calls.length, 1, 'não deve repetir um POST automaticamente');
  }
});

test('resposta inválida e falha de rede são erros, nunca sucesso vazio', async () => {
  const { client } = setup({});
  await assert.rejects(() => client.get('coach'), /resposta inesperada/);
  const offline = createCoachMatchClient({ supabaseUrl: 'https://isolated.example.test', publicKey: 'fake', fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(() => offline.publicRequest('load', 'fake-token'), /offline/);
});

test('ambiente não configurado não envia requests', async () => {
  const client = createCoachMatchClient({ fetchImpl: async () => { assert.fail('não deveria chamar rede'); } });
  await assert.rejects(() => client.publicRequest('load', 'fake-token'), error => error.code === 'match_not_configured');
});
