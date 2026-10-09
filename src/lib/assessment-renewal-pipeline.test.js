import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowsAutoRenewal,
  awaitsRenewalChange,
  buildRenewalBoard,
  buildRenewalTimeline,
  businessDate,
  daysUntil,
  followUpLabel,
  isVisibleOnBoard,
  planPeriodMonths,
  renewalCardState,
  renewalChangeHref,
  renewalDueLabel,
  renewalContactPlan,
  renewalContactStep,
  renewalDueNotice,
  renewalStepLabel,
  summarizeRenewalBoard,
  terminalDaysLeft,
} from './assessment-renewal-pipeline.js';

test('urgency labels follow the end of the current contract', () => {
  assert.equal(renewalDueLabel(daysUntil('2026-10-17', '2026-10-07')), 'vence em 10 dias');
  assert.equal(renewalDueLabel(daysUntil('2026-10-17', '2026-10-14')), 'vence em 3 dias');
  assert.equal(renewalDueLabel(daysUntil('2026-10-17', '2026-10-16')), 'vence amanhã');
  assert.equal(renewalDueLabel(daysUntil('2026-10-17', '2026-10-17')), 'vence hoje');
  assert.equal(renewalDueLabel(daysUntil('2026-10-17', '2026-10-18')), 'venceu ontem');
  assert.equal(renewalDueLabel(daysUntil('2026-10-17', '2026-10-25')), 'venceu há 8 dias');
  assert.equal(renewalDueLabel(null), 'sem data');
});

test('follow-up labels count the days late', () => {
  assert.equal(followUpLabel(0), 'follow-up hoje');
  assert.equal(followUpLabel(1), 'follow-up atrasado há 1 dia');
  assert.equal(followUpLabel(2), 'follow-up atrasado há 2 dias');
});

test('the Pebinha notice names the plan and its last day', () => {
  assert.equal(renewalDueNotice('2026-10-17', '2026-10-07', 'Corrida - Trimestral'), 'seu plano Corrida - Trimestral vence em 17/10');
  assert.equal(renewalDueNotice('2026-10-17', '2026-10-17'), 'seu plano vence em 17/10');
  assert.equal(renewalDueNotice('2026-10-05', '2026-10-09'), 'seu plano venceu em 05/10');
  assert.equal(renewalDueNotice('', '2026-10-09'), 'a data de vencimento do seu plano precisa ser confirmada');
});

// Mesmos casos de supabase/tests/assessment_renewal_contact_flow_test.sql.
const at = day => `${day}T15:00:00.000Z`;
const plan = (step, stepDay, responseCode, responseDay, followUpAt, endDate) => renewalContactPlan({
  step, stepAt: stepDay ? at(stepDay) : null, responseCode,
  responseAt: responseDay ? `${responseDay}T14:00:00.000Z` : null, followUpAt, endDate,
}, '2026-10-08');

test('renewal contact cadence without an answer', () => {
  assert.deepEqual(plan(null, null, null, null, null, '2026-11-20'), { step: 'intent', eligibleAt: '2026-10-08' });
  assert.deepEqual(plan(null, null, null, null, null, '2026-10-12'), { step: 'intent', eligibleAt: '2026-10-02' });
  assert.deepEqual(plan('intent', '2026-11-10', null, null, null, '2026-11-20'), { step: 'reminder', eligibleAt: '2026-11-12' });
  assert.deepEqual(plan('intent', '2026-11-18', null, null, null, '2026-11-20'), { step: 'last_day', eligibleAt: '2026-11-20' });
  assert.deepEqual(plan('reminder', '2026-11-12', null, null, null, '2026-11-20'), { step: 'last_day', eligibleAt: '2026-11-20' });
  assert.deepEqual(plan('last_day', '2026-11-20', null, null, null, '2026-11-20'), { step: 'closing', eligibleAt: '2026-11-25' });
  assert.deepEqual(plan('intent', '2026-11-22', null, null, null, '2026-11-20'), { step: 'closing', eligibleAt: '2026-11-25' });
  assert.deepEqual(plan('closing', '2026-11-25', null, null, null, '2026-11-20'), { step: 'close', eligibleAt: '2026-11-25' });
  assert.deepEqual(plan('intent', '2026-11-10', null, null, '2026-11-16', '2026-11-20'), { step: 'reminder', eligibleAt: '2026-11-16' });
});

