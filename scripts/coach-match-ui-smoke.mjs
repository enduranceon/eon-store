// Local-only browser smoke test. Start Vite with a localhost Supabase URL and
// fixture public key; this script mocks all API requests and blocks remote URLs.
// PLAYWRIGHT_MODULE_PATH and PLAYWRIGHT_CHROMIUM_EXECUTABLE can use bundled tools.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const base = new URL(process.env.MATCH_UI_BASE_URL || 'http://127.0.0.1:5197');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'UI smoke must target localhost');
const output = process.env.MATCH_UI_OUTPUT_DIR || '/private/tmp/eon-match-ui-smoke';
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  headless: true,
  args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'],
});
const token = 'A'.repeat(43);
const coachId = '11111111-1111-4111-8111-111111111111';
const answers = {
  version: 2, service_formats: ['florianopolis', 'online'],
  focus_goals: { primary: 'performance', secondary: 'health' },
  focus_levels: { primary: 'intermediate', secondary: 'beginner' },
  communication_style: { primary: 'balanced', secondary: 'close' },
  age_groups: { primary: 'age_31_50', secondary: 'up_to_30' },
  gender_preference: { primary: 'no_preference', secondary: null },
};
const submittedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
const submission = (status, id = 'latest') => ({ id, status, answers, submitted_at: submittedAt, reviewed_at: status === 'approved' ? submittedAt : null });
const errors = [];
const blocked = [];
const screenshots = [];
const checks = [];
const requests = [];
let latest = null;
let published = null;
let invites = [];
let loadFailure = false;
let snapshotFailure = false;
let conflict = false;

