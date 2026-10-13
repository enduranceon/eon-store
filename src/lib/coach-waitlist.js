// Lista de espera de cada coach: situações, ordem da fila e o cadastro manual.
// Quem entra pelo site cai aqui; a equipe conversa, consulta o coach, oferece
// outro coach ou cria o prospect. Nada aqui cria contrato ou cobrança.
import { normalizePhone } from './phone.js';

export const WAITLIST_STATUSES = [
  { value: 'waiting', label: 'Aguardando', open: true, tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  { value: 'contacted', label: 'Em contato', open: true, tone: 'bg-blue-50 text-blue-800 border-blue-200' },
  { value: 'asking_coach', label: 'Consultando o coach', open: true, tone: 'bg-violet-50 text-violet-800 border-violet-200' },
  { value: 'converted', label: 'Virou prospect', open: false, tone: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  { value: 'closed', label: 'Encerrado', open: false, tone: 'bg-slate-100 text-slate-600 border-slate-200' },
];

export const OPEN_WAITLIST_STATUSES = new Set(
  WAITLIST_STATUSES.filter(status => status.open).map(status => status.value),
);

export const WAITLIST_REGIONS = [
  { value: 'florianopolis', label: 'Florianópolis' },
  { value: 'online', label: 'Online' },
];

export const WAITLIST_SOURCES = { site: 'Site', internal: 'Cadastro interno' };

export const WAITLIST_CLOSE_REASONS = [
  'Desistiu',
  'Não respondeu',
  'Foi para outra assessoria',
  'O coach não pode atender',
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 24 * 60 * 60 * 1000;

export function waitlistStatus(value) {
  return WAITLIST_STATUSES.find(status => status.value === value) || WAITLIST_STATUSES[0];
}

export function isOpenWaitlistEntry(entry) {
  return OPEN_WAITLIST_STATUSES.has(entry?.status);
}

const SAO_PAULO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : SAO_PAULO_DATE.format(date);
}

// Dias na fila, contados em datas de São Paulo (entrou hoje = 0).
export function waitingDays(entry, today) {
  const start = localDate(entry?.created_at);
  if (!start || !today) return 0;
  return Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY));
}

// Fila aberta primeiro, por ordem de chegada; depois as encerradas, mais recentes antes.
export function sortWaitlist(entries = []) {
  return [...entries].sort((a, b) => {
    const openA = isOpenWaitlistEntry(a);
    const openB = isOpenWaitlistEntry(b);
    if (openA !== openB) return openA ? -1 : 1;
    if (openA) return String(a.created_at).localeCompare(String(b.created_at));
    return String(b.status_changed_at || b.updated_at).localeCompare(String(a.status_changed_at || a.updated_at));
  });
}

// Posição de cada pessoa na fila aberta do seu coach (1 = primeira da fila).
export function waitlistPositions(entries = []) {
  const positions = new Map();
  const counters = new Map();
  for (const entry of sortWaitlist(entries)) {
    if (!isOpenWaitlistEntry(entry)) continue;
    const next = (counters.get(entry.coach_id) || 0) + 1;
    counters.set(entry.coach_id, next);
    positions.set(entry.id, next);
  }
  return positions;
}

// Fila aberta por coach: quantas pessoas e há quantos dias espera a primeira.
export function summarizeWaitlist(entries = [], today) {
  const byCoach = new Map();
  for (const entry of entries) {
    if (!isOpenWaitlistEntry(entry)) continue;
    const current = byCoach.get(entry.coach_id) || { open: 0, waiting: 0, oldestDays: 0 };
    current.open += 1;
    if (entry.status === 'waiting') current.waiting += 1;
    current.oldestDays = Math.max(current.oldestDays, waitingDays(entry, today));
    byCoach.set(entry.coach_id, current);
  }
  return byCoach;
}

export function emptyWaitlistForm(coachId = '') {
  return { coach_id: coachId, modality_id: '', full_name: '', whatsapp: '', email: '', region: '', notes: '' };
}

// Cadastro manual: devolve { error } ou { payload } no formato da API.
export function prepareWaitlistEntry(form, coach) {
  const fullName = String(form.full_name || '').trim().replace(/\s+/g, ' ');
  if (!form.coach_id) return { error: 'Escolha o coach' };
  if (fullName.length < 3) return { error: 'Informe o nome' };
  const whatsapp = normalizePhone(form.whatsapp);
  if (!whatsapp || whatsapp.length > 16) return { error: 'Informe um WhatsApp válido' };
  const email = String(form.email || '').trim().toLowerCase();
  if (email && !EMAIL_PATTERN.test(email)) return { error: 'Informe um e-mail válido' };
  if (form.modality_id && coach && !(coach.modality_ids || []).includes(form.modality_id)) {
    return { error: 'O coach não atende esta modalidade' };
  }
  const notes = String(form.notes || '').trim();
  if (notes.length > 1000) return { error: 'As observações devem ter até 1000 caracteres' };
  return {
    payload: {
      coach_id: form.coach_id,
      modality_id: form.modality_id || null,
      full_name: fullName,
      whatsapp,
      email: email || null,
      region: form.region || null,
      notes: notes || null,
    },
  };
}
