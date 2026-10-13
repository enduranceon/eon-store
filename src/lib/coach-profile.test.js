import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlyMovement } from './assessment-movement.js';
import { buildCoachProfile } from './coach-profile.js';

const TODAY = '2026-10-13';
const plans = [
  { id: 'run', name: 'Corrida - Mensal', modality_id: 'm-run', period_months: 1, price_monthly: 300, price_total: 300 },
  { id: 'bike', name: 'Ciclismo - Trimestral', modality_id: 'm-bike', period_months: 3, price_monthly: 250, price_total: 750 },
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
  contract({ id: 'a', customer_id: 'c1', start_date: '2026-09-10', end_date: '2026-11-10' }),
  contract({ id: 'b', customer_id: 'c2', status: 'cancelled', cancellation_date: '2026-09-20', cancellation_reason: 'Mudou de cidade' }),
  contract({ id: 'c', customer_id: 'c3', plan_id: 'bike', start_date: '2026-08-01', end_date: '2026-10-31' }),
  contract({ id: 'c-renewal', customer_id: 'c3', plan_id: 'bike', parent_contract_id: 'c', status: 'draft', payment_status: 'pending', renewal_stage: 'waiting_response', start_date: '2026-11-01', end_date: '2027-01-31' }),
  contract({ id: 'd', customer_id: 'c4', status: 'on_leave' }),
  contract({ id: 'e', customer_id: 'c5', payment_status: 'overdue', due_date: '2026-10-05' }),
  contract({ id: 'f', customer_id: 'c6', coach_id: 'k2', start_date: '2026-05-01' }),
  contract({ id: 'f-renewal', customer_id: 'c6', coach_id: 'k1', parent_contract_id: 'f', status: 'draft', payment_status: 'pending', renewal_stage: 'charge_pending', start_date: '2027-01-01' }),
  contract({ id: 'p1', customer_id: 'c7', status: 'draft', payment_status: 'pending', prospect_stage: 'clarifying', start_date: '2026-10-20', created_at: '2026-10-08T12:00:00Z' }),
  contract({ id: 'p2', customer_id: 'c8', status: 'draft', payment_status: 'pending', prospect_stage: 'lost', start_date: '2026-10-20' }),
  contract({ id: 'p3', customer_id: 'c9', coach_id: 'k2', status: 'draft', payment_status: 'pending', prospect_stage: 'new', start_date: '2026-10-20' }),
];

const profile = buildCoachProfile({
  coachId: 'k1',
  contracts,
  plans,
  today: TODAY,
  closings: [
    { id: 'cl-aug', competence: '2026-08-01', status: 'paid' },
    { id: 'cl-sep', competence: '2026-09-01', status: 'approved' },
  ],
  statementItems: [
    { closing_id: 'cl-sep', amount: 85 },
    { closing_id: 'cl-sep', amount: 42.5 },
    { closing_id: 'cl-aug', amount: 85 },
    { closing_id: 'missing', amount: 999 },
  ],
  pendingRepasse: [{ amount: 85 }, { amount: 40 }],
});

test('the month-by-month view ends in the current month', () => {
  const monthly = buildMonthlyMovement(contracts, plans, { asOf: TODAY, months: 3, coachId: 'k1' });
  assert.deepEqual(monthly.map(month => [month.month, month.to]), [
    ['2026-08', '2026-08-31'], ['2026-09', '2026-09-30'], ['2026-10', TODAY],
  ]);
  assert.equal(monthly[1].entries, 1);
  assert.equal(monthly[1].exits, 1);
});

test('active students today with what needs attention first', () => {
  const byCustomer = Object.fromEntries(profile.students.map(student => [student.customerId, student]));
  assert.deepEqual(Object.keys(byCustomer).sort(), ['c1', 'c3', 'c4', 'c5']);
  assert.equal(byCustomer.c5.situation.label, 'Pagamento atrasado');
  assert.equal(byCustomer.c4.situation.label, 'Em licença');
  assert.equal(byCustomer.c3.situation.label, 'Renovação: Aguardando decisão');
  assert.equal(byCustomer.c3.renewalContractId, 'c-renewal');
  assert.equal(byCustomer.c1.situation.label, 'Ativo');
  assert.equal(byCustomer.c3.monthlyValue, 250);
  assert.equal(profile.kpis.active, 4);
  assert.equal(profile.kpis.monthlyRevenue, 1150);
  assert.deepEqual(profile.byModality.map(group => [group.modalityId, group.students]), [['m-run', 3], ['m-bike', 1]]);
});

test('real exits keep the reason; prospects and renewals only open ones', () => {
  assert.deepEqual(profile.exits.map(exit => [exit.customerId, exit.date, exit.reason]), [['c2', '2026-09-20', 'Mudou de cidade']]);
  assert.equal(profile.kpis.exits, 1);
  assert.deepEqual(profile.prospects.map(prospect => [prospect.customerId, prospect.stageLabel]), [['c7', 'Tirando dúvidas']]);
  assert.deepEqual(profile.renewals.map(renewal => [renewal.customerId, renewal.stageLabel, renewal.coachChange]), [
    ['c3', 'Aguardando decisão', null],
    ['c6', 'Enviar cobrança', 'arriving'],
  ]);
  const other = buildCoachProfile({ coachId: 'k2', contracts, plans, today: TODAY });
  assert.deepEqual(other.renewals.map(renewal => [renewal.customerId, renewal.coachChange]), [['c6', 'leaving']]);
});

test('payouts add up the coach items of each closing, newest first', () => {
  assert.deepEqual(profile.payouts.map(row => [row.competence, row.statusLabel, row.total, row.items]), [
    ['2026-09-01', 'Aprovado', 127.5, 2],
    ['2026-08-01', 'Pago', 85, 1],
  ]);
  assert.deepEqual(profile.pending, { count: 2, total: 125 });
});
