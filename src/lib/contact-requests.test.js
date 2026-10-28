import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contactProspectNotes,
  contactStatus,
  isOpenContactRequest,
  sortContactRequests,
  summarizeContactRequests,
} from './contact-requests.js';

const REQUESTS = [
  { id: 'a', status: 'contacted', created_at: '2026-10-20T15:00:00Z' },
  { id: 'b', status: 'new', created_at: '2026-10-10T15:00:00Z' },
  { id: 'c', status: 'closed', created_at: '2026-09-01T15:00:00Z', status_changed_at: '2026-10-25T10:00:00Z' },
  { id: 'd', status: 'new', created_at: '2026-10-27T15:00:00Z' },
  { id: 'e', status: 'converted', created_at: '2026-08-01T15:00:00Z', status_changed_at: '2026-10-26T10:00:00Z' },
];

test('only new and in-conversation contacts are open', () => {
  assert.deepEqual(REQUESTS.filter(isOpenContactRequest).map(request => request.id), ['a', 'b', 'd']);
  assert.equal(isOpenContactRequest(null), false);
});

test('the open ones come first, oldest first, then the latest outcomes', () => {
  assert.deepEqual(sortContactRequests(REQUESTS).map(request => request.id), ['b', 'a', 'd', 'e', 'c']);
  assert.deepEqual(REQUESTS.map(request => request.id), ['a', 'b', 'c', 'd', 'e'], 'the input is not reordered');
});

test('the summary counts the open line and the new contacts', () => {
  assert.deepEqual(summarizeContactRequests(REQUESTS), { open: 3, new: 2 });
  assert.deepEqual(summarizeContactRequests([]), { open: 0, new: 0 });
});

test('an unknown status falls back to new', () => {
  assert.equal(contactStatus('closed').label, 'Encerrado');
  assert.equal(contactStatus('lost').value, 'new');
});

test('the prospect note carries the subject and the message the person wrote', () => {
  const note = contactProspectNotes({ subject: 'Dúvida sobre planos', message: 'Quero saber mais.\nObrigada!' }, '28/10/2026');
  assert.equal(note, [
    'Veio do formulário de contato do site (em 28/10/2026).',
    'Assunto: Dúvida sobre planos',
    'Mensagem: Quero saber mais.\nObrigada!',
  ].join('\n'));
  assert.equal(contactProspectNotes({}, ''), 'Veio do formulário de contato do site.');
});

test('the longest possible contact still fits the prospect notes limit', () => {
  const note = contactProspectNotes({ subject: 'a'.repeat(120), message: 'b'.repeat(1_500) }, '28/10/2026');
  assert.ok(note.length <= 2_000, `note has ${note.length} characters`);
});
