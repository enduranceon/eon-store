// Operação do grupo do WhatsApp do evento e responsáveis (coaches) do evento.
//
// O evento marca se tem grupo no WhatsApp. Quando tem, cada inscrição PAGA entra no
// acompanhamento: "falta adicionar", "no grupo" ou "não quer entrar". Inscrição que
// ainda não pagou não entra na conta (ainda não é hora de chamar para o grupo) e
// cancelada/reembolsada nunca entra.

export const WHATSAPP_GROUP_STATUS = Object.freeze({
  PENDING: 'pending',
  ADDED: 'added',
  DECLINED: 'declined',
});

export const WHATSAPP_GROUP_OPTIONS = Object.freeze([
  { value: WHATSAPP_GROUP_STATUS.PENDING, label: 'Falta adicionar' },
  { value: WHATSAPP_GROUP_STATUS.ADDED, label: 'No grupo' },
  { value: WHATSAPP_GROUP_STATUS.DECLINED, label: 'Não quer entrar' },
]);

export function whatsappGroupLabel(status) {
  return WHATSAPP_GROUP_OPTIONS.find(option => option.value === status)?.label
    || WHATSAPP_GROUP_OPTIONS[0].label;
}

export function groupStatusOf(registration) {
  const status = registration?.whatsapp_group_status;
  return WHATSAPP_GROUP_OPTIONS.some(option => option.value === status)
    ? status
    : WHATSAPP_GROUP_STATUS.PENDING;
}

// A situação só pode ser mudada em evento com grupo e inscrição paga.
export function canChangeWhatsappGroup(event, registration) {
  return Boolean(event?.whatsapp_group_enabled) && registration?.payment_status === 'paid';
}

// Contagem só das inscrições pagas: é a lista de quem já pode ser chamado para o grupo.
export function summarizeWhatsappGroup(registrations = []) {
  const summary = { paid: 0, added: 0, pending: 0, declined: 0 };
  for (const registration of registrations) {
    if (registration?.payment_status !== 'paid') continue;
    summary.paid += 1;
    const status = groupStatusOf(registration);
    if (status === WHATSAPP_GROUP_STATUS.ADDED) summary.added += 1;
    else if (status === WHATSAPP_GROUP_STATUS.DECLINED) summary.declined += 1;
    else summary.pending += 1;
  }
  return summary;
}

export function isMissingFromGroup(registration) {
  return registration?.payment_status === 'paid'
    && groupStatusOf(registration) === WHATSAPP_GROUP_STATUS.PENDING;
}

export function summaryText(summary) {
  if (!summary.paid) return 'Nenhuma inscrição paga ainda.';
  const parts = [`${summary.added} de ${summary.paid} ${summary.paid === 1 ? 'pago' : 'pagos'} já ${summary.added === 1 ? 'está' : 'estão'} no grupo`];
  parts.push(summary.pending
    ? `${summary.pending} ${summary.pending === 1 ? 'falta' : 'faltam'} adicionar`
    : 'ninguém falta adicionar');
  if (summary.declined) parts.push(`${summary.declined} não ${summary.declined === 1 ? 'quer' : 'querem'} entrar`);
  return parts.join(' · ');
}

// Responsáveis atuais do evento (ids), na ordem estável de id.
export function responsibleCoachIds(eventCoaches = [], eventId) {
  return eventCoaches
    .filter(item => item.event_id === eventId)
    .map(item => item.coach_id)
    .sort();
}

export function sameCoachSet(a = [], b = []) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

// Coaches que podem ser escolhidos: ativos, mais os inativos que já eram responsáveis
// (para não sumirem da lista e serem tirados sem querer).
export function selectableCoaches(coaches = [], assignedIds = []) {
  const assigned = new Set(assignedIds);
  return coaches
    .filter(coach => coach.active !== false || assigned.has(coach.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
}
