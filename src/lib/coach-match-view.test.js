import assert from 'node:assert/strict';
import test from 'node:test';
import { getCoachMatchView, coachMatchStatusMessage } from './coach-match-view.js';

const snapshot = () => ({
  coach: { id: 'coach-1', name: 'Coach de teste' },
  latest: null, published: null, invites: [], server_time: '2026-10-12T12:00:00Z',
});

test('aprovação só usa latest pendente, nunca uma versão antiga da listagem', () => {
  const current = { id: 'latest', status: 'pending' };
  const view = getCoachMatchView({ ...snapshot(), latest: current, submissions: [{ id: 'old', status: 'pending' }] });
  assert.equal(view.pending, current);
  for (const status of ['approved', 'rejected', 'superseded']) {
    assert.equal(getCoachMatchView({ ...snapshot(), latest: { id: 'latest', status }, submissions: [{ id: 'old', status: 'pending' }] }).pending, null);
  }
});

test('versão aprovada permanece independente da última resposta e do limite do histórico', () => {
  const approved = { id: 'published-before-history-window', status: 'approved' };
  for (const status of ['pending', 'rejected']) {
    const view = getCoachMatchView({ ...snapshot(), published: approved, latest: { id: 'new', status }, submissions: [] });
    assert.equal(view.published, approved);
  }
});

test('link ativo usa relógio do servidor, revogação e tempo decorrido desde a consulta', () => {
  const data = { ...snapshot(), invites: [
    { id: 'revoked', expires_at: '2026-11-01T12:00:00Z', revoked_at: '2026-10-10T12:00:00Z' },
    { id: 'expired', expires_at: '2026-10-12T12:00:00Z', revoked_at: null },
    { id: 'active', expires_at: '2026-10-12T12:01:00Z', revoked_at: null },
  ] };
  assert.equal(getCoachMatchView(data).currentInvite.id, 'active');
  assert.equal(getCoachMatchView(data, 60_000).currentInvite, null);
});

test('resposta incompleta ou inválida não aparece como ausência de respostas', () => {
  for (const invalid of [null, {}, { ...snapshot(), latest: undefined, server_time: null },
    { ...snapshot(), published: { id: 'bad', status: 'pending' } },
    { ...snapshot(), latest: { id: 'bad', status: 'unknown' } }]) {
    assert.throws(() => getCoachMatchView(invalid), /confirmar o estado/);
  }
});

test('mensagens explicam revisão e manutenção da versão aprovada', () => {
  assert.match(coachMatchStatusMessage('pending'), /aguardando revisão/);
  assert.match(coachMatchStatusMessage('approved'), /até nova aprovação/);
  assert.match(coachMatchStatusMessage('rejected'), /anteriormente continua/);
  assert.match(coachMatchStatusMessage('superseded'), /mais recente/);
  assert.equal(coachMatchStatusMessage(null), null);
});