test('"still thinking" gets an answer now and a return two days later', () => {
  assert.deepEqual(plan('intent', '2026-11-10', 'thinking', '2026-11-11', '2026-11-13', '2026-11-20'), { step: 'thinking_ack', eligibleAt: '2026-11-11' });
  assert.deepEqual(plan('thinking_ack', '2026-11-11', 'thinking', '2026-11-11', '2026-11-13', '2026-11-20'), { step: 'thinking_return', eligibleAt: '2026-11-13' });
  assert.deepEqual(plan('thinking_return', '2026-11-13', 'thinking', '2026-11-11', null, '2026-11-20'), { step: 'last_day', eligibleAt: '2026-11-20' });
  assert.deepEqual(plan('thinking_return', '2026-11-21', 'thinking', '2026-11-19', null, '2026-11-20'), { step: 'closing', eligibleAt: '2026-11-25' });
  assert.equal(plan('intent', '2026-11-10', 'will_renew', '2026-11-11', null, '2026-11-20').step, 'none');
});

test('the card shows the next contact step and asks for attention when it is due', () => {
  const contract = {
    renewal_stage: 'waiting_response', renewal_contact_step: 'intent',
    renewal_contact_step_at: at('2026-10-06'), start_date: '2026-10-15',
  };
  const due = renewalContactStep(contract, { end_date: '2026-10-14' }, '2026-10-08');
  assert.deepEqual(due, { step: 'reminder', eligibleAt: '2026-10-08', due: true });
  assert.equal(renewalStepLabel(due, '2026-10-08'), 'Lembrete: hoje');
  const later = renewalContactStep(contract, { end_date: '2026-10-14' }, '2026-10-07');
  assert.equal(renewalStepLabel(later, '2026-10-07'), 'Lembrete: 08/10');
  assert.equal(renewalContactStep({ ...contract, auto_renewal: true }, null, '2026-10-08'), null);
  assert.equal(renewalContactStep({ ...contract, renewal_stage: 'waiting_payment' }, null, '2026-10-08'), null);
});

test('resolution dates use the São Paulo business day', () => {
  assert.equal(businessDate('2026-10-02T15:00:00Z'), '2026-10-02');
  // 23h em São Paulo ainda é o mesmo dia, mesmo já sendo o dia seguinte em UTC.
  assert.equal(businessDate('2026-10-03T02:00:00Z'), '2026-10-02');
  assert.equal(businessDate(''), '');
});

test('final cards stay five days and then only leave the board', () => {
  const renewed = { renewal_stage: 'renewed', renewal_resolved_at: '2026-10-02T15:00:00Z' };
  assert.equal(terminalDaysLeft(renewed.renewal_resolved_at, '2026-10-02'), 5);
  assert.equal(isVisibleOnBoard(renewed, '2026-10-02'), true);
  assert.equal(isVisibleOnBoard(renewed, '2026-10-07'), true);
  assert.equal(terminalDaysLeft(renewed.renewal_resolved_at, '2026-10-07'), 0);
  assert.equal(isVisibleOnBoard(renewed, '2026-10-08'), false);

  const notRenewed = { renewal_stage: 'not_renewed', renewal_resolved_at: '2026-10-03T02:00:00Z' };
  assert.equal(isVisibleOnBoard(notRenewed, '2026-10-07'), true);
  assert.equal(isVisibleOnBoard(notRenewed, '2026-10-08'), false);
});

