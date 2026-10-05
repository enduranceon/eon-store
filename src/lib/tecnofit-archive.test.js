import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveSituation,
  countByExitYear,
  filterArchive,
  hasRunningTecnofitPlan,
  matchesArchiveSearch,
  sortArchive,
  summarizeArchive,
} from './tecnofit-archive.js';

const TODAY = '2026-10-05';

function person(overrides = {}) {
  return {
    tecnofit_code: 1,
    full_name: 'PESSOA FICTICIA',
    has_eon_contract: false,
    plans_count: 1,
    receipts_count: 1,
    receipts_total: 100,
    last_plan_end: '2025-03-01',
    ...overrides,
  };
}

const people = [
  person({ tecnofit_code: 10, full_name: 'JOÃO DA SILVA', last_plan_end: '2026-02-10', receipts_count: 3, receipts_total: 600 }),
  person({ tecnofit_code: 11, full_name: 'Maria Conceição Souza', last_plan_end: '2024-07-01', receipts_total: 210.5 }),
  person({ tecnofit_code: 12, full_name: 'ANA VOLTOU', has_eon_contract: true, last_plan_end: '2026-07-01' }),
  person({ tecnofit_code: 13, full_name: 'CARLOS SO EVENTO', plans_count: 0, last_plan_end: null, receipts_total: 74.9 }),
  person({ tecnofit_code: 14, full_name: 'BEATRIZ SAIU', last_plan_end: '2026-09-15' }),
];

test('the situation separates ex-students, people back in the EON Store and buyers only', () => {
  assert.equal(archiveSituation(people[0]), 'ex_students');
  assert.equal(archiveSituation(people[2]), 'in_eon');
  assert.equal(archiveSituation(people[3]), 'customers_only');
  assert.equal(archiveSituation(person({ plans_count: 0, has_eon_contract: true })), 'in_eon');
});

test('the search ignores accents, case and word order and accepts the Tecnofit code', () => {
  assert.equal(matchesArchiveSearch(people[0], 'joao silva'), true);
  assert.equal(matchesArchiveSearch(people[0], 'silva joão'), true);
  assert.equal(matchesArchiveSearch(people[1], 'conceicao'), true);
  assert.equal(matchesArchiveSearch(people[1], 'maria pereira'), false);
  assert.equal(matchesArchiveSearch(people[1], '11'), true);
  assert.equal(matchesArchiveSearch(people[0], '1'), false);
  assert.equal(matchesArchiveSearch(people[0], '   '), true);
});

test('the filters combine view, exit year and search', () => {
  const codes = rows => rows.map(row => row.tecnofit_code);
  assert.deepEqual(codes(filterArchive(people)), [10, 11, 14]);
  assert.deepEqual(codes(filterArchive(people, { year: 2026 })), [10, 14]);
  assert.deepEqual(codes(filterArchive(people, { year: '2026', query: 'beatriz' })), [14]);
  assert.deepEqual(codes(filterArchive(people, { view: 'in_eon' })), [12]);
  assert.deepEqual(codes(filterArchive(people, { view: 'all', query: 'evento' })), [13]);
});

test('the summary counts each view, the receipts and their total', () => {
  assert.deepEqual(summarizeArchive(people), {
    views: { ex_students: 3, in_eon: 1, customers_only: 1, all: 5 },
    receipts: 7,
    total: 1085.4,
  });
});

test('exit years are listed from the most recent and skip people without a plan', () => {
  assert.deepEqual(countByExitYear(people), [
    { year: 2026, count: 3 },
    { year: 2024, count: 1 },
  ]);
});

test('the default order shows who left last first and people without a plan at the end', () => {
  assert.deepEqual(sortArchive(people).map(row => row.tecnofit_code), [14, 12, 10, 11, 13]);
  assert.deepEqual(sortArchive(people, 'name').map(row => row.full_name), [
    'ANA VOLTOU', 'BEATRIZ SAIU', 'CARLOS SO EVENTO', 'JOÃO DA SILVA', 'Maria Conceição Souza',
  ]);
});

test('a plan still running in the Tecnofit is flagged only for ex-students', () => {
  assert.equal(hasRunningTecnofitPlan(person({ last_plan_end: '2026-11-13' }), TODAY), true);
  assert.equal(hasRunningTecnofitPlan(person({ last_plan_end: '2026-10-05' }), TODAY), false);
  assert.equal(hasRunningTecnofitPlan(person({ last_plan_end: '2026-11-13', has_eon_contract: true }), TODAY), false);
});
