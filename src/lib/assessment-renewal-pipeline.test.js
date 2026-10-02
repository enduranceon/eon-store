import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowsAutoRenewal,
  businessDate,
  daysUntil,
  followUpLabel,
  isVisibleOnBoard,
  planPeriodMonths,
  renewalDueLabel,
  renewalDueNotice,
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

test('the Pebinha notice changes once the plan has ended', () => {
  assert.equal(renewalDueNotice('2026-10-17', '2026-10-07'), 'seu plano vence nos próximos dias');
  assert.equal(renewalDueNotice('2026-10-17', '2026-10-17'), 'seu plano vence nos próximos dias');
  assert.equal(renewalDueNotice('2026-10-05', '2026-10-09'), 'seu plano venceu em 05/10');
  assert.equal(renewalDueNotice('', '2026-10-09'), 'seu plano vence nos próximos dias');
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
