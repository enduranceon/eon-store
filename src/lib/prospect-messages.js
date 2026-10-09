// Textos da conversa da proposta no quadro de Prospects
// (docs/fluxos-de-mensagens.md, seção 2). Ficam em Comunicação → Modelos e
// regras, na jornada "Propostas"; o quadro usa o modelo ativo de cada passo e,
// sem ele, o texto padrão abaixo. O envio continua manual.
import { formatCurrency, formatDate } from './utils.js';
import { formatDeadline, prospectFirstName } from './assessment-prospect-flow.js';

export const PROSPECT_JOURNEY = 'proposal';
export const PROSPECT_TASK_KIND = {
  CONTACT: 'prospect_contact',
  PROPOSAL: 'prospect_proposal',
};

// Cada passo é um par (tipo de tarefa, marco). O marco não é uma data: só
// identifica o texto dentro da etapa.
export const PROSPECT_MESSAGES = {
  first_contact: { taskKind: PROSPECT_TASK_KIND.CONTACT, offset: 0, label: 'Primeiro contato · cadastro novo' },
  first_contact_returning: { taskKind: PROSPECT_TASK_KIND.CONTACT, offset: 1, label: 'Primeiro contato · ex-aluno' },
  follow_up: { taskKind: PROSPECT_TASK_KIND.CONTACT, offset: 2, label: 'Lembrete · 2 dias depois do contato' },
  closing: { taskKind: PROSPECT_TASK_KIND.CONTACT, offset: 5, label: 'Encerramento sem link · 5 dias depois do contato' },
  proposal_after_contact: { taskKind: PROSPECT_TASK_KIND.PROPOSAL, offset: 10, label: 'Envio do link · depois da conversa' },
  proposal_new: { taskKind: PROSPECT_TASK_KIND.PROPOSAL, offset: 11, label: 'Envio do link · cadastro sem conversa' },
  proposal_returning: { taskKind: PROSPECT_TASK_KIND.PROPOSAL, offset: 12, label: 'Envio do link · ex-aluno sem conversa' },
  payment_reminder: { taskKind: PROSPECT_TASK_KIND.PROPOSAL, offset: 20, label: 'Lembrete de pagamento · dia seguinte ao vencimento' },
  payment_closing: { taskKind: PROSPECT_TASK_KIND.PROPOSAL, offset: 25, label: 'Encerramento com link · 5 dias depois do vencimento' },
};

// Variáveis aceitas nos textos da proposta (as mesmas da simulação no banco).
export const PROSPECT_TEMPLATE_VARIABLES = [
  ['{nome}', 'primeiro nome'],
  ['{modalidade}', 'modalidade'],
  ['{plano}', 'plano'],
  ['{coach}', 'nome do coach'],
  ['{modalidade_texto}', '" *Corrida*" ou vazio'],
  ['{plano_texto}', '", no plano *X*" ou vazio'],
  ['{coach_texto}', '", com acompanhamento de *X*" ou vazio'],
  ['{com_coach}', '"com *X*" ou "na assessoria"'],
  ['{o_coach}', '"o coach *X*" ou "o coach escolhido"'],
  ['{resumo_proposta}', 'modalidade, plano, coach, total, matrícula e vencimento'],
  ['{valor}', 'total da proposta'],
  ['{parcelas}', '"3x de R$ 300,00"'],
  ['{vencimento}', 'vencimento do link'],
  ['{link_pagamento}', 'link de pagamento'],
  ['{link_bloco}', '"🔗 link" ou vazio'],
  ['{prazo_link}', 'último dia do link no encerramento ("sábado, 10/10")'],
];

const FIRST_CONTACT_END = '\n\nQuer seguir com a contratação? Se preferir tirar alguma dúvida antes, sobre os treinos, '
  + 'o plano ou o dia a dia da assessoria, é só me falar que eu te ajudo!';
const PROPOSAL_END = '{resumo_proposta}\n\nPara confirmar sua vaga, faça o pagamento pelo link:\n🔗 {link_pagamento}\n\n'
  + 'Assim que o pagamento for confirmado, {o_coach} entrará em contato para iniciar seu atendimento. 🏆';

