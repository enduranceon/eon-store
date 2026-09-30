import assert from 'node:assert/strict';
import test from 'node:test';
import { coachHistorySegments, coachOnDay, pendingCoachChange } from './assessment-coach-history.js';

const contract = { startDate: '2026-06-01', endDate: '2026-12-01', today: '2026-09-30' };

const row = (id, coachId, startedAt, createdAt, extra = {}) => ({
  id, coach_id: coachId, started_at: startedAt, created_at: createdAt, ended_at: null, ...extra,
});

test('each day follows the last registered change already in force', () => {
  const rows = [
    row('1', 'A', '2026-06-01', '2026-06-01T10:00:00Z'),
    row('2', 'B', '2026-09-15', '2026-09-20T10:00:00Z'),
  ];
  assert.equal(coachOnDay(rows, '2026-09-14'), 'A');
  assert.equal(coachOnDay(rows, '2026-09-15'), 'B');
  assert.deepEqual(coachHistorySegments(rows, contract), [
    { coachId: 'A', from: '2026-06-01', to: '2026-09-14', current: false, scheduled: false },
    { coachId: 'B', from: '2026-09-15', to: '2026-11-30', current: true, scheduled: false },
  ]);
});

test('a scheduled change shows as a future segment and is pending', () => {
  const rows = [
    row('1', 'A', '2026-06-01', '2026-06-01T10:00:00Z'),
    row('2', 'B', '2026-09-15', '2026-09-20T10:00:00Z'),
    row('3', 'C', '2026-11-01', '2026-09-30T10:00:00Z'),
  ];
  assert.deepEqual(coachHistorySegments(rows, contract).map(s => [s.coachId, s.from, s.to, s.scheduled]), [
    ['A', '2026-06-01', '2026-09-14', false],
    ['B', '2026-09-15', '2026-10-31', false],
    ['C', '2026-11-01', '2026-11-30', true],
  ]);
  assert.equal(pendingCoachChange(rows, contract)?.id, '3');
});

test('a later correction on the same day replaces the coach of that segment', () => {
  const rows = [
    row('1', 'A', '2026-06-01', '2026-06-01T10:00:00Z'),
    row('2', 'B', '2026-09-15', '2026-09-20T10:00:00Z'),
    row('3', 'C', '2026-09-15', '2026-09-25T10:00:00Z'),
  ];
  assert.deepEqual(coachHistorySegments(rows, contract).map(s => [s.coachId, s.from]), [
    ['A', '2026-06-01'],
    ['C', '2026-09-15'],
  ]);
});

test('a change registered before a future contract starts covers it from the first day', () => {
  const future = { startDate: '2026-10-10', endDate: '2027-04-10', today: '2026-09-30' };
  const rows = [
    row('1', 'A', '2026-10-10', '2026-09-01T10:00:00Z'),
    row('2', 'B', '2026-09-30', '2026-09-30T10:00:00Z', { ended_at: null }),
  ];
  assert.deepEqual(coachHistorySegments(rows, future).map(s => [s.coachId, s.from, s.scheduled]), [
    ['B', '2026-10-10', true],
  ]);
  assert.equal(pendingCoachChange(rows, future), null);
});

test('a plan change coach and the first row are not a pending coach change', () => {
  const rows = [
    row('1', 'A', '2026-06-01', '2026-06-01T10:00:00Z'),
    row('2', 'B', '2026-11-01', '2026-09-30T10:00:00Z', { plan_change_id: 'pc1' }),
  ];
  assert.equal(pendingCoachChange(rows, contract), null);
  assert.deepEqual(coachHistorySegments([], contract), []);
});
