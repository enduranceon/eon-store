import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canChangeProrata,
  contractProrata,
  prorataCycleEnd,
  prorataFullPrice,
  prorataPreview,
} from './assessment-prorata.js';

const contract = (overrides = {}) => ({
  start_date: '2026-10-28',
  status: 'draft',
  payment_status: 'charge_sent',
  manual_payment: false,
  payment_date: null,
  asaas_charge_id: null,
  plan_snapshot: { price_total: 210, period_months: 1 },
  ...overrides,
});

test('the cycle ends on the next cycle day after the start', () => {
  assert.equal(prorataCycleEnd('2026-10-28', 7), '2026-11-07');
  assert.equal(prorataCycleEnd('2026-10-05', 7), '2026-10-07');
  assert.equal(prorataCycleEnd('2026-12-20', 1), '2027-01-01');
  assert.equal(prorataCycleEnd('2026-01-31', 28), '2026-02-28');
  assert.equal(prorataCycleEnd('2026-10-28', 29), null);
});

test('the value is the monthly price over 30 days times the days', () => {
  assert.deepEqual(prorataPreview(contract(), 7), {
    start: '2026-10-28', end: '2026-11-07', days: 10, full: 210, value: 70,
  });
  assert.equal(prorataPreview(contract(), 1).value, 28);
  assert.equal(prorataPreview(contract(), 28), null, 'the start day itself is not a pro rata');
});

test('a contract already in pro rata is recomputed from the full price', () => {
  const current = contract({ plan_snapshot: { price_total: 70, prorata: { cycle_day: 7, days: 10, full_price_total: 210 } } });
  assert.equal(prorataFullPrice(current), 210);
  assert.equal(contractProrata(current).cycle_day, 7);
  assert.equal(prorataPreview(current, 15).value, 126);
  assert.equal(contractProrata(contract()), null);
});

test('the pro rata only changes on unpaid monthly contracts without renewal', () => {
  assert.equal(canChangeProrata(contract(), { monthly: true }), true);
  assert.equal(canChangeProrata(contract(), { monthly: false }), false);
  assert.equal(canChangeProrata(contract({ payment_status: 'paid' }), { monthly: true }), false);
  assert.equal(canChangeProrata(contract({ manual_payment: true }), { monthly: true }), false);
  assert.equal(canChangeProrata(contract({ status: 'finished' }), { monthly: true }), false);
  assert.equal(canChangeProrata(contract(), { monthly: true, hasRenewal: true }), false);
});
