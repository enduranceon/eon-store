// Painel "Entradas e saídas" da assessoria: o que aconteceu num período
// qualquer, com a lista de quem entrou, voltou, renovou ou saiu, e a quebra por
// coach e por modalidade. As regras são as mesmas dos Indicadores
// (assessment-yearly-indicators.js): saída real, retorno e renovação não mudam
// de significado entre as telas.
import {
  addDays,
  classifyAssessmentContracts,
  dateOnly,
  getContractStart,
  isContractActiveAtEnd,
} from './assessment-yearly-indicators.js';

export const MOVEMENT_PERIODS = [
  { value: 'month', label: 'Mês atual' },
  { value: 'previous_month', label: 'Mês anterior' },
  { value: 'quarter', label: 'Últimos 3 meses' },
  { value: 'year', label: 'Ano atual' },
  { value: 'custom', label: 'Personalizado' },
];

export const MOVEMENT_KINDS = {
  baseStart: { label: 'Base no início', list: 'Alunos ativos no início do período' },
  entries: { label: 'Entradas', list: 'Novos alunos no período' },
  returns: { label: 'Retornos', list: 'Ex-alunos que voltaram no período' },
  renewals: { label: 'Renovações', list: 'Renovações que começaram no período' },
  exits: { label: 'Saídas', list: 'Saídas reais no período' },
  baseEnd: { label: 'Base no fim', list: 'Alunos ativos no fim do período' },
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function monthFirst(date, shift = 0) {
  const [year, month] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 + shift, 1, 12));
  return value.toISOString().slice(0, 10);
}

function monthLast(date) {
  return addDays(monthFirst(date, 1), -1);
}

function shortDate(date) {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

export function periodLabel(from, to) {
  if (from === monthFirst(from) && to.slice(0, 7) === from.slice(0, 7)) {
    const month = `${MONTHS[Number(from.slice(5, 7)) - 1]}/${from.slice(0, 4)}`;
    return to === monthLast(from) ? month : `${month} até ${to.slice(8)}/${to.slice(5, 7)}`;
  }
  return `${shortDate(from)} a ${shortDate(to)}`;
}

// Período escolhido nos botões. "Mês atual" e "Ano atual" vão até hoje.
export function movementPeriod(value, today, custom = {}) {
  if (value === 'previous_month') {
    const from = monthFirst(today, -1);
    return { from, to: monthLast(from) };
  }
  if (value === 'quarter') return { from: monthFirst(today, -2), to: today };
  if (value === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (value === 'custom' && DATE_PATTERN.test(custom.from || '') && DATE_PATTERN.test(custom.to || '')) {
    return custom.from <= custom.to ? { from: custom.from, to: custom.to } : { from: custom.to, to: custom.from };
  }
  return { from: monthFirst(today), to: today };
}

function dayCount(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

// Período de comparação. Começando no dia 1, volta os mesmos meses (1 a 9 de
// outubro compara com 1 a 9 de setembro; setembro inteiro, com agosto
// inteiro); o ano até hoje compara com o mesmo trecho do ano anterior. Fora
// disso, a mesma quantidade de dias logo antes.
export function previousMovementPeriod({ from, to }) {
  if (from === monthFirst(from)) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
      + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    const yearToDate = from.slice(5) === '01-01' && from.slice(0, 4) === to.slice(0, 4) && months > 3;
    const shift = yearToDate ? 12 : months;
    const prevFrom = monthFirst(from, -shift);
    const prevToMonth = monthFirst(to, -shift);
    const prevTo = to === monthLast(to)
      ? monthLast(prevToMonth)
      : [prevToMonth.slice(0, 8) + to.slice(8), monthLast(prevToMonth)].sort()[0];
    return { from: prevFrom, to: prevTo };
  }
  const days = dayCount(from, to);
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(days - 1)), to: prevTo };
}

function modalityOf(contract, plansById) {
  return contract.plan_snapshot?.modality_id || plansById[contract.plan_id]?.modality_id || null;
}

function planNameOf(contract, plansById) {
  return contract.plan_snapshot?.name || plansById[contract.plan_id]?.name || '';
}

function inPeriod(date, from, to) {
  return Boolean(date) && date >= from && date <= to;
}

