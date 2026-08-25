import { FINANCIAL_MOVEMENT_KIND } from './financial-ledger.js';

export const FINANCIAL_DASHBOARD_PERIOD_OPTIONS = [
  { value: 'month', label: 'Mes atual' },
  { value: '30d', label: 'Ultimos 30 dias' },
  { value: '90d', label: 'Ultimos 90 dias' },
  { value: 'ytd', label: 'Ano atual' },
];

export const FINANCIAL_UNIT_META = Object.freeze({
  assessoria: { label: 'Assessoria', color: '#2563eb' },
  loja: { label: 'Loja', color: '#f97316' },
  pre_venda: { label: 'Pre-venda', color: '#8b5cf6' },
  eventos: { label: 'Eventos', color: '#059669' },
  outros: { label: 'Outros', color: '#64748b' },
});

const number = value => Number(value) || 0;

function localDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateOnly(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : localDateString(date);
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + amount);
  return localDateString(date);
}

function monthLabel(ym) {
  const date = new Date(`${ym}-01T12:00:00`);
  return date.toLocaleString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
}

export function financialMovementDate(movement) {
  if (movement?.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIVABLE) {
    return dateOnly(movement.due_on || movement.scheduled_on || movement.recognition_on || movement.created_at);
  }
  return dateOnly(movement?.occurred_on || movement?.scheduled_on || movement?.recognition_on || movement?.created_at);
}

export function financialUnitLabel(unit) {
  return FINANCIAL_UNIT_META[unit]?.label || FINANCIAL_UNIT_META.outros.label;
}

export function getFinancialDashboardPeriod(value = 'month', now = new Date()) {
  const today = localDateString(now);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  let label = FINANCIAL_DASHBOARD_PERIOD_OPTIONS.find(option => option.value === value)?.label || 'Mes atual';

  if (value === 'month') start.setDate(1);
  else if (value === '30d') start.setDate(start.getDate() - 29);
  else if (value === '90d') start.setDate(start.getDate() - 89);
  else if (value === 'ytd') start.setMonth(0, 1);
  else {
    start.setDate(1);
    label = 'Mes atual';
  }

  return { value, label, from: localDateString(start), to: today };
}

export function isActualFinancialMovement(movement) {
  return movement?.is_actual === true
    && movement?.movement_kind !== FINANCIAL_MOVEMENT_KIND.RECEIVABLE;
}

export function isOpenReceivable(movement) {
  return movement?.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIVABLE
    && movement?.is_actual !== true;
}

export function movementIsInPeriod(movement, period) {
  const date = financialMovementDate(movement);
  return !!date && date >= period.from && date <= period.to;
}

function createSummary() {
  return {
    grossReceipts: 0,
    netReceipts: 0,
    fees: 0,
    refunds: 0,
    expenses: 0,
    payouts: 0,
    payoutAdjustments: 0,
    operatingResult: 0,
    cashInflows: 0,
    cashOutflows: 0,
    actualMovementCount: 0,
    openReceivables: 0,
    overdueReceivables: 0,
    dueSoonReceivables: 0,
    receivableCount: 0,
  };
}

function signedAmount(movement) {
  const signed = Number(movement?.signed_net_amount);
  if (Number.isFinite(signed)) return signed;
  const amount = number(movement?.net_amount);
  return movement?.cash_direction === 'outflow' ? -amount : amount;
}

function addActualMovement(summary, movement) {
  const gross = Math.abs(number(movement.gross_amount));
  const net = Math.abs(number(movement.net_amount));
  const fee = Math.abs(number(movement.fee_amount));
  const signed = signedAmount(movement);

  summary.actualMovementCount += 1;
  summary.operatingResult += signed;
  if (signed >= 0) summary.cashInflows += signed;
  else summary.cashOutflows += Math.abs(signed);

  if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIPT) {
    summary.grossReceipts += gross;
    summary.netReceipts += net;
    summary.fees += fee;
  } else if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.REFUND) {
    summary.refunds += net;
  } else if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.EXPENSE) {
    summary.expenses += net;
  } else if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.PAYOUT) {
    summary.payouts += net;
  } else if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.PAYOUT_ADJUSTMENT) {
    summary.payoutAdjustments += signed;
  }
}

