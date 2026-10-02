// Regras do quadro de Renovações que não dependem de banco nem de tela.
// A etapa (renewal_stage) é gravada pelo servidor; aqui só se lê.

export const RENEWAL_STAGE = {
  CONTACT_PENDING: 'contact_pending',
  WAITING_RESPONSE: 'waiting_response',
  CHARGE_PENDING: 'charge_pending',
  WAITING_PAYMENT: 'waiting_payment',
  RENEWED: 'renewed',
  NOT_RENEWED: 'not_renewed',
  DISCARDED: 'discarded',
};

export const RENEWAL_STAGE_LABELS = {
  contact_pending: 'Enviar mensagem',
  waiting_response: 'Aguardando decisão',
  charge_pending: 'Enviar cobrança',
  waiting_payment: 'Aguardando pagamento',
  renewed: 'Renovou',
  not_renewed: 'Não renovou',
  discarded: 'Descartada',
};

export const RENEWAL_RESPONSE_LABELS = {
  will_renew: 'Sim, vou renovar',
  thinking: 'Ainda estou pensando',
  change_plan_or_coach: 'Mudar plano/treinador',
  needs_agent: 'Falar com um atendente',
  not_renewing: 'Não vou renovar',
};

export const OPEN_RENEWAL_STAGES = new Set([
  RENEWAL_STAGE.CONTACT_PENDING,
  RENEWAL_STAGE.WAITING_RESPONSE,
  RENEWAL_STAGE.CHARGE_PENDING,
  RENEWAL_STAGE.WAITING_PAYMENT,
]);

// Renovou / Não renovou ficam no quadro por 5 dias depois da decisão; depois
// disso só saem da tela (o registro e o histórico continuam).
export const RENEWAL_TERMINAL_VISIBLE_DAYS = 5;

const DAY_MS = 86400000;
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

function dateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// Dias de `todayStr` até `dateStr` (negativo quando a data já passou).
export function daysUntil(dateStr, todayStr) {
  const target = dateOnly(dateStr);
  const today = dateOnly(todayStr);
  if (target === null || today === null) return null;
  return Math.round((target - today) / DAY_MS);
}

// Data de negócio (São Paulo) de um instante gravado pelo servidor.
export function businessDate(timestamp) {
  const time = Date.parse(timestamp || '');
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}

export function renewalDueLabel(daysToEnd) {
  if (daysToEnd === null || daysToEnd === undefined) return 'sem data';
  if (daysToEnd > 1) return `vence em ${daysToEnd} dias`;
  if (daysToEnd === 1) return 'vence amanhã';
  if (daysToEnd === 0) return 'vence hoje';
  if (daysToEnd === -1) return 'venceu ontem';
  return `venceu há ${Math.abs(daysToEnd)} dias`;
}

export function followUpLabel(daysLate) {
  if (!daysLate || daysLate <= 0) return 'follow-up hoje';
  return `follow-up atrasado há ${daysLate} dia${daysLate === 1 ? '' : 's'}`;
}

// Trecho da mensagem do Pebinha: antes do fim, "seu plano vence nos próximos
// dias"; depois, "seu plano venceu em DD/MM".
export function renewalDueNotice(endDate, todayStr) {
  const days = daysUntil(endDate, todayStr);
  if (days === null || days >= 0) return 'seu plano vence nos próximos dias';
  const date = String(endDate).slice(0, 10);
  return `seu plano venceu em ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

// Quantos dias um card final ainda fica no quadro (0 = último dia).
export function terminalDaysLeft(resolvedAt, todayStr) {
  const resolvedDate = businessDate(resolvedAt);
  if (!resolvedDate) return null;
  const elapsed = -daysUntil(resolvedDate, todayStr);
  return RENEWAL_TERMINAL_VISIBLE_DAYS - elapsed;
}

// Uma renovação aberta nunca sai do quadro por data; só as finais saem, e só
// depois da janela de 5 dias.
export function isVisibleOnBoard(contract, todayStr) {
  const stage = contract?.renewal_stage;
  if (OPEN_RENEWAL_STAGES.has(stage)) return true;
  if (stage !== RENEWAL_STAGE.RENEWED && stage !== RENEWAL_STAGE.NOT_RENEWED) return false;
  const left = terminalDaysLeft(contract.renewal_resolved_at, todayStr);
  return left !== null && left >= 0;
}

const PERIOD_MONTHS = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

export function planPeriodMonths(plan) {
  const months = Number(plan?.period_months);
  if (Number.isInteger(months) && months > 0) return months;
  return PERIOD_MONTHS[plan?.period] || null;
}

// Renovação automática é só para o plano mensal (assinatura que já existe no
// Asaas). Plano desconhecido não é bloqueado aqui; o servidor decide.
export function allowsAutoRenewal(plan) {
  const months = planPeriodMonths(plan);
  return months === null || months === 1;
}

export const AUTO_RENEWAL_MONTHLY_ONLY_MESSAGE = 'A renovação automática só vale para plano mensal';