// Uma linha por pessoa: a primeira ocorrência no período (ou o contrato da base).
function people(rows, dateOf) {
  const byCustomer = new Map();
  rows
    .slice()
    .sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))))
    .forEach(row => {
      const key = row.customer_id || `contract:${row.id}`;
      if (!byCustomer.has(key)) byCustomer.set(key, row);
    });
  return [...byCustomer.values()];
}

function item(contract, plansById, date, extra = {}) {
  return {
    customerId: contract.customer_id || null,
    contractId: contract.id,
    contractNumber: contract.contract_number || '',
    coachId: contract.coach_id || null,
    modalityId: modalityOf(contract, plansById),
    planName: planNameOf(contract, plansById),
    date: date || '',
    ...extra,
  };
}

function exitReason(contract) {
  return String(contract.cancellation_reason || contract.scheduled_cancellation_reason || '').trim();
}

function summarize(lists) {
  const count = key => lists[key].length;
  const baseStart = count('baseStart');
  return {
    baseStart,
    entries: count('entries'),
    returns: count('returns'),
    renewals: count('renewals'),
    exits: count('exits'),
    baseEnd: count('baseEnd'),
    net: count('entries') + count('returns') - count('exits'),
    churnRate: baseStart > 0 ? (count('exits') / baseStart) * 100 : 0,
  };
}

function movementLists(classified, { from, to, matches }) {
  const { plansById, operativeContracts, startKinds, exitDates } = classified;
  const rows = operativeContracts.filter(matches);
  const startsOfKind = kind => people(
    rows.filter(contract => startKinds.get(contract.id) === kind && inPeriod(getContractStart(contract), from, to)),
    getContractStart,
  ).map(contract => item(contract, plansById, getContractStart(contract)));
  const dayBefore = addDays(from, -1);
  return {
    baseStart: people(rows.filter(contract => isContractActiveAtEnd(contract, dayBefore)), getContractStart)
      .map(contract => item(contract, plansById, getContractStart(contract))),
    entries: startsOfKind('entry'),
    returns: startsOfKind('return'),
    renewals: startsOfKind('renewal'),
    exits: people(rows.filter(contract => inPeriod(exitDates.get(contract.id), from, to)), contract => exitDates.get(contract.id))
      .map(contract => item(contract, plansById, exitDates.get(contract.id), { reason: exitReason(contract) })),
    baseEnd: people(rows.filter(contract => isContractActiveAtEnd(contract, to)), getContractStart)
      .map(contract => item(contract, plansById, getContractStart(contract))),
  };
}

function breakdown(classified, { from, to, matches, keyOf }) {
  const keys = new Set();
  const lists = movementLists(classified, { from, to, matches });
  Object.values(lists).flat().forEach(entry => keys.add(keyOf(entry) ?? null));
  return [...keys].map(key => {
    const subset = movementLists(classified, {
      from,
      to,
      matches: contract => matches(contract) && keyOf(item(contract, classified.plansById, '')) === key,
    });
    return { key, lists: subset, ...summarize(subset) };
  })
    .filter(row => row.baseStart || row.baseEnd || row.entries || row.returns || row.renewals || row.exits)
    .sort((a, b) => b.baseEnd - a.baseEnd || b.exits - a.exits);
}

export function buildAssessmentMovement(contracts = [], plans = [], options = {}) {
  const asOf = dateOnly(options.asOf || new Date());
  const from = options.from;
  const to = [options.to, asOf].filter(Boolean).sort()[0];
  const classified = classifyAssessmentContracts(contracts, plans, asOf);
  const matches = contract => (!options.coachId || contract.coach_id === options.coachId)
    && (!options.modalityId || modalityOf(contract, classified.plansById) === options.modalityId);
  const lists = movementLists(classified, { from, to, matches });
  const previous = previousMovementPeriod({ from, to });
  const previousLists = movementLists(classified, { from: previous.from, to: previous.to, matches });
  return {
    from,
    to,
    requestedTo: options.to,
    asOf,
    label: periodLabel(from, to),
    previous: { ...previous, label: periodLabel(previous.from, previous.to), kpis: summarize(previousLists) },
    kpis: summarize(lists),
    lists,
    byCoach: breakdown(classified, { from, to, matches, keyOf: entry => entry.coachId }),
    byModality: breakdown(classified, { from, to, matches, keyOf: entry => entry.modalityId }),
  };
}
