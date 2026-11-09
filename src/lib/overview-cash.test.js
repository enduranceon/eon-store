import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYearCash, CASH_MONTH_STATE, dedupeMovements, selectMonthMovements } from './overview-cash.js';

// Valores e datas fictícios. Hoje = 2026-11-10 (mês corrente parcial).
const NOW = new Date(2026, 10, 10, 12);
const COVERED = '2026-01-05';

const receipt = (id, net, date, extra = {}) => ({
  movement_id: id, movement_kind: 'receipt', is_actual: true, cash_direction: 'inflow',
  gross_amount: net + 3, net_amount: net, fee_amount: 3, signed_net_amount: net, occurred_on: date, scheduled_on: date, ...extra,
});
const outflow = (id, kind, amount, date) => ({
  movement_id: id, movement_kind: kind, is_actual: true, cash_direction: 'outflow',
  gross_amount: amount, net_amount: amount, fee_amount: 0, signed_net_amount: -amount, occurred_on: date, scheduled_on: date,
});
const adjustment = (id, signed, date) => ({
  movement_id: id, movement_kind: 'payout_adjustment', is_actual: true,
  cash_direction: signed >= 0 ? 'inflow' : 'outflow',
  gross_amount: Math.abs(signed), net_amount: Math.abs(signed), fee_amount: 0, signed_net_amount: signed, occurred_on: date, scheduled_on: date,
});
const build = (movements, extra = {}) => buildYearCash(movements, { year: 2026, now: NOW, coverageFrom: COVERED, ...extra });
const month = (cash, ym) => cash.months.find(row => row.ym === ym);

test('a received amount already net of the fee is not discounted again', () => {
  const cash = build([receipt('r1', 97, '2026-10-05'), outflow('e1', 'expense', 20, '2026-10-06')]);
  const october = month(cash, '2026-10');
  assert.equal(october.received, 97);
  assert.equal(october.outflows, 20);
  assert.equal(october.result, 77);
  assert.equal(october.reconciles, true);
});

test('a positive adjustment shows up on its own and the bars add up to the result', () => {
  const cash = build([receipt('r1', 100, '2026-10-05'), adjustment('a1', 10, '2026-10-07'), outflow('e1', 'expense', 20, '2026-10-08')]);
  const october = month(cash, '2026-10');
  assert.equal(october.positiveAdjustments, 10);
  assert.equal(october.result, 90);
  assert.equal(october.received + october.positiveAdjustments - october.outflows, october.result);
});

test('a negative adjustment is an outflow', () => {
  const october = month(build([receipt('r1', 100, '2026-10-05'), adjustment('a1', -15, '2026-10-07')]), '2026-10');
  assert.equal(october.outflows, 15);
  assert.equal(october.positiveAdjustments, 0);
  assert.equal(october.result, 85);
});

test('a refund in the month is an outflow and the original receipt stays', () => {
  const october = month(build([receipt('r1', 100, '2026-10-05'), outflow('f1', 'refund', 30, '2026-10-20')]), '2026-10');
  assert.equal(october.received, 100);
  assert.equal(october.outflows, 30);
  assert.equal(october.result, 70);
});

test('a payout of October paid in November belongs to November', () => {
  const cash = build([outflow('p1', 'payout', 500, '2026-11-03')]);
  assert.equal(month(cash, '2026-11').outflows, 500);
  assert.equal(month(cash, '2026-10').outflows, 0);
});

test('the same movement_id counts once, different ids with the same value and date both count', () => {
  const twice = [receipt('same', 50, '2026-10-05'), receipt('same', 50, '2026-10-05')];
  assert.equal(dedupeMovements(twice).length, 1);
  assert.equal(month(build(twice), '2026-10').received, 50);
  const distinct = [receipt('a', 50, '2026-10-05'), receipt('b', 50, '2026-10-05')];
  assert.equal(month(build(distinct), '2026-10').received, 100);
});

test('the current month is partial, future months have no value and covered empty months are a confirmed zero', () => {
  const cash = build([receipt('r1', 40, '2026-11-02')]);
  assert.equal(month(cash, '2026-11').state, CASH_MONTH_STATE.PARTIAL);
  assert.equal(month(cash, '2026-11').received, 40);
  assert.equal(month(cash, '2026-12').state, CASH_MONTH_STATE.FUTURE);
  assert.equal(month(cash, '2026-12').received, null);
  assert.equal(month(cash, '2026-03').state, CASH_MONTH_STATE.REALIZED);
  assert.equal(month(cash, '2026-03').received, 0, 'covered month without movements is zero, not missing');
});

test('months before the first known movement have insufficient history, not zero', () => {
  const cash = build([receipt('r1', 40, '2026-10-02')], { coverageFrom: '2026-09-15' });
  assert.equal(month(cash, '2026-08').state, CASH_MONTH_STATE.INSUFFICIENT);
  assert.equal(month(cash, '2026-08').result, null);
  assert.equal(month(cash, '2026-09').state, CASH_MONTH_STATE.REALIZED);
});

test('without any known coverage nothing is presented as realized', () => {
  const cash = build([], { coverageFrom: null });
  assert.ok(cash.months.filter(row => row.monthIndex <= 10).every(row => row.state === CASH_MONTH_STATE.INSUFFICIENT));
});

test('a previous year is read from its own movements', () => {
  const cash = buildYearCash([receipt('r1', 70, '2025-06-10')], { year: 2025, now: NOW, coverageFrom: '2025-01-02' });
  assert.equal(month(cash, '2025-06').received, 70);
  assert.ok(cash.months.every(row => row.state !== CASH_MONTH_STATE.FUTURE));
});

test('the accumulated result sums the realized and partial months only', () => {
  const cash = build([receipt('r1', 100, '2026-09-05'), outflow('e1', 'expense', 40, '2026-10-05'), receipt('r2', 10, '2026-11-05')]);
  assert.equal(cash.accumulated, 70);
  assert.equal(cash.realizedMonths, 11);
});

test('movements that are not realized are ignored and the truncation flag is kept', () => {
  const open = { movement_id: 'x', movement_kind: 'receivable', is_actual: false, net_amount: 999, occurred_on: '2026-10-05', due_on: '2026-10-05' };
  const cash = build([open], { truncated: true });
  assert.equal(month(cash, '2026-10').received, 0);
  assert.equal(cash.truncated, true);
});

test('the month detail lists the movements of that month, newest first', () => {
  const list = selectMonthMovements([receipt('a', 10, '2026-10-02'), receipt('b', 20, '2026-10-20'), receipt('c', 5, '2026-09-30')], '2026-10');
  assert.deepEqual(list.map(item => item.movement_id), ['b', 'a']);
});
