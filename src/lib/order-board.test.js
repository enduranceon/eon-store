import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrderBoard,
  nextFulfillmentStep,
  orderBoardColumn,
  orderCardSignals,
} from './order-board.js';

const order = (fields = {}) => ({
  id: fields.order_number || 'x', type: 'stock', total: 100, created_date: '2026-10-01T15:00:00Z', ...fields,
});

test('each order lands in the column of the next thing to do', () => {
  assert.equal(orderBoardColumn(order({ payment_status: 'awaiting_charge', delivery_status: 'awaiting_delivery' })), 'awaiting_charge');
  assert.equal(orderBoardColumn(order({ payment_status: null })), 'awaiting_charge');
  assert.equal(orderBoardColumn(order({ payment_status: 'charge_sent' })), 'charge_sent');
  assert.equal(orderBoardColumn(order({ payment_status: 'overdue' })), 'charge_sent');
  assert.equal(orderBoardColumn(order({ payment_status: 'partially_paid' })), 'charge_sent');
  assert.equal(orderBoardColumn(order({ payment_status: 'paid', delivery_status: 'awaiting_delivery' })), 'to_separate');
  assert.equal(orderBoardColumn(order({ payment_status: 'paid', delivery_status: null })), 'to_separate');
  assert.equal(orderBoardColumn(order({ type: 'presale', payment_status: 'paid', delivery_status: 'awaiting_supplier' })), 'supplier');
  assert.equal(orderBoardColumn(order({ type: 'presale', payment_status: 'paid', delivery_status: 'supplier_ordered' })), 'supplier');
  assert.equal(orderBoardColumn(order({ type: 'presale', payment_status: 'paid', delivery_status: null })), 'supplier');
  assert.equal(orderBoardColumn(order({ type: 'presale', payment_status: 'paid', delivery_status: 'received' })), 'to_separate');
  assert.equal(orderBoardColumn(order({ payment_status: 'paid', delivery_status: 'separated' })), 'ready');
  assert.equal(orderBoardColumn(order({ payment_status: 'paid', delivery_status: 'delivered' })), 'delivered');
  assert.equal(orderBoardColumn(order({ payment_status: 'cancelled', delivery_status: 'cancelled' })), 'cancelled');
  assert.equal(orderBoardColumn(order({ payment_status: 'refunded', delivery_status: 'delivered' })), 'cancelled');
  assert.equal(orderBoardColumn(order({ payment_status: 'paid', delivery_status: 'cancelled' })), 'cancelled');
  // Separado ou entregue sem pagamento fica na entrega, com o selo de pagamento.
  assert.equal(orderBoardColumn(order({ payment_status: 'charge_sent', delivery_status: 'separated' })), 'ready');
});

test('the card only offers the next delivery step, never a payment', () => {
  assert.equal(nextFulfillmentStep(order({ payment_status: 'charge_sent', delivery_status: 'awaiting_delivery' })), null);
  assert.deepEqual(nextFulfillmentStep(order({ payment_status: 'paid', delivery_status: 'awaiting_delivery' })),
    { status: 'separated', short: 'Separado', label: 'Marcar como separado', needsDate: false, needsShipment: false });
  assert.deepEqual(nextFulfillmentStep(order({ payment_status: 'paid', delivery_status: 'separated' })),
    { status: 'delivered', short: 'Entregue', label: 'Marcar como entregue', needsDate: true, needsShipment: false });
  assert.equal(nextFulfillmentStep(order({ type: 'presale', payment_status: 'paid', delivery_status: null })).status, 'supplier_ordered');
  assert.equal(nextFulfillmentStep(order({ type: 'presale', payment_status: 'paid', delivery_status: 'supplier_ordered' })).status, 'received');
  assert.equal(nextFulfillmentStep(order({ type: 'presale', payment_status: 'paid', delivery_status: 'received' })).status, 'separated');
  assert.equal(nextFulfillmentStep(order({ payment_status: 'paid', delivery_status: 'delivered' })), null);
  assert.equal(nextFulfillmentStep(order({ payment_status: 'cancelled', delivery_status: 'cancelled' })), null);
});

