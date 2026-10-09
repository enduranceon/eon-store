import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  formatDeadline,
  hoursSince,
  needsActionToday,
  prospectNextStep,
} from './assessment-prospect-flow.js';
import { buildProspectMessage } from './prospect-messages.js';

// Horários ao meio-dia UTC: o dia é o mesmo em UTC e em São Paulo.
const site = { status: 'draft', created_at: '2026-10-08T15:00:00Z', latest_submission: { id: 'sub-1' } };

test('cadastro do site começa pelo primeiro contato; manual e aluno atual vão para a proposta', () => {
  assert.deepEqual(prospectNextStep({ ...site, prospect_stage: 'new' }), { kind: 'first_contact', dueDate: '2026-10-08' });
  assert.equal(prospectNextStep({ ...site, prospect_stage: 'new', latest_submission: null }).kind, 'proposal');
  assert.equal(prospectNextStep({ ...site, prospect_stage: 'new', prospect_customer_relationship: 'active_student' }).kind, 'proposal');
  assert.equal(prospectNextStep({ ...site, prospect_stage: 'new', prospect_first_contact_at: '2026-10-08T15:00:00Z' }).kind, 'proposal');
  assert.equal(prospectNextStep({ ...site, prospect_stage: 'new', external_payment_link: 'https://x.test' }), null);
  assert.equal(prospectNextStep({ ...site, prospect_stage: 'new', status: 'active' }), null);
});

test('sem resposta: lembrete no dia 2 e encerramento no dia 5, pelo menos 3 dias depois do lembrete', () => {
  const waiting = { ...site, prospect_stage: 'awaiting_reply', prospect_last_contact_at: '2026-10-08T15:00:00Z' };
  assert.deepEqual(prospectNextStep(waiting), { kind: 'follow_up', dueDate: '2026-10-10' });
  assert.deepEqual(
    prospectNextStep({ ...waiting, prospect_followup_sent_at: '2026-10-10T15:00:00Z' }),
    { kind: 'closing', dueDate: '2026-10-13' },
  );
  // Lembrete atrasado (enviado no dia 4): o encerramento espera 3 dias.
  assert.deepEqual(
    prospectNextStep({ ...waiting, prospect_followup_sent_at: '2026-10-12T15:00:00Z' }),
    { kind: 'closing', dueDate: '2026-10-15' },
  );
});

test('tirando dúvidas usa o mesmo relógio, a partir da última conversa', () => {
  const clarifying = { ...site, prospect_stage: 'clarifying', prospect_last_contact_at: '2026-10-09T15:00:00Z' };
  assert.deepEqual(prospectNextStep(clarifying), { kind: 'follow_up', dueDate: '2026-10-11' });
});

test('com link: lembrete no dia seguinte ao vencimento, encerramento 5 dias depois e arquivar no prazo final', () => {
  const sent = { ...site, prospect_stage: 'payment_link_sent', due_date: '2026-10-09' };
  assert.deepEqual(prospectNextStep(sent), { kind: 'payment_reminder', dueDate: '2026-10-10' });
  assert.deepEqual(
    prospectNextStep({ ...sent, prospect_payment_reminder_sent_at: '2026-10-10T15:00:00Z' }),
    { kind: 'payment_closing', dueDate: '2026-10-14' },
  );
  assert.deepEqual(
    prospectNextStep({ ...sent, prospect_payment_reminder_sent_at: '2026-10-13T15:00:00Z' }),
    { kind: 'payment_closing', dueDate: '2026-10-16' },
  );
  assert.deepEqual(
    prospectNextStep({
      ...sent,
      prospect_payment_reminder_sent_at: '2026-10-10T15:00:00Z',
      prospect_closing_sent_at: '2026-10-14T15:00:00Z',
      prospect_close_deadline: '2026-10-16',
    }),
    { kind: 'archive', dueDate: '2026-10-16' },
  );
  assert.equal(prospectNextStep({ ...sent, due_date: null }), null);
});

test('para hoje mostra o que venceu, e não o que ainda está por vir', () => {
  const waiting = { ...site, prospect_stage: 'awaiting_reply', prospect_last_contact_at: '2026-10-08T15:00:00Z' };
  assert.equal(needsActionToday(waiting, '2026-10-09'), false);
  assert.equal(needsActionToday(waiting, '2026-10-10'), true);
  assert.equal(needsActionToday(waiting, '2026-10-12'), true);
  assert.equal(needsActionToday({ ...site, prospect_stage: 'converted' }, '2026-10-12'), false);
});

test('datas e horas', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(addDays('', 3), '');
  assert.equal(formatDeadline('2026-10-10'), 'sábado, 10/10');
  assert.equal(hoursSince('2026-10-08T12:00:00Z', Date.parse('2026-10-08T15:30:00Z')), 3);
  assert.equal(hoursSince(null), null);
});

test('textos usam o primeiro nome e o que a pessoa escolheu', () => {
  const first = buildProspectMessage('first_contact', { fullName: 'Ana Maria Teste', modality: 'corrida', plan: 'Corrida - Mensal', coach: 'Coach Fictício' });
  assert.match(first, /^Olá, Ana! Tudo bem\?/);
  assert.match(first, /interesse em treinar \*corrida\* com a gente, no plano \*Corrida - Mensal\*, com acompanhamento de \*Coach Fictício\*\./);
  assert.match(first, /Quer seguir com a contratação\?/);
  assert.match(buildProspectMessage('first_contact_returning', { fullName: 'Ana', modality: 'corrida' }), /Que bom ver você de volta! Recebemos seu interesse em voltar a treinar \*corrida\* com a gente\./);
  assert.match(buildProspectMessage('follow_up', { fullName: 'Ana', coach: 'Coach Fictício' }), /primeiras semanas com \*Coach Fictício\*/);
  assert.doesNotMatch(buildProspectMessage('follow_up', { fullName: 'Ana' }), /viu minha mensagem/);
  assert.match(buildProspectMessage('closing', { fullName: 'Ana' }), /Vou arquivar sua proposta/);
  const closing = buildProspectMessage('payment_closing', { fullName: 'Ana', deadline: '2026-10-10', paymentLink: 'https://www.asaas.com/i/ficticio' });
  assert.match(closing, /link ativo até sábado, 10\/10/);
  assert.match(closing, /🔗 https:\/\/www\.asaas\.com\/i\/ficticio/);
  assert.match(closing, /Se você já fez o pagamento, pode desconsiderar/);
});
