import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeReference, itemsBlock, overdueDaysText } from './billing-message.js';

test('dias de atraso no singular, no plural e vazio antes de vencer', () => {
  assert.equal(overdueDaysText(1), '1 dia');
  assert.equal(overdueDaysText(4), '4 dias');
  assert.equal(overdueDaysText(0), '');
  assert.equal(overdueDaysText(-2), '');
  assert.equal(overdueDaysText(null), '');
});

test('referência da cobrança por tipo de venda', () => {
  assert.equal(
    chargeReference({ sourceType: 'contract', orderNumber: 'ASS-TESTE', planLabel: 'Corrida - Trimestral' }),
    'referente ao seu plano Corrida - Trimestral (ASS-TESTE)',
  );
  assert.equal(chargeReference({ sourceType: 'contract', orderNumber: 'ASS-TESTE' }), 'referente ao seu contrato ASS-TESTE');
  assert.equal(chargeReference({ sourceType: 'stock', orderNumber: 'EST-TESTE' }), 'do seu pedido', 'sem o número interno');
  assert.equal(chargeReference({ sourceType: 'presale', orderNumber: 'PED-TESTE' }), 'do seu pedido');
  assert.equal(chargeReference({ sourceType: 'event', orderNumber: 'INS-TESTE' }), 'da sua inscrição');
  assert.equal(chargeReference({ sourceType: 'stock', orderNumber: 'EST-TESTE', shippingCharge: true }), 'do frete do seu pedido');
});

test('a lista de itens aparece sempre que há itens', () => {
  assert.equal(itemsBlock('- Boné fictício x1'), 'Itens:\n- Boné fictício x1\n\n');
  assert.equal(itemsBlock(''), '');
});
