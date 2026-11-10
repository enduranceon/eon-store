import test from 'node:test';
import assert from 'node:assert/strict';
import { homePathForRole, mustChangePassword, resolveAccountRole } from './auth-role.js';

const apiError = (status, code = 'x') => Object.assign(new Error('falhou'), { status, code });
const ok = value => async () => value;
const fail = error => async () => { throw error; };

function checkers({ admin, coach }) {
  const calls = [];
  return {
    calls,
    checkAdmin: async () => { calls.push('admin'); return admin(); },
    checkCoach: async () => { calls.push('coach'); return coach(); },
  };
}

test('an administrator is an administrator and the coach check never runs', async () => {
  const c = checkers({ admin: ok({ data: { role: 'admin' } }), coach: ok({ data: {} }) });
  const result = await resolveAccountRole(c);
  assert.equal(result.role, 'admin');
  assert.deepEqual(c.calls, ['admin']);
});

test('an account the server says is not an administrator is then checked as a coach', async () => {
  const c = checkers({ admin: fail(apiError(403, 'forbidden')), coach: ok({ data: { coach_id: 'c1', name: 'Coach Teste' } }) });
  const result = await resolveAccountRole(c);
  assert.equal(result.role, 'coach');
  assert.deepEqual(result.coach, { coach_id: 'c1', name: 'Coach Teste' });
  assert.deepEqual(c.calls, ['admin', 'coach']);
});

test('an account that is neither administrator nor coach gets no role', async () => {
  const c = checkers({ admin: fail(apiError(403)), coach: fail(apiError(403, 'forbidden')) });
  const result = await resolveAccountRole(c);
  assert.equal(result.role, null);
  assert.equal(result.error.status, 403);
});

test('an invalid session, a network failure or a server error never fall through to coach', async () => {
  for (const status of [401, 0, 500, 502, undefined]) {
    const c = checkers({ admin: fail(apiError(status)), coach: ok({ data: {} }) });
    const result = await resolveAccountRole(c);
    assert.equal(result.role, null, `status ${status} gives no role`);
    assert.deepEqual(c.calls, ['admin'], `status ${status} does not try the coach check`);
  }
});

test('a plain error without a status is not treated as "not an administrator"', async () => {
  const c = checkers({ admin: fail(new TypeError('Failed to fetch')), coach: ok({ data: {} }) });
  const result = await resolveAccountRole(c);
  assert.equal(result.role, null);
  assert.deepEqual(c.calls, ['admin']);
});

test('the forced password change follows the account flag only when it is exactly true', () => {
  assert.equal(mustChangePassword({ user_metadata: { must_change_password: true } }), true);
  assert.equal(mustChangePassword({ user_metadata: { must_change_password: false } }), false);
  assert.equal(mustChangePassword({ user_metadata: { must_change_password: 'true' } }), false);
  assert.equal(mustChangePassword({ user_metadata: {} }), false);
  assert.equal(mustChangePassword({}), false);
  assert.equal(mustChangePassword(null), false);
});

test('each role has its own home', () => {
  assert.equal(homePathForRole('admin'), '/admin');
  assert.equal(homePathForRole('coach'), '/coach');
  assert.equal(homePathForRole(null), '/login');
  assert.equal(homePathForRole('whatever'), '/login');
});
