import assert from 'node:assert/strict';
import test from 'node:test';

import { projectInstallments } from './manual-payment-projection.js';

test('projects an editable date for every manual-payment installment', () => {
  const rows = projectInstallments({
    installments: 3,
    credit_days_first: 0,
    credit_days_between: 32,
  }, '2026-09-12', 100);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.value), [33.33, 33.33, 33.34]);
  assert.equal(rows[0].date, '2026-09-14');
  for (const row of rows) {
    assert.equal(row.date, row.due_date);
    assert.equal(row.date, row.credit_date);
  }
});
