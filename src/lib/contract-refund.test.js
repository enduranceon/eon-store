import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultAlreadyCredited,
  isCardRefundMethod,
  isDifferentFromCalculated,
  refundAllocationStatus,
  refundAllocationsPayload,
  refundMethodLabel,
} from './contract-refund.js';

const installments = [
  { id: 'p1', value: 373.3, credit_date: '2026-06-27' },
  { id: 'p2', value: 373.3, credit_date: '2026-07-27' },
  { id: 'p3', value: 373.3, credit_date: '2026-08-27' },
];

test('card refunds are split by installment; the others are one outflow', () => {
  assert.equal(isCardRefundMethod('card_asaas'), true);
  assert.equal(isCardRefundMethod('card_machine'), true);
  assert.equal(isCardRefundMethod('pix'), false);
  assert.equal(refundMethodLabel('card_asaas'), 'Estorno no cartão (Asaas)');
  assert.equal(refundMethodLabel('pix'), 'PIX');
});

test('an installment already credited on the refund day counts as received', () => {
  assert.equal(defaultAlreadyCredited('2026-07-27', '2026-08-03'), true);
  assert.equal(defaultAlreadyCredited('2026-08-03', '2026-08-03'), true);
  assert.equal(defaultAlreadyCredited('2026-08-27', '2026-08-03'), false);
  assert.equal(defaultAlreadyCredited(null, '2026-08-03'), false);
});

test('the split closes when the installments add up to the refund, to the cent', () => {
  // O caso do print: parcela 2 inteira e parte da 3.
  const done = refundAllocationStatus(installments, { p2: '373,30', p3: '230.57' }, '603.87');
  assert.deepEqual(
    { allocated: done.allocated, remaining: done.remaining, complete: done.complete },
    { allocated: 603.87, remaining: 0, complete: true },
  );

  const missing = refundAllocationStatus(installments, { p2: '373.30' }, '603.87');
  assert.equal(missing.remaining, 230.57);
  assert.equal(missing.complete, false);

  const over = refundAllocationStatus(installments, { p3: '400' }, '400');
  assert.equal(over.errors.p3, 'Acima do valor da parcela');
  assert.equal(over.complete, false);
});

test('only installments with a refunded value go to the API', () => {
  assert.deepEqual(
    refundAllocationsPayload(installments, { p1: '', p2: '373,30', p3: '230.57' }, { p2: true }),
    [
      { payment_id: 'p2', value: 373.3, already_credited: true },
      { payment_id: 'p3', value: 230.57, already_credited: false },
    ],
  );
});

test('a refund different from the calculated one is detected in cents', () => {
  assert.equal(isDifferentFromCalculated('603.87', 603.87), false);
  assert.equal(isDifferentFromCalculated('603,87', 603.87), false);
  assert.equal(isDifferentFromCalculated('600', 603.87), true);
});
