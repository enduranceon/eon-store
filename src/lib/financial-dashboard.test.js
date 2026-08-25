import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFinancialDashboard,
  getFinancialDashboardPeriod,
  summarizeFinancialMovements,
} from './financial-dashboard.js';

const now = new Date('2026-08-25T12:00:00');

const movements = [
  { movement_id: 'receipt-store', movement_kind: 'receipt', is_actual: true, business_unit: 'loja', gross_amount: 100, net_amount: 96, fee_amount: 4, signed_net_amount: 96, occurred_on: '2026-08-03' },
  { movement_id: 'receipt-event', movement_kind: 'receipt', is_actual: true, business_unit: 'eventos', gross_amount: 40, net_amount: 40, fee_amount: 0, signed_net_amount: 40, occurred_on: '2026-08-04' },
  { movement_id: 'refund-store', movement_kind: 'refund', is_actual: true, business_unit: 'loja', gross_amount: 10, net_amount: 10, signed_net_amount: -10, occurred_on: '2026-08-05' },
  { movement_id: 'expense-event', movement_kind: 'expense', is_actual: true, business_unit: 'eventos', gross_amount: 15, net_amount: 15, signed_net_amount: -15, occurred_on: '2026-08-06' },
  { movement_id: 'payout', movement_kind: 'payout', is_actual: true, business_unit: 'assessoria', gross_amount: 20, net_amount: 20, signed_net_amount: -20, occurred_on: '2026-08-07' },
  { movement_id: 'overdue', movement_kind: 'receivable', is_actual: false, business_unit: 'loja', gross_amount: 80, due_on: '2026-08-20' },
  { movement_id: 'due-soon', movement_kind: 'receivable', is_actual: false, business_unit: 'assessoria', gross_amount: 50, due_on: '2026-08-28' },
];

test('summarizes actual cash, fees and outstanding receivables by the same ledger rules', () => {
  const summary = summarizeFinancialMovements(movements, { now });

  assert.equal(summary.grossReceipts, 140);
  assert.equal(summary.netReceipts, 136);
  assert.equal(summary.fees, 4);
  assert.equal(summary.refunds, 10);
  assert.equal(summary.expenses, 15);
  assert.equal(summary.payouts, 20);
  assert.equal(summary.operatingResult, 91);
  assert.equal(summary.openReceivables, 130);
  assert.equal(summary.overdueReceivables, 80);
  assert.equal(summary.dueSoonReceivables, 50);
  assert.equal(summary.byUnit.eventos.operatingResult, 25);
});

test('builds the management dashboard for a bounded period without dropping open receivables', () => {
  const dashboard = buildFinancialDashboard(movements, { period: 'month', now });

  assert.equal(dashboard.period.from, '2026-08-01');
  assert.equal(dashboard.summary.actualMovementCount, 5);
  assert.equal(dashboard.summary.openReceivables, 130);
  assert.equal(dashboard.recentMovements.length, 5);
  assert.equal(dashboard.monthlySeries.length, 1);
  assert.equal(dashboard.monthlySeries[0].result, 91);
});

test('uses local calendar boundaries for management periods', () => {
  assert.deepEqual(getFinancialDashboardPeriod('30d', now), {
    value: '30d',
    label: 'Ultimos 30 dias',
    from: '2026-07-27',
    to: '2026-08-25',
  });
});