const DEFAULT_TEMPLATES = {
  first_contact: {
    slug: 'proposal-first-contact',
    name: 'Proposta · primeiro contato (cadastro novo)',
    template: 'Olá, {nome}! Tudo bem?\n\nAqui é da Endurance ON! Recebemos seu interesse em treinar{modalidade_texto} com a gente{plano_texto}{coach_texto}. 🙌'
      + FIRST_CONTACT_END,
  },
  first_contact_returning: {
    slug: 'proposal-first-contact-returning',
    name: 'Proposta · primeiro contato (ex-aluno)',
    template: 'Olá, {nome}! Tudo bem?\n\nAqui é da Endurance ON! Que bom ver você de volta! Recebemos seu interesse em voltar a treinar{modalidade_texto} com a gente{plano_texto}{coach_texto}. 🙌'
      + FIRST_CONTACT_END,
  },
  follow_up: {
    slug: 'proposal-follow-up',
    name: 'Proposta · lembrete do dia 2',
    template: 'Oi, {nome}! Tudo bem?\n\nSe ajudar na decisão, posso te explicar como funcionam as primeiras semanas {com_coach} '
      + 'ou tirar qualquer dúvida por aqui, por áudio ou numa ligação rápida, como for melhor para você.\n\n'
      + 'Quer seguir com a contratação?',
  },
  closing: {
    slug: 'proposal-closing',
    name: 'Proposta · encerramento sem link',
    template: 'Oi, {nome}! Tudo bem?\n\nComo não consegui falar com você, imagino que agora não seja o melhor momento. '
      + 'Vou arquivar sua proposta por aqui para não ficar te mandando mensagem.\n\n'
      + 'Se quiser treinar com a gente mais para frente, é só me chamar. Vai ser um prazer te receber na Endurance ON! 🙌',
  },
  proposal_after_contact: {
    slug: 'proposal-send-after-contact',
    name: 'Proposta · envio do link (depois da conversa)',
    template: 'Olá, {nome}! 👋\n\nQue bom que você quer seguir! Sua proposta está pronta:\n\n' + PROPOSAL_END,
  },
  proposal_new: {
    slug: 'proposal-send-new',
    name: 'Proposta · envio do link (cadastro sem conversa)',
    template: 'Olá, {nome}! 👋\n\nRecebemos seu cadastro para treinar com a *Endurance On*. Sua proposta está pronta:\n\n' + PROPOSAL_END,
  },
  proposal_returning: {
    slug: 'proposal-send-returning',
    name: 'Proposta · envio do link (ex-aluno sem conversa)',
    template: 'Olá, {nome}! 👋\n\nQue bom ter você de volta à *Endurance On*! Sua nova proposta está pronta:\n\n' + PROPOSAL_END,
  },
  payment_reminder: {
    slug: 'proposal-payment-reminder',
    name: 'Proposta · lembrete de pagamento',
    template: 'Olá, {nome}! 👋\n\nPassando só para lembrar que sua proposta para treinar com a *Endurance On* ficou reservada e o pagamento ainda está em aberto.\n\n'
      + '{resumo_proposta}\n\nPara confirmar sua vaga, é só finalizar pelo link abaixo:\n🔗 {link_pagamento}\n\n'
      + 'Assim que o pagamento for confirmado, {o_coach} entra em contato para dar início ao atendimento. '
      + 'Se você já fez o pagamento, pode desconsiderar esta mensagem. Qualquer dúvida, me chama por aqui.',
  },
  payment_closing: {
    slug: 'proposal-payment-closing',
    name: 'Proposta · encerramento com link',
    template: 'Oi, {nome}! Tudo bem?\n\nComo o pagamento da sua proposta ainda não foi concluído, imagino que agora não seja o melhor momento. '
      + 'Vou deixar o link ativo até {prazo_link}; depois disso, arquivo a proposta por aqui.\n\n'
      + '{link_bloco}Se você já fez o pagamento, pode desconsiderar esta mensagem. '
      + 'E se quiser retomar mais para frente, é só me chamar. 🙌',
  },
};

export const DEFAULT_PROSPECT_RULES = Object.entries(DEFAULT_TEMPLATES).map(([key, item], index) => ({
  slug: item.slug,
  name: item.name,
  journey: PROSPECT_JOURNEY,
  trigger_event: 'manual',
  task_kind: PROSPECT_MESSAGES[key].taskKind,
  days_offset: PROSPECT_MESSAGES[key].offset,
  channel: 'whatsapp',
  active: true,
  order_index: 70 + index,
  message_template: item.template,
}));

