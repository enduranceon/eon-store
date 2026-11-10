import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { buildCoachProfile } from './coach-profile.js';
import { computeCoachPanel, customerIdsOf, presentCoachPanel } from '../../supabase/functions/_shared/assessment-metrics/coach-panel.js';

const TODAY = '2026-10-13';
const plans = [
  { id: 'run', name: 'Corrida - Mensal', modality_id: 'm-run', period_months: 1, price_monthly: 300, price_total: 300 },
  { id: 'bike', name: 'Ciclismo - Trimestral', modality_id: 'm-bike', period_months: 3, price_monthly: 250, price_total: 750 },
];

function contract(overrides) {
  return {
    plan_id: 'run', coach_id: 'k1', status: 'active', payment_status: 'paid',
    start_date: '2026-01-01', end_date: '2027-01-01', created_at: '2026-01-01T12:00:00.000Z', ...overrides,
  };
}

// Pessoas e contratos fictícios: k1 é o coach do teste; k2, outro coach.
const contracts = [
  contract({ id: 'a', customer_id: 'c1', start_date: '2026-09-10', end_date: '2026-11-10' }),
  contract({ id: 'b', customer_id: 'c2', status: 'cancelled', cancellation_date: '2026-09-20', cancellation_reason: 'Mudou de cidade' }),
  contract({ id: 'c', customer_id: 'c3', plan_id: 'bike', start_date: '2026-08-01', end_date: '2026-10-31' }),
  contract({ id: 'c-renewal', customer_id: 'c3', plan_id: 'bike', parent_contract_id: 'c', status: 'draft', payment_status: 'pending', renewal_stage: 'waiting_response', start_date: '2026-11-01', end_date: '2027-01-31' }),
  contract({ id: 'd', customer_id: 'c4', status: 'on_leave' }),
  contract({ id: 'e', customer_id: 'c5', payment_status: 'overdue', due_date: '2026-10-05' }),
  contract({ id: 'f', customer_id: 'c6', coach_id: 'k2', start_date: '2026-05-01' }),
  contract({ id: 'g', customer_id: 'c10', coach_id: 'k2', start_date: '2026-06-01' }),
  contract({ id: 'h', customer_id: 'c11', coach_id: 'k2', status: 'cancelled', cancellation_date: '2026-09-25', cancellation_reason: 'Motivo do outro coach' }),
];
const customerNames = new Map([
  ['c1', 'Ana Souza'], ['c2', 'Bruno Lima'], ['c3', 'Carla Dias'], ['c4', 'Davi Rocha'], ['c5', 'Elisa Prado'],
  ['c6', 'Fábio Outro'], ['c10', 'Gabi Outro'], ['c11', 'Hugo Outro'],
]);
const modalityNames = new Map([['m-run', 'Corrida'], ['m-bike', 'Ciclismo']]);

const panel = computeCoachPanel({ coachId: 'k1', contracts, plans, today: TODAY });
const shown = presentCoachPanel(panel, { customerNames, modalityNames });

test('the coach sees exactly the numbers of the profile the team sees', () => {
  const profile = buildCoachProfile({ coachId: 'k1', contracts, plans, today: TODAY });
  assert.equal(shown.kpis.active, profile.kpis.active);
  assert.equal(shown.kpis.entries, profile.kpis.entries);
  assert.equal(shown.kpis.returns, profile.kpis.returns);
  assert.equal(shown.kpis.renewals, profile.kpis.renewals);
  assert.equal(shown.kpis.exits, profile.kpis.exits);
  assert.equal(shown.kpis.net, profile.kpis.net);
  assert.equal(shown.kpis.renewals_in_progress, profile.renewals.length);
  assert.deepEqual(shown.monthly.map(row => [row.month, row.base_start, row.entries, row.returns, row.renewals, row.exits, row.base_end]),
    profile.monthly.map(row => [row.month, row.baseStart, row.entries, row.returns, row.renewals, row.exits, row.baseEnd]));
  assert.equal(shown.students.length, profile.students.length);
  assert.equal(shown.exits.length, profile.exits.length);
});

