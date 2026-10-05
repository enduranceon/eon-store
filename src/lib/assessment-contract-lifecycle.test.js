import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContractLifecycleRows,
  hasFullContractRefund,
  opensChargeMessageAfterRegister,
} from './assessment-contract-lifecycle.js';

const TODAY = '2026-10-05';

function contract(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    customer_id: overrides.customer_id || 'student',
    status: 'cancelled',
    payment_status: 'paid',
    manual_payment: true,
    start_date: '2026-07-01',
    end_date: '2027-01-01',
    cancellation_date: '2026-08-30',
    created_at: '2026-07-01T12:00:00.000Z',
    plan_snapshot: { price_total: 1110 },
    ...overrides,
  };
}

const lifecycleOf = (rows, id) => rows.find(row => row.id === id).lifecycle;

test('a paid cancellation with a partial refund counts as a real exit', () => {
  const rows = buildContractLifecycleRows([
    contract({ id: 'partial', cancellation_fee: 112.5, refund_status: 'done', refund_amount: 637.5 }),
  ], { today: TODAY });

  const lifecycle = lifecycleOf(rows, 'partial');
  assert.equal(lifecycle.type, 'real_exit');
  assert.equal(lifecycle.counts.exit, true);
});

test('a full refund undoes the sale and stays out of the exits', () => {
  const rows = buildContractLifecycleRows([
    contract({ id: 'full', refund_status: 'done', refund_amount: 1110 }),
  ], { today: TODAY });

  const lifecycle = lifecycleOf(rows, 'full');
  assert.equal(lifecycle.type, 'financial_adjustment');
  assert.equal(lifecycle.counts.exit, false);
});

test('a partial refund followed by a new contract is a plan change, not an exit', () => {
  const rows = buildContractLifecycleRows([
    contract({ id: 'old-plan', customer_id: 'changer', refund_status: 'done', refund_amount: 300 }),
    contract({
      id: 'new-plan',
      customer_id: 'changer',
      status: 'active',
      cancellation_date: null,
      start_date: '2026-08-30',
      end_date: '2027-02-28',
      created_at: '2026-08-30T12:00:00.000Z',
    }),
  ], { today: TODAY });

  assert.equal(lifecycleOf(rows, 'old-plan').counts.exit, false);
});

test('an older contract recorded later is not a replacement for a cancellation', () => {
  const rows = buildContractLifecycleRows([
    contract({
      id: 'cancelled',
      customer_id: 'migrated',
      start_date: '2026-09-02',
      end_date: '2026-12-02',
      cancellation_date: '2026-09-24',
      plan_snapshot: { price_total: 585 },
      cancellation_fee: 133.53,
      refund_status: 'done',
      refund_amount: 311.58,
    }),
    contract({
      id: 'previous-term',
      customer_id: 'migrated',
      status: 'finished',
      start_date: '2026-06-02',
      end_date: '2026-09-02',
      cancellation_date: null,
      created_at: '2026-10-01T12:00:00.000Z',
    }),
  ], { today: TODAY });

  const lifecycle = lifecycleOf(rows, 'cancelled');
  assert.equal(lifecycle.type, 'real_exit');
  assert.equal(lifecycle.counts.exit, true);
});

test('the full refund check compares with what the student paid', () => {
  const plan = { plan_snapshot: { price_total: 1080 }, enrollment_fee: 39.9 };
  assert.equal(hasFullContractRefund({ ...plan, refund_amount: 1119.9 }), true);
  assert.equal(hasFullContractRefund({ ...plan, refund_amount: 603.87 }), false);
  assert.equal(hasFullContractRefund({ ...plan, refund_status: 'pending' }), false);
  assert.equal(hasFullContractRefund({ payment_status: 'refunded' }), true);
});

test('the charge message opens after registering the charge until it is sent', () => {
  assert.equal(opensChargeMessageAfterRegister({ id: 'new' }), true);
  assert.equal(opensChargeMessageAfterRegister({ id: 'renewal', parent_contract_id: 'old' }), true);
  assert.equal(opensChargeMessageAfterRegister({ id: 'sent', payment_message_sent_at: '2026-10-05T12:00:00Z' }), false);
  // Na renovação automática a cobrança sai pela assinatura.
  assert.equal(opensChargeMessageAfterRegister({ id: 'auto', parent_contract_id: 'old', auto_renewal: true }), false);
  // A flag de renovação automática num contrato novo não muda o envio da cobrança dele.
  assert.equal(opensChargeMessageAfterRegister({ id: 'first', auto_renewal: true }), true);
  assert.equal(opensChargeMessageAfterRegister(null), false);
});
