// Trechos de coach do contrato, pela mesma regra do fechamento do repasse
// (supabase/functions/generate-monthly-closing/calculation.ts): em cada dia
// vale a troca registrada por último cujo started_at já chegou; antes de
// todas, vale a primeira.

function dayOf(value) {
  return String(value || '').slice(0, 10);
}

function addDays(day, amount) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10);
}

// Ordem de registro. No mesmo instante, a linha já encerrada vem antes.
function compareRows(a, b) {
  const byCreated = String(a.created_at || '').localeCompare(String(b.created_at || ''));
  if (byCreated) return byCreated;
  const openA = a.ended_at == null ? 1 : 0;
  const openB = b.ended_at == null ? 1 : 0;
  if (openA !== openB) return openA - openB;
  const byStart = dayOf(a.started_at).localeCompare(dayOf(b.started_at));
  if (byStart) return byStart;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function validRows(rows) {
  return (rows || []).filter(row => row?.coach_id && row?.started_at).sort(compareRows);
}

export function coachOnDay(rows, day) {
  const ordered = validRows(rows);
  if (!ordered.length) return null;
  let current = ordered[0];
  for (const row of ordered) {
    if (dayOf(row.started_at) <= day) current = row;
  }
  return current.coach_id;
}

// Trechos dentro da vigência: [{ coachId, from, to, current, scheduled }].
// "to" é o último dia do trecho; o último trecho vai até o fim do contrato
// (end_date é exclusivo).
export function coachHistorySegments(rows, { startDate, endDate, today } = {}) {
  const ordered = validRows(rows);
  if (!ordered.length || !startDate) return [];
  const first = dayOf(startDate);
  const lastDay = endDate ? addDays(dayOf(endDate), -1) : null;
  const boundaries = [...new Set([first, ...ordered.map(row => dayOf(row.started_at))])]
    .filter(day => day >= first && (!lastDay || day <= lastDay))
    .sort();

  const segments = [];
  boundaries.forEach((from, index) => {
    const coachId = coachOnDay(ordered, from);
    const next = boundaries[index + 1];
    const to = next ? addDays(next, -1) : lastDay;
    const previous = segments[segments.length - 1];
    if (previous && previous.coachId === coachId) {
      previous.to = to;
      return;
    }
    segments.push({ coachId, from, to });
  });

  return segments.map(segment => ({
    ...segment,
    current: Boolean(today) && segment.from <= today && (!segment.to || segment.to >= today),
    scheduled: Boolean(today) && segment.from > today,
  }));
}

// Troca agendada: troca de coach (fora de mudança de plano) que começa depois
// de hoje e depois do início do contrato. Mesma regra do banco
// (eon_private.pending_contract_coach_change).
export function pendingCoachChange(rows, { startDate, today } = {}) {
  const start = dayOf(startDate);
  const pending = validRows(rows).filter(row => !row.plan_change_id
    && dayOf(row.started_at) > today
    && dayOf(row.started_at) > start);
  return pending[pending.length - 1] || null;
}
