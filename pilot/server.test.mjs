import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createPilotServer, parseFilters, createRepository } from './server.mjs';

const person = { id: '00000000-0000-4000-a000-000000000001', name: 'Pessoa Fictícia' };

async function withServer(fn) {
  const calls = [];
  const repository = {
    summary: async () => ({ activeStudents: 2 }),
    people: async filters => { calls.push(filters); return { items: [person], total: 1, ...filters }; },
    person: async id => id === person.id ? person : null,
  };
  const server = createPilotServer(repository);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: '127.0.0.1:8787', ...headers } }, res => {
      let body = '';
      res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end();
  });
  try { await fn(get, calls); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('GET summary/list/detail and bounded filters', async () => withServer(async (get, calls) => {
  assert.equal((await get('/api/summary')).body.activeStudents, 2);
  const response = await get('/api/people?q=Fict%C3%ADcia&category=team&sportsStatus=active&page=2&limit=10');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(calls[0], { q: 'Fictícia', category: 'team', sportsStatus: 'active', view: '', page: 2, limit: 10 });
  assert.deepEqual((await get(`/api/people/${person.id}`)).body, person);
  assert.equal((await get('/api/people/00000000-0000-4000-a000-000000000002')).status, 404);
  assert.equal((await get('/api/people/not-an-id')).status, 400);
}));

test('rejects mutations, foreign hosts/origins and cross-site requests', async () => withServer(async get => {
  assert.equal((await get('/api/people', {}, 'POST')).status, 405);
  assert.equal((await get('/api/summary', { Host: 'malicious.example:8787' })).status, 403);
  assert.equal((await get('/api/summary', { Origin: 'https://malicious.example' })).status, 403);
  assert.equal((await get('/api/summary', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get('/api/summary', { Origin: 'http://127.0.0.1:5174' })).status, 200);
}));

test('rejects invalid pagination and filters without querying', async () => withServer(async (get, calls) => {
  for (const query of ['page=-1', 'page=1.5', 'limit=101', 'limit=0', 'category=admin', 'sportsStatus=paid',
    'view=unknown', 'view=customers&sportsStatus=active', `q=${'a'.repeat(121)}`]) {
    assert.equal((await get(`/api/people?${query}`)).status, 400, query);
  }
  assert.equal(calls.length, 0);
}));

test('query uses parameters and literal wildcard escaping', async () => {
  const queries = [];
  const client = { release() {}, async query(sql, values) {
    queries.push({ sql, values });
    return sql.includes('count(*)') ? { rows: [{ total: 1 }] } : sql.includes('p.display') ? { rows: [{ display: person }] } : { rows: [] };
  } };
  const repository = createRepository({ connect: async () => client });
  const result = await repository.people(parseFilters(new URLSearchParams("q=%_'--&category=team")));
  assert.equal(result.total, 1);
  const query = queries.find(q => q.sql.includes('p.display'));
  assert.equal(query.sql.includes("%_'--"), false);
  assert.deepEqual(query.values, ['team', "%\\%\\_'--%", 25, 0]);
  assert.equal(queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('customer view scopes list and detail to Store or confirmed benefits and hides Hub lifecycle', async () => {
  const queries = [];
  const display = { ...person, category: 'review', roles: [], sportsStatus: 'active',
    customerStatus: { key: 'cancelled', label: 'Cancelado', source: 'store' },
    inActiveStudents: false, coach: 'Coach Store', modality: 'corrida',
    memberships: [], sources: [{ system: 'store', kind: 'customer', id: 'technical-id' }],
    decisions: [{ action: 'identity' }], metadata: { observedSportsStatus: 'active' } };
  const client = { release() {}, async query(sql, values) {
    queries.push({ sql, values });
    return sql.includes('count(*)') ? { rows: [{ total: 1 }] } : sql.includes('p.display') ? { rows: [{ display }] } : { rows: [] };
  } };
  const repository = createRepository({ connect: async () => client, query: client.query });
  const result = await repository.people(parseFilters(new URLSearchParams('view=customers&category=historical')));
  assert.equal(result.items[0].category, 'historical');
  assert.deepEqual(result.items[0].customerStatus, display.customerStatus);
  for (const key of ['sportsStatus','sources','decisions','metadata','reviewReason']) assert.equal(key in result.items[0], false);
  for (const query of queries.filter(q => q.sql.includes('WHERE'))) {
    assert.match(query.sql, /"system":"store","kind":"customer"/);
    assert.match(query.sql, /p.category IN \('team','partner'\)/);
    assert.match(query.sql, /p.category IN \('historical','review'\)/);
  }
  const detail = await repository.person(person.id, 'customers');
  assert.deepEqual(detail, result.items[0]);
  assert.match(queries.at(-1).sql, /"system":"store","kind":"customer"/);
});

test('customer summary uses Store licence and operational customer counts only', async () => {
  const repository = createRepository({ query: async () => ({ rows: [{ as_of: '2026-11-12', summary: {
    totalPeople: 20, operationalPeople: 12, activeStudents: 8, benefits: 2, team: 1, partners: 1,
    storeOnLeave: 3, commercialOnLeave: 7, sportsOnLeave: 9, identityLinks: 10,
  } }] }) });
  const summary = await repository.summary('customers');
  assert.equal(summary.people, 12);
  assert.equal(summary.onLeave, 3);
  assert.equal(summary.customerAuthority, 'store');
  assert.equal('sportsOnLeave' in summary, false);
  assert.equal('identityLinks' in summary, false);
});
