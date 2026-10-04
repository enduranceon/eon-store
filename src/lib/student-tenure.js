import { getContractCancellationDate, getContractLocalDate, isContractVoidedSale } from './assessment-contract-lifecycle.js';
import { isEffectiveSale, PAID_PAYMENT_STATUSES } from './sales.js';
import { todayLocalStr } from './utils.js';

// Tempo de casa da pessoa. "Cliente desde" é o primeiro contrato que já
// começou ou a primeira compra paga; sem nenhum dos dois, vale o cadastro.
// Os dias na assessoria somam só os dias com plano vigente até hoje:
// intervalos sem plano, licenças, vendas descartadas, rascunhos e contratos
// que ainda não começaram ficam de fora.

const DAY_MS = 86400000;
const COVERED_STATUSES = new Set(['active', 'overdue', 'on_leave', 'scheduled', 'finished', 'cancelled']);

function dayNumber(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function dateFromDayNumber(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// Vigência como [início, fim) em dias corridos. O fim do contrato é o início
// do seguinte; o cancelamento guarda o último dia, que entra na conta.
function contractCoverage(contract, todayDay) {
  if (!COVERED_STATUSES.has(contract?.status) || isContractVoidedSale(contract)) return null;
  const start = getContractLocalDate(contract.start_date);
  if (!start) return null;
  const ends = [todayDay + 1];
  const end = getContractLocalDate(contract.end_date);
  if (end) ends.push(dayNumber(end));
  if (contract.status === 'cancelled') {
    const lastDay = getContractLocalDate(getContractCancellationDate(contract));
    if (lastDay) ends.push(dayNumber(lastDay) + 1);
  }
  const from = dayNumber(start);
  const to = Math.min(...ends);
  return to > from ? [from, to] : null;
}

// A licença também guarda o último dia; a que está em andamento vai até hoje.
function leaveInterval(leave, todayDay) {
  const start = getContractLocalDate(leave?.start_date);
  if (!start) return null;
  const end = getContractLocalDate(leave.end_date);
  const from = dayNumber(start);
  const to = Math.min(end ? dayNumber(end) + 1 : todayDay + 1, todayDay + 1);
  return to > from ? [from, to] : null;
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const [from, to] of intervals.filter(Boolean).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function sumDays(intervals) {
  return intervals.reduce((total, [from, to]) => total + to - from, 0);
}

function overlapDays(a, b) {
  let days = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const from = Math.max(a[i][0], b[j][0]);
    const to = Math.min(a[i][1], b[j][1]);
    if (to > from) days += to - from;
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return days;
}

export function assessmentTenure({ contracts = [], leaves = [], today = todayLocalStr() } = {}) {
  const todayDay = dayNumber(today);
  const coverage = mergeIntervals(contracts.map(contract => contractCoverage(contract, todayDay)));
  if (coverage.length === 0) return { days: 0, since: '' };
  const paused = mergeIntervals(leaves.map(leave => leaveInterval(leave, todayDay)));
  return {
    days: sumDays(coverage) - overlapDays(coverage, paused),
    since: dateFromDayNumber(coverage[0][0]),
  };
}

export function customerSinceDate({ customer = null, contracts = [], orders = [], today = todayLocalStr() } = {}) {
  const todayDay = dayNumber(today);
  const dates = contracts
    .map(contract => contractCoverage(contract, todayDay))
    .filter(Boolean)
    .map(([from]) => dateFromDayNumber(from));
  for (const order of orders) {
    if (!isEffectiveSale(order) || !PAID_PAYMENT_STATUSES.has(order.payment_status)) continue;
    const date = getContractLocalDate(order.created_date || order.created_at || order.payment_date);
    if (date && date <= today) dates.push(date);
  }
  if (dates.length > 0) return dates.sort()[0];
  return getContractLocalDate(customer?.created_date || customer?.created_at);
}
