// Recebimentos do ano na Visão geral: quanto entrou em cada mês (planos, eventos,
// loja e pré-venda), em valor líquido de taxa, pela data do recebimento.
//
// O sistema ainda não controla saídas (despesas, repasses, devoluções), então esta
// visão NÃO é caixa nem resultado: só entram recebimentos realizados. Nenhuma
// saída é somada, subtraída ou exibida como zero. A análise de saídas virá depois.
// O que ainda vai entrar (a receber, emitido ou contratado) também não conta.
//
// A taxa já está abatida no valor líquido e não é descontada de novo.

import { FINANCIAL_MOVEMENT_KIND } from './financial-ledger.js';
import { financialMovementDate, isActualFinancialMovement } from './financial-dashboard.js';

// Estados de um mês: o que mostrar nunca é inferido de um zero.
export const RECEIPT_MONTH_STATE = Object.freeze({
  REALIZED: 'realized', // mês fechado com histórico: zero é zero confirmado
  PARTIAL: 'partial', // mês corrente: valor recebido até a data da consulta
  FUTURE: 'future', // sem valor recebido ainda
  INSUFFICIENT: 'insufficient', // antes do primeiro recebimento conhecido: sem valor
});

const cents = value => Math.round((Number(value) || 0) * 100);
const fromCents = value => value / 100;

function localDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function isReceipt(movement) {
  return movement?.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIPT && isActualFinancialMovement(movement);
}

// Mesmo movement_id conta uma vez; ids diferentes com mesmo valor e data são
// recebimentos distintos e permanecem na soma.
export function dedupeMovements(movements = []) {
  const seen = new Set();
  const result = [];
  for (const movement of movements) {
    const id = movement?.movement_id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    result.push(movement);
  }
  return result;
}

function monthState({ year, monthIndex, today, coverageFrom }) {
  const [todayYear, todayMonth] = today.split('-').map(Number);
  const last = localDate(new Date(year, monthIndex + 1, 0, 12));
  if (year > todayYear || (year === todayYear && monthIndex + 1 > todayMonth)) return RECEIPT_MONTH_STATE.FUTURE;
  if (!coverageFrom || last < coverageFrom) return RECEIPT_MONTH_STATE.INSUFFICIENT;
  if (year === todayYear && monthIndex + 1 === todayMonth) return RECEIPT_MONTH_STATE.PARTIAL;
  return RECEIPT_MONTH_STATE.REALIZED;
}

// movements: movimentos do ano (só os recebimentos realizados contam, qualquer
// outro tipo é ignorado). coverageFrom: data do primeiro recebimento realizado
// conhecido (todos os anos), para saber desde quando há histórico. truncated: a
// consulta bateu no limite e pode estar incompleta.
export function buildYearReceipts(movements = [], { year, now = new Date(), coverageFrom = null, truncated = false } = {}) {
  const today = localDate(now);
  const targetYear = year ?? now.getFullYear();
  const months = Array.from({ length: 12 }, (_, monthIndex) => ({
    ym: `${targetYear}-${String(monthIndex + 1).padStart(2, '0')}`,
    monthIndex,
    state: monthState({ year: targetYear, monthIndex, today, coverageFrom }),
    receivedCents: 0,
    receiptCount: 0,
  }));

  for (const movement of dedupeMovements(movements)) {
    if (!isReceipt(movement)) continue;
    const date = financialMovementDate(movement);
    if (!date || Number(date.slice(0, 4)) !== targetYear) continue;
    const month = months[Number(date.slice(5, 7)) - 1];
    if (month.state === RECEIPT_MONTH_STATE.FUTURE || month.state === RECEIPT_MONTH_STATE.INSUFFICIENT) continue;
    month.receivedCents += Math.abs(cents(movement.net_amount));
    month.receiptCount += 1;
  }

  const rows = months.map(month => {
    const hasValue = month.state === RECEIPT_MONTH_STATE.REALIZED || month.state === RECEIPT_MONTH_STATE.PARTIAL;
    return {
      ym: month.ym,
      monthIndex: month.monthIndex,
      state: month.state,
      received: hasValue ? fromCents(month.receivedCents) : null,
      receiptCount: month.receiptCount,
    };
  });

  const withValue = rows.filter(row => row.received !== null);
  return {
    year: targetYear,
    today,
    months: rows,
    accumulated: fromCents(withValue.reduce((sum, row) => sum + cents(row.received), 0)),
    realizedMonths: withValue.length,
    truncated: Boolean(truncated),
    coverageFrom,
  };
}

// Recebimentos que compõem um mês (para "Ver recebimentos"), na mesma regra de
// data, do mais recente para o mais antigo.
export function selectMonthReceipts(movements = [], ym) {
  return dedupeMovements(movements)
    .filter(movement => isReceipt(movement) && (financialMovementDate(movement) || '').startsWith(ym))
    .sort((a, b) => financialMovementDate(b).localeCompare(financialMovementDate(a)));
}