test('an open renewal never leaves the board because of a date', () => {
  for (const stage of ['contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment']) {
    assert.equal(isVisibleOnBoard({ renewal_stage: stage }, '2027-12-31'), true, stage);
  }
});

test('discarded sales and contracts outside the pipeline are not on the board', () => {
  assert.equal(isVisibleOnBoard({ renewal_stage: 'discarded', renewal_resolved_at: '2026-10-02T15:00:00Z' }, '2026-10-02'), false);
  assert.equal(isVisibleOnBoard({ renewal_stage: null }, '2026-10-02'), false);
  assert.equal(isVisibleOnBoard(null, '2026-10-02'), false);
});

test('automatic renewal is only offered for monthly plans', () => {
  assert.equal(planPeriodMonths({ period_months: 6 }), 6);
  assert.equal(planPeriodMonths({ period: 'trimestral' }), 3);
  assert.equal(allowsAutoRenewal({ period_months: 1 }), true);
  assert.equal(allowsAutoRenewal({ period: 'mensal' }), true);
  assert.equal(allowsAutoRenewal({ period_months: 3 }), false);
  assert.equal(allowsAutoRenewal({ period: 'semestral' }), false);
  assert.equal(allowsAutoRenewal(null), true);
});

const parentEnding = (endDate) => ({ id: 'p1', contract_number: 'ASS-000100', end_date: endDate });

test('a semiannual renewal ignored past its end stays in "Enviar mensagem" with a red alert', () => {
  const contract = {
    id: 'c1', renewal_stage: 'contact_pending', start_date: '2026-10-17',
    plan_snapshot: { price_total: 1110 }, parent_contract_id: 'p1',
  };
  const day18 = renewalCardState(contract, { parent: parentEnding('2026-10-17'), todayStr: '2026-10-18' });
  assert.equal(day18.needsAttention, true);
  assert.ok(day18.badges.some(badge => badge.text === 'venceu ontem' && badge.tone === 'red'));
  assert.ok(day18.alerts.some(alert => alert.text.includes('continua no quadro')));
  const day25 = renewalCardState(contract, { parent: parentEnding('2026-10-17'), todayStr: '2026-10-25' });
  assert.ok(day25.badges.some(badge => badge.text === 'venceu há 8 dias'));
  assert.equal(isVisibleOnBoard(contract, '2026-11-30'), true);
});

test('a late follow-up keeps the card waiting and raises the urgency', () => {
  const contract = {
    id: 'c2', renewal_stage: 'waiting_response', start_date: '2026-10-30',
    renewal_response_code: 'thinking', renewal_follow_up_at: '2026-10-12',
  };
  const state = renewalCardState(contract, { parent: parentEnding('2026-10-30'), todayStr: '2026-10-14' });
  assert.equal(state.followUpDaysLate, 2);
  assert.equal(state.needsAttention, true);
  assert.ok(state.alerts.some(alert => alert.text === 'Follow-up atrasado há 2 dias.'));
  assert.ok(state.badges.some(badge => badge.text === 'ainda pensando'));
});

test('a plan or coach change is a badge, not a new column', () => {
  const waiting = renewalCardState(
    { id: 'c3', renewal_stage: 'waiting_response', start_date: '2026-10-30', renewal_response_code: 'change_plan_or_coach' },
    { todayStr: '2026-10-14' },
  );
  assert.ok(waiting.badges.some(badge => badge.text === 'mudar plano/coach' && badge.tone === 'violet'));
  const charge = renewalCardState(
    { id: 'c3', renewal_stage: 'charge_pending', start_date: '2026-10-30', renewal_response_code: 'change_plan_or_coach' },
    { todayStr: '2026-10-14' },
  );
  assert.ok(charge.alerts.some(alert => alert.text.startsWith('Mudança resolvida')));
});

