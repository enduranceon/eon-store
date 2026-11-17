import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelOrderEffects, cancelOrderResultNotice } from './order-cancel-notice.js';

const LINK = 'https://www.asaas.com/i/939o9u67smmagwhq';

test('an external invoice link is not cancelled in Asaas; an API charge is', () => {
  assert.deepEqual(cancelOrderEffects({ external_payment_link: ` ${LINK} ` }), {
    delivered: false, apiCharge: false, externalLink: LINK,
  });
  assert.deepEqual(cancelOrderEffects({ asaas_charge_id: 'pay_1', external_payment_link: LINK }), {
    delivered: false, apiCharge: true, externalLink: null,
  });
  assert.equal(cancelOrderEffects({}).externalLink, null);
  assert.equal(cancelOrderEffects(null).delivered, false);
});

test('a delivered store order says the stock was not restocked', () => {
  const notice = cancelOrderResultNotice(
    { delivery_status: 'delivered', external_payment_link: LINK },
    { stock_restocked: 0 },
    'stock',
  );
  assert.match(notice.message, /não foi reposto/);
  assert.match(notice.message, /Devoluções/);
  assert.doesNotMatch(notice.message, /voltaram para o estoque/);
  assert.equal(notice.externalLink, LINK, 'the invoice to cancel in Asaas is handed back');
});

test('the stock message follows what the server restocked', () => {
  const restocked = cancelOrderResultNotice({ delivery_status: 'awaiting_delivery' }, { stock_restocked: 2 }, 'stock');
  assert.match(restocked.message, /As peças voltaram para o estoque/);
  assert.equal(restocked.externalLink, null);

  const nothingReserved = cancelOrderResultNotice({ delivery_status: 'awaiting_delivery' }, { stock_restocked: 0 }, 'stock');
  assert.equal(nothingReserved.message, 'Pedido cancelado.');
});

test('a pre-sale order never talks about restocking', () => {
  const notice = cancelOrderResultNotice(
    { delivery_status: 'delivered', external_payment_link: LINK },
    { stock_restocked: 0 },
    'presale',
  );
  assert.equal(notice.message, 'Pedido cancelado.');
  assert.equal(notice.externalLink, LINK);
});
