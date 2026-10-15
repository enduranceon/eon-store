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
  const two = [{ label: 'Camiseta fictícia', quantity: 1 }, { label: 'Boné fictício', quantity: 1 }];
  assert.equal(chargeReference({ sourceType: 'presale', orderNumber: 'PED-TESTE', items: two }), 'do seu pedido');
  assert.equal(
    chargeReference({ sourceType: 'stock', orderNumber: 'EST-TESTE', items: [{ label: 'Boné fictício', quantity: 1 }] }),
    'do seu pedido (Boné fictício)',
    'sem o número interno',
  );
  assert.equal(
    chargeReference({ sourceType: 'stock', items: [{ label: 'Boné fictício', quantity: 2 }] }),
    'do seu pedido (Boné fictício x2)',
  );
  assert.equal(
    chargeReference({ sourceType: 'event', orderNumber: 'INS-TESTE', items: [{ label: 'Prova fictícia 10 km', quantity: 1 }] }),
    'da sua inscrição (Prova fictícia 10 km)',
  );
  assert.equal(chargeReference({ sourceType: 'stock' }), 'do seu pedido');
});

test('a lista de itens só aparece com mais de um item', () => {
  const one = [{ label: 'Boné fictício', quantity: 1 }];
  const two = [...one, { label: 'Camiseta fictícia', quantity: 1 }];
  assert.equal(itemsBlock(one, '- Boné fictício x1'), '');
  assert.equal(itemsBlock(two, '- Boné fictício x1\n- Camiseta fictícia x1'), 'Itens:\n- Boné fictício x1\n- Camiseta fictícia x1\n\n');
  assert.equal(itemsBlock([], ''), '');
});
