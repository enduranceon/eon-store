import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commissionFormFromProduct,
  commissionPayload,
  commissionPerUnit,
  commissionRuleLabel,
  estimateOrderCommission,
  summarizeOrderCommissions,
} from './product-commission.js';

const NBSP = /\u00a0/g;
const plain = text => String(text).replace(NBSP, ' ');

test('the product form keeps percent, fixed value or no commission', () => {
  assert.deepEqual(commissionFormFromProduct({}), { type: 'none', value: '' });
  assert.deepEqual(commissionFormFromProduct({ commission_type: 'percent', commission_value: 10 }), { type: 'percent', value: '10' });
  assert.deepEqual(commissionPayload({ type: 'none', value: '5' }), { commission_type: null, commission_value: null });
  assert.deepEqual(commissionPayload({ type: 'percent', value: '7,5' }), { commission_type: 'percent', commission_value: 7.5 });
  assert.deepEqual(commissionPayload({ type: 'fixed', value: '15' }), { commission_type: 'fixed', commission_value: 15 });
  assert.ok(commissionPayload({ type: 'percent', value: '120' }).error);
  assert.ok(commissionPayload({ type: 'fixed', value: '' }).error);
  assert.ok(commissionPayload({ type: 'fixed', value: '0' }).error);
});

test('rules read as people say them', () => {
  assert.equal(commissionRuleLabel({ commission_type: 'percent', commission_value: 7.5 }), '7,5% do valor pago');
  assert.equal(plain(commissionRuleLabel({ commission_type: 'fixed', commission_value: 15 })), 'R$ 15,00 por unidade');
  assert.equal(plain(commissionRuleLabel({ commission_type: 'fixed', commission_value: 15 }, { short: true })), 'R$ 15,00/un.');
  assert.equal(commissionRuleLabel({}), 'Sem comissão');
  assert.equal(commissionPerUnit({ commission_type: 'percent', commission_value: 10 }, 129.9), 12.99);
  assert.equal(commissionPerUnit({ commission_type: 'fixed', commission_value: 15 }, 129.9), 15);
});

test('the estimate follows the database: paid value per item, discount spread, cancelled items out', () => {
  const order = {
    total_value: 216,
    items: [
      { product_id: 'gel', product_name: 'Gel', quantity: 1, sale_price: 100 },
      { product_id: 'meia', product_name: 'Meia', quantity: 2, sale_price: 50 },
      { product_id: 'bone', product_name: 'Boné', quantity: 1, sale_price: 40 },
      { product_id: 'gel', product_name: 'Gel cancelado', quantity: 1, sale_price: 100, cancelled: true },
    ],
  };
  const rules = {
    gel: { commission_type: 'percent', commission_value: 10 },
    meia: { commission_type: 'fixed', commission_value: 15 },
  };
  const estimate = estimateOrderCommission(order, rules);
  assert.deepEqual(estimate.rows.map(row => [row.product_name, row.base, row.amount]), [['Gel', 90, 9], ['Meia', 90, 30]]);
  assert.equal(estimate.total, 39);
  // Pré-venda com adicionais.
  const presale = estimateOrderCommission(
    { total_value: 220, items: [{ product_id: 'gel', quantity: 2, sale_price: 100, extras_total: 10 }] },
    rules,
  );
  assert.equal(presale.total, 22);
});

test('the order summary shows each coach balance and every entry', () => {
  const coaches = { a: { name: 'Coach A' }, b: { name: 'Coach B' } };
  const summary = summarizeOrderCommissions([
    { id: '1', coach_id: 'a', amount: '9.00', item_index: 0, kind: 'commission', commission_type: 'percent', commission_value: 10, competence: '2026-09-01', created_at: '2026-09-15T10:00:00Z', closing_id: 'x' },
    { id: '2', coach_id: 'a', amount: '-9.00', item_index: 0, kind: 'adjustment', commission_type: 'percent', commission_value: 10, competence: '2026-10-01', created_at: '2026-10-02T10:00:00Z', closing_id: null },
    { id: '3', coach_id: 'b', amount: '9.00', item_index: 0, kind: 'commission', commission_type: 'percent', commission_value: 10, competence: '2026-09-01', created_at: '2026-10-02T10:00:00Z', closing_id: null },
  ], coaches);
  assert.deepEqual(summary.balances.map(row => [row.coachName, row.amount]), [['Coach B', 9], ['Coach A', 0]]);
  assert.equal(summary.total, 9);
  assert.deepEqual(summary.list.map(row => [row.id, row.statusLabel, row.competenceLabel]), [
    ['1', 'No fechamento', 'set/2026'],
    ['2', 'Aguardando fechamento', 'out/2026'],
    ['3', 'Aguardando fechamento', 'set/2026'],
  ]);
});
