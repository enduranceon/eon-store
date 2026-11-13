import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { validateDatabaseUrl } from './db.mjs'

const local = fileURLToPath(new URL('./.local/', import.meta.url))
const configPath = `${local}/database.json`
const container = 'eon-unification-pilot'
const label = 'eon.pilot=unification-local'
const dockerEnv = { ...process.env }
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key]
function docker(args, { optional = false } = {}) {
  const result = spawnSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env: dockerEnv, encoding: 'utf8' })
  if (result.status !== 0 && !optional) throw new Error(result.stderr || 'Docker indisponível')
  return result
}

await mkdir(local, { recursive: true, mode: 0o700 })
let config
try { config = JSON.parse(await readFile(configPath, 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const existing = docker(['inspect', container], { optional: true })
if (config) {
  validateDatabaseUrl(config.url)
  validateDatabaseUrl(config.readUrl, { readOnly: true })
}
if (existing.status === 0) {
  const info = JSON.parse(existing.stdout)[0]
  if (info.Config.Labels?.['eon.pilot'] !== 'unification-local' || !config) throw new Error('Container existente não corresponde à configuração privada do piloto.')
  const bindings = info.HostConfig.PortBindings?.['5432/tcp']
  if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== '55432') throw new Error('Porta do banco precisa ficar restrita ao loopback.')
  if (!info.State.Running) docker(['start', container])
} else {
  if (config) throw new Error('Configuração antiga encontrada sem container. Preserve os dados e revise a configuração antes de recriar o banco.')
  const ownerPassword = randomBytes(32).toString('base64url')
  const readerPassword = randomBytes(32).toString('base64url')
  config = {
    url: `postgres://eon_pilot_owner:${ownerPassword}@127.0.0.1:55432/eon_pilot`,
    readUrl: `postgres://eon_pilot_reader:${readerPassword}@127.0.0.1:55432/eon_pilot`,
  }
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
  const envPath = `${local}/postgres.env`
  await writeFile(envPath, `POSTGRES_USER=eon_pilot_owner\nPOSTGRES_PASSWORD=${ownerPassword}\nPOSTGRES_DB=eon_pilot\n`, { mode: 0o600, flag: 'wx' })
  docker(['run', '-d', '--name', container, '--label', label, '--env-file', envPath,
    '-p', '127.0.0.1:55432:5432', '--mount', 'type=volume,source=eon-unification-pilot-data,target=/var/lib/postgresql/data',
    'postgres:17.7-bookworm'])
}

let client
for (let attempt = 0; attempt < 40; attempt++) {
  client = new pg.Client({ connectionString: config.url, connectionTimeoutMillis: 1000 })
  try { await client.connect(); break } catch (error) {
    await client.end().catch(() => {})
    if (attempt === 39) throw error
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
try {
  const found = await client.query("select 1 from pg_roles where rolname = 'eon_pilot_reader'")
  if (!found.rowCount) {
    const password = new URL(config.readUrl).password
    if (!/^[\w-]+$/.test(password)) throw new Error('Senha local inválida')
    await client.query(`create role eon_pilot_reader login password '${password}' nosuperuser nocreatedb nocreaterole`)
  }
  await client.query('revoke create on schema public from public')
  await client.query('alter role eon_pilot_reader set default_transaction_read_only = on')
  console.log('Banco isolado pronto em 127.0.0.1:55432; credenciais somente em pilot/.local/.')
} finally { await client.end() }
