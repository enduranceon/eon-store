import test from 'node:test';
import assert from 'node:assert/strict';
import { maskCnpj, validateCnpj } from './utils.js';

test('a CNPJ is masked while typing and checked by its digits', () => {
  assert.equal(maskCnpj('11222333000181'), '11.222.333/0001-81');
  assert.equal(maskCnpj('11222'), '11.222');
  assert.equal(maskCnpj('11.222.333/0001-81999'), '11.222.333/0001-81');
  assert.equal(validateCnpj('11.222.333/0001-81'), true);
  assert.equal(validateCnpj('11.222.333/0001-82'), false);
  assert.equal(validateCnpj('11111111111111'), false);
  assert.equal(validateCnpj('529.982.247-25'), false, 'a CPF is not a CNPJ');
});
