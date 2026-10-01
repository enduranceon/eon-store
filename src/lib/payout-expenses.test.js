import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPENSE_CATEGORIES, expenseCategoryLabel, manualEntryKind, signedManualAmount,
} from './payout-expenses.js';

test('the entry kind comes from the stored category', () => {
  assert.equal(manualEntryKind('repasse_extra'), 'repasse_extra');
  assert.equal(manualEntryKind('desconto'), 'desconto');
  assert.equal(manualEntryKind('reembolso_combustivel'), 'gasto');
  assert.equal(manualEntryKind('ajuste'), 'gasto');
  assert.equal(manualEntryKind(null), 'gasto');
});

test('a discount is stored negative and the rest positive', () => {
  assert.equal(signedManualAmount('desconto', '25.5'), -25.5);
  assert.equal(signedManualAmount('desconto', -25.5), -25.5);
  assert.equal(signedManualAmount('repasse_extra', '21'), 21);
  assert.equal(signedManualAmount('gasto', '62.11'), 62.11);
});

test('labels cover the new kinds, the expense list and older entries', () => {
  assert.equal(expenseCategoryLabel('repasse_extra'), 'Repasse extra');
  assert.equal(expenseCategoryLabel('desconto'), 'Desconto');
  assert.equal(expenseCategoryLabel('ajuste'), 'Ajuste');
  assert.equal(expenseCategoryLabel('escala_evento'), 'Escala / evento');
  assert.equal(expenseCategoryLabel(null), 'Ajuste');
  assert.ok(!EXPENSE_CATEGORIES.some((c) => ['repasse_extra', 'desconto', 'ajuste'].includes(c.value)));
});
