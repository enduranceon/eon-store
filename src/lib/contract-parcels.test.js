import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carneProgressLabel,
  parcelMessage,
  parcelsSummary,
  parcelState,
} from './contract-parcels.js';

// Carnê fictício de R$ 600 em 3 parcelas.
const today = '2026-11-12';
const parcel = (number, extra = {}) => ({
  installment_number: number,
  total_installments: 3,
  value: 200,
  due_date: `2026-${10 + number}-10`,
  asaas_status: 'PENDING',
  payment_row_id: null,
  paid_date: null,
  invoice_url: `https://www.asaas.com/i/aaa${number}`,
  ...extra,
});

test('a recorded parcel is paid, with the day it was paid', () => {
  const state = parcelState(parcel(1, { payment_row_id: 'row', paid_date: '2026-11-05', asaas_status: 'CONFIRMED' }), today);
  assert.deepEqual([state.key, state.tone, state.label], ['recorded', 'success', 'Paga em 05/11']);
});

test('paid in Asaas but not recorded asks for the registration', () => {
  const state = parcelState(parcel(1, { asaas_status: 'RECEIVED' }), today);
  assert.equal(state.key, 'paid_unrecorded');
  assert.match(state.label, /falta registrar/);
});

test('late, due today and upcoming parcels', () => {
  assert.equal(parcelState(parcel(1, { due_date: '2026-11-10' }), today).label, 'Vencida há 2 dias');
  assert.equal(parcelState(parcel(1, { due_date: '2026-11-11' }), today).label, 'Vencida há 1 dia');
  assert.equal(parcelState(parcel(1, { due_date: '2026-11-12' }), today).key, 'due_today');
  assert.equal(parcelState(parcel(2, { due_date: '2026-12-10' }), today).label, 'Vence em 10/12');
});

test('parcels removed or refunded in Asaas are flagged, not counted as late', () => {
  assert.equal(parcelState(parcel(1, { asaas_status: 'DELETED', due_date: '2026-10-01' }), today).key, 'deleted');
  assert.equal(parcelState(parcel(1, { asaas_status: 'REFUNDED' }), today).key, 'refunded');
});

test('summary counts recorded value, balance, late parcels and the next open one', () => {
  const summary = parcelsSummary([
    parcel(3, { due_date: '2027-01-10' }),
    parcel(1, { payment_row_id: 'row', paid_date: '2026-11-05', asaas_status: 'CONFIRMED', due_date: '2026-11-10' }),
    parcel(2, { due_date: '2026-11-11' }),
  ], today);
  assert.equal(summary.total, 3);
  assert.equal(summary.recorded, 1);
  assert.equal(summary.recordedValue, 200);
  assert.equal(summary.balance, 400);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.nextOpen.installment_number, 2);
});

test('summary of a closed carnê has no balance and no next parcel', () => {
  const closed = [1, 2, 3].map(n => parcel(n, { payment_row_id: `row${n}`, asaas_status: 'CONFIRMED' }));
  const summary = parcelsSummary(closed, today);
  assert.equal(summary.complete, true);
  assert.equal(summary.balance, 0);
  assert.equal(summary.nextOpen, null);
});

test('progress text for an open and a closed carnê', () => {
  const open = parcelsSummary([
    parcel(1, { payment_row_id: 'a', value: 195 }),
    parcel(2, { payment_row_id: 'b', value: 195 }),
    parcel(3, { value: 195 }),
  ], today);
  assert.equal(carneProgressLabel(open), '2 de 3 parcelas pagas · R$ 390,00 de R$ 585,00 · saldo R$ 195,00');
  const closed = parcelsSummary([1, 2].map(n => parcel(n, { payment_row_id: `r${n}`, value: 300 })), today);
  assert.equal(carneProgressLabel(closed), '2 de 2 parcelas pagas · R$ 600,00 de R$ 600,00');
});

test('the message carries number, value, due day and the link of that parcel', () => {
  assert.equal(
    parcelMessage({ firstName: 'Ana', parcel: parcel(2, { due_date: '2026-12-10' }) }),
    'Oi, Ana! Segue o link da parcela 2/3 (R$ 200,00, vence em 10/12): https://www.asaas.com/i/aaa2',
  );
});
