// Pro rata do plano mensal: o primeiro período vai do início até o próximo
// dia do ciclo (1 a 28) e custa o mensal ÷ 30 × dias. Mesma conta do servidor
// (apply_assessment_contract_prorata); aqui só para a prévia na tela.

export const PRORATA_DAY_BASE = 30;
export const PRORATA_CYCLE_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Próximo dia do ciclo depois do início.
export function prorataCycleEnd(startDate, cycleDay) {
  const start = parseDate(startDate);
  if (!start || !Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 28) return null;
  const sameMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), cycleDay));
  if (sameMonth > start) return formatDate(sameMonth);
  return formatDate(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, cycleDay)));
}

export function contractProrata(contract) {
  const prorata = contract?.plan_snapshot?.prorata;
  return prorata && typeof prorata === 'object' ? prorata : null;
}

// Valor mensal cheio do contrato (sem o pro rata).
export function prorataFullPrice(contract) {
  const prorata = contractProrata(contract);
  return money(prorata?.full_price_total) ?? money(contract?.plan_snapshot?.price_total);
}

export function prorataPreview(contract, cycleDay) {
  const full = prorataFullPrice(contract);
  const start = contract?.start_date;
  const startDay = parseDate(start)?.getUTCDate();
  const end = prorataCycleEnd(start, cycleDay);
  if (full == null || !end || startDay === cycleDay) return null;
  const days = Math.round((parseDate(end) - parseDate(start)) / 86400000);
  return {
    start: start.slice(0, 10),
    end,
    days,
    full,
    value: Math.round((full / PRORATA_DAY_BASE) * days * 100) / 100,
  };
}

const OPEN_PAYMENT = new Set(['pending', 'awaiting_charge', 'charge_sent', 'overdue']);
const OPEN_STATUS = new Set(['draft', 'scheduled', 'active', 'overdue']);

// O pro rata só muda antes do pagamento (o servidor confere o resto).
export function canChangeProrata(contract, { monthly, hasRenewal = false } = {}) {
  return Boolean(
    monthly &&
    contract &&
    OPEN_STATUS.has(contract.status) &&
    OPEN_PAYMENT.has(contract.payment_status) &&
    !contract.manual_payment &&
    !contract.payment_date &&
    !contract.asaas_charge_id &&
    !hasRenewal,
  );
}