const json = (route, data, status = 200) => route.fulfill({
  status, contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,HEAD', 'Content-Range': '*/0' },
  body: JSON.stringify(data),
});
async function makeContext(viewport, admin = false) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base.origin) return route.continue();
    if (url.origin !== 'http://127.0.0.1:54321') {
      blocked.push(url.origin + url.pathname);
      return route.abort('blockedbyclient');
    }
    requests.push({ path: url.pathname, method: route.request().method() });
    if (route.request().method() === 'OPTIONS') return json(route, {});
    if (url.pathname === '/functions/v1/api-v1/session') return json(route, { data: { id: 'fixture-admin', role: 'admin' } });
    if (url.pathname.startsWith('/rest/v1/')) return json(route, []);
    if (url.pathname === '/functions/v1/api-v1/financial/quality') return json(route, { data: [] });
    if (url.pathname === '/functions/v1/coach-match-form') {
      const body = route.request().postDataJSON();
      assert.equal(body.token, token);
      assert.equal(body.profile_version, 2);
      if (loadFailure) return json(route, { error: 'Este link expirou ou foi revogado.' }, 410);
      if (body.action === 'load') return json(route, { data: { coach: {
        name: 'Coach Teste', modalities: [{ id: 'corrida', name: 'Corrida' }, { id: 'triathlon', name: 'Triathlon' }],
      }, latest, expires_at: expiresAt } });
      assert.equal(body.action, 'submit');
      assert.deepEqual(body.answers, answers);
      latest = { ...submission('pending'), answers: body.answers };
      return json(route, { data: { received: true, id: 'latest', submitted_at: submittedAt } });
    }
    const path = `/functions/v1/coach-match-admin/coach-match/${coachId}`;
    if (url.pathname === path) {
      assert.equal(url.search, '?profile_version=2');
      if (snapshotFailure) return json(route, { error: 'Falha de consulta simulada' }, 500);
      return json(route, { data: { coach: { id: coachId, name: 'Coach Teste', active: true,
        modalities: [{ id: 'corrida', name: 'Corrida' }, { id: 'triathlon', name: 'Triathlon' }] },
      latest, published, invites, server_time: new Date().toISOString() } });
    }
    if (url.pathname === `${path}/invite`) {
      assert.equal(url.search, '');
      invites = [{ id: 'invite-test', expires_at: expiresAt, revoked_at: null }];
      return json(route, { data: { id: 'invite-test', token, expires_at: expiresAt } });
    }
    if (url.pathname === `${path}/revoke`) {
      assert.equal(url.search, '');
      invites = [];
      return json(route, { data: { revoked: true } });
    }
    if (url.pathname === `${path}/review`) {
      assert.equal(url.search, '?profile_version=2');
      if (conflict) { latest = submission('pending', 'concurrent'); return json(route, { error: 'Esta resposta foi substituída. Atualize e confira a nova versão.' }, 409); }
      const body = route.request().postDataJSON();
      assert.equal(body.submission_id, latest.id);
      latest = { ...latest, status: body.decision };
      if (body.decision === 'approved') published = { ...latest };
      return json(route, { data: { id: latest.id, status: latest.status } });
    }
    throw new Error(`Unmocked local API: ${url.pathname}`);
  });
  if (admin) {
    await context.addInitScript(origin => {
      if (window.location.origin !== origin) return;
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const jwt = [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: 'fixture-admin', exp })), 'fixture'].join('.');
      localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'fake-refresh', expires_at: exp, expires_in: 3600, token_type: 'bearer', user: { id: 'fixture-admin', email: 'fixture@example.test', aud: 'authenticated' } }));
    }, base.origin);
  }
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return context;
}
async function shot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${name}: horizontal overflow`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  screenshots.push(`${name}.png`);
}
async function publicFlow(viewport, name) {
  latest = null;
  const context = await makeContext(viewport);
  const page = await context.newPage();
  await page.goto(`${base.origin}/match-coach#token=${token}`);
  await page.getByRole('heading', { name: 'Olá, Coach.' }).waitFor();
  await page.getByText('Modalidades do seu cadastro').waitFor();
  await page.getByText('Corrida', { exact: true }).waitFor();
  assert.equal(await page.locator('textarea').count(), 0, `${name}: v2 não deve ter campos de texto livre`);
  await shot(page, `${name}-form-empty`);
  await page.getByLabel('Florianópolis', { exact: true }).check();
  await page.getByLabel('Online', { exact: true }).check();
  await page.locator('#focus-goals-primary').selectOption('performance');
  await page.locator('#focus-goals-secondary').selectOption('health');
  await page.locator('#focus-levels-primary').selectOption('intermediate');
  await page.locator('#focus-levels-secondary').selectOption('beginner');
  await page.locator('#communication-style-primary').selectOption('balanced');
  await page.locator('#communication-style-secondary').selectOption('close');
  await page.locator('#age-groups-primary').selectOption('no_preference');
  assert.equal(await page.locator('#age-groups-secondary').isDisabled(), true);
  await page.locator('#age-groups-primary').selectOption('age_31_50');
  await page.locator('#age-groups-secondary').selectOption('up_to_30');
  await page.locator('#gender-preference-primary').selectOption('no_preference');
  assert.equal(await page.locator('#gender-preference-secondary').isDisabled(), true);
  await page.getByRole('button', { name: 'Enviar para revisão ↗' }).click();
  await page.getByRole('heading', { name: 'Obrigado, Coach.' }).waitFor();
  await shot(page, `${name}-form-success`);
  for (const status of ['pending', 'approved', 'rejected']) {
    latest = submission(status);
    await page.reload();
    await page.getByRole('heading', { name: 'Olá, Coach.' }).waitFor();
    assert.equal(await page.locator('#focus-goals-primary').inputValue(), answers.focus_goals.primary);
    assert.equal(await page.locator('#focus-goals-secondary').inputValue(), answers.focus_goals.secondary);
    assert.equal(await page.locator('#gender-preference-primary').inputValue(), 'no_preference');
    assert.equal(await page.locator('#gender-preference-secondary').isDisabled(), true);
    await shot(page, `${name}-form-${status}`);
  }
  loadFailure = true;
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'expirou ou foi revogado' }).waitFor();
  await shot(page, `${name}-form-expired`);
  loadFailure = false;
  checks.push(`${name}: formulário v2 sem texto livre, prioridades, sem preferência, envio, prefill e link expirado`);
  await context.close();
}
async function adminFlow(viewport, name) {
  latest = submission('pending'); published = submission('approved', 'previous-approved'); invites = [];
  const context = await makeContext(viewport, true);
  const page = await context.newPage();
  await page.goto(`${base.origin}/assessoria/coaches/${coachId}/match`);
  await page.getByRole('heading', { name: 'Coach Teste', exact: true }).waitFor();
  await shot(page, `${name}-admin-pending`);
  await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await shot(page, `${name}-admin-pending-bottom`);
  await page.locator('main').evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('button', { name: 'Gerar novo link' }).click();
  await page.getByLabel('Link individual do formulário').waitFor();
  assert.equal(await page.getByLabel('Link individual do formulário').inputValue(), `${base.origin}/match-coach#token=${token}`);
  await page.getByRole('button', { name: 'Revogar', exact: true }).click();
  await page.getByText('Link revogado.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Link individual do formulário').count(), 0);
  await page.getByRole('button', { name: 'Não usar esta versão' }).click();
  await page.getByText('Nenhuma resposta pendente.').waitFor();
  assert.equal(published.id, 'previous-approved');
  latest = submission('pending', 'to-approve');
  await page.getByRole('button', { name: 'Atualizar respostas' }).click();
  await page.getByRole('button', { name: 'Aprovar para o match' }).click();
  await page.getByText('Nenhuma resposta pendente.').waitFor();
  assert.equal(published.id, 'to-approve');
  await shot(page, `${name}-admin-approved`);
  latest = submission('pending', 'stale');
  await page.getByRole('button', { name: 'Atualizar respostas' }).click();
  conflict = true;
  await page.getByRole('button', { name: 'Aprovar para o match' }).click();
  await page.getByRole('alert').filter({ hasText: 'substituída' }).waitFor();
  assert.equal(published.id, 'to-approve');
  conflict = false;
  snapshotFailure = true;
  await page.getByRole('button', { name: 'Atualizar respostas' }).click();
  await page.getByRole('alert').filter({ hasText: 'Falha de consulta simulada' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Aprovar para o match' }).count(), 0);
  await shot(page, `${name}-admin-error`);
  snapshotFailure = false;
  await page.getByRole('button', { name: 'Atualizar formulário' }).click();
  await page.getByRole('heading', { name: 'Coach Teste', exact: true }).waitFor();
  checks.push(`${name}: painel, gerar/revogar link, rejeitar/preservar, aprovar, conflito e recuperação de erro`);
  await context.close();
}

try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await publicFlow(viewport, name);
    await adminFlow(viewport, name);
  }
  assert.deepEqual(errors, [], 'Nenhum erro de runtime esperado');
  assert.deepEqual(blocked, [], 'A aplicação não deve tentar acessar origens externas');
  await writeFile(`${output}/ui-smoke-results.json`, JSON.stringify({ checks, screenshots, errors, blocked, requests }, null, 2));
  console.log(JSON.stringify({ passed: checks, screenshots: screenshots.length, errors, blocked, output }));
} finally {
  await browser.close();
}
