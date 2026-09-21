import assert from 'node:assert/strict';
import test from 'node:test';

import { getContractMonthlyValue, getContractTotalValue, buildContractLifecycleRows } from './assessment-contract-lifecycle.js';
import { computeAssessmentMetrics, computeMrrHistory } from './assessment-metrics.js';
import { buildAssessmentYearlyIndicators } from './assessment-yearly-indicators.js';
import { buildAnalytics } from './analytics-metrics.js';

const NOW = new Date('2026-09-21T12:00:00');
const filters = { period: 'ytd', modality: 'all', plan: 'all', coach: 'all', gender: 'all', age: 'all' };
const plan = { id: 'plan', modality_id: 'modality', price_monthly: 200, price_total: 200, period_months: 1 };

function contract(overrides = {}) {
  return {
    id: 'contract', customer_id: 'student', plan_id: 'plan', coach_id: 'coach',
    status: 'active', payment_status: 'paid',
    start_date: '2026-01-01', end_date: '2027-01-01', created_at: '2026-01-01T12:00:00Z',
    plan_snapshot: { price_monthly: 200, price_total: 200, period_months: 1 },
    manual_discount: 0, enrollment_fee: 0, credit_balance: 0,
    ...overrides,
  };
}

const cases = [
  ['unchanged monthly price without discount', {}, 200],
  ['one-cycle discount', { manual_discount: 50, discount_recurring: false }, 150],
  ['recurring discount', { manual_discount: 50, discount_recurring: true }, 150],
  ['discount already included in the package total', { plan_snapshot: { price_monthly: 200, price_total: 1080, period_months: 6 } }, 180],
  ['annual package plus individual discount', { plan_snapshot: { price_monthly: 200, price_total: 2160, period_months: 12 }, manual_discount: 120 }, 170],
  ['custom two-month period', { plan_snapshot: { price_monthly: 200, price_total: 360, period_months: 2 }, manual_discount: 20 }, 170],
  ['numeric strings from legacy snapshots', { plan_snapshot: { price_monthly: '200', price_total: '1080', period_months: '6' }, manual_discount: '60' }, 170],
  ['zero-value service does not fall back to list price', { plan_snapshot: { price_monthly: 200, price_total: 0, period_months: 6 } }, 0],
  ['fully discounted service', { manual_discount: 200 }, 0],
  ['discount larger than service is clamped to zero', { manual_discount: 250, enrollment_fee: 100 }, 0],
  ['enrollment and existing credits do not change recurring revenue', { manual_discount: 50, enrollment_fee: 100, credit_balance: 40 }, 150],
  ['payment amount and refund are not the subscription price', { manual_discount: 50, manual_payment: true, payment_value: 999, refund_amount: 20 }, 150],
  ['billing installments are not the duration', { plan_snapshot: { price_monthly: 200, price_total: 1080, period_months: 6 }, installments: 3 }, 180],
  ['extended end date does not dilute the contracted term', { plan_snapshot: { price_monthly: 200, price_total: 1080, period_months: 6 }, original_end_date: '2026-07-01', end_date: '2026-10-01' }, 180],
  ['invalid discount cannot increase MRR', { manual_discount: -50 }, 200],
  ['non-finite discount cannot poison MRR', { manual_discount: Infinity }, 200],
];

for (const [name, overrides, expected] of cases) {
  test(`MRR uses sold value: ${name}`, () => {
    const row = contract(overrides);
    const before = structuredClone(row);
    assert.equal(getContractMonthlyValue(row), expected);
    assert.deepEqual(row, before);
  });
}

test('snapshot price and period take precedence over later catalog changes', () => {
  const row = contract({ plan_snapshot: { price_total: 1080, price_monthly: 200, period_months: 6 }, manual_discount: 60 });
  assert.equal(getContractMonthlyValue(row, { plan: { ...plan, price_total: 6000, price_monthly: 500, period_months: 12 } }), 170);
});

test('legacy period labels in a snapshot take precedence over the catalog duration', () => {
  for (const [period, months] of [['mensal', 1], ['trimestral', 3], ['semestral', 6], ['anual', 12]]) {
    const row = contract({ plan_snapshot: { price_total: 200 * months, price_monthly: 200, period }, manual_discount: 20 * months });
    assert.equal(getContractMonthlyValue(row, { plan: { ...plan, period_months: 12 } }), 180);
  }
});

