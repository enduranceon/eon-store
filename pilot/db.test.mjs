import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDatabaseUrl, publicPerson, customerPerson } from './db.mjs';
import { readImport, importNormalized } from './import.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const snapshot = join(fixtures, 'synthetic-snapshot.json');
const manifest = join(fixtures, 'synthetic-manifest.json');

test('database guard rejects production, socket overrides and non-reader API identities', () => {
  const local = 'postgresql://eon_pilot_owner:synthetic@127.0.0.1:55432/eon_pilot';
  assert.equal(validateDatabaseUrl(local), local);
  for (const url of [local.replace('127.0.0.1', 'db.example.com'), local.replace('55432', '5432'),
    local.replace(/\/eon_pilot$/, '/postgres'), `${local}?host=evil.example`, local.replace(':synthetic', '')]) {
    assert.throws(() => validateDatabaseUrl(url));
  }
  assert.throws(() => validateDatabaseUrl(local, { readOnly: true }));
  assert.doesNotThrow(() => validateDatabaseUrl(local.replace('eon_pilot_owner', 'eon_pilot_reader'), { readOnly: true }));
});

test('import verifies raw snapshot SHA before normalization', async () => {
  const data = await readImport(snapshot, manifest);
  assert.equal(data.id.length, 64);
  assert.equal(data.projectionHash.length, 64);
  assert.equal(data.projectionVersion, 1);
  assert.equal((await readImport(snapshot, manifest)).id, data.id);
  const dir = await mkdtemp(join(tmpdir(), 'eon-pilot-fixture-'));
  try {
    const changed = join(dir, 'snapshot.json');
    await writeFile(changed, `${await readFile(snapshot, 'utf8')}\n`);
    await assert.rejects(readImport(changed, manifest), /SHA-256 mismatch/);
  } finally { await rm(dir, { recursive: true }); }
});

test('operational Store input must name the canonical project and reconciled date', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eon-pilot-store-'));
  try {
    const path = join(dir, 'store.json');
    const validShape = { project: 'bsiljrrodgtmtdilnuxr', asOf: '2026-11-12', customers: [] };
    for (const invalid of [{ ...validShape, project: 'another-project' }, { ...validShape, asOf: '2026-11-13' },
      { ...validShape, customers: null }, null]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(readImport(snapshot, manifest, path), /canonical Store project/);
    }
  } finally { await rm(dir, { recursive: true }); }
});

test('HTTP projection excludes private fields while preserving benefit and source evidence', async () => {
  const data = await readImport(snapshot, manifest);
  const person = structuredClone(data.people.find(p => p.category === 'team'));
  person.email = 'private@example.invalid';
  person.metadata.birthDateCorrection = { value: '2000-01-01' };
  person.decisions.push({ decision_id: 'fake-private', action: 'identity', user_answer: 'private text', canonical_fields: { cpf: 'private' } });
  const projected = publicPerson(person);
  assert.equal(projected.memberships.find(m => m.category === 'team').billingRequired, false);
  assert.equal(projected.metadata.sportsHistoryImported, false);
  assert.equal(projected.sources.length, person.sources.length);
  assert.equal(JSON.stringify(projected).includes('private text'), false);
  assert.equal(JSON.stringify(projected).includes('private@example'), false);
  assert.equal(JSON.stringify(projected).includes('2000-01-01'), false);
});

test('customer projection preserves Store status without audit source IDs or Hub state', () => {
  const customer = customerPerson({ id: 'local-id', name: 'Pessoa Fictícia', category: 'commercial', roles: ['athlete'],
    customerStatus: { key: 'on_leave', label: 'Em licença', source: 'store' },
    sportsStatus: 'active', coach: 'Coach Store', modality: 'triathlon', inActiveStudents: true,
    memberships: [{ category: 'commercial', status: 'current', inActiveStudents: true,
      contracts: [{ id: 'private-source-id', number: 'DEMO-1', start: '2026-10-01', end: '2027-04-01', status: 'on_leave' }] }],
    sources: [{ id: 'private-source-id' }], decisions: [], metadata: { observedSportsStatus: 'active' } });
  assert.equal(customer.customerStatus.key, 'on_leave');
  assert.equal(customer.coach, 'Coach Store');
  assert.equal(JSON.stringify(customer).includes('private-source-id'), false);
  assert.equal('sportsStatus' in customer, false);
  assert.equal('sources' in customer, false);
  assert.equal('metadata' in customer, false);
});

test('import locks before writes, repeated snapshots skip and identity conflicts roll back', async () => {
  const data = await readImport(snapshot, manifest);
  const statements = [];
  const client = { release() {}, async query(sql) {
    statements.push(sql);
    if (sql.startsWith('SELECT id FROM eon_pilot.imports')) return { rowCount: 1, rows: [{ id: data.id }] };
    return { rowCount: 0, rows: [] };
  } };
  const result = await importNormalized({ connect: async () => client }, data);
  assert.equal(result.imported, false);
  assert.match(statements[1], /pg_advisory_xact_lock/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some(sql => sql.startsWith('INSERT')), false);
  statements.length = 0;
  client.query = async sql => {
    statements.push(sql);
    if (sql.startsWith('SELECT person_id')) return { rows: [{ person_id: 'different-person' }] };
    return { rowCount: 0, rows: [] };
  };
  await assert.rejects(importNormalized({ connect: async () => client }, data), /move between people/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some(sql => sql.startsWith('INSERT INTO eon_pilot.current_import')), false);
});
