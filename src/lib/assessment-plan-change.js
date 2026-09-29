import { EXTERNAL_CHARGE_METHODS } from './external-charge.js';

// Regras de tela da mudança de plano no meio do ciclo. O cálculo que vale é o
// do banco (quote_assessment_plan_change); aqui ficam só rótulos, o filtro de
// formas de pagamento e a parte do estorno que a tela mostra antes de cancelar.

export const PLAN_CHANGE_STATUS = {
  scheduled: { label: 'Agendada', className: 'bg-blue-100 text-blue-700' },
  applied: { label: 'Em vigor', className: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Cancelada', className: 'bg-gray-100 text-gray-500' },
};

export const PLAN_CHANGE_PAYMENT_STATUS = {
  not_required: { label: 'Sem cobrança', className: 'bg-gray-100 text-gray-600' },
  awaiting_charge: { label: 'Aguardando cobrança', className: 'bg-amber-100 text-amber-700' },
  charge_sent: { label: 'Cobrança enviada', className: 'bg-amber-100 text-amber-700' },
  paid: { label: 'Pago', className: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Cancelada', className: 'bg-gray-100 text-gray-500' },
};

export const PLAN_CHANGE_TYPE_LABEL = { upgrade: 'Upgrade', lateral: 'Troca lateral' };

// Até 6x, parcela mínima de R$ 50; abaixo de R$ 100, à vista.
export function planChangeMaxInstallments(amount) {
  const value = Number(amount) || 0;
  return value >= 100 ? Math.min(6, Math.floor(value / 50)) : 1;
}

export function isOpenPlanChangeCharge(change) {
  return ['awaiting_charge', 'charge_sent'].includes(change?.payment_status);
}

// Formas de pagamento (agrupadas como loadActivePaymentMethods devolve) que
// cabem no parcelamento permitido para a diferença.
export function allowedPlanChangeMethodGroups(methodGroups, maxInstallments) {
  const max = Math.max(1, Number(maxInstallments) || 1);
  return (methodGroups || [])
    .map(([group, list]) => [group, (list || []).filter(method => (Number(method.installments) || 1) <= max)])
    .filter(([, list]) => list.length > 0);
}

// Formas da cobrança externa (PIX, boleto e cartão) que cabem no parcelamento
// permitido para a diferença.
export function planChangeChargeMethods(maxInstallments) {
  const max = Math.max(1, Number(maxInstallments) || 1);
  return EXTERNAL_CHARGE_METHODS.filter(method => {
    const card = method.value.match(/^card_(\d+)x$/);
    return !card || Number(card[1]) <= max;
  });
}

function dayNumber(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

// Parte não usada das mudanças pagas numa data de cancelamento, com a mesma
// contagem de dias do cancelamento do contrato no banco.
export function planChangeUnusedValue(changes, contract, cutoffDate) {
  if (!contract?.end_date || !cutoffDate) return 0;
  const end = dayNumber(contract.end_date);
  const cutoff = dayNumber(cutoffDate);
  return (changes || [])
    .filter(change => change.status !== 'cancelled' && change.payment_status === 'paid')
    .reduce((sum, change) => {
      const effective = dayNumber(change.effective_date);
      const unusedDays = Math.max(0, (end - Math.max(cutoff, effective)) + 1);
      const upgradeDays = Math.max(1, (end - effective) + 1);
      return sum + (Number(change.amount) || 0) * unusedDays / upgradeDays;
    }, 0);
}

// Planos de destino que a matriz permite a partir do plano atual.
export function planChangeTargets(plans, transitions, fromPlanId) {
  const allowed = new Map(
    (transitions || [])
      .filter(row => row.from_plan_id === fromPlanId && ['upgrade', 'lateral'].includes(row.transition_type))
      .map(row => [row.to_plan_id, row.transition_type]),
  );
  return (plans || [])
    .filter(plan => allowed.has(plan.id) && plan.active !== false)
    .map(plan => ({ plan, type: allowed.get(plan.id) }))
    .sort((a, b) => Number(a.plan.price_total) - Number(b.plan.price_total)
      || String(a.plan.name || '').localeCompare(String(b.plan.name || ''), 'pt-BR'));
}

function dateFromDayNumber(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

// Trechos de plano do contrato, em ordem, com o último dia de cada um (a data
// final do contrato é exclusiva). No mesmo dia, a linha da mudança vale por
// cima da original, como no repasse.
export function planHistorySegments(historyRows, contractEndDate) {
  const byDay = new Map();
  [...(historyRows || [])]
    .sort((a, b) => String(a.valid_from).localeCompare(String(b.valid_from))
      || (a.change_type === 'original' ? 0 : 1) - (b.change_type === 'original' ? 0 : 1))
    .forEach(row => byDay.set(String(row.valid_from).slice(0, 10), row));
  const rows = [...byDay.values()];
  return rows.map((row, index) => {
    const next = rows[index + 1];
    const lastDay = next
      ? dayNumber(next.valid_from) - 1
      : (contractEndDate ? dayNumber(contractEndDate) - 1 : null);
    return {
      row,
      from: String(row.valid_from).slice(0, 10),
      to: lastDay == null ? null : dateFromDayNumber(lastDay),
    };
  });
}
