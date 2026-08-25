import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINANCIAL_MOVEMENT_KIND,
  financialQualityPath,
  isActualReceipt,
  movementAmount,
  toPaymentRecord,
} from './financial-ledger.js';

test('identifies an actual receipt without confusing it with a receivable', () => {
  assert.equal(isActualReceipt({ movement_kind: FINANCIAL_MOVEMENT_KIND.RECEIPT, is_actual: true }), true);
  assert.equal(isActualReceipt({ movement_kind: FINANCIAL_MOVEMENT_KIND.RECEIVABLE, is_actual: false }), false);
});

test('normalizes a canonical movement for legacy payment views', () => {
  const record = toPaymentRecord({
    movement_id: 'payment:1',
    movement_kind: FINANCIAL_MOVEMENT_KIND.RECEIPT,
    source: 'manual',
    status: 'CONFIRMED',
    order_id: 'order-1',
    order_type: 'contract',
    gross_amount: '120.50',
    net_amount: '117.00',
    scheduled_on: '2026-08-25',
    occurred_on: '2026-08-24',
    due_on: '2026-08-20',
    payment_method: 'PIX',
    reference: 'CTR-01',
    metadata: { installment_number: 1, total_installments: 3 },
  });

  assert.equal(record.id, 'payment:1');
  assert.equal(record.value, 120.5);
  assert.equal(record.net_value, 117);
  assert.equal(record.credit_date, '2026-08-25');
  assert.equal(record.total_installments, 3);
});

test('keeps amounts numeric and links quality rows to their operational source', () => {
  assert.equal(movementAmount({ gross_amount: '42.30' }), 42.3);
  assert.equal(movementAmount({ gross_amount: null }), 0);
  assert.equal(financialQualityPath({ order_type: 'presale', source_id: 'order-1' }), '/pedidos/order-1');
  assert.equal(financialQualityPath({ order_type: 'event', source_id: 'registration-1' }), '/eventos');
});