test('a monthly automatic renewal without link is still a valid open sale', () => {
  const state = renewalCardState(
    {
      id: 'c4', renewal_stage: 'waiting_payment', auto_renewal: true, start_date: '2026-10-11',
      payment_status: 'awaiting_charge', plan_snapshot: { price_total: 210 },
    },
    { todayStr: '2026-10-06' },
  );
  assert.equal(state.missingLink, true);
  assert.equal(state.needsAttention, false);
  assert.ok(state.badges.some(badge => badge.text === 'Automática'));
  assert.ok(state.alerts.some(alert => alert.text === 'Link da cobrança ainda não informado.'));
  assert.equal(state.total, 210);
});

test('renewals without link come first in "Aguardando pagamento" and are counted', () => {
  const contracts = [
    { id: 'w1', customer_id: 'p1', renewal_stage: 'waiting_payment', start_date: '2026-10-05',
      payment_status: 'charge_sent', external_payment_link: 'https://pagamento.example.test/1' },
    { id: 'w2', customer_id: 'p2', renewal_stage: 'waiting_payment', auto_renewal: true, start_date: '2026-10-20',
      payment_status: 'awaiting_charge' },
  ];
  const board = buildRenewalBoard(contracts, { customers: {}, todayStr: '2026-10-09' });
  const waiting = board.columns.find(column => column.stage === 'waiting_payment');
  assert.deepEqual(waiting.items.map(card => card.contract.id), ['w2', 'w1']);
  assert.equal(waiting.missingLinkCount, 1);
  assert.ok(waiting.items[0].state.badges.some(badge => badge.text === 'Sem link'));
  assert.ok(!waiting.items[1].state.badges.some(badge => badge.text === 'Sem link'));
});

test('an unpaid renewal whose term already started stays in "Aguardando pagamento" with a red alert', () => {
  const state = renewalCardState(
    {
      id: 'c5', renewal_stage: 'waiting_payment', start_date: '2026-10-05',
      payment_status: 'charge_sent', external_payment_link: 'https://pagamento.example.test/1',
    },
    { todayStr: '2026-10-09' },
  );
  assert.equal(state.termStartedDays, 4);
  assert.equal(state.needsAttention, true);
  assert.equal(state.missingLink, false);
  assert.ok(state.alerts.some(alert => alert.text === 'A vigência começou há 4 dias e o pagamento continua pendente.'));
});

test('final cards show until when they stay on the board', () => {
  const contract = { id: 'c6', renewal_stage: 'renewed', renewal_resolved_at: '2026-10-02T15:00:00Z' };
  assert.match(renewalCardState(contract, { todayStr: '2026-10-02' }).leavesLabel, /^Fica no quadro até 07\/10/);
  assert.match(renewalCardState(contract, { todayStr: '2026-10-07' }).leavesLabel, /^Último dia no quadro/);
});

test('flagged inconsistencies always ask for review', () => {
  const state = renewalCardState(
    { id: 'c7', renewal_stage: 'waiting_payment', start_date: '2026-10-20', payment_status: 'paid' },
    { todayStr: '2026-10-09', issues: [{ issue_label: 'Pagamento confirmado, mas a renovação não está em Renovou' }] },
  );
  assert.equal(state.needsAttention, true);
  assert.ok(state.alerts.some(alert => alert.text.startsWith('Precisa de conferência')));
});

