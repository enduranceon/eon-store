export const RENEWAL_TERMINAL_STAGES = new Set(['renewed', 'not_renewed']);

export function saoPauloDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function todaySaoPaulo() {
  return saoPauloDate(new Date());
}

function calendarDays(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
}

export function renewalTerminalDaysRemaining(contract, today) {
  const resolved = saoPauloDate(contract?.renewal_resolved_at);
  if (!resolved) return null;
  const elapsed = calendarDays(resolved, today);
  return elapsed === null ? null : Math.max(0, 5 - elapsed);
}

export function hasRenewalPaymentLink(contract) {
  return Boolean(
    contract?.asaas_payment_link ||
    contract?.asaas_pix_copy ||
    contract?.external_payment_link
  );
}

export function needsRenewalReview(contract) {
  if (!contract?.renewal_stage) return false;
  const stage = contract.renewal_stage;
  const paid = contract.payment_status === 'paid';
  return (paid && stage !== 'renewed') || (stage === 'renewed' && !paid) ||
    (stage === 'waiting_payment' && !contract.parent_contract_id) ||
    (RENEWAL_TERMINAL_STAGES.has(stage) && !contract.renewal_resolved_at);
}

export function isVisibleOnRenewalBoard(contract, today) {
  if (!contract?.renewal_stage) return false;
  if (!RENEWAL_TERMINAL_STAGES.has(contract.renewal_stage)) return true;
  const resolved = saoPauloDate(contract.renewal_resolved_at);
  if (!resolved) return true;
  const elapsed = calendarDays(resolved, today);
  return elapsed !== null && elapsed <= 5;
}

export function renewalDaysUntilEnd(parentEndDate, today) {
  return parentEndDate ? calendarDays(today, parentEndDate) : null;
}
