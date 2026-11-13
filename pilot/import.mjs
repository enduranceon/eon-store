import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPool, normalizeSearch, publicPerson } from './db.mjs';
import { normalizeSnapshot } from './domain.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const projectionVersion = 1;
const canonicalJson = value => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  }
  return item;
});

export async function readImport(snapshotPath, manifestPath) {
  const [snapshotBytes, manifestBytes] = await Promise.all([readFile(snapshotPath), readFile(manifestPath)]);
  const snapshot = JSON.parse(snapshotBytes);
  const manifest = JSON.parse(manifestBytes);
  const snapshotHash = sha256(snapshotBytes);
  if (manifest.input?.sha256 !== snapshotHash) throw new Error('Snapshot differs from the reconciled manifest (SHA-256 mismatch).');
  const manifestHash = sha256(manifestBytes);
  const normalized = normalizeSnapshot(snapshot, manifest);
  const projectionHash = sha256(canonicalJson({
    version: projectionVersion, normalized,
    publicPeople: normalized.people.map(publicPerson),
  }));
  return {
    id: sha256(`${snapshotHash}:${manifestHash}:${projectionHash}`),
    snapshotHash, manifestHash, projectionHash, projectionVersion,
    ...normalized,
  };
}

export async function importNormalized(pool, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('eon-isolated-pilot-import'))");
    await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const existing = await client.query('SELECT id FROM eon_pilot.imports WHERE id=$1', [data.id]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return { id: data.id, imported: false, summary: data.summary };
    }
    await client.query(`INSERT INTO eon_pilot.imports
      (id,snapshot_sha256,manifest_sha256,as_of,summary,decisions,projection_sha256,projection_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [data.id, data.snapshotHash, data.manifestHash, data.asOf, data.summary, JSON.stringify(data.decisions),
      data.projectionHash, data.projectionVersion]);
    for (const person of data.people) {
      await client.query(`INSERT INTO eon_pilot.people
        (import_id,id,name,search_name,category,sports_status,active_student,needs_athlete_profile,display,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [data.id, person.id, person.name, normalizeSearch(person.name), person.category,
        person.sportsStatus, person.inActiveStudents, person.needsAthleteProfile, publicPerson(person), person.metadata]);
      for (const source of person.sources) {
        const values = [source.system, source.kind, source.id, person.id];
        await client.query(`INSERT INTO eon_pilot.identities (system,kind,source_id,person_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, values);
        const { rows: [prior] } = await client.query(`SELECT person_id FROM eon_pilot.identities
          WHERE system=$1 AND kind=$2 AND source_id=$3`, values.slice(0, 3));
        if (prior.person_id !== person.id) throw new Error('A source identity would move between people; explicit reconciliation is required.');
        await client.query(`INSERT INTO eon_pilot.source_links
          (import_id,person_id,system,kind,source_id,relationship,source_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [data.id, person.id, source.system, source.kind, source.id, source.relationship, source.name ?? null]);
      }
      for (const role of person.roles) await client.query(`INSERT INTO eon_pilot.person_roles
        (import_id,person_id,role) VALUES ($1,$2,$3)`, [data.id, person.id, role]);
      for (const [ordinal, membership] of person.memberships.entries()) await client.query(`INSERT INTO eon_pilot.memberships
        (import_id,person_id,ordinal,evidence) VALUES ($1,$2,$3,$4)`, [data.id, person.id, ordinal, membership]);
    }
    await client.query(`INSERT INTO eon_pilot.current_import (singleton,import_id) VALUES (true,$1)
      ON CONFLICT (singleton) DO UPDATE SET import_id=EXCLUDED.import_id`, [data.id]);
    await client.query('COMMIT');
    return { id: data.id, imported: true, summary: data.summary };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    const args = process.argv.slice(2);
    const value = key => args[args.indexOf(key) + 1];
    if (!args.includes('--snapshot') || !args.includes('--manifest')) throw new Error('Usage: node pilot/import.mjs --snapshot PATH --manifest PATH');
    const data = await readImport(value('--snapshot'), value('--manifest'));
    pool = await createPool();
    console.log(JSON.stringify(await importNormalized(pool, data), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (pool) await pool.end(); }
}
