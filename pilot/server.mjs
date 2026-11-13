import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, normalizeSearch } from './db.mjs';

const categories = new Set(['commercial','team','partner','historical','review']);
const sportsStatuses = new Set(['active','on_leave','cancelled']);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const hosts = new Set(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5174', 'localhost:5174']);
const origins = new Set([...hosts].map(host => `http://${host}`));
const defaultStaticRoot = fileURLToPath(new URL('../pilot-dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function parseFilters(params) {
  const integer = (key, fallback, max) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw httpError(400, `Parâmetro ${key} inválido.`);
    return Number(raw);
  };
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sportsStatus = params.get('sportsStatus') ?? '';
  if (q.length > 120) throw httpError(400, 'Busca muito longa.');
  if (category && !categories.has(category)) throw httpError(400, 'Categoria inválida.');
  if (sportsStatus && !sportsStatuses.has(sportsStatus)) throw httpError(400, 'Situação esportiva inválida.');
  return { q, category, sportsStatus, page: integer('page', 1, 100000), limit: integer('limit', 25, 100) };
}

export function createRepository(pool) {
  return {
    async summary() {
      const { rows: [row] } = await pool.query(`SELECT i.as_of::text AS as_of,i.summary FROM eon_pilot.imports i
        JOIN eon_pilot.current_import c ON c.import_id=i.id`);
      if (!row) throw httpError(503, 'Importe o retrato reconciliado antes de abrir o piloto.');
      return { ...row.summary, asOf: row.as_of, people: row.summary.totalPeople,
        onLeave: row.summary.commercialOnLeave, needsAthleteProfile: row.summary.newAthleteProfiles };
    },
    async people(filters) {
      const values = [];
      const where = ['p.import_id=(SELECT import_id FROM eon_pilot.current_import)'];
      const add = (column, value) => { values.push(value); where.push(`${column}=$${values.length}`); };
      if (filters.category) add('p.category', filters.category);
      if (filters.sportsStatus) add('p.sports_status', filters.sportsStatus);
      if (filters.q.trim()) {
        values.push(`%${normalizeSearch(filters.q.trim()).replace(/[\\%_]/g, char => `\\${char}`)}%`);
        where.push(`p.search_name LIKE $${values.length} ESCAPE '\\'`);
      }
      const clause = where.join(' AND ');
      // A single read-only transaction keeps total and page on the same snapshot.
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { rows: [count] } = await client.query(`SELECT count(*)::int AS total FROM eon_pilot.people p WHERE ${clause}`, values);
        const { rows } = await client.query(`SELECT p.display FROM eon_pilot.people p WHERE ${clause}
          ORDER BY p.search_name,p.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, filters.limit, (filters.page - 1) * filters.limit]);
        await client.query('COMMIT');
        return { items: rows.map(row => row.display), total: count.total, page: filters.page, limit: filters.limit };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async person(id) {
      const { rows: [row] } = await pool.query(`SELECT display FROM eon_pilot.people
        WHERE import_id=(SELECT import_id FROM eon_pilot.current_import) AND id=$1`, [id]);
      return row?.display ?? null;
    },
  };
}

export function createPilotServer(repository, { staticRoot = defaultStaticRoot } = {}) {
  return createServer(async (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (!hosts.has(request.headers.host) || (request.headers.origin && !origins.has(request.headers.origin))
        || request.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Este piloto está disponível somente no ambiente local.');
      if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw httpError(405, 'O piloto permite apenas leitura.'); }
      const url = new URL(request.url, 'http://127.0.0.1:8787');
      if (url.pathname === '/api/summary') return json(200, await repository.summary());
      if (url.pathname === '/api/people') return json(200, await repository.people(parseFilters(url.searchParams)));
      if (url.pathname.startsWith('/api/people/')) {
        const id = url.pathname.slice('/api/people/'.length);
        if (!uuid.test(id)) throw httpError(400, 'Identificador inválido.');
        const person = await repository.person(id);
        if (!person) throw httpError(404, 'Pessoa não encontrada.');
        return json(200, person);
      }
      if (url.pathname.startsWith('/api/')) throw httpError(404, 'Rota não encontrada.');
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const path = resolve(staticRoot, relative);
      if (!path.startsWith(resolve(staticRoot) + sep)) throw httpError(404, 'Arquivo não encontrado.');
      const mime = types[extname(path)];
      if (!mime) throw httpError(404, 'Arquivo não encontrado.');
      let contents;
      try { contents = await readFile(path); } catch { throw httpError(404, 'Execute npm run pilot:build antes de abrir o piloto.'); }
      response.writeHead(200, { 'Content-Type': mime });
      response.end(contents);
    } catch (error) {
      json(error.status ?? 500, { error: error.status ? error.message : 'Falha ao consultar o piloto. Os dados de origem permanecem preservados.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    pool = await createPool({ readOnly: true });
    const server = createPilotServer(createRepository(pool));
    server.listen(8787, '127.0.0.1', () => console.log('EON pilot: http://127.0.0.1:8787 (local, read-only)'));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
  } catch (error) { console.error(error.message); if (pool) await pool.end(); process.exitCode = 1; }
}