function addReceivable(summary, movement, today) {
  const amount = Math.abs(number(movement.gross_amount));
  const dueOn = dateOnly(movement.due_on || movement.scheduled_on || movement.recognition_on);
  const dueSoon = addDays(today, 7);

  summary.openReceivables += amount;
  summary.receivableCount += 1;
  if (dueOn && dueOn < today) summary.overdueReceivables += amount;
  if (dueOn && dueOn >= today && dueOn <= dueSoon) summary.dueSoonReceivables += amount;
}

export function summarizeFinancialMovements(movements = [], { now = new Date() } = {}) {
  const today = localDateString(now);
  const summary = createSummary();
  const byUnit = {};

  const getUnitSummary = unit => {
    const key = FINANCIAL_UNIT_META[unit] ? unit : 'outros';
    if (!byUnit[key]) byUnit[key] = createSummary();
    return byUnit[key];
  };

  movements.forEach(movement => {
    const unitSummary = getUnitSummary(movement.business_unit);
    if (isActualFinancialMovement(movement)) {
      addActualMovement(summary, movement);
      addActualMovement(unitSummary, movement);
    } else if (isOpenReceivable(movement)) {
      addReceivable(summary, movement, today);
      addReceivable(unitSummary, movement, today);
    }
  });

  return { ...summary, byUnit };
}

function buildMonthSeries(movements, period) {
  const first = new Date(`${period.from.slice(0, 7)}-01T12:00:00`);
  const last = new Date(`${period.to.slice(0, 7)}-01T12:00:00`);
  const rows = [];
  const byMonth = new Map();

  for (const movement of movements) {
    const date = financialMovementDate(movement);
    if (!date) continue;
    const ym = date.slice(0, 7);
    if (!byMonth.has(ym)) {
      byMonth.set(ym, {
        ym,
        label: monthLabel(ym),
        receipts: 0,
        outflows: 0,
        result: 0,
        assessoria: 0,
        loja: 0,
        pre_venda: 0,
        eventos: 0,
        outros: 0,
      });
    }
    const row = byMonth.get(ym);
    const signed = signedAmount(movement);
    const unit = FINANCIAL_UNIT_META[movement.business_unit] ? movement.business_unit : 'outros';
    row.result += signed;
    row[unit] += signed;
    if (movement.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIPT) {
      row.receipts += Math.abs(number(movement.net_amount));
    } else if (signed < 0) {
      row.outflows += Math.abs(signed);
    }
  }

  const cursor = new Date(first);
  while (cursor <= last) {
    const ym = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    rows.push(byMonth.get(ym) || {
      ym,
      label: monthLabel(ym),
      receipts: 0,
      outflows: 0,
      result: 0,
      assessoria: 0,
      loja: 0,
      pre_venda: 0,
      eventos: 0,
      outros: 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return rows;
}

export function buildFinancialDashboard(movements = [], { period: periodValue = 'month', now = new Date() } = {}) {
  const period = getFinancialDashboardPeriod(periodValue, now);
  const actualMovements = movements
    .filter(isActualFinancialMovement)
    .filter(movement => movementIsInPeriod(movement, period));
  const receivables = movements.filter(isOpenReceivable);
  const summary = summarizeFinancialMovements([...actualMovements, ...receivables], { now });
  const recentMovements = [...actualMovements]
    .sort((a, b) => financialMovementDate(b).localeCompare(financialMovementDate(a)))
    .slice(0, 8);
  const openReceivables = [...receivables]
    .sort((a, b) => {
      const left = financialMovementDate(a) || '9999-12-31';
      const right = financialMovementDate(b) || '9999-12-31';
      return left.localeCompare(right);
    })
    .slice(0, 8);

  return {
    period,
    summary,
    monthlySeries: buildMonthSeries(actualMovements, period),
    recentMovements,
    openReceivables,
  };
}
