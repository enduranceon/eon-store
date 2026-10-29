import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_LINK_GENDERS,
  birthDateToIso,
  emptyPlanLinkForm,
  maskBirthDate,
  preparePlanLinkSubmission,
} from './plan-link-form.js';

const now = new Date(2026, 9, 29, 12, 0, 0);
const ids = { token: 'linkcorridateste0001', requestId: '11111111-1111-4111-8111-111111111111', now };

function filledForm(overrides = {}) {
  return {
    ...emptyPlanLinkForm(),
    plan_id: '22222222-2222-4222-8222-222222222222',
    coach_id: '33333333-3333-4333-8333-333333333333',
    full_name: 'Pessoa Link Fictícia',
    whatsapp: '(48) 99999-0601',
    email: 'pessoa@example.test',
    cpf: '529.982.247-25',
    birth_date: '25/03/1990',
    address_zip: '88000-000',
    address_street: 'Rua Fictícia',
    address_number: '10',
    address_neighborhood: 'Centro',
    address_city: 'Florianópolis',
    address_state: 'sc',
    confirmed: true,
    ...overrides,
  };
}

test('máscara da data de nascimento: dd/mm/aaaa e preenchimento automático AAAA-MM-DD', () => {
  assert.equal(maskBirthDate('25031990'), '25/03/1990');
  assert.equal(maskBirthDate('2503'), '25/03');
  assert.equal(maskBirthDate('25'), '25');
  assert.equal(maskBirthDate('25/03/19901234'), '25/03/1990');
  assert.equal(maskBirthDate('1990-03-25'), '25/03/1990');
  assert.equal(maskBirthDate('abc'), '');
});

test('data de nascimento: rejeita data inexistente, anterior a 1900 e futura', () => {
  assert.equal(birthDateToIso('25/03/1990', now), '1990-03-25');
  assert.equal(birthDateToIso('29/02/2000', now), '2000-02-29');
  assert.equal(birthDateToIso('29/02/1900', now), '', '1900 não foi bissexto');
  assert.equal(birthDateToIso('31/04/1990', now), '');
  assert.equal(birthDateToIso('15/13/1990', now), '');
  assert.equal(birthDateToIso('31/12/1899', now), '');
  assert.equal(birthDateToIso('01/01/1900', now), '1900-01-01');
  assert.equal(birthDateToIso('29/10/2026', now), '2026-10-29', 'hoje vale');
  assert.equal(birthDateToIso('30/10/2026', now), '', 'amanhã não vale');
  assert.equal(birthDateToIso('1/1/1990', now), '');
});

test('o envio do link do plano leva nascimento e gênero', () => {
  const { error, body } = preparePlanLinkSubmission(filledForm({ gender: 'feminino' }), ids);
  assert.equal(error, undefined);
  assert.equal(body.birth_date, '1990-03-25');
  assert.equal(body.gender, 'feminino');
  assert.equal(body.cpf, '52998224725');
});

test('gênero é opcional e valores desconhecidos viram vazio', () => {
  assert.equal(preparePlanLinkSubmission(filledForm(), ids).body.gender, '');
  assert.equal(preparePlanLinkSubmission(filledForm({ gender: 'prefiro' }), ids).body.gender, '');
  for (const value of Object.keys(PLAN_LINK_GENDERS)) {
    assert.equal(preparePlanLinkSubmission(filledForm({ gender: value }), ids).body.gender, value);
  }
});

test('data de nascimento é obrigatória e precisa ser válida', () => {
  assert.equal(preparePlanLinkSubmission(filledForm({ birth_date: '' }), ids).error, 'Informe a data de nascimento');
  assert.match(preparePlanLinkSubmission(filledForm({ birth_date: '31/02/1990' }), ids).error, /dia\/mês\/ano/);
  assert.match(preparePlanLinkSubmission(filledForm({ birth_date: '25/03/2999' }), ids).error, /dia\/mês\/ano/);
});

test('o formulário do link continua exigindo o resto dos dados', () => {
  assert.equal(preparePlanLinkSubmission(filledForm({ cpf: '111.111.111-11' }), ids).error, 'Informe um CPF válido');
  assert.equal(preparePlanLinkSubmission(filledForm({ confirmed: false }), ids).error, 'Confirme que os dados estão corretos');
  assert.equal(preparePlanLinkSubmission(filledForm({ plan_id: '' }), ids).error, 'Escolha a duração do plano');
});