test('only this coach\'s students and exits appear, never another coach\'s people', () => {
  const names = shown.students.map(student => student.name).sort();
  assert.deepEqual(names, ['Ana Souza', 'Carla Dias', 'Davi Rocha', 'Elisa Prado']);
  assert.deepEqual(shown.exits.map(exit => exit.name), ['Bruno Lima']);
  const text = JSON.stringify(shown);
  for (const forbidden of ['Fábio Outro', 'Gabi Outro', 'Hugo Outro', 'Motivo do outro coach']) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not reach this coach`);
  }
  assert.deepEqual(customerIdsOf(panel).sort(), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('every object has a fixed list of fields and nothing about money, contact or internal ids', () => {
  assert.deepEqual(Object.keys(shown).sort(), ['by_modality', 'exits', 'kpis', 'monthly', 'students', 'today']);
  assert.deepEqual(Object.keys(shown.kpis).sort(), ['active', 'average_churn', 'entries', 'exits', 'net', 'renewals', 'renewals_in_progress', 'returns']);
  assert.deepEqual(Object.keys(shown.students[0]).sort(), ['ends_on', 'modality', 'name', 'plan', 'situation', 'started_on']);
  assert.deepEqual(Object.keys(shown.exits[0]).sort(), ['date', 'modality', 'name', 'plan', 'reason']);
  assert.deepEqual(Object.keys(shown.monthly[0]).sort(), ['base_end', 'base_start', 'churn_rate', 'entries', 'exits', 'label', 'month', 'net', 'renewals', 'returns']);
  assert.deepEqual(Object.keys(shown.by_modality[0]).sort(), ['modality', 'students']);
  const text = JSON.stringify(shown).toLowerCase();
  for (const forbidden of ['revenue', 'price', 'value', 'amount', 'mensalidade', 'customer_id', 'customerid', 'contract', 'whatsapp', 'email', 'cpf', 'discount', 'asaas', 'payment', 'overdue', 'atrasad']) {
    assert.ok(!text.includes(forbidden), `no "${forbidden}" in the coach panel`);
  }
  assert.ok(!/monthlyvalue|monthly_value|monthlyrevenue|monthly_revenue/.test(text), 'no monthly value or revenue');
});

test('a student with a late payment shows as active, because that is the student\'s financial situation', () => {
  const late = shown.students.find(student => student.name === 'Elisa Prado');
  assert.equal(late.situation.key, 'active');
  assert.equal(late.situation.label, 'Ativo');
  assert.equal(shown.students.find(student => student.name === 'Davi Rocha').situation.label, 'Em licença');
  assert.equal(shown.students.find(student => student.name === 'Carla Dias').situation.label, 'Renovação em andamento');
});

test('students come in alphabetical order and exits keep their reason, cut at a safe length', () => {
  assert.deepEqual(shown.students.map(student => student.name), ['Ana Souza', 'Carla Dias', 'Davi Rocha', 'Elisa Prado']);
  assert.equal(shown.exits[0].reason, 'Mudou de cidade');
  const long = computeCoachPanel({
    coachId: 'k1', plans, today: TODAY,
    contracts: [contract({ id: 'z', customer_id: 'c2', status: 'cancelled', cancellation_date: '2026-09-20', cancellation_reason: `  ${'x'.repeat(500)}  ` })],
  });
  assert.equal(long.exits[0].reason.length, 280);
});

test('unknown people and modalities get neutral labels instead of breaking', () => {
  const bare = presentCoachPanel(panel);
  assert.ok(bare.students.every(student => student.name === '—'));
  assert.ok(bare.students.some(student => student.modality === 'Modalidade'));
  const noModality = presentCoachPanel(computeCoachPanel({ coachId: 'k1', plans: [], today: TODAY, contracts: [contract({ id: 'n', customer_id: 'c1', plan_id: 'missing' })] }), { customerNames });
  assert.equal(noModality.students[0].modality, 'Sem modalidade');
});

test('the builder requires the coach and today, so nothing depends on the machine clock', () => {
  assert.throws(() => computeCoachPanel({ contracts, plans, today: TODAY }), /coachId/);
  assert.throws(() => computeCoachPanel({ coachId: 'k1', contracts, plans }), /today/);
  assert.throws(() => computeCoachPanel({ coachId: 'k1', contracts, plans, today: 'amanhã' }), /today/);
});

test('the result is identical on machines in different time zones, even at 22h in Brasília', () => {
  // Instante fixo de 22h10 em Brasília (01h10 UTC do dia seguinte): em UTC o dia é outro.
  const script = `
    const FIXED = Date.parse('2026-11-10T01:10:00Z');
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
      static now() { return FIXED; }
    };
    const { computeCoachPanel, presentCoachPanel } = await import(${JSON.stringify(new URL('../../supabase/functions/_shared/assessment-metrics/coach-panel.js', import.meta.url).href)});
    const { businessDayOf } = await import(${JSON.stringify(new URL('../../supabase/functions/_shared/assessment-metrics/dates.js', import.meta.url).href)});
    const plans = [{ id: 'run', name: 'Corrida - Mensal', modality_id: 'm-run', period_months: 1, price_monthly: 300, price_total: 300 }];
    const base = { plan_id: 'run', coach_id: 'k1', status: 'active', payment_status: 'paid', end_date: '2027-01-01' };
    const contracts = [
      // Sem start_date: o início vem de created_at, um instante perto da meia-noite.
      { ...base, id: 'a', customer_id: 'c1', created_at: '2026-11-10T01:30:00.000Z' },
      { ...base, id: 'b', customer_id: 'c2', created_at: '2026-10-05T02:59:00.000Z' },
      { ...base, id: 'c', customer_id: 'c3', created_at: '2026-10-05T03:01:00.000Z' },
      { ...base, id: 'd', customer_id: 'c4', start_date: '2026-06-01', created_at: '2026-06-01T12:00:00Z', status: 'cancelled',
        cancellation_date: null, updated_at: '2026-11-10T02:00:00.000Z', cancellation_reason: 'Cancelou' },
    ];
    const today = businessDayOf(new Date());
    const panel = computeCoachPanel({ coachId: 'k1', contracts, plans, today });
    console.log(JSON.stringify({ today, shown: presentCoachPanel(panel, { customerNames: new Map([['c1','A'],['c2','B'],['c3','C'],['c4','D']]) }) }));
  `;
  const outputs = ['UTC', 'America/Sao_Paulo', 'Pacific/Auckland', 'America/Los_Angeles'].map(zone => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${zone}: ${result.stderr}`);
    return { zone, json: result.stdout.trim() };
  });
  const reference = JSON.parse(outputs[0].json);
  assert.equal(reference.today, '2026-11-09', 'today is the Brasília day, not the UTC day');
  for (const { zone, json } of outputs) assert.deepEqual(JSON.parse(json), reference, `${zone} gives the same panel`);
});
