import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssessmentMovement,
  movementPeriod,
  periodLabel,
  previousMovementPeriod,
} from './assessment-movement.js';

const AS_OF = '2026-10-09';
const plans = [
  { id: 'run', name: 'Corrida - Mensal', modality_id: 'm-run', price_monthly: 300 },
  { id: 'bike', name: 'Ciclismo - Mensal', modality_id: 'm-bike', price_monthly: 300 },
];

function contract(overrides) {
  return {
    plan_id: 'run',
    coach_id: 'k1',
    status: 'active',
    payment_status: 'paid',
    start_date: '2026-01-01',
    end_date: '2027-01-01',
    created_at: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

// Pessoas e contratos fictícios.
const contracts = [
  contract({ id: 'a', customer_id: 'c1', contract_number: 'ASS-A', start_date: '2026-09-10', end_date: '2026-10-10' }),
  contract({ id: 'b', customer_id: 'c2', contract_number: 'ASS-B', status: 'cancelled', cancellation_date: '2026-09-20', cancellation_reason: 'Mudou de cidade' }),
  contract({ id: 'c-old', customer_id: 'c3', start_date: '2026-06-01', end_date: '2026-09-01', status: 'finished' }),
  contract({ id: 'c-new', customer_id: 'c3', parent_contract_id: 'c-old', start_date: '2026-09-01', end_date: '2026-12-01' }),
  contract({ id: 'd-old', customer_id: 'c4', start_date: '2025-12-01', end_date: '2026-03-01', status: 'finished', cancellation_reason: 'Não renovou' }),
  contract({ id: 'd-new', customer_id: 'c4', start_date: '2026-09-05', end_date: '2026-12-05' }),
  contract({ id: 'e', customer_id: 'c5', plan_id: 'bike', coach_id: 'k2', start_date: '2026-08-15', end_date: '2026-11-15' }),
  contract({ id: 'void', customer_id: 'c6', status: 'voided', payment_status: 'cancelled', start_date: '2026-09-12' }),
];

test('períodos dos botões e o personalizado', () => {
  assert.deepEqual(movementPeriod('month', AS_OF), { from: '2026-10-01', to: AS_OF });
  assert.deepEqual(movementPeriod('previous_month', AS_OF), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(movementPeriod('quarter', AS_OF), { from: '2026-08-01', to: AS_OF });
  assert.deepEqual(movementPeriod('year', AS_OF), { from: '2026-01-01', to: AS_OF });
  assert.deepEqual(movementPeriod('custom', AS_OF, { from: '2026-09-30', to: '2026-09-01' }), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(movementPeriod('custom', AS_OF, { from: '', to: '2026-09-01' }), { from: '2026-10-01', to: AS_OF });
  assert.equal(periodLabel('2026-09-01', '2026-09-30'), 'set/2026');
  assert.equal(periodLabel('2026-10-01', '2026-10-09'), 'out/2026 até 09/10');
  assert.equal(periodLabel('2026-09-05', '2026-09-15'), '05/09/2026 a 15/09/2026');
});

test('comparação com o período anterior equivalente', () => {
  assert.deepEqual(previousMovementPeriod({ from: '2026-10-01', to: '2026-10-09' }), { from: '2026-09-01', to: '2026-09-09' });
  assert.deepEqual(previousMovementPeriod({ from: '2026-09-01', to: '2026-09-30' }), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(previousMovementPeriod({ from: '2026-03-01', to: '2026-03-31' }), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousMovementPeriod({ from: '2026-03-01', to: '2026-03-30' }), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousMovementPeriod({ from: '2026-08-01', to: '2026-10-09' }), { from: '2026-05-01', to: '2026-07-09' });
  assert.deepEqual(previousMovementPeriod({ from: '2026-01-01', to: '2026-10-09' }), { from: '2025-01-01', to: '2025-10-09' });
  assert.deepEqual(previousMovementPeriod({ from: '2026-09-10', to: '2026-09-19' }), { from: '2026-08-31', to: '2026-09-09' });
});

test('setembro: entradas, retornos, renovações e saídas reais com a lista de pessoas', () => {
  const movement = buildAssessmentMovement(contracts, plans, { from: '2026-09-01', to: '2026-09-30', asOf: AS_OF });
  assert.equal(movement.label, 'set/2026');
  assert.deepEqual(
    { ...movement.kpis, churnRate: Math.round(movement.kpis.churnRate) },
    { baseStart: 3, entries: 1, returns: 1, renewals: 1, exits: 1, baseEnd: 4, net: 1, churnRate: 33 },
  );
  assert.deepEqual(movement.lists.entries.map(row => [row.customerId, row.date, row.contractNumber]), [['c1', '2026-09-10', 'ASS-A']]);
  assert.deepEqual(movement.lists.returns.map(row => row.customerId), ['c4']);
  assert.deepEqual(movement.lists.renewals.map(row => row.customerId), ['c3']);
  assert.deepEqual(movement.lists.exits.map(row => [row.customerId, row.date, row.reason]), [['c2', '2026-09-20', 'Mudou de cidade']]);
  assert.equal(movement.lists.exits[0].planName, 'Corrida - Mensal');
  // Venda descartada não entra em lugar nenhum.
  assert.ok(!Object.values(movement.lists).flat().some(row => row.customerId === 'c6'));
  assert.equal(movement.previous.label, 'ago/2026');
  assert.equal(movement.previous.kpis.entries, 1);
});

test('quebra por coach e por modalidade, e filtros', () => {
  const movement = buildAssessmentMovement(contracts, plans, { from: '2026-09-01', to: '2026-09-30', asOf: AS_OF });
  const k1 = movement.byCoach.find(row => row.key === 'k1');
  const k2 = movement.byCoach.find(row => row.key === 'k2');
  assert.deepEqual([k1.entries, k1.returns, k1.exits, k1.baseEnd], [1, 1, 1, 3]);
  assert.deepEqual([k2.entries, k2.exits, k2.baseEnd], [0, 0, 1]);
  assert.deepEqual(k1.lists.exits.map(row => row.customerId), ['c2']);
  assert.deepEqual(movement.byModality.map(row => [row.key, row.baseEnd]), [['m-run', 3], ['m-bike', 1]]);

  const bike = buildAssessmentMovement(contracts, plans, { from: '2026-09-01', to: '2026-09-30', asOf: AS_OF, modalityId: 'm-bike' });
  assert.deepEqual([bike.kpis.baseStart, bike.kpis.entries, bike.kpis.exits, bike.kpis.baseEnd], [1, 0, 0, 1]);
  const coach2 = buildAssessmentMovement(contracts, plans, { from: '2026-08-01', to: '2026-08-31', asOf: AS_OF, coachId: 'k2' });
  assert.deepEqual(coach2.lists.entries.map(row => row.customerId), ['c5']);
});

test('o período nunca passa de hoje', () => {
  const movement = buildAssessmentMovement(contracts, plans, { from: '2026-10-01', to: '2026-10-31', asOf: AS_OF });
  assert.equal(movement.to, AS_OF);
  assert.equal(movement.requestedTo, '2026-10-31');
});
