import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyPersonRedirectPath, studentProfilePath } from './customer-profile.js';

test('the canonical person profile retains its ID and selected tab', () => {
  assert.equal(studentProfilePath('person-123'), '/pessoas/person-123');
  assert.equal(studentProfilePath('person-123', 'financial'), '/pessoas/person-123?aba=financial');
});

test('legacy person URLs retain ID, query, hash and assessment context', () => {
  assert.equal(
    legacyPersonRedirectPath({ id: 'person-123', search: '?aba=communication&periodo=2026-10', hash: '#historico' }),
    '/pessoas/person-123?aba=communication&periodo=2026-10#historico',
  );
  assert.equal(
    legacyPersonRedirectPath({ fromAssessment: true, search: '?busca=Ana&filtro=sem-cpf' }),
    '/pessoas?busca=Ana&filtro=sem-cpf',
  );
  assert.equal(
    legacyPersonRedirectPath({ fromAssessment: true, search: '?vinculo=active' }),
    '/pessoas?vinculo=active',
  );
});
