import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOpenSales } from './overview-overdue.js';
import { buildAttentionGroups } from './overview-attention.js';

const TODAY = '2026-11-10';
// Linhas fictícias no formato da lista de Cobranças.
const row = (id, value, due, extra = {}) => ({
  id, type: 'contract', order_number: `ASS-${id}`, customer: `Pessoa ${id}`, customer_id: `c${id}`,
  total_value: value, due_date: due, ...extra,
});

test('overdue means a due date before today; today is "vence hoje"; no date is its own bucket', () => {
  const summary = summarizeOpenSales([
    row('1', 100, '2026-11-09'),
    row('2', 50, '2026-11-10'),
    row('3', 70, null),
    row('4', 30, '2026-12-01'),
  ], TODAY);
  assert.equal(summary.overdue.count, 1);
  assert.equal(summary.overdue.total, 100);
  assert.equal(summary.dueToday.count, 1);
  assert.equal(summary.noDueDate.count, 1);
  assert.equal(summary.noDueDate.total, 70, 'no date is never presumed late');
});

test('carnê 3x100: one paid, one overdue, one future gives 100 overdue and 200 open', () => {
  // A parcela paga já saiu da lista; o contrato inteiro (300) não soma junto com as parcelas.
  const parcels = [
    row('9', 100, '2026-11-01', { is_carne_parcel: true }),
    row('9', 100, '2026-12-01', { is_carne_parcel: true }),
  ];
  const summary = summarizeOpenSales(parcels, TODAY);
  assert.equal(summary.overdue.total, 100);
  assert.equal(summary.overdue.count, 1);
  const open = summary.overdue.total + summary.dueToday.total + summary.noDueDate.total + 100;
  assert.equal(open, 200);
});

test('two overdue parcels of the same person are two obligations and one person', () => {
  const summary = summarizeOpenSales([
    row('1', 100, '2026-10-10', { is_carne_parcel: true }),
    row('1', 100, '2026-11-02', { is_carne_parcel: true }),
  ], TODAY);
  assert.equal(summary.overdue.count, 2);
  assert.equal(summary.overdue.people, 1);
  assert.equal(summary.overdue.total, 200);
});

test('people without an id are told apart by phone and then by name', () => {
  const summary = summarizeOpenSales([
    { id: 'a', total_value: 10, due_date: '2026-11-01', customer: 'Fulano', customer_whatsapp: '(43) 99999-0001' },
    { id: 'b', total_value: 10, due_date: '2026-11-01', customer: 'Fulano Outro', customer_whatsapp: '43999990001' },
    { id: 'c', total_value: 10, due_date: '2026-11-01', customer: 'Sicrano' },
  ], TODAY);
  assert.equal(summary.overdue.people, 2);
});

test('zero or empty values are not obligations and cents add up exactly', () => {
  const summary = summarizeOpenSales([row('1', 0, '2026-11-01'), row('2', 10.1, '2026-11-01'), row('3', 20.2, '2026-11-02')], TODAY);
  assert.equal(summary.overdue.count, 2);
  assert.equal(summary.overdue.total, 30.3);
});

test('the attention strip has at most four groups, ordered by consequence, with sourced wording', () => {
  const groups = buildAttentionGroups({
    overdue: { count: 7, people: 6, total: 1850 },
    refunds: 1,
    renewalCharges: 2,
    contacts: 25,
  });
  assert.deepEqual(groups.map(group => group.id), ['overdue', 'refunds', 'renewals', 'contacts']);
  assert.equal(groups[0].label, '7 cobranças em atraso');
  assert.equal(groups[0].detail, '6 pessoas');
  assert.equal(groups[1].label, '1 estorno pendente');
});

test('groups with nothing to do are left out and nothing invents a score', () => {
  assert.deepEqual(buildAttentionGroups({ overdue: { count: 0, people: 0, total: 0 }, refunds: 0, renewalCharges: 0, contacts: 0 }), []);
  const only = buildAttentionGroups({ contacts: 3 });
  assert.equal(only.length, 1);
  assert.equal(only[0].to, '/comunicacao');
});
