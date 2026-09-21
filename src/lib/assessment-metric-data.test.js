import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { loadAssessmentMetricContracts, loadAssessmentMetricPlans } from './assessment-metric-data.js';
import { computeAssessmentMetrics, computeMrrHistory } from './assessment-metrics.js';
import { buildContractLifecycleRows, summarizeContractLifecycle } from './assessment-contract-lifecycle.js';
import { buildAssessmentYearlyIndicators } from './assessment-yearly-indicators.js';
import { buildAnalytics } from './analytics-metrics.js';

const NOW = new Date('2026-09-21T12:00:00');
const plan = { id: 'plan', modality_id: 'modality', price_monthly: 200, price_total: 1080, period_months: 6 };

function contract(overrides = {}) {
  return {
    id: 'contract', customer_id: 'student', plan_id: 'plan', coach_id: 'coach',
    status: 'active', payment_status: 'paid',
    start_date: '2026-01-01', end_date: '2027-01-01', created_at: '2026-01-01T12:00:00Z',
    plan_snapshot: { price_total: 200, price_monthly: 200, period_months: 1 },
    manual_discount: 50,
    ...overrides,
  };
}

// Exercise the real Supabase query builder against a network-free REST stub.
function database(tables, { cap = 1000, failTable, failAfter = 0 } = {}) {
  const requests = [];
  const client = createClient('https://metrics.example.test', 'fictitious-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, 'https://metrics.example.test');
        assert.equal(init.method, 'GET');
        const table = url.pathname.split('/').at(-1);
        const query = url.searchParams;
        requests.push({ table, query });
        if (table === failTable && requests.filter(request => request.table === table).length > failAfter) {
          return new Response(JSON.stringify({ message: 'Read denied', code: '42501' }), { status: 403 });
        }
        assert.equal(query.get('order'), 'id.asc');
        let rows = structuredClone(tables[table] || []);
        if (query.has('id')) rows = rows.filter(row => row.id > query.get('id').slice(3));
        if (query.has('customer_id')) rows = rows.filter(row => row.customer_id === query.get('customer_id').slice(3));
        rows.sort((a, b) => a.id.localeCompare(b.id));
        rows = rows.slice(0, Math.min(cap, Number(query.get('limit'))));
        const selected = query.get('select');
        if (selected !== '*') {
          rows = rows.map(row => Object.fromEntries(selected.split(',').map(field => [field, row[field]])));
        }
        return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  return { client, requests };
}

test('metric reads preserve discounts, terms, snapshots and lifecycle evidence', async () => {
  const row = contract({ payment_date: '2026-09-01', manual_payment: true, due_date: '2026-09-01', refund_amount: 0, cancellation_fee: 0 });
  const { client, requests } = database({ assessment_contracts: [row], assessment_plans: [plan] });
  const contracts = await loadAssessmentMetricContracts(client);
  const plans = await loadAssessmentMetricPlans(client);
  assert.deepEqual(contracts, [row]);
  assert.deepEqual(plans, [plan]);
  assert.ok(requests.every(request => request.query.get('select') === '*'));
  assert.equal(computeAssessmentMetrics(contracts, plans).mrr, 150);
});

test('loaded legacy contracts use the full catalog term and total after discounts', async () => {
  const { client } = database({ assessment_contracts: [contract({ plan_snapshot: null, manual_discount: 60 })], assessment_plans: [plan] });
  const contracts = await loadAssessmentMetricContracts(client);
  const plans = await loadAssessmentMetricPlans(client);
  assert.equal(computeAssessmentMetrics(contracts, plans).mrr, 170);
});

for (const count of [0, 1000, 1001, 2001]) {
  test(`loads all ${count} contracts without truncation or duplicate rows`, async () => {
    const rows = Array.from({ length: count }, (_, index) => contract({ id: String(index).padStart(5, '0') }));
    const { client } = database({ assessment_contracts: rows });
    const result = await loadAssessmentMetricContracts(client);
    assert.equal(result.length, count);
    assert.equal(new Set(result.map(row => row.id)).size, count);
    assert.equal(computeAssessmentMetrics(result).mrr, count * 150);
  });
}

test('a server page cap below the requested limit cannot silently truncate metrics', async () => {
  const rows = Array.from({ length: 23 }, (_, index) => contract({ id: String(index).padStart(3, '0') }));
  const { client, requests } = database({ assessment_contracts: rows }, { cap: 7 });
  assert.equal((await loadAssessmentMetricContracts(client)).length, 23);
  assert.equal(requests.length, 5);
});

test('customer-scoped reads preserve their filter across pages and newest-first order', async () => {
  const rows = [
    contract({ id: 'a', customer_id: 'one', created_at: '2026-01-01' }),
    contract({ id: 'b', customer_id: 'two', created_at: '2026-02-01' }),
    contract({ id: 'c', customer_id: 'one', created_at: '2026-03-01' }),
  ];
  const { client, requests } = database({ assessment_contracts: rows }, { cap: 1 });
  assert.deepEqual((await loadAssessmentMetricContracts(client, 'one')).map(row => row.id), ['c', 'a']);
  assert.ok(requests.every(request => request.query.get('customer_id') === 'eq.one'));
});

for (const table of ['assessment_contracts', 'assessment_plans']) {
  test(`a failed ${table} read rejects instead of calculating zero or a partial MRR`, async () => {
    const { client } = database({ [table]: [contract()] }, { cap: 1, failTable: table, failAfter: 1 });
    const load = table === 'assessment_contracts' ? loadAssessmentMetricContracts : loadAssessmentMetricPlans;
    await assert.rejects(load(client), error => error.code === '42501');
  });
}

test('loaded data agrees across current KPIs, audit, individual portfolios, Analytics and both histories', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [
    contract({ id: 'monthly', end_date: '2026-09-25' }),
    contract({ id: 'annual', customer_id: 'second', plan_snapshot: { price_total: 2160, period_months: 12 }, manual_discount: 120 }),
    contract({ id: 'legacy', customer_id: 'third', plan_snapshot: null, manual_discount: 60, payment_status: 'awaiting_charge', status: 'overdue', end_date: '2026-09-20' }),
    ...['draft', 'scheduled', 'voided', 'finished', 'cancelled'].map(status => contract({ id: status, customer_id: status, status, cancellation_date: '2026-09-10' })),
    contract({ id: 'future', customer_id: 'future', start_date: '2026-09-25' }),
  ];
  const { client } = database({ assessment_contracts: rows, assessment_plans: [plan] });
  const contracts = await loadAssessmentMetricContracts(client);
  const plans = await loadAssessmentMetricPlans(client);
  const before = structuredClone({ contracts, plans });
  const metrics = computeAssessmentMetrics(contracts, plans);
  const lifecycle = buildContractLifecycleRows(contracts, { plansById: { plan } });
  const audit = summarizeContractLifecycle(lifecycle);
  const portfolioTotal = lifecycle.filter(row => row.lifecycle.counts.active).reduce((total, row) => total + row.monthly, 0);
  const yearly = buildAssessmentYearlyIndicators(contracts, plans, { year: 2026, asOf: '2026-09-21' });
  const analytics = buildAnalytics({
    contracts, plans, customers: [], modalities: [], coaches: [],
    financialMovements: [], presaleOrders: [], stockOrders: [], eventRegistrations: [], prospectSubmissions: [], payoutItems: [],
  }, { period: 'ytd', modality: 'all', plan: 'all', coach: 'all', gender: 'all', age: 'all' }, NOW);
  assert.equal(metrics.mrr, 490);
  for (const value of [audit.mrr, portfolioTotal, yearly.summary.mrr, analytics.summary.mrr, analytics.mrrHistory.at(-1).mrr, computeMrrHistory(contracts, plans).at(-1).mrr]) {
    assert.equal(value, metrics.mrr);
  }
  assert.equal(metrics.activeStudents, 3);
  assert.equal(analytics.summary.contractedTicket, metrics.ticketMedio);
  assert.equal(analytics.summary.estimatedLtv, metrics.ticketMedio / (analytics.summary.monthlyChurn / 100));
  assert.equal(metrics.ltv, metrics.ticketMedio / (metrics.churnRate / 100));
  assert.equal(analytics.summary.netRevenue, 0);
  assert.deepEqual({ contracts, plans }, before);
});
