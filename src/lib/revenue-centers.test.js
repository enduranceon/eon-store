import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultRevenueCenterId,
  revenueCenterLinksLabel,
  summarizeRevenueCenterLinks,
} from './revenue-centers.js';

const centers = [
  { id: 'assessoria', name: 'Assessoria', type: 'assessoria', active: true },
  { id: 'loja', name: 'Loja', type: 'loja', active: true },
  { id: 'lifestyle', name: 'Loja · Lifestyle', type: 'loja', active: false },
  { id: 'eventos', name: 'Eventos · Clínicas', type: 'eventos' },
];

test('each area defaults to its only active center', () => {
  assert.equal(defaultRevenueCenterId(centers, 'assessoria'), 'assessoria');
  assert.equal(defaultRevenueCenterId(centers, 'loja'), 'loja');
  // Sem o campo active, o centro conta como ativo, como no banco.
  assert.equal(defaultRevenueCenterId(centers, 'eventos'), 'eventos');
});

test('two active centers in the same area have no default', () => {
  const twoStores = centers.map(center => ({ ...center, active: true }));
  assert.equal(defaultRevenueCenterId(twoStores, 'loja'), '');
  assert.equal(defaultRevenueCenterId([], 'assessoria'), '');
  assert.equal(defaultRevenueCenterId(undefined, 'assessoria'), '');
});

test('links are counted per center and the ones without center stand apart', () => {
  const summary = summarizeRevenueCenterLinks({
    plans: [{ revenue_center_id: 'assessoria' }, { revenue_center_id: 'assessoria' }, { revenue_center_id: null }],
    products: [{ revenue_center_id: 'loja' }, { revenue_center_id: '' }],
    events: [{ revenue_center_id: 'eventos' }],
  });
  assert.deepEqual(summary.byCenter, {
    assessoria: { plans: 2, products: 0, events: 0 },
    loja: { plans: 0, products: 1, events: 0 },
    eventos: { plans: 0, products: 0, events: 1 },
  });
  assert.deepEqual(summary.unassigned, { plans: 1, products: 1, events: 0 });
});

test('the label lists only what is linked', () => {
  assert.equal(revenueCenterLinksLabel({ plans: 21, products: 0, events: 0 }), '21 planos');
  assert.equal(revenueCenterLinksLabel({ plans: 1, products: 58, events: 1 }), '1 plano · 58 produtos · 1 evento');
  assert.equal(revenueCenterLinksLabel({ plans: 0, products: 0, events: 0 }), '');
  assert.equal(revenueCenterLinksLabel(undefined), '');
});
