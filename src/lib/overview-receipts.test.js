import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYearReceipts, RECEIPT_MONTH_STATE, dedupeMovements, selectMonthReceipts } from './overview-receipts.js';

// Valores e datas fictícios. Hoje = 2026-11-10 (mês corrente parcial).
const NOW = new Date(2026, 10, 10, 12);
const COVERED = '2026-01-05';

const receipt = (id, net, date, extra = {}) => ({
  movement_id: id, movement_kind: 'receipt', is_actual: true, cash_direction: 'inflow',
  gross_amount: net + 3, net_amount: net, fee_amount: 3, signed_net_amount: net, occurred_on: date, scheduled_on: date, ...extra,
});
const other = (id, kind, amount, date) => ({
  movement_id: id, movement_kind: kind, is_actual: true, cash_direction: 'outflow',
  gross_amount: amount, net_amount: amount, fee_amount: 0, signed_net_amount: -amount, occurred_on: date, scheduled_on: date,
});
const build = (movements, extra = {}) => buildYearReceipts(movements, { year: 2026, now: NOW, coverageFrom: COVERED, ...extra });
const month = (data, ym) => data.months.find(row => row.ym === ym);

test('a received amount already net of the fee is not discounted again', () => {
  const october = month(build([receipt('r1', 97, '2026-10-05')]), '2026-10');
  assert.equal(october.received, 97);
  assert.equal(october.receiptCount, 1);
});

test('outflows, refunds, payouts and adjustments never enter or reduce the received amount', () => {
  const october = month(build([
    receipt('r1', 100, '2026-10-05'),
    other('e1', 'expense', 20, '2026-10-06'),
    other('f1', 'refund', 30, '2026-10-20'),
    other('p1', 'payout', 500, '2026-10-21'),
    other('a1', 'payout_adjustment', 15, '2026-10-22'),
  ]), '2026-10');
  assert.equal(october.received, 100);
  assert.equal(october.receiptCount, 1);
  assert.ok(!('outflows' in october) && !('result' in october), 'the month exposes no outflow or result field');
});

test('a month with only outflows is a confirmed zero of receipts, not a negative number', () => {
  const october = month(build([other('p1', 'payout', 500, '2026-10-21')]), '2026-10');
  assert.equal(october.received, 0);
});

test('the same movement_id counts once, different ids with the same value and date both count', () => {
  const twice = [receipt('same', 50, '2026-10-05'), receipt('same', 50, '2026-10-05')];
  assert.equal(dedupeMovements(twice).length, 1);
  assert.equal(month(build(twice), '2026-10').received, 50);
  const distinct = [receipt('a', 50, '2026-10-05'), receipt('b', 50, '2026-10-05')];
  assert.equal(month(build(distinct), '2026-10').received, 100);
  assert.equal(month(build(distinct), '2026-10').receiptCount, 2);
});

test('the current month is partial, future months have no value and covered empty months are a confirmed zero', () => {
  const data = build([receipt('r1', 40, '2026-11-02')]);
  assert.equal(month(data, '2026-11').state, RECEIPT_MONTH_STATE.PARTIAL);
  assert.equal(month(data, '2026-11').received, 40);
  assert.equal(month(data, '2026-12').state, RECEIPT_MONTH_STATE.FUTURE);
  assert.equal(month(data, '2026-12').received, null);
  assert.equal(month(data, '2026-03').state, RECEIPT_MONTH_STATE.REALIZED);
  assert.equal(month(data, '2026-03').received, 0, 'covered month without receipts is zero, not missing');
});

test('months before the first known receipt have insufficient history, not zero', () => {
  const data = build([receipt('r1', 40, '2026-10-02')], { coverageFrom: '2026-09-15' });
  assert.equal(month(data, '2026-08').state, RECEIPT_MONTH_STATE.INSUFFICIENT);
  assert.equal(month(data, '2026-08').received, null);
  assert.equal(month(data, '2026-09').state, RECEIPT_MONTH_STATE.REALIZED);
});

test('without any known coverage nothing is presented as realized', () => {
  const data = build([], { coverageFrom: null });
  assert.ok(data.months.filter(row => row.monthIndex <= 10).every(row => row.state === RECEIPT_MONTH_STATE.INSUFFICIENT));
});

test('a previous year is read from its own receipts', () => {
  const data = buildYearReceipts([receipt('r1', 70, '2025-06-10')], { year: 2025, now: NOW, coverageFrom: '2025-01-02' });
  assert.equal(month(data, '2025-06').received, 70);
  assert.ok(data.months.every(row => row.state !== RECEIPT_MONTH_STATE.FUTURE));
});

test('the accumulated amount sums the realized and partial months only', () => {
  const data = build([receipt('r1', 100, '2026-09-05'), receipt('r2', 10, '2026-11-05'), receipt('r3', 5, '2026-12-05')]);
  assert.equal(data.accumulated, 110);
  assert.equal(data.realizedMonths, 11);
});

test('receipts that are not realized are ignored and the truncation flag is kept', () => {
  const open = { movement_id: 'x', movement_kind: 'receivable', is_actual: false, net_amount: 999, occurred_on: '2026-10-05', due_on: '2026-10-05' };
  const notActual = receipt('y', 888, '2026-10-05', { is_actual: false });
  const data = build([open, notActual], { truncated: true });
  assert.equal(month(data, '2026-10').received, 0);
  assert.equal(data.truncated, true);
});

test('the month detail lists only the receipts of that month, newest first', () => {
  const list = selectMonthReceipts([
    receipt('a', 10, '2026-10-02'), receipt('b', 20, '2026-10-20'), receipt('c', 5, '2026-09-30'),
    other('e1', 'expense', 7, '2026-10-10'),
  ], '2026-10');
  assert.deepEqual(list.map(item => item.movement_id), ['b', 'a']);
});