test('contracts without snapshots use catalog total and term, not the list monthly price', () => {
  const row = contract({ plan_snapshot: null, manual_discount: 60 });
  assert.equal(getContractMonthlyValue(row, { plan: { ...plan, price_total: 1080, period_months: 6 } }), 170);
});

test('monthly-only legacy snapshots are not repriced using a newer catalog total', () => {
  const row = contract({ plan_snapshot: { price_monthly: 100, period: 'semestral' }, manual_discount: 60 });
  assert.equal(getContractMonthlyValue(row, { plan: { ...plan, price_total: 3000, period_months: 6 } }), 90);
});

test('missing legacy duration retains monthly basis instead of treating a package as one month', () => {
  const row = contract({ plan_snapshot: { price_total: 2400, price_monthly: 200 } });
  assert.equal(getContractMonthlyValue(row), 200);
  assert.equal(getContractMonthlyValue(contract({ plan_snapshot: null }), { plan: { price_monthly: 100 } }), 100);
});

test('invalid prices and periods have finite nonnegative fallbacks', () => {
  const row = contract({ plan_snapshot: { price_total: 'invalid', price_monthly: '', period_months: 0 }, manual_discount: 'invalid' });
  assert.equal(getContractMonthlyValue(row, { plan }), 200);
  assert.equal(getContractMonthlyValue(row), 0);
  assert.equal(getContractMonthlyValue(null), 0);
  assert.equal(getContractMonthlyValue(contract({ plan_snapshot: { price_monthly: 200, period: 'constructor' } })), 200);
});

test('fractional monthly values are not rounded before aggregation', () => {
  const row = contract({ plan_snapshot: { price_total: 100, period_months: 3 } });
  assert.equal(getContractMonthlyValue(row), 100 / 3);
  assert.equal(getContractMonthlyValue(row) * 3, 100);
  assert.equal(getContractMonthlyValue({ ...row, manual_discount: 0.01 }), 33.33);
});

test('new monthly metrics leave the financial contract total unchanged', () => {
  const row = contract({ manual_discount: 50, enrollment_fee: 100, credit_balance: 40 });
  assert.equal(getContractMonthlyValue(row), 150);
  assert.equal(getContractTotalValue(row), 210);
  const [enriched] = buildContractLifecycleRows([row]);
  assert.equal(enriched.monthly, 150);
  assert.equal(enriched.value, 210);
});

test('MRR and ticket use all active contracts but count each student only once', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [
    contract({ id: 'monthly', manual_discount: 50 }),
    contract({ id: 'semestral', plan_snapshot: { price_monthly: 200, price_total: 1080, period_months: 6 } }),
    contract({ id: 'other-student', customer_id: 'second-student' }),
  ];
  const result = computeAssessmentMetrics(rows, [plan]);
  assert.equal(result.mrr, 530);
  assert.equal(result.activeStudents, 2);
  assert.equal(result.activeContracts, 3);
  assert.equal(result.ticketMedio, 265);
});

test('discount correction does not change active, pending, leave or terminal status rules', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = ['active', 'overdue', 'on_leave', 'scheduled', 'draft', 'voided', 'finished', 'cancelled']
    .map(status => contract({ id: status, customer_id: status, status, payment_status: 'pending', manual_discount: 50 }));
  const result = computeAssessmentMetrics(rows, [plan]);
  assert.equal(result.activeContracts, 3);
  assert.equal(result.activeStudents, 3);
  assert.equal(result.mrr, 450);
  assert.equal(result.ticketMedio, 150);
});

test('zero-price active students do not become churn when a discount is applied', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const result = computeAssessmentMetrics([contract({ manual_discount: 200 })]);
  assert.equal(result.mrr, 0);
  assert.equal(result.ticketMedio, 0);
  assert.equal(result.activeStudents, 1);
  assert.equal(result.saidasNoMes, 0);
});

