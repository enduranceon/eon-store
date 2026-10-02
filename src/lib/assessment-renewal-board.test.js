import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasRenewalPaymentLink,
  isVisibleOnRenewalBoard,
  needsRenewalReview,
  renewalDaysUntilEnd,
  renewalTerminalDaysRemaining,
  saoPauloDate,
} from './assessment-renewal-board.js';

test('an unresolved renewal remains visible after its parent contract expires', () => {
  const child = { renewal_stage: 'contact_pending', renewal_resolved_at: null };
  assert.equal(renewalDaysUntilEnd('2026-10-01', '2026-11-10'), -40);
  assert.equal(isVisibleOnRenewalBoard(child, '2026-11-10'), true);
});

test('terminal renewals remain through the fifth Sao Paulo calendar day', () => {
  const child = { renewal_stage: 'renewed', renewal_resolved_at: '2026-10-02T23:30:00-03:00' };
  assert.equal(isVisibleOnRenewalBoard(child, '2026-10-07'), true);
  assert.equal(renewalTerminalDaysRemaining(child, '2026-10-07'), 0);
  assert.equal(isVisibleOnRenewalBoard(child, '2026-10-08'), false);
});

test('terminal time follows Sao Paulo even near UTC midnight', () => {
  const child = { renewal_stage: 'not_renewed', renewal_resolved_at: '2026-10-03T01:30:00Z' };
  assert.equal(saoPauloDate(child.renewal_resolved_at), '2026-10-02');
  assert.equal(isVisibleOnRenewalBoard(child, '2026-10-07'), true);
  assert.equal(isVisibleOnRenewalBoard(child, '2026-10-08'), false);
});

test('a voided operational correction has no terminal board card', () => {
  assert.equal(isVisibleOnRenewalBoard({ renewal_stage: null }, '2026-10-02'), false);
});

test('terminal stage without resolution date remains visible for review', () => {
  const child = { renewal_stage: 'renewed', renewal_resolved_at: null, payment_status: 'paid' };
  assert.equal(isVisibleOnRenewalBoard(child, '2026-10-02'), true);
  assert.equal(needsRenewalReview(child), true);
});

test('subscription invoice id is not mistaken for a usable payment link', () => {
  assert.equal(hasRenewalPaymentLink({ asaas_charge_id: 'pay_1', external_invoice_number: 'INV-1' }), false);
  assert.equal(hasRenewalPaymentLink({ asaas_payment_link: 'https://example.test/pay' }), true);
});

test('financially inconsistent cards need review', () => {
  assert.equal(needsRenewalReview({ renewal_stage: 'waiting_payment', payment_status: 'paid', parent_contract_id: 'p' }), true);
  assert.equal(needsRenewalReview({ renewal_stage: 'renewed', payment_status: 'overdue', parent_contract_id: 'p' }), true);
  assert.equal(needsRenewalReview({ renewal_stage: 'waiting_payment', payment_status: 'overdue', parent_contract_id: 'p' }), false);
});
