import assert from 'node:assert/strict';
import test from 'node:test';

import { isAwaitingCharge, isEffectiveOpenSale } from './sales.js';

test('distinguishes an order that needs a charge from one already sent to the customer', () => {
  const awaitingCharge = { payment_status: 'pending' };
  const sentCharge = {
    payment_status: 'pending',
    external_invoice_number: 'FAT-2026-001',
  };

  assert.equal(isAwaitingCharge(awaitingCharge), true);
  assert.equal(isEffectiveOpenSale(awaitingCharge), false);
  assert.equal(isAwaitingCharge(sentCharge), false);
  assert.equal(isEffectiveOpenSale(sentCharge), true);
});
