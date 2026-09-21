import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareManualProspect } from './assessment-prospect-form.js';

const form = {
  full_name: ' Pessoa Ficticia ', whatsapp: '(51) 99999-9999',
  email: ' prospect@example.test ', cpf: '123.456.789-09',
  gender: 'feminino', birth_date: '2000-02-29',
  plan_id: 'plan', coach_id: 'coach', installments: '3', notes: ' Teste ',
};
const prepare = (overrides = {}) => prepareManualProspect({ ...form, ...overrides }, 3, '2026-09-21');

test('manual prospect normalizes contact and includes profile fields', () => {
  assert.deepEqual(prepare().payload, {
    fullName: 'Pessoa Ficticia', whatsapp: '+5551999999999', email: 'prospect@example.test',
    cpf: '12345678909', gender: 'feminino', birthDate: '2000-02-29',
    planId: 'plan', coachId: 'coach', installments: 3, notes: 'Teste',
  });
});

test('manual prospect keeps optional fields optional', () => {
  const { payload } = prepare({ email: '', cpf: '', gender: '', birth_date: '', notes: '' });
  for (const key of ['email', 'cpf', 'gender', 'birthDate', 'notes']) assert.equal(payload[key], null);
});

for (const [field, value, message] of [
  ['full_name', 'A', /nome/], ['full_name', 'a'.repeat(201), /nome/],
  ['whatsapp', '123', /WhatsApp/], ['email', 'invalid@', /e-mail/],
  ['cpf', '123.45', /CPF/], ['gender', 'invalid', /gênero/],
  ['birth_date', '2025-02-29', /nascimento/], ['birth_date', '2026-04-31', /nascimento/],
  ['birth_date', '2026-09-22', /nascimento/], ['birth_date', '1899-12-31', /nascimento/],
  ['birth_date', 'invalid', /nascimento/], ['plan_id', '', /plano/], ['coach_id', '', /coach/],
  ['installments', '', /parcelas/], ['installments', '1.5', /parcelas/],
  ['installments', '4', /parcelas/], ['installments', '0', /parcelas/],
  ['notes', 'a'.repeat(2001), /observações/],
]) {
  test(`manual prospect rejects ${field}=${String(value).slice(0, 20)} before a request`, () => {
    const result = prepare({ [field]: value });
    assert.match(result.error, message);
    assert.equal(result.payload, undefined);
  });
}

test('manual prospect accepts all offered genders and date boundaries', () => {
  for (const gender of ['feminino', 'masculino', 'outro']) {
    for (const birth_date of ['1900-01-01', '2026-09-21']) assert.ok(prepare({ gender, birth_date }).payload);
  }
});
