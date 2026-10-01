import assert from 'node:assert/strict';
import test from 'node:test';
import { payoutItemReference } from './analytics-metrics.js';

test('a closing item counts in its reference month', () => {
  assert.equal(payoutItemReference({ reference_competence: '2026-09-01', created_at: '2026-10-01T12:00:00Z' }), '2026-09-01');
  assert.equal(payoutItemReference({ reference_competence: '2026-06-01', closing: { competence: '2026-08-01' } }), '2026-06-01');
});

test('an older manual entry without reference counts in the closing month', () => {
  assert.equal(
    payoutItemReference({ reference_competence: null, closing: { competence: '2026-07-01' }, created_at: '2026-08-06T17:43:40Z' }),
    '2026-07-01',
  );
  assert.equal(payoutItemReference({ reference_competence: null, created_at: '2026-08-06T17:43:40Z' }), '2026-08-06T17:43:40Z');
});
