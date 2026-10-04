import test from 'node:test';
import assert from 'node:assert/strict';
import { assessmentTenure, customerSinceDate } from './student-tenure.js';

const today = '2026-10-04';

test('days in the assessment add up each plan up to today and skip the gaps between plans', () => {
  const contracts = [
    { status: 'finished', payment_status: 'paid', start_date: '2020-10-15', end_date: '2021-01-15' },
    { status: 'finished', payment_status: 'paid', start_date: '2021-01-15', end_date: '2021-04-15' },
    { status: 'active', payment_status: 'paid', start_date: '2026-08-01', end_date: '2026-11-01' },
  ];

  assert.deepEqual(assessmentTenure({ contracts, today }), { days: 92 + 90 + 65, since: '2020-10-15' });
});

test('discarded sales, drafts and parallel plans do not inflate the days; a cancellation counts until its last day', () => {
  const contracts = [
    {
      status: 'cancelled', payment_status: 'paid', payment_date: '2026-01-01',
      start_date: '2026-01-01', end_date: '2026-07-01', cancellation_date: '2026-03-31',
    },
    { status: 'finished', payment_status: 'paid', start_date: '2026-02-01', end_date: '2026-03-01' },
    { status: 'voided', payment_status: 'cancelled', start_date: '2025-01-01', end_date: '2025-02-01' },
    {
      status: 'cancelled', payment_status: 'cancelled',
      start_date: '2025-06-01', end_date: '2025-07-01', cancellation_date: '2025-06-10',
    },
    { status: 'draft', parent_contract_id: 'c-1', start_date: '2026-07-01', end_date: '2026-08-01' },
  ];

  assert.deepEqual(assessmentTenure({ contracts, today }), { days: 90, since: '2026-01-01' });
});

test('leaves are taken out of the days, including the one still running', () => {
  const contracts = [{ status: 'on_leave', payment_status: 'paid', start_date: '2026-06-01', end_date: '2026-12-01' }];
  const leaves = [
    { status: 'finished', start_date: '2026-07-01', end_date: '2026-07-10', days: 10 },
    { status: 'active', start_date: '2026-10-01', end_date: null, days: null },
    { status: 'active', start_date: '2026-12-10', end_date: null, days: null },
  ];

  assert.deepEqual(assessmentTenure({ contracts, leaves, today }), { days: 126 - 10 - 4, since: '2026-06-01' });
});

test('a person without a started plan has no days in the assessment', () => {
  assert.deepEqual(assessmentTenure({ contracts: [], today }), { days: 0, since: '' });
  assert.deepEqual(
    assessmentTenure({ contracts: [{ status: 'scheduled', payment_status: 'paid', start_date: '2026-11-01', end_date: '2026-12-01' }], today }),
    { days: 0, since: '' },
  );
});

test('customer since is the first started plan or paid purchase, and falls back to the registration date', () => {
  const customer = { created_date: '2026-07-27T12:00:00Z' };
  const oldPlan = { status: 'finished', payment_status: 'paid', start_date: '2020-10-15', end_date: '2021-01-15' };
  const futurePlan = { status: 'scheduled', payment_status: 'paid', start_date: '2026-11-01', end_date: '2026-12-01' };
  const orders = [
    { payment_status: 'paid', created_date: '2021-01-28T12:00:00Z' },
    { payment_status: 'pending', created_date: '2019-05-01T12:00:00Z' },
    { payment_status: 'cancelled', created_date: '2019-01-01T12:00:00Z' },
  ];

  assert.equal(customerSinceDate({ customer, contracts: [oldPlan, futurePlan], orders, today }), '2020-10-15');
  assert.equal(customerSinceDate({ customer, contracts: [futurePlan], orders, today }), '2021-01-28');
  assert.equal(customerSinceDate({ customer, contracts: [futurePlan], orders: [], today }), '2026-07-27');
});
