import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeReference, overdueDaysText } from './billing-message.js';

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
  assert.equal(
    chargeReference({ sourceType: 'presale', orderNumber: 'PED-TESTE' }, 'Camiseta fictícia +1'),
    'referente ao seu pedido PED-TESTE (Camiseta fictícia +1)',
  );
  assert.equal(
    chargeReference({ sourceType: 'event', orderNumber: 'INS-TESTE' }, 'Prova fictícia 10 km'),
    'referente à sua inscrição INS-TESTE (Prova fictícia 10 km)',
  );
  assert.equal(chargeReference({ sourceType: 'stock' }), 'referente ao seu pedido');
});
