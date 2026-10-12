import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCoachMatchAnswers, validateCoachMatchAnswers } from '../../supabase/functions/_shared/coach-match-contract.js';

const valid = {
  version: 1,
  focus_goals: ['start', 'routine'],
  focus_levels: ['beginner'],
  service_formats: ['florianopolis', 'online'],
  communication_style: 'balanced',
  approach: 'Escuto a rotina do aluno e ajusto o plano conforme sua evolução.',
  experience: 'Acompanho pessoas que estão começando.',
};

test('normaliza uma resposta válida e só entrega campos previstos ao público', () => {
  const result = validateCoachMatchAnswers({ ...valid, email: 'private@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.answers.email, undefined);
  assert.deepEqual(publicCoachMatchAnswers(result.answers), result.answers);
});

test('recusa categorias desconhecidas ou mais de dois focos', () => {
  assert.equal(validateCoachMatchAnswers({ ...valid, focus_goals: ['start', 'race', 'routine'] }).ok, false);
  assert.equal(validateCoachMatchAnswers({ ...valid, focus_levels: ['beginner', 'other'] }).ok, false);
  assert.equal(validateCoachMatchAnswers({ ...valid, service_formats: ['outside'] }).ok, false);
  assert.equal(validateCoachMatchAnswers({ ...valid, communication_style: 'always_online' }).ok, false);
});

test('não publica conteúdo incompleto ou de outra versão', () => {
  assert.equal(publicCoachMatchAnswers({ ...valid, version: 9 }), null);
  assert.equal(publicCoachMatchAnswers({ ...valid, approach: 'Curto' }), null);
});
