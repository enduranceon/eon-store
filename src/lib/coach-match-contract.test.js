import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publicCoachMatchAnswers,
  validateCoachMatchAnswers,
  validateCoachMatchV2Answers,
  validateLegacyCoachMatchAnswers,
} from '../../supabase/functions/_shared/coach-match-contract.js';

const validV2 = {
  version: 2,
  service_formats: ['florianopolis', 'online'],
  focus_goals: { primary: 'performance', secondary: 'health' },
  focus_levels: { primary: 'intermediate', secondary: 'beginner' },
  communication_style: { primary: 'balanced', secondary: 'close' },
  age_groups: { primary: 'age_31_50', secondary: 'up_to_30' },
  gender_preference: { primary: 'no_preference', secondary: null },
};

const validV1 = {
  version: 1,
  focus_goals: ['start', 'routine'],
  focus_levels: ['beginner'],
  service_formats: ['florianopolis', 'online'],
  communication_style: 'balanced',
  approach: 'Escuto a rotina do aluno e ajusto o plano conforme sua evolução.',
  experience: 'Acompanho pessoas que estão começando.',
};

test('normaliza o contrato v2 sem aceitar campos extras', () => {
  const result = validateCoachMatchV2Answers(validV2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers, validV2);
  assert.notEqual(result.answers.focus_goals, validV2.focus_goals);
  assert.equal(validateCoachMatchV2Answers({ ...validV2, email: 'private@example.com' }).ok, false);
});

test('valida principal obrigatório e secundário opcional, sem duplicidade', () => {
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    focus_goals: { primary: 'performance', secondary: null } }).ok, true);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    focus_goals: { primary: 'performance', secondary: 'performance' } }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    focus_goals: { primary: 'performance' } }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    focus_goals: { primary: 'unknown', secondary: null } }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    focus_goals: { primary: null, secondary: null } }).ok, false);
});

test('sem preferência é exclusivo em idade e gênero', () => {
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    age_groups: { primary: 'no_preference', secondary: null } }).ok, true);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    age_groups: { primary: 'no_preference', secondary: 'age_31_50' } }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    age_groups: { primary: 'age_31_50', secondary: 'no_preference' } }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    gender_preference: { primary: 'female', secondary: 'no_preference' } }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    gender_preference: { primary: null, secondary: null } }).ok, false);
});

test('recusa formatos, categorias e versões desconhecidas', () => {
  assert.equal(validateCoachMatchV2Answers({ ...validV2, service_formats: [] }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2, service_formats: ['online', 'online'] }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2, service_formats: ['outside'] }).ok, false);
  assert.equal(validateCoachMatchV2Answers({ ...validV2,
    communication_style: { primary: 'always_online', secondary: null } }).ok, false);
  assert.equal(validateCoachMatchAnswers({ ...validV2, version: 9 }).ok, false);
});

test('dispatcher mantém v1 para rollback, mas catálogo público não expõe afinidades v2', () => {
  assert.equal(validateLegacyCoachMatchAnswers(validV1).ok, true);
  assert.deepEqual(validateCoachMatchAnswers(validV1).answers, validV1);
  assert.deepEqual(publicCoachMatchAnswers(validV1), validV1);
  assert.equal(publicCoachMatchAnswers(validV2), null);
  assert.equal(publicCoachMatchAnswers({ ...validV1, approach: 'Curto' }), null);
});
