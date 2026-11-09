// Peças puras da área do coach: separar eventos próximos e passados, agrupar e filtrar
// inscritos, resumo do grupo do WhatsApp e link da conversa. O coach só olha (e marca o
// grupo): nada aqui calcula valor, porque o servidor nem envia valores.

import { groupStatusOf } from './event-whatsapp-group.js';

export const COACH_PAYMENT = Object.freeze({
  paid: { label: 'Pago', tone: 'success' },
  not_paid: { label: 'Não pago', tone: 'warning' },
  cancelled: { label: 'Cancelada', tone: 'secondary' },
});

export function paymentInfo(payment) {
  return COACH_PAYMENT[payment] || COACH_PAYMENT.not_paid;
}

function lastDay(event) {
  return event.end_date || event.event_date || '';
}

// Próximos (ainda não acabaram): do mais perto para o mais longe. Passados: do mais recente.
export function splitEvents(events = [], today) {
  const upcoming = events.filter(event => lastDay(event) >= today)
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
  const past = events.filter(event => lastDay(event) < today)
    .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
  return { upcoming, past };
}

export function groupRegistrations(registrations = []) {
  return {
    paid: registrations.filter(item => item.payment === 'paid'),
    notPaid: registrations.filter(item => item.payment === 'not_paid'),
    cancelled: registrations.filter(item => item.payment === 'cancelled'),
  };
}

const normalize = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Busca por nome (sem acento e sem diferenciar maiúsculas) e, se pedido, só quem ainda
// falta adicionar ao grupo (inscrição paga que está como "falta adicionar").
export function filterRegistrations(registrations = [], { query = '', onlyMissingGroup = false } = {}) {
  const needle = normalize(query);
  return registrations.filter(item => {
    if (needle && !normalize(item.person_name).includes(needle)) return false;
    if (onlyMissingGroup && !(item.payment === 'paid' && groupStatusOf({ whatsapp_group_status: item.whatsapp_group_status }) === 'pending')) return false;
    return true;
  });
}

// O servidor devolve o resumo do grupo com nomes próprios; aqui vira o formato do resumo em texto.
export function groupSummaryOf(summary) {
  if (!summary || summary.group_added == null) return null;
  const added = Number(summary.group_added) || 0;
  const pending = Number(summary.group_missing) || 0;
  const declined = Number(summary.group_declined) || 0;
  return { paid: added + pending + declined, added, pending, declined };
}

// Só dígitos e com o código do Brasil quando faltar. Sem número válido não há link.
export function whatsappLink(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${full}`;
}

export function formatPhone(number) {
  const digits = String(number || '').replace(/\D/g, '');
  const local = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return number || '';
}
