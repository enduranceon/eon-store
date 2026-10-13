import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareWaitlistEntry,
  sortWaitlist,
  summarizeWaitlist,
  waitingDays,
  waitlistPositions,
} from './coach-waitlist.js';

const ENTRIES = [
  { id: 'a', coach_id: 'c1', status: 'contacted', created_at: '2026-10-02T15:00:00Z' },
  { id: 'b', coach_id: 'c1', status: 'waiting', created_at: '2026-09-20T15:00:00Z' },
  { id: 'c', coach_id: 'c1', status: 'closed', created_at: '2026-09-01T15:00:00Z', status_changed_at: '2026-10-05T10:00:00Z' },
  { id: 'd', coach_id: 'c2', status: 'waiting', created_at: '2026-10-10T15:00:00Z' },
  { id: 'e', coach_id: 'c1', status: 'converted', created_at: '2026-08-01T15:00:00Z', status_changed_at: '2026-10-11T10:00:00Z' },
];

test('waiting days count São Paulo dates', () => {
  // 01:30 UTC on the 13th is still the 12th in São Paulo.
  assert.equal(waitingDays({ created_at: '2026-10-13T01:30:00Z' }, '2026-10-13'), 1);
  assert.equal(waitingDays({ created_at: '2026-10-13T12:00:00Z' }, '2026-10-13'), 0);
  assert.equal(waitingDays({ created_at: null }, '2026-10-13'), 0);
});

test('the open line comes first, in order of arrival, then the latest outcomes', () => {
  assert.deepEqual(sortWaitlist(ENTRIES).map(entry => entry.id), ['b', 'a', 'd', 'e', 'c']);
});

test('each coach has its own line position', () => {
  const positions = waitlistPositions(ENTRIES);
  assert.equal(positions.get('b'), 1);
  assert.equal(positions.get('a'), 2);
  assert.equal(positions.get('d'), 1);
  assert.equal(positions.has('c'), false);
});

test('the summary counts only the open line', () => {
  const summary = summarizeWaitlist(ENTRIES, '2026-10-13');
  assert.deepEqual(summary.get('c1'), { open: 2, waiting: 1, oldestDays: 23 });
  assert.deepEqual(summary.get('c2'), { open: 1, waiting: 1, oldestDays: 3 });
});

test('a manual entry needs coach, name and a valid WhatsApp', () => {
  const coach = { id: 'c1', modality_ids: ['m1'] };
  const form = { coach_id: 'c1', modality_id: 'm1', full_name: '  Pessoa   Fictícia ', whatsapp: '(48) 99999-0401', email: ' Pessoa@Example.test ', region: 'online', notes: '' };
  assert.deepEqual(prepareWaitlistEntry(form, coach), {
    payload: {
      coach_id: 'c1', modality_id: 'm1', full_name: 'Pessoa Fictícia', whatsapp: '+5548999990401',
      email: 'pessoa@example.test', region: 'online', notes: null,
    },
  });
  assert.equal(prepareWaitlistEntry({ ...form, coach_id: '' }, coach).error, 'Escolha o coach');
  assert.equal(prepareWaitlistEntry({ ...form, whatsapp: '123' }, coach).error, 'Informe um WhatsApp válido');
  assert.equal(prepareWaitlistEntry({ ...form, email: 'x@' }, coach).error, 'Informe um e-mail válido');
  assert.equal(prepareWaitlistEntry({ ...form, modality_id: 'm2' }, coach).error, 'O coach não atende esta modalidade');
});
