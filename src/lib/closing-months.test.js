import assert from 'node:assert/strict';
import test from 'node:test';
import { endedMonths, lastEndedMonth, monthHasEnded, monthOpensOn } from './closing-months.js';

test('the month to close is the one that already ended', () => {
  assert.equal(lastEndedMonth('2026-10-01'), '2026-09');
  assert.equal(lastEndedMonth('2026-10-31'), '2026-09');
  assert.equal(lastEndedMonth('2027-01-05'), '2026-12');
});

test('the current and future months cannot be closed', () => {
  assert.equal(monthHasEnded('2026-09', '2026-10-01'), true);
  assert.equal(monthHasEnded('2026-10', '2026-10-01'), false);
  assert.equal(monthHasEnded('2026-10', '2026-10-31'), false);
  assert.equal(monthHasEnded('2026-11', '2026-10-15'), false);
  assert.equal(monthHasEnded('2026-10-01', '2026-11-01'), true);
});

test('a month opens on the first day of the next one', () => {
  assert.equal(monthOpensOn('2026-10'), '2026-11-01');
  assert.equal(monthOpensOn('2026-12-01'), '2027-01-01');
});

test('the month picker lists only ended months, newest first', () => {
  assert.deepEqual(endedMonths('2026-10-01', 4), ['2026-09', '2026-08', '2026-07', '2026-06']);
  assert.deepEqual(endedMonths('2027-02-10', 3), ['2027-01', '2026-12', '2026-11']);
});
