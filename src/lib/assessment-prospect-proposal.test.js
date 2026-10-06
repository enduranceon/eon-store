import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonthsToDate,
  describeProspectProposal,
  planProspectProposalSave,
  proposalFormFrom,
} from './assessment-prospect-proposal.js';

const plans = [
  { id: 'plan-run-1', name: 'Corrida Mensal', modality_id: 'mod-run', price_total: 250, enrollment_fee: 40, max_installments: 1, period_months: 1 },
  { id: 'plan-run-3', name: 'Corrida Trimestral', modality_id: 'mod-run', price_total: 600, enrollment_fee: 40, max_installments: 3, period_months: 3 },
  { id: 'plan-tri-3', name: 'Triathlon Trimestral', modality_id: 'mod-tri', price_total: 900, enrollment_fee: 0, max_installments: 3, period: 'trimestral' },
];
const coaches = [
  { id: 'coach-run', name: 'Coach Corrida', active: true, modality_ids: ['mod-run'] },
  { id: 'coach-all', name: 'Coach Geral', active: true, modality_ids: ['mod-run', 'mod-tri'] },
  { id: 'coach-tri', name: 'Coach Tri', active: true, modality_ids: ['mod-tri'] },
];
// Retrato antigo: o plano ficou mais caro depois que o prospect se cadastrou.
const contract = {
  id: 'contract-1',
  plan_id: 'plan-run-3',
  coach_id: 'coach-run',
  start_date: '2026-10-06',
  installments: 3,
  enrollment_fee: 40,
  manual_discount: 0,
  due_date: null,
  plan_snapshot: { plan_id: 'plan-run-3', name: 'Corrida Trimestral', modality_id: 'mod-run', price_total: 570, enrollment_fee: 40, max_installments: 3, period_months: 3 },
};
const baseForm = {
  ...proposalFormFrom(contract, { paymentLink: '', defaultDueDate: '2026-10-07' }),
  payment_link: 'https://pagamento.example.test/abc',
};
const save = (overrides = {}, extra = {}) => planProspectProposalSave({
  contract, form: { ...baseForm, ...overrides }, plans, coaches, today: '2026-10-06', ...extra,
});

test('adds months like the database, keeping the day inside the month', () => {
  assert.equal(addMonthsToDate('2026-10-06', 3), '2027-01-06');
  assert.equal(addMonthsToDate('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsToDate('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonthsToDate('', 1), '');
});

test('form starts from the saved contract', () => {
  assert.deepEqual(proposalFormFrom(contract, { paymentLink: 'https://x.test', defaultDueDate: '2026-10-07' }), {
    plan_id: 'plan-run-3', coach_id: 'coach-run', start_date: '2026-10-06', installments: 3,
    enrollment_fee: '40', manual_discount: '0', payment_link: 'https://x.test', due_date: '2026-10-07',
  });
});

test('keeps the saved plan price while plan, installments and start stay the same', () => {
  const proposal = describeProspectProposal({ contract, form: baseForm, plans });
  assert.equal(proposal.needsPlanUpdate, false);
  assert.equal(proposal.base, 570);
  assert.equal(proposal.total, 610);
  assert.equal(proposal.endDate, '2027-01-06');
});

test('uses today plan price when the plan record is rewritten', () => {
  const proposal = describeProspectProposal({ contract, form: { ...baseForm, installments: 2 }, plans });
  assert.equal(proposal.needsPlanUpdate, true);
  assert.equal(proposal.base, 600);
  assert.equal(proposal.perInstallment, 320);
});

test('only values and link changed: saves just the proposal', () => {
  const result = save({ enrollment_fee: '0', manual_discount: '10' });
  assert.deepEqual(result.steps, ['proposal']);
  assert.equal(result.values.enrollmentFee, 0);
  assert.equal(result.values.manualDiscount, 10);
  assert.equal(result.proposal.total, 560);
});

test('empty money fields count as zero', () => {
  const result = save({ enrollment_fee: '', manual_discount: '' });
  assert.equal(result.values.enrollmentFee, 0);
  assert.equal(result.values.manualDiscount, 0);
});

test('plan change keeps the coach when the coach serves the new plan', () => {
  const result = save({ plan_id: 'plan-run-1', installments: 1 });
  assert.deepEqual(result.steps, ['plan', 'proposal']);
  assert.equal(result.proposal.base, 250);
});

test('plan change to a modality the coach does not serve asks for another coach', () => {
  assert.match(save({ plan_id: 'plan-tri-3' }).error, /Coach Corrida não atende/);
});

test('plan and coach change: plan first when the current coach serves the new plan', () => {
  const result = planProspectProposalSave({
    contract: { ...contract, coach_id: 'coach-all' },
    form: { ...baseForm, coach_id: 'coach-tri', plan_id: 'plan-tri-3' },
    plans, coaches, today: '2026-10-06',
  });
  assert.deepEqual(result.steps, ['plan', 'coach', 'proposal']);
});

test('plan and coach change: coach first when only the new coach serves both plans', () => {
  const result = save({ coach_id: 'coach-all', plan_id: 'plan-tri-3' });
  assert.deepEqual(result.steps, ['coach', 'plan', 'proposal']);
});

test('plan and coach change with no safe order is refused', () => {
  assert.match(save({ coach_id: 'coach-tri', plan_id: 'plan-tri-3' }).error, /Troque o coach pela tela do contrato/);
});

test('coach change alone and start date change', () => {
  assert.deepEqual(save({ coach_id: 'coach-all' }).steps, ['coach', 'proposal']);
  assert.deepEqual(save({ start_date: '2026-10-13' }).steps, ['plan', 'proposal']);
  assert.deepEqual(save({ start_date: '2026-10-13', coach_id: 'coach-all' }).steps, ['plan', 'coach', 'proposal']);
});

test('rejects invalid choices before saving anything', () => {
  assert.match(save({ installments: 4 }).error, /entre 1 e 3 parcelas/);
  assert.match(save({ installments: 2 }, { plans: plans.filter(plan => plan.id !== 'plan-run-3') }).error, /desativado/);
  assert.match(save({ coach_id: '' }).error, /Selecione o coach/);
  assert.match(save({ manual_discount: '611' }).error, /desconto não pode ser maior/);
  assert.match(save({ enrollment_fee: '-1' }).error, /matrícula válida/);
  assert.match(save({ payment_link: 'http://pagamento.example.test' }).error, /https:\/\//);
  assert.match(save({ payment_link: '  ' }).error, /Cole o link/);
  assert.match(save({ due_date: '2026-10-05' }).error, /antes de hoje/);
  assert.match(save({ start_date: '' }).error, /data de início/);
});

test('prospect with an Asaas charge is adjusted only on the contract page', () => {
  const withCharge = planProspectProposalSave({
    contract: { ...contract, asaas_charge_id: 'pay_ficticio' }, form: baseForm, plans, coaches, today: '2026-10-06',
  });
  assert.match(withCharge.error, /cobrança no Asaas/);
});
