const LEGACY_PERIOD_MONTHS = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

function nonnegativeNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function periodMonths(plan) {
  const months = nonnegativeNumber(plan.period_months);
  if (Number.isInteger(months) && months > 0) return months;
  const legacyMonths = LEGACY_PERIOD_MONTHS[plan.period];
  return typeof legacyMonths === 'number' ? legacyMonths : null;
}

export function getContractMonthlyValue(contract, plansById = {}) {
  const snapshot = contract?.plan_snapshot || {};
  const plan = plansById[contract?.plan_id] || {};
  const months = periodMonths(snapshot) ?? periodMonths(plan);
  const snapshotMonthly = nonnegativeNumber(snapshot.price_monthly);
  const planMonthly = nonnegativeNumber(plan.price_monthly);

  // Preserve a legacy snapshot's sold price instead of repricing it from today's catalog.
  const serviceTotal = months
    ? nonnegativeNumber(snapshot.price_total)
      ?? (snapshotMonthly == null ? null : snapshotMonthly * months)
      ?? nonnegativeNumber(plan.price_total)
      ?? (planMonthly ?? 0) * months
    : snapshotMonthly ?? planMonthly ?? 0;

  // Without a known term, retain the legacy monthly basis; never count a full package as one month.
  // Discounts apply to this contract. The renewal flow already decides whether to carry them forward.
  const discount = nonnegativeNumber(contract?.manual_discount) ?? 0;
  const netCents = Math.max(0, Math.round(serviceTotal * 100) - Math.round(discount * 100));

  // Enrollment, existing credits, installment count and payment fees are not recurring service value.
  // Keep fractional cents until display/aggregation instead of rounding each contract's monthly share.
  return netCents / 100 / (months ?? 1);
}
