// Arquivo do Tecnofit (sistema antigo, 2020 a 2026). Só consulta: nada daqui
// entra em contratos, indicadores, financeiro ou repasse.

export const ARCHIVE_VIEWS = [
  { key: 'ex_students', label: 'Ex-alunos' },
  { key: 'in_eon', label: 'Já na EON Store' },
  { key: 'customers_only', label: 'Só compras e eventos' },
  { key: 'all', label: 'Todos' },
];

export const RECEIPT_KINDS = {
  plan: 'Plano',
  fee: 'Taxa ou ajuste',
  event: 'Evento',
  store: 'Loja',
  service: 'Serviço',
};

export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Quem tem contrato na EON Store já voltou (ou nunca saiu); sem plano no
// Tecnofit, a pessoa só comprou na loja ou foi a eventos.
export function archiveSituation(person) {
  if (person?.has_eon_contract) return 'in_eon';
  if (Number(person?.plans_count) > 0) return 'ex_students';
  return 'customers_only';
}

export function exitYear(person) {
  return person?.last_plan_end ? Number(String(person.last_plan_end).slice(0, 4)) : null;
}

// Ex-aluno com plano pago no Tecnofit que vai além de hoje.
export function hasRunningTecnofitPlan(person, today) {
  return archiveSituation(person) === 'ex_students'
    && Boolean(person.last_plan_end)
    && String(person.last_plan_end) > today;
}

export function summarizeArchive(people) {
  const views = { ex_students: 0, in_eon: 0, customers_only: 0, all: people.length };
  let receipts = 0;
  let total = 0;
  for (const person of people) {
    views[archiveSituation(person)] += 1;
    receipts += Number(person.receipts_count) || 0;
    total += Number(person.receipts_total) || 0;
  }
  return { views, receipts, total: Math.round(total * 100) / 100 };
}

export function countByExitYear(people) {
  const counts = new Map();
  for (const person of people) {
    const year = exitYear(person);
    if (year) counts.set(year, (counts.get(year) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, count]) => ({ year, count }));
}

// Busca por partes do nome, sem acento e em qualquer ordem, ou pelo código do
// cliente no Tecnofit.
export function matchesArchiveSearch(person, query) {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  if (!terms.length) return true;
  if (terms.length === 1 && /^\d+$/.test(terms[0])) return String(person.tecnofit_code) === terms[0];
  const name = normalizeSearchText(person.full_name);
  return terms.every(term => name.includes(term));
}

export function filterArchive(people, { view = 'ex_students', year = 'all', query = '' } = {}) {
  return people.filter(person => {
    if (view !== 'all' && archiveSituation(person) !== view) return false;
    if (year !== 'all' && String(exitYear(person)) !== String(year)) return false;
    return matchesArchiveSearch(person, query);
  });
}

const byName = (a, b) => normalizeSearchText(a.full_name).localeCompare(normalizeSearchText(b.full_name), 'pt-BR')
  || a.tecnofit_code - b.tecnofit_code;

// "recent": quem saiu por último aparece primeiro; quem nunca teve plano vai
// para o fim.
export function sortArchive(people, order = 'recent') {
  const rows = [...people];
  if (order === 'name') return rows.sort(byName);
  return rows.sort((a, b) => {
    const endA = a.last_plan_end || '';
    const endB = b.last_plan_end || '';
    if (endA !== endB) return endA < endB ? 1 : -1;
    return byName(a, b);
  });
}
