// Conversa da proposta (docs/fluxos-de-mensagens.md, seção 2): primeiro
// contato sem link, lembrete, encerramento e o prazo final do link. O envio é
// manual; aqui só se calcula o próximo passo de cada card. Os textos ficam em
// prospect-messages.js.
import { utcToLocalDateStr } from './utils.js';

export const FOLLOW_UP_DAYS = 2;
export const CLOSING_DAYS = 5;
export const CLOSING_AFTER_FOLLOW_UP_DAYS = 3;
export const PAYMENT_REMINDER_DAYS = 1;
export const PAYMENT_CLOSING_DAYS = 5;
export const LINK_DEADLINE_DAYS = 2;

export const PROSPECT_STEP_LABELS = {
  first_contact: 'Primeiro contato',
  proposal: 'Preparar proposta',
  follow_up: 'Lembrete',
  closing: 'Encerramento',
  send_proposal: 'Enviar proposta',
  payment_reminder: 'Lembrete de pagamento',
  payment_closing: 'Encerramento',
  archive: 'Arquivar',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function addDays(dateStr, days) {
  if (!DATE_PATTERN.test(dateStr || '')) return '';
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function latest(...dates) {
  return dates.filter(Boolean).sort().at(-1) || '';
}

function hasPaymentLink(draft) {
  return Boolean(draft?.external_payment_link || draft?.asaas_payment_link || draft?.payment_message_sent_at);
}

// Cadastro manual nasce, em geral, depois de uma conversa: vai direto para a
// proposta. Aluno atual também não recebe o primeiro contato.
export function skipsFirstContact(draft) {
  return Boolean(draft?.prospect_first_contact_at)
    || !draft?.latest_submission
    || draft?.prospect_customer_relationship === 'active_student';
}

// Próximo passo do card e a data em que ele vence. Os prazos contam a partir
// do envio real: o encerramento vem pelo menos 3 dias depois do lembrete.
export function prospectNextStep(draft) {
  if (!draft || draft.status !== 'draft') return null;
  const stage = draft.prospect_stage;
  if (stage === 'new') {
    if (hasPaymentLink(draft)) return null;
    return {
      kind: skipsFirstContact(draft) ? 'proposal' : 'first_contact',
      dueDate: utcToLocalDateStr(draft.created_at),
    };
  }
  if (stage === 'awaiting_reply' || stage === 'clarifying') {
    const lastContact = utcToLocalDateStr(draft.prospect_last_contact_at);
    if (!lastContact) return null;
    if (!draft.prospect_followup_sent_at) {
      return { kind: 'follow_up', dueDate: addDays(lastContact, FOLLOW_UP_DAYS) };
    }
    return {
      kind: 'closing',
      dueDate: latest(
        addDays(lastContact, CLOSING_DAYS),
        addDays(utcToLocalDateStr(draft.prospect_followup_sent_at), CLOSING_AFTER_FOLLOW_UP_DAYS),
      ),
    };
  }
  if (stage === 'proposal_ready') {
    return { kind: 'send_proposal', dueDate: utcToLocalDateStr(draft.prospect_proposal_ready_at) };
  }
  if (stage === 'payment_link_sent' && DATE_PATTERN.test(draft.due_date || '')) {
    if (draft.prospect_closing_sent_at && draft.prospect_close_deadline) {
      return { kind: 'archive', dueDate: draft.prospect_close_deadline };
    }
    const reminder = utcToLocalDateStr(draft.prospect_payment_reminder_sent_at);
    if (!reminder) {
      return { kind: 'payment_reminder', dueDate: addDays(draft.due_date, PAYMENT_REMINDER_DAYS) };
    }
    return {
      kind: 'payment_closing',
      dueDate: latest(
        addDays(draft.due_date, PAYMENT_CLOSING_DAYS),
        addDays(reminder, CLOSING_AFTER_FOLLOW_UP_DAYS),
      ),
    };
  }
  return null;
}

export function isStepDue(step, today) {
  return Boolean(step?.dueDate) && step.dueDate <= today;
}

// "Para hoje": todo passo que já venceu, de mensagem, proposta ou arquivar.
export function needsActionToday(draft, today) {
  return isStepDue(prospectNextStep(draft), today);
}

export function hoursSince(timestamp, now = Date.now()) {
  const time = new Date(timestamp || '').getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / 3_600_000));
}

export function formatDeadline(dateStr) {
  if (!DATE_PATTERN.test(dateStr || '')) return '';
  const date = new Date(`${dateStr}T12:00:00Z`);
  const [, month, day] = dateStr.split('-');
  return `${WEEKDAYS[date.getUTCDay()]}, ${day}/${month}`;
}

export function prospectFirstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'atleta';
}
