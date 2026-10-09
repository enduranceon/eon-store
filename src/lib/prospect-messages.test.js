import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  DEFAULT_PROSPECT_RULES,
  PROSPECT_MESSAGES,
  PROSPECT_TEMPLATE_VARIABLES,
  buildProspectMessage,
  contactMessageKey,
  prospectMessageRule,
  prospectMessageValues,
  proposalMessageKey,
} from './prospect-messages.js';
import { formatCurrency } from './utils.js';

const full = {
  fullName: 'Ana Maria Teste', modality: 'Corrida', plan: 'Corrida - Trimestral', periodMonths: 3,
  coach: 'Coach Fictício', total: 900, installments: 3, enrollmentFee: 100, dueDate: '2026-10-12',
  paymentLink: 'https://www.asaas.com/i/ficticio', deadline: '2026-10-10',
};

test('cada passo tem um texto padrão e todos resolvem as variáveis', () => {
  assert.equal(DEFAULT_PROSPECT_RULES.length, Object.keys(PROSPECT_MESSAGES).length);
  for (const key of Object.keys(PROSPECT_MESSAGES)) {
    for (const data of [full, { fullName: 'Ana' }]) {
      const text = buildProspectMessage(key, data);
      assert.ok(text.startsWith('Ol') || text.startsWith('Oi'), key);
      assert.doesNotMatch(text, /\{[^{}]+\}/, key);
    }
  }
});

test('o quadro usa o modelo ativo de menor ordem; sem ele, o padrão', () => {
  const custom = { journey: 'proposal', task_kind: 'prospect_contact', days_offset: 2, active: true, order_index: 5, slug: 'b', message_template: 'Oi {nome}, tudo certo?' };
  const later = { ...custom, order_index: 9, slug: 'a', message_template: 'Outro' };
  assert.equal(buildProspectMessage('follow_up', full, [later, custom]), 'Oi Ana, tudo certo?');
  assert.match(buildProspectMessage('follow_up', full, [{ ...custom, active: false }]), /primeiras semanas com \*Coach Fictício\*/);
  // Regra de outra jornada no mesmo marco não é usada.
  assert.match(buildProspectMessage('follow_up', full, [{ ...custom, journey: 'renewal' }]), /primeiras semanas/);
  assert.equal(prospectMessageRule([], 'nao_existe'), null);
});

test('a proposta com link escolhe a abertura certa', () => {
  assert.equal(proposalMessageKey({ prospect_stage: 'payment_link_sent', prospect_message_sent_at: 'x' }), 'payment_reminder');
  assert.equal(proposalMessageKey({ prospect_stage: 'proposal_ready', prospect_last_contact_at: 'x' }), 'proposal_after_contact');
  assert.equal(proposalMessageKey({ prospect_stage: 'proposal_ready', prospect_customer_relationship: 'former_student' }), 'proposal_returning');
  assert.equal(proposalMessageKey({ prospect_stage: 'new' }), 'proposal_new');
  assert.equal(contactMessageKey('first_contact', true), 'first_contact_returning');
  assert.equal(contactMessageKey('payment_closing'), 'payment_closing');
  assert.equal(contactMessageKey('desconhecido'), null);
});

test('resumo e frases opcionais da proposta', () => {
  const values = prospectMessageValues(full);
  assert.equal(values['{resumo_proposta}'], [
    '🏃 Modalidade: *Corrida*',
    '📅 Plano: *Corrida - Trimestral* (3 meses)',
    '👤 Coach: *Coach Fictício*',
    `💰 Total: *${formatCurrency(900)}* em *3x de ${formatCurrency(300)}*`,
    `📌 Matrícula: ${formatCurrency(100)}`,
    '⏰ Vencimento: *12/10/2026*',
  ].join('\n'));
  const bare = prospectMessageValues({ fullName: 'Ana' });
  assert.equal(bare['{coach_texto}'], '');
  assert.equal(bare['{com_coach}'], 'na assessoria');
  assert.equal(bare['{o_coach}'], 'o coach escolhido');
  assert.equal(bare['{link_bloco}'], '');
  assert.equal(values['{prazo_link}'], 'sábado, 10/10');
});

test('as variáveis do quadro são as mesmas da simulação no banco', () => {
  const tokens = Object.keys(prospectMessageValues(full)).sort();
  assert.deepEqual(PROSPECT_TEMPLATE_VARIABLES.map(([token]) => token).sort(), tokens);
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).filter(name => name.endsWith('_prospect_messages_and_reopen.sql'))[0];
  const sql = readFileSync(new URL(file, dir), 'utf8');
  const body = sql.slice(sql.indexOf('FUNCTION eon_private.prospect_message_sample_context'), sql.indexOf('FUNCTION eon_private.prospect_message_money'));
  const sqlTokens = [...body.matchAll(/^ {4}'([a-z_]+)',/gm)].map(match => `{${match[1]}}`).sort();
  assert.deepEqual(sqlTokens, tokens);
});
