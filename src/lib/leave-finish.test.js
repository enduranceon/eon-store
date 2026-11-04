import test from 'node:test';
import assert from 'node:assert/strict';
import { addDaysIso, leaveFinishPreview, leaveLastDayProblem } from './leave-finish.js';

// Contrato fictício no formato do caso real: licença aberta desde 24/08, fim 13/11.
const base = { leaveStart: '2026-08-24', contractEnd: '2026-11-13', today: '2026-11-04' };

test('ending on a past day adds only the days until that day, both included', () => {
  assert.deepEqual(leaveFinishPreview({ ...base, lastDay: '2026-10-14' }), { days: 52, newEnd: '2027-01-04' });
});

test('ending today keeps the previous result', () => {
  assert.deepEqual(leaveFinishPreview({ ...base, lastDay: '2026-11-04' }), { days: 73, newEnd: '2027-01-25' });
});

test('a leave of one day counts that day', () => {
  assert.deepEqual(leaveFinishPreview({ ...base, lastDay: '2026-08-24' }), { days: 1, newEnd: '2026-11-14' });
});

test('the preview is empty when the day is before the start or in the future', () => {
  assert.equal(leaveFinishPreview({ ...base, lastDay: '2026-08-23' }), null);
  assert.equal(leaveFinishPreview({ ...base, lastDay: '2026-11-05' }), null);
  assert.equal(leaveFinishPreview({ ...base, lastDay: '' }), null);
  assert.equal(leaveFinishPreview({ ...base, lastDay: '2026-02-31' }), null);
});

test('the problem text says what is wrong with the day', () => {
  assert.equal(leaveLastDayProblem({ ...base, lastDay: '2026-10-14' }), '');
  assert.match(leaveLastDayProblem({ ...base, lastDay: '2026-08-23' }), /antes do início/);
  assert.match(leaveLastDayProblem({ ...base, lastDay: '2026-11-05' }), /futuro/);
  assert.match(leaveLastDayProblem({ ...base, lastDay: '' }), /válida/);
});

test('adding days crosses month and year without drifting', () => {
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysIso('not-a-date', 1), '');
});
