// Caixa do ano na Visão geral: doze meses de recebimentos e saídas realizados.
// Só entra movimento realizado (recebimento, estorno, despesa, repasse e ajuste),
// pela data efetiva do movimento, como o livro financeiro. O que ainda vai
// entrar (a receber, emitido ou contratado) não é dinheiro recebido.
//
// Composição de cada mês:
//   resultado = recebido líquido + ajustes positivos - saídas realizadas
// Ajuste positivo que não é recebimento (ex.: ajuste de repasse a favor) aparece
// à parte; nunca fica escondido para forçar duas barras. Ajuste negativo entra
// nas saídas. A taxa já está abatida no recebido líquido e não é descontada de novo.

import { FINANCIAL_MOVEMENT_KIND } from './financial-ledger.js';
import { financialMovementDate, isActualFinancialMovement } from './financial-dashboard.js';

// Estados de um mês: o que mostrar nunca é inferido de um zero.
export const CASH_MONTH_STATE = Object.freeze({
  REALIZED: 'realized', // mês fechado com cobertura: zero é zero confirmado
  PARTIAL: 'partial', // mês corrente: valor realizado até a data da consulta
  FUTURE: 'future', // sem valor realizado
  INSUFFICIENT: 'insufficient', // antes do primeiro movimento conhecido: sem valor
});

const cents = value => Math.round((Number(value) || 0) * 100);
const fromCents = value => value / 100;

function localDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function signedCents(movement) {
  const signed = Number(movement?.signed_net_amount);
  if (Number.isFinite(signed)) return cents(signed);
  const amount = Math.abs(cents(movement?.net_amount));
  return movement?.cash_direction === 'outflow' ? -amount : amount;
}

// Mesmo movement_id conta uma vez; ids diferentes com mesmo valor e data são
// operações distintas e permanecem na soma.
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
  if (year > todayYear || (year === todayYear && monthIndex + 1 > todayMonth)) return CASH_MONTH_STATE.FUTURE;
  if (!coverageFrom || last < coverageFrom) return CASH_MONTH_STATE.INSUFFICIENT;
  if (year === todayYear && monthIndex + 1 === todayMonth) return CASH_MONTH_STATE.PARTIAL;
  return CASH_MONTH_STATE.REALIZED;
}

// movements: movimentos do ano (realizados). coverageFrom: data do primeiro
// movimento realizado conhecido no livro (todos os anos), para saber a partir
// de quando há histórico. truncated: a consulta bateu no limite e pode estar incompleta.
export function buildYearCash(movements = [], { year, now = new Date(), coverageFrom = null, truncated = false } = {}) {
  const today = localDate(now);
  const targetYear = year ?? now.getFullYear();
  const months = Array.from({ length: 12 }, (_, monthIndex) => ({
    ym: `${targetYear}-${String(monthIndex + 1).padStart(2, '0')}`,
    monthIndex,
    state: monthState({ year: targetYear, monthIndex, today, coverageFrom }),
    receivedCents: 0,
    outflowsCents: 0,
    positiveAdjustmentsCents: 0,
    resultCents: 0,
    movementCount: 0,
  }));

  for (const movement of dedupeMovements(movements)) {
    if (!isActualFinancialMovement(movement)) continue;
    const date = financialMovementDate(movement);
    if (!date || Number(date.slice(0, 4)) !== targetYear) continue;
    const month = months[Number(date.slice(5, 7)) - 1];
    if (month.state === CASH_MONTH_STATE.FUTURE || month.state === CASH_MONTH_STATE.INSUFFICIENT) continue;

    const signed = signedCents(movement);
    month.resultCents += signed;
    month.movementCount += 1;
    if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIPT) {
      month.receivedCents += Math.abs(cents(movement.net_amount));
    } else if (signed < 0) {
      month.outflowsCents += -signed;
    } else {
      month.positiveAdjustmentsCents += signed;
    }
  }

  const rows = months.map(month => {
    const hasValue = month.state === CASH_MONTH_STATE.REALIZED || month.state === CASH_MONTH_STATE.PARTIAL;
    return {
      ym: month.ym,
      monthIndex: month.monthIndex,
      state: month.state,
      received: hasValue ? fromCents(month.receivedCents) : null,
      outflows: hasValue ? fromCents(month.outflowsCents) : null,
      positiveAdjustments: hasValue ? fromCents(month.positiveAdjustmentsCents) : null,
      result: hasValue ? fromCents(month.resultCents) : null,
      movementCount: month.movementCount,
      // Receber líquido + ajustes positivos - saídas precisa fechar com o resultado.
      reconciles: !hasValue
        || month.receivedCents + month.positiveAdjustmentsCents - month.outflowsCents === month.resultCents,
    };
  });

  const withValue = rows.filter(row => row.result !== null);
  const accumulated = fromCents(withValue.reduce((sum, row) => sum + cents(row.result), 0));
  return {
    year: targetYear,
    today,
    months: rows,
    accumulated,
    realizedMonths: withValue.length,
    truncated: Boolean(truncated),
    coverageFrom,
  };
}

// Movimentos que compõem um mês (para "Ver movimentações"), na mesma regra de data.
export function selectMonthMovements(movements = [], ym) {
  return dedupeMovements(movements)
    .filter(movement => isActualFinancialMovement(movement) && (financialMovementDate(movement) || '').startsWith(ym))
    .sort((a, b) => financialMovementDate(b).localeCompare(financialMovementDate(a)));
}
