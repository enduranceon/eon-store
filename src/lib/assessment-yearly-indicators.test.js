import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssessmentYearlyIndicators,
  getAssessmentIndicatorYears,
} from './assessment-yearly-indicators.js';

const AS_OF = '2026-09-03';
const plans = [{ id: 'plan', price_monthly: 100 }];

function contract(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    customer_id: overrides.customer_id || crypto.randomUUID(),
    plan_id: 'plan',
    status: 'active',
    payment_status: 'paid',
    start_date: '2026-01-01',
    end_date: '2027-01-01',
    created_at: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

function month(indicators, key) {
  return indicators.months.find(item => item.key === key);
}

test('uses the contract start date instead of the creation date for monthly entries', () => {
  const indicators = buildAssessmentYearlyIndicators([
    contract({
      id: 'started-in-july',
      customer_id: 'student-july',
      start_date: '2026-07-20',
      created_at: '2026-08-02T14:00:00.000Z',
    }),
  ], plans, { year: 2026, asOf: AS_OF });

  assert.equal(month(indicators, '2026-07').entries, 1);
  assert.equal(month(indicators, '2026-08').entries, 0);
  assert.equal(month(indicators, '2026-01').available, false);
  assert.equal(month(indicators, '2026-09').isPartial, true);
  assert.equal(month(indicators, '2026-10').available, false);
});

test('does not count a future-dated contract before its actual start', () => {
  const indicators = buildAssessmentYearlyIndicators([
    contract({
      id: 'starts-tomorrow',
      customer_id: 'student-starts-tomorrow',
      start_date: '2026-09-04',
      created_at: '2026-09-03T12:00:00.000Z',
    }),
  ], plans, { year: 2026, asOf: AS_OF });

  const september = month(indicators, '2026-09');
  assert.equal(september.entries, 0);
  assert.equal(september.baseEnd, 0);
  assert.equal(september.mrr, 0);
});

test('keeps returns and renewals out of new entries', () => {
  const indicators = buildAssessmentYearlyIndicators([
    contract({ id: 'original', customer_id: 'returning-student', start_date: '2026-01-01', end_date: '2026-03-01', status: 'finished' }),
    contract({
      id: 'return',
      customer_id: 'returning-student',
      start_date: '2026-08-01',
      prospect_customer_relationship: 'former_student',
    }),
    contract({
      id: 'parent',
      customer_id: 'renewing-student',
      start_date: '2026-01-01',
      end_date: '2026-08-01',
      status: 'finished',
    }),
    contract({
      id: 'renewal',
      customer_id: 'renewing-student',
      start_date: '2026-08-01',
      parent_contract_id: 'parent',
    }),
  ], plans, { year: 2026, asOf: AS_OF });

  const august = month(indicators, '2026-08');
  assert.equal(august.entries, 0);
  assert.equal(august.returns, 1);
  assert.equal(august.renewals, 1);
});

test('counts only real exits and ignores replacements, refunds and voided sales', () => {
  const indicators = buildAssessmentYearlyIndicators([
    contract({
      id: 'real-exit',
      customer_id: 'student-exit',
      status: 'cancelled',
      start_date: '2026-05-01',
      end_date: '2026-12-01',
      cancellation_date: '2026-08-10',
    }),
    contract({
      id: 'plan-replaced',
      customer_id: 'student-replaced',
      status: 'cancelled',
      start_date: '2026-05-01',
      end_date: '2026-12-01',
      cancellation_date: '2026-08-10',
    }),
    contract({
      id: 'replacement',
      customer_id: 'student-replaced',
      start_date: '2026-08-10',
      end_date: '2027-08-10',
    }),
    contract({
      id: 'refunded',
      customer_id: 'student-refunded',
      status: 'cancelled',
      start_date: '2026-05-01',
      end_date: '2026-12-01',
      cancellation_date: '2026-08-12',
      refund_status: 'completed',
      refund_amount: 50,
    }),
    contract({
      id: 'voided',
      customer_id: 'student-voided',
      status: 'voided',
      payment_status: 'cancelled',
      start_date: '2026-08-04',
    }),
  ], plans, { year: 2026, asOf: AS_OF });

  const august = month(indicators, '2026-08');
  assert.equal(august.exits, 1);
  assert.equal(august.entries, 0);
});

test('uses the exclusive contract end date for the monthly base and recognizes non-renewal', () => {
  const indicators = buildAssessmentYearlyIndicators([
    contract({
      id: 'non-renewal',
      customer_id: 'student-non-renewal',
      status: 'finished',
      start_date: '2026-07-01',
      end_date: '2026-09-01',
      cancellation_date: '2026-09-01',
      cancellation_reason: 'Não renovou',
    }),
  ], plans, { year: 2026, asOf: AS_OF });

  assert.equal(month(indicators, '2026-08').baseEnd, 1);
  assert.equal(month(indicators, '2026-09').baseStart, 1);
  assert.equal(month(indicators, '2026-09').baseEnd, 0);
  assert.equal(month(indicators, '2026-09').exits, 1);
});

test('lists the current year together with historical contract years', () => {
  assert.deepEqual(getAssessmentIndicatorYears([
    contract({ start_date: '2024-08-01', end_date: '2025-08-01' }),
  ], new Date('2026-09-03T12:00:00')), [2026, 2025, 2024]);
});
