import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowedPlanChangeMethodGroups,
  planChangeChargeMethods,
  planChangeMaxInstallments,
  planChangeTargets,
  planChangeUnusedValue,
  planHistorySegments,
} from './assessment-plan-change.js';

test('the difference splits in up to 6 installments of at least R$ 50', () => {
  assert.equal(planChangeMaxInstallments(397.79), 6);
  assert.equal(planChangeMaxInstallments(251.93), 5);
  assert.equal(planChangeMaxInstallments(135), 2);
  assert.equal(planChangeMaxInstallments(100), 2);
  assert.equal(planChangeMaxInstallments(99.99), 1);
  assert.equal(planChangeMaxInstallments(0), 1);
});

test('payment methods above the allowed installments are hidden', () => {
  const groups = [
    ['Sem gateway', [{ id: 'pix', installments: 1 }, { id: 'cash', installments: null }]],
    ['Cartão', [{ id: 'card_2x', installments: 2 }, { id: 'card_7x', installments: 7 }]],
    ['Parcelado', [{ id: 'card_12x', installments: 12 }]],
  ];
  assert.deepEqual(
    allowedPlanChangeMethodGroups(groups, 2).map(([group, list]) => [group, list.map(m => m.id)]),
    [['Sem gateway', ['pix', 'cash']], ['Cartão', ['card_2x']]],
  );
});

test('the refund preview adds the unused part of paid upgrades like the database', () => {
  const contract = { end_date: '2027-03-01' };
  const changes = [
    { status: 'applied', payment_status: 'paid', effective_date: '2026-11-01', amount: 397.79 },
    { status: 'applied', payment_status: 'charge_sent', effective_date: '2026-12-01', amount: 100 },
    { status: 'cancelled', payment_status: 'cancelled', effective_date: '2026-10-01', amount: 999 },
  ];
  // (01/03 - 01/01) + 1 = 60 dias não usados de (01/03 - 01/11) + 1 = 121.
  assert.equal(planChangeUnusedValue(changes, contract, '2027-01-01'), 397.79 * 60 / 121);
  assert.equal(planChangeUnusedValue(changes, contract, '2026-10-15'), 397.79);
  assert.equal(planChangeUnusedValue(changes, contract, '2027-03-02'), 0);
});

test('only upgrade and lateral targets of active plans are offered', () => {
  const plans = [
    { id: 'tri', name: 'Triathlon', price_total: 1800, active: true },
    { id: 'duas', name: '2 Modalidades', price_total: 1500, active: true },
    { id: 'ess', name: 'Essencial', price_total: 1110, active: true },
    { id: 'old', name: 'Antigo', price_total: 1900, active: false },
    { id: 'bis', name: 'Corrida bis', price_total: 1200, active: true },
  ];
  const transitions = [
    { from_plan_id: 'cor', to_plan_id: 'tri', transition_type: 'upgrade' },
    { from_plan_id: 'cor', to_plan_id: 'duas', transition_type: 'not_allowed' },
    { from_plan_id: 'cor', to_plan_id: 'ess', transition_type: 'downgrade' },
    { from_plan_id: 'cor', to_plan_id: 'old', transition_type: 'upgrade' },
    { from_plan_id: 'cor', to_plan_id: 'bis', transition_type: 'lateral' },
    { from_plan_id: 'tri', to_plan_id: 'bis', transition_type: 'upgrade' },
  ];
  assert.deepEqual(
    planChangeTargets(plans, transitions, 'cor').map(({ plan, type }) => [plan.id, type]),
    [['bis', 'lateral'], ['tri', 'upgrade']],
  );
});

test('the external charge offers PIX, boleto and cards up to the allowed installments', () => {
  assert.deepEqual(planChangeChargeMethods(2).map(method => method.value), ['pix', 'boleto', 'card_1x', 'card_2x']);
  assert.deepEqual(planChangeChargeMethods(1).map(method => method.value), ['pix', 'boleto', 'card_1x']);
  assert.equal(planChangeChargeMethods(6).at(-1).value, 'card_6x');
});

test('plan segments end the day before the next change and on the last contract day', () => {
  assert.deepEqual(
    planHistorySegments([
      { plan_id: 'tri', valid_from: '2026-11-01', change_type: 'upgrade' },
      { plan_id: 'cor', valid_from: '2026-09-01', change_type: 'original' },
    ], '2027-03-01').map(segment => [segment.row.plan_id, segment.from, segment.to]),
    [['cor', '2026-09-01', '2026-10-31'], ['tri', '2026-11-01', '2027-02-28']],
  );
  // Mudança desde o primeiro dia: vale por cima da linha original.
  assert.deepEqual(
    planHistorySegments([
      { plan_id: 'tri', valid_from: '2026-09-01', change_type: 'lateral' },
      { plan_id: 'cor', valid_from: '2026-09-01', change_type: 'original' },
    ], '2027-03-01').map(segment => [segment.row.plan_id, segment.from, segment.to]),
    [['tri', '2026-09-01', '2027-02-28']],
  );
});
