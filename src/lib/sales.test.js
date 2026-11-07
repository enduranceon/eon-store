import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAwaitingCharge,
  isEffectiveOpenSale,
  isOpenCollectionSale,
  isOpenSaleForFinancial,
  PAID_PAYMENT_STATUSES,
} from './sales.js';

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

test('includes an uncharged operational sale in the collection queue', () => {
  const awaitingCharge = { payment_status: 'awaiting_charge' };
  const sentCharge = { payment_status: 'charge_sent' };
  const cancelled = { payment_status: 'cancelled' };
  const unqualifiedDraft = {
    status: 'draft',
    payment_status: 'awaiting_charge',
    prospect_stage: 'new',
  };
  const billableDraft = {
    status: 'draft',
    payment_status: 'awaiting_charge',
    prospect_stage: 'proposal_ready',
    asaas_payment_link: 'https://asaas.com/i/example',
  };

  assert.equal(isOpenCollectionSale(awaitingCharge), true);
  assert.equal(isOpenCollectionSale(sentCharge), true);
  assert.equal(isOpenCollectionSale(cancelled), false);
  assert.equal(isOpenCollectionSale(unqualifiedDraft), false);
  assert.equal(isOpenCollectionSale(billableDraft), true);
});

test('a partially paid carnê keeps its open balance as an open sale', () => {
  const carne = { payment_status: 'partially_paid', status: 'active', external_payment_link: 'https://www.asaas.com/i/abc123def456' };
  assert.equal(isOpenCollectionSale(carne), true);
  assert.equal(isOpenSaleForFinancial(carne), true);
  // Continua contando como pago para tempo de casa e para "efetiva e paga".
  assert.equal(isEffectiveOpenSale(carne), false);
  assert.equal(PAID_PAYMENT_STATUSES.has('partially_paid'), true);
  assert.equal(isAwaitingCharge(carne), false);
});

test('a voided partially paid sale is not open', () => {
  assert.equal(isOpenCollectionSale({ payment_status: 'partially_paid', status: 'voided' }), false);
});
