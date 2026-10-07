import test from 'node:test';
import assert from 'node:assert/strict';
import { communicationSendState } from './communication-case.js';

test('onboarding registra o envio sem telefone e antes da data', () => {
  const state = communicationSendState({
    purpose: 'onboarding', hasPhone: false, isFuture: true, ruleVersion: 2,
  });
  assert.equal(state.canRegister, true);
  assert.equal(state.early, true);
  assert.equal(state.block, null);
});

test('onboarding ignora a revisão automática de origem reaberta', () => {
  const state = communicationSendState({
    purpose: 'onboarding', caseBlock: 'source_reopened_review', hasPhone: true, ruleVersion: 1,
  });
  assert.equal(state.canRegister, true);
  assert.equal(state.block, null);
});

test('onboarding concluído, fora da regra ou sem modelo não registra', () => {
  for (const suggestionBlock of ['already_completed', 'onboarding_not_eligible', 'payment_changed']) {
    const state = communicationSendState({ purpose: 'onboarding', suggestionBlock, hasPhone: true, ruleVersion: 1 });
    assert.equal(state.canRegister, false, suggestionBlock);
    assert.equal(state.block, suggestionBlock);
  }
  assert.equal(communicationSendState({ purpose: 'onboarding', hasPhone: true, ruleVersion: null }).canRegister, false);
});

test('cobrança mantém as conferências de telefone, data e link', () => {
  const ok = { purpose: 'billing', hasPhone: true, ruleVersion: 3, hasPaymentLink: true };
  assert.equal(communicationSendState(ok).canRegister, true);
  assert.equal(communicationSendState({ ...ok, hasPhone: false }).canRegister, false);
  assert.equal(communicationSendState({ ...ok, isFuture: true }).canRegister, false);
  assert.equal(communicationSendState({ ...ok, hasPaymentLink: false }).canRegister, false);
  assert.equal(communicationSendState({ ...ok, hasPaymentLink: false, canSendWithoutLink: true }).canRegister, true);
  assert.equal(communicationSendState({ ...ok, suggestionBlock: 'source_resolved' }).canRegister, false);
});

test('renovação continua respeitando bloqueios e data', () => {
  const ok = { purpose: 'renewal', hasPhone: true, ruleVersion: 1 };
  assert.equal(communicationSendState(ok).canRegister, true);
  assert.equal(communicationSendState({ ...ok, caseBlock: 'renewal_review' }).canRegister, false);
  assert.equal(communicationSendState({ ...ok, isFuture: true }).canRegister, false);
});
