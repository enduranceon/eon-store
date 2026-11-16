import assert from 'node:assert/strict';
import test from 'node:test';

import { PICKUP_CITY, checkoutDelivery } from './checkout-delivery.js';

test('a única entrega é a retirada no treino coletivo de Florianópolis', () => {
  assert.equal(PICKUP_CITY, 'Florianópolis');
  assert.deepEqual(checkoutDelivery(), { method: 'pickup', city: 'Florianópolis' });
});

test('cada chamada devolve um objeto novo, que o chamador pode alterar sem afetar as outras', () => {
  const first = checkoutDelivery();
  first.city = 'Outra';
  assert.deepEqual(checkoutDelivery(), { method: 'pickup', city: 'Florianópolis' });
});
