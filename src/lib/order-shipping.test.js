import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentShippingCharge,
  isShippingCharge,
  parseShippingMoney,
  shipmentFormError,
  shippingChargeTag,
  shippingChargesByParent,
  shipsByCarrier,
} from './order-shipping.js';

test('only orders with shipping go through Shipped; the charge itself never ships', () => {
  assert.equal(shipsByCarrier({ delivery_method: 'shipping' }), true);
  assert.equal(shipsByCarrier({ delivery_method: 'pickup' }), false);
  assert.equal(shipsByCarrier({ delivery_method: null }), false);
  assert.equal(shipsByCarrier({ delivery_method: 'shipping', shipping_parent_id: 'p' }), false);
  assert.equal(isShippingCharge({ shipping_parent_id: 'p' }), true);
  assert.equal(isShippingCharge({}), false);
});

test('money accepts comma or dot and rejects text', () => {
  assert.equal(parseShippingMoney('30,50'), 30.5);
  assert.equal(parseShippingMoney('30.5'), 30.5);
  assert.equal(parseShippingMoney('1.234,56'), 1234.56);
  assert.equal(parseShippingMoney(' 0 '), 0);
  assert.equal(parseShippingMoney(34), 34);
  assert.ok(Number.isNaN(parseShippingMoney('')));
  assert.ok(Number.isNaN(parseShippingMoney('-3')));
  assert.ok(Number.isNaN(parseShippingMoney('trinta')));
});

test('the shipment form needs what was paid and what will be charged', () => {
  assert.equal(shipmentFormError({ cost: '30,50', price: '34' }), null);
  assert.equal(shipmentFormError({ cost: '30', price: '0' }), null);
  assert.equal(shipmentFormError({ cost: '', price: '34' }), 'Informe quanto você pagou no frete');
  assert.equal(shipmentFormError({ cost: '30', price: '' }), 'Informe quanto vai cobrar (0 para frete grátis)');
  assert.equal(shipmentFormError({ cost: '30', price: '200000' }), 'Informe quanto vai cobrar (0 para frete grátis)');
  assert.equal(shipmentFormError({ cost: '30', price: '', chargeExists: true }), null);
  assert.equal(shipmentFormError({ trackingCode: 'x'.repeat(81), cost: '30', price: '30' }), 'Código de rastreio muito longo');
});

test('the current charge is the latest one still open', () => {
  const cancelled = { id: 'a', payment_status: 'cancelled', created_date: '2026-10-21T12:00:00Z' };
  const open = { id: 'b', payment_status: 'awaiting_charge', created_date: '2026-10-20T12:00:00Z' };
  assert.equal(currentShippingCharge([cancelled, open]).id, 'b');
  assert.equal(currentShippingCharge([cancelled]).id, 'a');
  assert.equal(currentShippingCharge([]), null);
});

test('charges are grouped by the order they belong to', () => {
  const map = shippingChargesByParent([
    { id: 'x', shipping_parent_type: 'presale', shipping_parent_id: '1', payment_status: 'paid' },
    { id: 'y', shipping_parent_type: 'stock', shipping_parent_id: '1', payment_status: 'charge_sent' },
    { id: 'z', payment_status: 'paid' },
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get('presale:1').id, 'x');
  assert.equal(map.get('stock:1').id, 'y');
});

test('the order card says where the shipping charge is', () => {
  assert.deepEqual(shippingChargeTag({ payment_status: 'awaiting_charge' }), { label: 'Frete a cobrar', tone: 'amber' });
  assert.deepEqual(shippingChargeTag({ payment_status: 'charge_sent' }), { label: 'Frete cobrado', tone: 'blue' });
  assert.deepEqual(shippingChargeTag({ payment_status: 'overdue' }), { label: 'Frete cobrado', tone: 'blue' });
  assert.deepEqual(shippingChargeTag({ payment_status: 'paid' }), { label: 'Frete pago', tone: 'green' });
  assert.equal(shippingChargeTag({ payment_status: 'cancelled' }), null);
  assert.equal(shippingChargeTag(null), null);
});