function matchesStep(rule, meta) {
  return rule.journey === PROSPECT_JOURNEY
    && rule.task_kind === meta.taskKind
    && Number(rule.days_offset) === meta.offset;
}

// Modelo ativo de menor ordem para o passo; sem ele, o texto padrão.
export function prospectMessageRule(rules, key) {
  const meta = PROSPECT_MESSAGES[key];
  if (!meta) return null;
  const active = (rules || [])
    .filter(rule => rule.active !== false && matchesStep(rule, meta) && String(rule.message_template || '').trim())
    .sort((a, b) => (Number(a.order_index) || 0) - (Number(b.order_index) || 0)
      || String(a.slug || '').localeCompare(String(b.slug || '')));
  return active[0] || DEFAULT_PROSPECT_RULES.find(rule => matchesStep(rule, meta)) || null;
}

function proposalSummary({ modality, plan, periodMonths, coach, total, installments, enrollmentFee, dueDate }) {
  const months = Number(periodMonths) || 1;
  const count = Number(installments) || 1;
  const lines = [];
  if (modality) lines.push(`🏃 Modalidade: *${modality}*`);
  lines.push(`📅 Plano: *${plan}* (${months} ${months === 1 ? 'mês' : 'meses'})`);
  if (coach) lines.push(`👤 Coach: *${coach}*`);
  lines.push(`💰 Total: *${formatCurrency(total)}*${count > 1 ? ` em *${count}x de ${formatCurrency(total / count)}*` : ''}`);
  if (Number(enrollmentFee) > 0) lines.push(`📌 Matrícula: ${formatCurrency(enrollmentFee)}`);
  lines.push(`⏰ Vencimento: *${formatDate(dueDate)}*`);
  return lines.join('\n');
}

export function prospectMessageValues(data = {}) {
  const modality = String(data.modality || '').trim();
  const plan = String(data.plan || '').trim();
  const coach = String(data.coach || '').trim();
  const total = Number(data.total) || 0;
  const installments = Number(data.installments) || 1;
  const paymentLink = String(data.paymentLink || '').trim();
  return {
    '{nome}': prospectFirstName(data.fullName),
    '{modalidade}': modality,
    '{plano}': plan,
    '{coach}': coach,
    '{modalidade_texto}': modality ? ` *${modality}*` : '',
    '{plano_texto}': plan ? `, no plano *${plan}*` : '',
    '{coach_texto}': coach ? `, com acompanhamento de *${coach}*` : '',
    '{com_coach}': coach ? `com *${coach}*` : 'na assessoria',
    '{o_coach}': coach ? `o coach *${coach}*` : 'o coach escolhido',
    '{resumo_proposta}': proposalSummary({ ...data, modality, plan: plan || 'Assessoria', coach, total, installments }),
    '{valor}': formatCurrency(total),
    '{parcelas}': `${installments}x de ${formatCurrency(total / installments)}`,
    '{vencimento}': data.dueDate ? formatDate(data.dueDate) : '',
    '{link_pagamento}': paymentLink,
    '{link_bloco}': paymentLink ? `🔗 ${paymentLink}\n\n` : '',
    '{prazo_link}': formatDeadline(data.deadline),
  };
}

export function renderProspectMessage(template, values) {
  return Object.entries(values)
    .reduce((text, [key, value]) => text.replaceAll(key, value), String(template || ''))
    .trim();
}

export function buildProspectMessage(key, data, rules) {
  const rule = prospectMessageRule(rules, key);
  return rule ? renderProspectMessage(rule.message_template, prospectMessageValues(data)) : '';
}

// Qual texto da proposta com link: lembrete depois do primeiro envio; antes
// dele, "quer seguir" quando já houve conversa, ou a abertura do cadastro.
export function proposalMessageKey(contract) {
  if (contract?.prospect_stage === 'payment_link_sent' && contract.prospect_message_sent_at) return 'payment_reminder';
  if (contract?.prospect_first_contact_at || contract?.prospect_last_contact_at) return 'proposal_after_contact';
  return contract?.prospect_customer_relationship === 'former_student' ? 'proposal_returning' : 'proposal_new';
}

export function contactMessageKey(kind, returning = false) {
  if (kind === 'first_contact') return returning ? 'first_contact_returning' : 'first_contact';
  return PROSPECT_MESSAGES[kind] ? kind : null;
}
