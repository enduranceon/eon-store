import test from 'node:test';
import assert from 'node:assert/strict';
import { accessBlocker, accessMessage, firstNameOf } from './coach-access.js';

test('the access message carries the link, the e-mail and the temporary password', () => {
  const message = accessMessage({ name: 'Maria Souza', link: 'https://sistema.example.test/login', email: 'maria@example.test', password: 'SenhaTeste12' });
  assert.match(message, /^Olá, Maria!/);
  assert.match(message, /Link: https:\/\/sistema\.example\.test\/login/);
  assert.match(message, /E-mail: maria@example\.test/);
  assert.match(message, /Senha provisória: SenhaTeste12/);
  assert.match(message, /senha nova/);
});

test('the message still reads well without a name', () => {
  assert.match(accessMessage({ name: '', link: 'l', email: 'e', password: 'p' }), /^Olá! /);
  assert.equal(firstNameOf('  Ana  Paula '), 'Ana');
  assert.equal(firstNameOf(null), '');
});

test('access cannot be created for an inactive coach or one without a valid e-mail, but a coach who already has access is never blocked', () => {
  assert.equal(accessBlocker({ active: true, email: 'a@b.test' }), null);
  assert.match(accessBlocker({ active: false, email: 'a@b.test' }), /inativo/);
  assert.match(accessBlocker({ active: true, email: '' }), /e-mail válido/);
  assert.match(accessBlocker({ active: true, email: 'sem-arroba' }), /e-mail válido/);
  assert.equal(accessBlocker({ active: false, email: '', auth_user_id: 'u1' }), null);
  assert.match(accessBlocker(null), /não encontrado/);
});