test('history and current MRR follow each renewal own discount without double counting', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const original = contract({ id: 'original', start_date: '2026-08-01', end_date: '2026-09-01', status: 'finished', manual_discount: 50, discount_recurring: false });
  const renewal = contract({ id: 'renewal', parent_contract_id: 'original', start_date: '2026-09-01', end_date: '2026-10-01', created_at: '2026-09-01T12:00:00Z' });
  const rows = [original, renewal];
  const history = computeMrrHistory(rows, [plan], 2);
  assert.deepEqual(history.map(row => row.mrr), [150, 200]);
  assert.equal(computeAssessmentMetrics(rows, [plan]).mrr, 200);
  const yearly = buildAssessmentYearlyIndicators(rows, [plan], { year: 2026, asOf: '2026-09-21' });
  assert.equal(yearly.months[7].mrr, 150);
  assert.equal(yearly.months[8].mrr, 200);
  assert.equal(yearly.summary.mrr, 200);
  const recurringRows = [original, { ...renewal, manual_discount: 50, discount_recurring: true }];
  assert.deepEqual(computeMrrHistory(recurringRows, [plan], 2).map(row => row.mrr), [150, 150]);
});

test('annual indicators use the same net package value as the current dashboard', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [contract({ plan_snapshot: { price_monthly: 200, price_total: 2160, period_months: 12 }, manual_discount: 120 })];
  const yearly = buildAssessmentYearlyIndicators(rows, [plan], { year: 2026, asOf: '2026-09-21' });
  assert.equal(yearly.summary.mrr, 170);
  assert.equal(yearly.summary.mrr, computeAssessmentMetrics(rows, [plan]).mrr);
  assert.ok(computeMrrHistory(rows, [plan], 6).every(row => row.mrr === 170));
});

test('Analytics shares net MRR and ticket without altering recorded cash or receivables', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const row = contract({ manual_discount: 50 });
  const data = {
    contracts: [row], plans: [plan], customers: [{ id: 'student', full_name: 'Fictitious Student' }],
    modalities: [{ id: 'modality', name: 'Fictitious Modality' }], coaches: [{ id: 'coach', name: 'Fictitious Coach' }],
    presaleOrders: [], stockOrders: [], eventRegistrations: [], prospectSubmissions: [], payoutItems: [],
    financialMovements: [
      { movement_id: 'receipt', order_type: 'contract', order_id: 'contract', movement_kind: 'receipt', is_actual: true, business_unit: 'assessoria', gross_amount: 150, net_amount: 145, fee_amount: 5, signed_net_amount: 145, occurred_on: '2026-09-01' },
      { movement_id: 'refund', order_type: 'contract', order_id: 'contract', movement_kind: 'refund', is_actual: true, business_unit: 'assessoria', gross_amount: 20, net_amount: 20, signed_net_amount: -20, occurred_on: '2026-09-02' },
      { movement_id: 'receivable', order_type: 'contract', order_id: 'contract', movement_kind: 'receivable', is_actual: false, business_unit: 'assessoria', gross_amount: 90, due_on: '2026-09-03' },
    ],
  };
  const before = structuredClone(data);
  const result = buildAnalytics(data, filters, NOW);
  assert.equal(result.summary.mrr, 150);
  assert.equal(result.summary.contractedTicket, 150);
  assert.equal(result.summary.receivedTicket, 125);
  assert.equal(result.summary.grossRevenue, 150);
  assert.equal(result.summary.netRevenue, 125);
  assert.equal(result.summary.refunded, 20);
  assert.equal(result.summary.fees, 5);
  assert.equal(result.summary.receivableAmount, 90);
  for (const breakdown of Object.values(result.breakdowns)) {
    assert.equal(breakdown[0].mrr, 150);
    assert.equal(breakdown[0].ticket, 150);
  }
  assert.equal(result.mrrHistory.length, 12);
  assert.ok(result.mrrHistory.every(month => month.mrr === (month.ym >= '2026-01' ? 150 : 0)));
  assert.deepEqual(data, before);
});

test('undiscounted monthly, quarterly, semiannual and annual contracts keep the same MRR', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [1, 3, 6, 12].map(months => contract({
    id: `term-${months}`, customer_id: `student-${months}`,
    plan_snapshot: { price_monthly: 200, price_total: 200 * months, period_months: months },
  }));
  const result = computeAssessmentMetrics(rows);
  assert.equal(result.mrr, 800);
  assert.equal(result.ticketMedio, 200);
  assert.equal(result.activeStudents, 4);
});

