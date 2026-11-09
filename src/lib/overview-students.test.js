import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverviewStudents } from './overview-students.js';

// Contratos fictícios. Hoje = 2026-11-10.
const TODAY = '2026-11-10';
const modalities = [
  { id: 'm-run', name: 'Corrida' },
  { id: 'm-tri', name: 'Triathlon' },
  { id: 'm-two', name: '2 Modalidades' },
];
const plans = [
  { id: 'p-run', modality_id: 'm-run', name: 'Corrida trimestral', price_monthly: 200, price_total: 600, period_months: 3 },
  { id: 'p-tri', modality_id: 'm-tri', name: 'Triathlon mensal', price_monthly: 400, price_total: 400, period_months: 1 },
  { id: 'p-two', modality_id: 'm-two', name: 'Duas modalidades', price_monthly: 500, price_total: 500, period_months: 1 },
];
const customers = [
  { id: 'c1', full_name: 'Ana Teste' },
  { id: 'c2', full_name: 'Bruno Teste' },
  { id: 'c3', full_name: 'Carla Teste' },
];
const contract = (id, customerId, planId, extra = {}) => ({
  id,
  contract_number: `ASS-${id}`,
  customer_id: customerId,
  plan_id: planId,
  status: 'active',
  start_date: '2026-10-01',
  end_date: '2027-01-01',
  created_at: '2026-09-28T12:00:00Z',
  payment_status: 'paid',
  payment_date: '2026-10-01',
  manual_discount: 0,
  plan_snapshot: null,
  ...extra,
});
const build = list => buildOverviewStudents({ contracts: list, plans, modalities, customers, today: TODAY });

test('two active contracts of the same person are one active person', () => {
  const result = build([contract('1', 'c1', 'p-run'), contract('2', 'c1', 'p-run', { start_date: '2026-10-15' })]);
  assert.equal(result.activePeople, 1);
  assert.equal(result.activeContracts, 2);
  assert.equal(result.peopleList.length, 1);
});

test('MRR is the monthly equivalent of the eligible contracts, with the manual discount', () => {
  const result = build([
    contract('1', 'c1', 'p-run'), // 600 / 3 = 200
    contract('2', 'c2', 'p-tri', { manual_discount: 100 }), // (400 - 100) / 1 = 300
  ]);
  assert.equal(result.mrr, 500);
  assert.equal(result.activePeople, 2);
});

test('draft, scheduled and cancelled contracts are not active people nor MRR', () => {
  const result = build([
    contract('1', 'c1', 'p-run', { status: 'draft', payment_status: 'pending', payment_date: null }),
    contract('2', 'c2', 'p-run', { status: 'scheduled', start_date: '2026-12-01' }),
    contract('3', 'c3', 'p-run', { status: 'cancelled', cancellation_date: '2026-10-20' }),
  ]);
  assert.equal(result.activePeople, 0);
  assert.equal(result.mrr, 0);
});

test('a person on leave still counts as active, as the canonical lifecycle defines', () => {
  const result = build([contract('1', 'c1', 'p-run', { status: 'on_leave' })]);
  assert.equal(result.activePeople, 1);
});

test('the composition has one line per modality with people, MRR and shares', () => {
  const result = build([
    contract('1', 'c1', 'p-run'),
    contract('2', 'c2', 'p-run'),
    contract('3', 'c3', 'p-tri'),
  ]);
  const byName = Object.fromEntries(result.composition.map(item => [item.name, item]));
  assert.equal(byName.Corrida.people, 2);
  assert.equal(byName.Corrida.mrr, 400);
  assert.equal(byName.Triathlon.people, 1);
  assert.equal(byName.Triathlon.mrr, 400);
  assert.equal(Math.round(byName.Corrida.peopleShare * 100), 67);
  assert.equal(Math.round(byName.Corrida.mrrShare * 100), 50);
  assert.equal(byName.Corrida.ticket, 200);
  assert.equal(result.hasOverlap, false);
});

test('a person with active contracts in two modalities appears in both and the EON total stays unique', () => {
  const result = build([contract('1', 'c1', 'p-run'), contract('2', 'c1', 'p-tri'), contract('3', 'c2', 'p-run')]);
  assert.equal(result.activePeople, 2);
  assert.equal(result.overlapPeople, 1);
  assert.equal(result.linkedPeople, 3);
  assert.equal(result.hasOverlap, true);
  assert.equal(result.mrr, 200 + 400 + 200, 'MRR is by contract, with no double counting');
});

test('the registered "2 Modalidades" category is kept as a category of its own', () => {
  const result = build([contract('1', 'c1', 'p-two')]);
  assert.equal(result.composition.length, 1);
  assert.equal(result.composition[0].name, '2 Modalidades');
});

test('a contract whose plan has no modality goes to an explicit unclassified line', () => {
  const result = build([contract('1', 'c1', 'p-missing', { plan_snapshot: { period_months: 1, price_monthly: 100, price_total: 100 } })]);
  assert.equal(result.composition[0].name, 'Sem modalidade');
  assert.equal(result.composition[0].people, 1);
});

test('the lists that make up each number are available with people and contracts', () => {
  const result = build([contract('1', 'c1', 'p-run'), contract('2', 'c2', 'p-tri')]);
  assert.deepEqual(result.peopleList.map(person => person.name), ['Ana Teste', 'Bruno Teste']);
  assert.equal(result.mrrList[0].number, 'ASS-2');
  assert.equal(result.mrrList.reduce((sum, item) => sum + item.monthly, 0), result.mrr);
});
