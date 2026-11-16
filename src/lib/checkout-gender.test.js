import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultGender, listGenders } from './checkout-gender.js';

const variation = (gender, size) => ({ name: gender ? `${gender} - ${size}` : size, gender, size });

test('listGenders lista cada gênero uma vez, na ordem das variações', () => {
  const variations = [
    variation('Masculino', 'PP'), variation('Masculino', 'P'),
    variation('Feminino', 'PP'), variation('Feminino', 'P'),
  ];
  assert.deepEqual(listGenders(variations), ['Masculino', 'Feminino']);
});

test('listGenders ignora variação sem gênero e aceita lista vazia ou ausente', () => {
  assert.deepEqual(listGenders([variation('', 'M'), variation(null, 'G')]), []);
  assert.deepEqual(listGenders([]), []);
  assert.deepEqual(listGenders(undefined), []);
  assert.deepEqual(listGenders(null), []);
});

test('produto só feminino já vem com o gênero escolhido', () => {
  const variations = ['PP', 'P', 'M', 'G', 'GG', 'XGG'].map(size => variation('Feminino', size));
  assert.equal(defaultGender(listGenders(variations)), 'Feminino');
});

test('produto com dois gêneros não escolhe pelo cliente', () => {
  const variations = [variation('Masculino', 'M'), variation('Feminino', 'M')];
  assert.equal(defaultGender(listGenders(variations)), null);
});

test('produto sem gênero não tem gênero escolhido', () => {
  assert.equal(defaultGender(listGenders([variation('', 'M')])), null);
  assert.equal(defaultGender([]), null);
  assert.equal(defaultGender(undefined), null);
});
