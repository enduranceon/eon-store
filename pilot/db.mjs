import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const defaultConfigPath = fileURLToPath(new URL('./.local/database.json', import.meta.url));

export function validateDatabaseUrl(value, { readOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid isolated pilot database URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1' || url.port !== '55432'
    || url.pathname !== '/eon_pilot' || url.search || url.hash
    || !url.password || !url.username
    || (readOnly && decodeURIComponent(url.username) !== 'eon_pilot_reader')) {
    throw new Error('Pilot accepts only the isolated 127.0.0.1:55432/eon_pilot database and explicit credentials.');
  }
  return value;
}

export async function createPool({ configPath = defaultConfigPath, readOnly = false } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const connectionString = validateDatabaseUrl(readOnly ? config.readUrl : config.url, { readOnly });
  const pool = new pg.Pool({
    connectionString, max: 4, connectionTimeoutMillis: 5000,
    application_name: readOnly ? 'eon-pilot-reader' : 'eon-pilot-importer',
    options: readOnly ? '-c default_transaction_read_only=on -c statement_timeout=5000' : '-c statement_timeout=30000',
  });
  try {
    const { rows: [row] } = await pool.query('SELECT current_database() AS database, current_user AS role');
    if (row.database !== 'eon_pilot' || (readOnly && row.role !== 'eon_pilot_reader')) {
      throw new Error('Unexpected isolated database identity.');
    }
    return pool;
  } catch (error) { await pool.end(); throw error; }
}

export function normalizeSearch(value) {
  return String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
}

export function publicPerson(person) {
  // Explicit allow-list: no contacts, birth dates, authentication fields or raw
  // source snapshots are copied to the HTTP projection.
  return {
    id: person.id, name: person.name, category: person.category,
    roles: person.roles, sportsStatus: person.sportsStatus ?? null,
    coach: person.coach ?? null, modality: person.modality ?? null,
    inActiveStudents: Boolean(person.inActiveStudents),
    needsAthleteProfile: Boolean(person.needsAthleteProfile),
    reviewReason: person.reviewReason ?? null,
    sources: person.sources.map(source => ({
      system: source.system, kind: source.kind, id: source.id,
      relationship: source.relationship, name: source.name ?? null,
    })),
    memberships: person.memberships.map(membership => ({
      category: membership.category ?? membership.kind ?? membership.type ?? null,
      status: membership.status ?? null,
      inActiveStudents: Boolean(membership.inActiveStudents),
      billingRequired: membership.billingRequired ?? null,
      chargeAmount: membership.chargeAmount ?? null,
      financialStatus: membership.financialStatus ?? null,
      source: membership.source ?? null,
      contracts: (membership.contracts ?? []).map(contract => ({
        id: contract.id, number: contract.number ?? null, start: contract.start ?? null,
        end: contract.end ?? null, status: contract.status ?? null,
        coach: contract.coach ?? null, modality: contract.modality ?? null,
      })),
    })),
    decisions: person.decisions.map(decision => ({
      decision_id: decision.decision_id, action: decision.action,
      recorded_at: decision.recorded_at ?? null, production_applied: decision.production_applied === true,
      source: decision.source ?? null,
    })),
    metadata: {
      ...Object.fromEntries(['commercialStatus', 'observedSportsStatus', 'sportsStatusOrigin',
        'sportsProfilePresent', 'sportsProfilePlanned', 'sportsEffectiveDate',
        'sportsHistoryReferences', 'knownHistoryCounts', 'identityEvidence',
        'candidateHubIds', 'changesAuthOrPermissions', 'referenceDate'].map(key => [key, person.metadata?.[key] ?? null])),
      sportsHistoryImported: false,
      sportsHistory: 'source_references_only',
      authenticationMigrated: false,
      paymentsMigrated: false,
    },
  };
}
