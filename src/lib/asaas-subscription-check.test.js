import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billingTypeLabel,
  groupSubscriptionCheck,
  subscriptionCheckNote,
  subscriptionValueDiffers,
} from './asaas-subscription-check.js';

const row = (overrides) => ({
  contract_id: 'c1',
  customer_name: 'Pessoa',
  end_date: '2026-11-10',
  expected_value: 210,
  status: 'subscription',
  subscription: { id: 'sub_teste123', value: 210 },
  ...overrides,
});

test('results are grouped as found, to review and without subscription, by end date', () => {
  const groups = groupSubscriptionCheck([
    row({ contract_id: 'late', end_date: '2026-11-20' }),
    row({ contract_id: 'none', status: 'no_customer', subscription: undefined }),
    row({ contract_id: 'early', end_date: '2026-11-04' }),
    row({ contract_id: 'error', status: 'asaas_error', subscription: undefined }),
    row({ contract_id: 'inactive', status: 'no_subscription', subscription: undefined }),
  ]);
  assert.deepEqual(groups.map(group => group.key), ['found', 'review', 'none']);
  assert.deepEqual(groups[0].items.map(item => item.contract_id), ['early', 'late']);
  assert.deepEqual(groups[2].items.map(item => item.contract_id).sort(), ['inactive', 'none']);
});

test('empty groups are left out', () => {
  assert.deepEqual(groupSubscriptionCheck([row({ status: 'no_customer' })]).map(group => group.key), ['none']);
  assert.deepEqual(groupSubscriptionCheck([]), []);
});

test('a different value in Asaas is flagged', () => {
  assert.equal(subscriptionValueDiffers(row()), false);
  assert.equal(subscriptionValueDiffers(row({ subscription: { id: 'sub_x1234', value: 189 } })), true);
  assert.equal(subscriptionValueDiffers(row({ status: 'no_customer', subscription: undefined })), false);
});

test('each status that is not a single subscription explains itself', () => {
  for (const status of ['multiple', 'asaas_error', 'no_document', 'no_subscription', 'no_customer']) {
    assert.ok(subscriptionCheckNote({ status }), status);
  }
  assert.equal(subscriptionCheckNote({ status: 'subscription' }), null);
});

test('billing types read in Portuguese', () => {
  assert.equal(billingTypeLabel('CREDIT_CARD'), 'Cartão');
  assert.equal(billingTypeLabel('UNDEFINED'), 'Pessoa escolhe');
  assert.equal(billingTypeLabel(null), null);
});