test('the board groups, filters and summarizes without hiding open renewals', () => {
  const contracts = [
    { id: 'a', customer_id: 'u1', coach_id: 'k1', renewal_stage: 'contact_pending', start_date: '2026-10-01', parent_contract_id: 'pa', plan_snapshot: { name: 'Semestral', price_total: 1110, modality_id: 'm1' } },
    { id: 'b', customer_id: 'u2', coach_id: 'k2', renewal_stage: 'waiting_payment', start_date: '2026-10-20', payment_status: 'charge_sent', external_payment_link: 'https://x.test', plan_snapshot: { name: 'Mensal', price_total: 210, modality_id: 'm1' } },
    { id: 'c', customer_id: 'u3', coach_id: 'k1', renewal_stage: 'renewed', renewal_resolved_at: '2026-09-20T12:00:00Z', plan_snapshot: { name: 'Mensal', price_total: 210 } },
    { id: 'd', customer_id: 'u4', coach_id: 'k1', renewal_stage: 'not_renewed', renewal_resolved_at: '2026-10-08T12:00:00Z', plan_snapshot: { name: 'Mensal', price_total: 210 } },
  ];
  const customers = { u1: { full_name: 'Ána Souza' }, u2: { full_name: 'Bruno Lima' }, u3: { full_name: 'Carla' }, u4: { full_name: 'Davi' } };
  const board = buildRenewalBoard(contracts, { customers, todayStr: '2026-10-09' });
  assert.deepEqual(board.columns.map(column => column.items.length), [1, 0, 0, 1, 0, 1]);
  const summary = summarizeRenewalBoard(board.cards);
  assert.equal(summary.inPipeline, 2);
  assert.equal(summary.waitingPaymentCount, 1);
  assert.equal(summary.waitingPaymentTotal, 210);
  assert.equal(summary.needsAttention, 1);

  const searched = buildRenewalBoard(contracts, { customers, todayStr: '2026-10-09', filters: { search: 'ana' } });
  assert.deepEqual(searched.columns.map(column => column.items.length), [1, 0, 0, 0, 0, 0]);
  const hidden = buildRenewalBoard(contracts, { customers, todayStr: '2026-10-09', filters: { hideCompleted: true } });
  assert.equal(hidden.columns.length, 4);
  const byCoach = buildRenewalBoard(contracts, { customers, todayStr: '2026-10-09', filters: { coachId: 'k2' } });
  assert.deepEqual(byCoach.columns.map(column => column.items.length), [0, 0, 0, 1, 0, 0]);
});

test('the timeline keeps the renewal story and the related events of the previous contract', () => {
  const rows = buildRenewalTimeline({
    contract: { id: 'child' },
    parent: { id: 'parent' },
    contractEvents: [
      { id: 1, contract_id: 'child', event_type: 'renewal_message_sent', notes: 'Mensagem enviada', created_at: '2026-10-03T10:00:00Z' },
      { id: 2, contract_id: 'parent', event_type: 'renewal_drafted', notes: 'Rascunho', created_at: '2026-10-01T10:00:00Z' },
      { id: 3, contract_id: 'parent', event_type: 'leave_started', notes: 'Licença', created_at: '2026-09-01T10:00:00Z' },
      { id: 4, contract_id: 'other', event_type: 'created', created_at: '2026-10-01T10:00:00Z' },
    ],
    saleEvents: [{ id: 9, order_id: 'child', reason: 'Venda aberta', created_at: '2026-10-04T10:00:00Z' }],
  });
  assert.deepEqual(rows.map(row => row.title), ['Financeiro', 'Mensagem de renovação enviada', 'Rascunho de renovação criado']);
  assert.equal(rows[2].fromParent, true);
});

test('a change answer opens the plan or coach change of the renewal contract', () => {
  assert.equal(renewalChangeHref('c1', 'plan'), '/assessoria/contratos/c1?ajustar-plano=1');
  assert.equal(renewalChangeHref('c1', 'coach'), '/assessoria/contratos/c1?trocar-coach=1');
  assert.equal(renewalChangeHref('c1', 'other'), null);
  assert.equal(renewalChangeHref('', 'plan'), null);
});

test('only a renewal still waiting for the plan or coach change counts as awaiting it', () => {
  const waiting = { renewal_stage: 'waiting_response', renewal_response_code: 'change_plan_or_coach' };
  assert.equal(awaitsRenewalChange(waiting), true);
  assert.equal(awaitsRenewalChange({ ...waiting, renewal_stage: 'charge_pending' }), false);
  assert.equal(awaitsRenewalChange({ ...waiting, renewal_response_code: 'thinking' }), false);
  assert.equal(awaitsRenewalChange(null), false);
});