test('future renewals stay outside current MRR until activated, regardless of their discount', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const current = contract({ manual_discount: 50, end_date: '2026-10-01' });
  const scheduled = contract({ id: 'future', parent_contract_id: current.id, status: 'scheduled', start_date: '2026-10-01', manual_discount: 25 });
  const result = computeAssessmentMetrics([current, scheduled]);
  assert.equal(result.mrr, 150);
  assert.equal(result.activeContracts, 1);
  assert.equal(result.ticketMedio, 150);
});

test('changing only the payment schedule does not change any recurring metric', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const row = contract({ plan_snapshot: { price_monthly: 200, price_total: 1080, period_months: 6 }, manual_discount: 60 });
  for (const installments of [1, 3, 6, 12]) {
    const result = computeAssessmentMetrics([{ ...row, installments }]);
    assert.equal(result.mrr, 170);
    assert.equal(result.ticketMedio, 170);
  }
});

test('current history uses today, not a future month-end projection', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [contract({ end_date: '2026-09-25', manual_discount: 50 })];
  const current = computeAssessmentMetrics(rows).mrr;
  assert.equal(current, 150);
  assert.equal(computeMrrHistory(rows, [], 2).at(-1).mrr, current);
  assert.equal(buildAssessmentYearlyIndicators(rows, [], { year: 2026, asOf: '2026-09-21' }).summary.mrr, current);
});

test('current graphs retain operational contracts awaiting renewal, including open payments', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [contract({ status: 'overdue', payment_status: 'awaiting_charge', end_date: '2026-09-20', manual_discount: 50 })];
  const current = computeAssessmentMetrics(rows).mrr;
  assert.equal(current, 150);
  assert.equal(computeMrrHistory(rows, [], 2).at(-1).mrr, current);
  assert.equal(buildAssessmentYearlyIndicators(rows, [], { year: 2026, asOf: '2026-09-21' }).summary.mrr, current);
});

test('future starts cannot count as current MRR even with a legacy active status', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [contract({ start_date: '2026-09-25', manual_discount: 50 })];
  assert.equal(computeAssessmentMetrics(rows).mrr, 0);
  assert.equal(computeAssessmentMetrics(rows).activeStudents, 0);
  assert.equal(computeMrrHistory(rows, [], 2).at(-1).mrr, 0);
  assert.equal(buildAssessmentYearlyIndicators(rows, [], { year: 2026, asOf: '2026-09-21' }).summary.mrr, 0);
});

test('closed-month graphs agree on end-date boundaries and exclude unfulfilled cancelled sales', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [
    contract({ id: 'old', status: 'finished', end_date: '2026-08-31', manual_discount: 50 }),
    contract({ id: 'renewal', parent_contract_id: 'old', start_date: '2026-08-31', manual_discount: 25 }),
    contract({ id: 'unfulfilled', customer_id: 'unfulfilled', status: 'cancelled', payment_status: 'awaiting_charge', cancellation_date: '2026-09-01' }),
  ];
  const yearly = buildAssessmentYearlyIndicators(rows, [], { year: 2026, asOf: '2026-09-21' });
  assert.equal(yearly.months[7].mrr, 175);
  assert.equal(computeMrrHistory(rows, [], 2)[0].mrr, yearly.months[7].mrr);
});

test('effective-date guard includes the first day without mutating the stored contract', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const status of ['active', 'overdue', 'on_leave']) {
    const row = contract({ status, start_date: '2026-09-21', manual_discount: 50 });
    const before = structuredClone(row);
    assert.equal(buildContractLifecycleRows([row], { today: '2026-09-20' })[0].lifecycle.counts.mrr, false);
    assert.equal(buildContractLifecycleRows([row], { today: '2026-09-21' })[0].lifecycle.counts.mrr, true);
    assert.equal(computeAssessmentMetrics([row]).mrr, 150);
    assert.deepEqual(row, before);
  }
});

test('unknown customer IDs do not create phantom students in the ticket denominator', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const result = computeAssessmentMetrics([contract({ manual_discount: 50 }), contract({ id: 'legacy', customer_id: null, manual_discount: 50 })]);
  assert.equal(result.mrr, 300);
  assert.equal(result.activeStudents, 1);
  assert.equal(result.ticketMedio, 300);
});