test('an order with shipping is shipped before it is delivered', () => {
  const separated = order({ payment_status: 'paid', delivery_status: 'separated', delivery_method: 'shipping' });
  assert.equal(orderBoardColumn(separated), 'ready');
  assert.deepEqual(nextFulfillmentStep(separated),
    { status: 'shipped', short: 'Enviado', label: 'Marcar como enviado', needsDate: false, needsShipment: true });
  // Retirada continua indo direto para Entregue.
  assert.equal(nextFulfillmentStep(order({ payment_status: 'paid', delivery_status: 'separated', delivery_method: 'pickup' })).status, 'delivered');
  const shipped = order({ type: 'presale', payment_status: 'paid', delivery_status: 'shipped', delivery_method: 'shipping' });
  assert.equal(orderBoardColumn(shipped), 'shipped');
  assert.equal(nextFulfillmentStep(shipped).status, 'delivered');
  assert.equal(nextFulfillmentStep(shipped).needsDate, true);
  assert.equal(orderCardSignals(order({ payment_status: 'charge_sent', delivery_status: 'shipped' }), '2026-10-13').unpaid, true);
});

test('the shipping charge stays out of the board', () => {
  const board = buildOrderBoard([
    order({ order_number: 'P', payment_status: 'paid', delivery_status: 'shipped', delivery_method: 'shipping' }),
    order({ order_number: 'F', payment_status: 'awaiting_charge', delivery_status: null, shipping_parent_type: 'stock', shipping_parent_id: 'P' }),
  ], { today: '2026-10-13' });
  const byId = Object.fromEntries(board.columns.map(column => [column.id, column]));
  assert.deepEqual(byId.shipped.items.map(item => item.order.order_number), ['P']);
  assert.equal(byId.awaiting_charge.items.length, 0);
});

test('days and flags are counted in São Paulo dates', () => {
  const late = orderCardSignals(order({ payment_status: 'charge_sent', due_date: '2026-10-10', status_changed_at: '2026-10-08T02:30:00Z' }), '2026-10-13');
  assert.equal(late.overdueDays, 3);
  // 02:30 UTC de 08/10 ainda é 07/10 em São Paulo.
  assert.equal(late.daysInStage, 6);
  assert.equal(orderCardSignals(order({ payment_status: 'overdue', due_date: null }), '2026-10-13').overdueDays, 1);
  assert.equal(orderCardSignals(order({ payment_status: 'charge_sent', due_date: '2026-10-13' }), '2026-10-13').overdueDays, 0);
  assert.equal(orderCardSignals(order({ payment_status: 'charge_sent', delivery_status: 'separated' }), '2026-10-13').unpaid, true);
  assert.equal(orderCardSignals(order({ payment_status: 'paid', delivery_status: 'separated' }), '2026-10-13').unpaid, false);
  // 01:00 UTC de 12/10 ainda é 11/10 em São Paulo: dois dias, não é mais novo.
  assert.equal(orderCardSignals(order({ created_date: '2026-10-12T01:00:00Z' }), '2026-10-13').isNew, false);
  assert.equal(orderCardSignals(order({ created_date: '2026-10-12T15:00:00Z' }), '2026-10-13').isNew, true);
});

test('the board hides old deliveries and cancelled orders unless asked', () => {
  const orders = [
    order({ order_number: 'A', payment_status: 'paid', delivery_status: 'awaiting_delivery', created_date: '2026-06-01T15:00:00Z' }),
    order({ order_number: 'B', payment_status: 'paid', delivery_status: 'awaiting_delivery', created_date: '2026-10-12T15:00:00Z' }),
    order({ order_number: 'C', payment_status: 'paid', delivery_status: 'delivered', delivery_date: '2026-10-11', total: 50 }),
    order({ order_number: 'D', payment_status: 'paid', delivery_status: 'delivered', delivery_date: '2026-08-01' }),
    order({ order_number: 'E', payment_status: 'cancelled', delivery_status: 'cancelled' }),
  ];
  const board = buildOrderBoard(orders, { today: '2026-10-13' });
  const byId = Object.fromEntries(board.columns.map(column => [column.id, column]));
  assert.equal(byId.cancelled, undefined);
  assert.equal(board.cancelled, 1);
  assert.equal(board.olderDelivered, 1);
  // O pedido mais novo vem primeiro, com o selo de novo.
  assert.deepEqual(byId.to_separate.items.map(item => item.order.order_number), ['B', 'A']);
  assert.deepEqual(byId.to_separate.items.map(item => item.signals.isNew), [true, false]);
  assert.equal(byId.to_separate.total, 200);
  assert.deepEqual(byId.delivered.items.map(item => item.order.order_number), ['C']);
  const withCancelled = buildOrderBoard(orders, { today: '2026-10-13', showCancelled: true });
  assert.equal(withCancelled.columns.at(-1).items[0].order.order_number, 'E');
});
