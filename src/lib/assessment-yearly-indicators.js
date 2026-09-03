const OPERATIVE_STATUSES = new Set(['active', 'overdue', 'on_leave', 'finished', 'cancelled']);
const TERMINAL_PAYMENT_STATUSES = new Set(['cancelled', 'refunded']);
const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function dateOnly(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  if (!date) return '';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setDate(parsed.getDate() + days);
  return dateOnly(parsed);
}

function daysBetween(from, to) {
  const start = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return Infinity;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function monthStart(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}

function nextMonthStart(year, monthIndex) {
  const date = new Date(year, monthIndex + 1, 1, 12);
  return dateOnly(date);
}

function monthEnd(year, monthIndex) {
  return addDays(nextMonthStart(year, monthIndex), -1);
}

function getContractStart(contract) {
  return dateOnly(contract?.start_date) || dateOnly(contract?.created_at);
}

function getEffectiveEnd(contract) {
  const dates = [
    dateOnly(contract?.cancellation_date),
    dateOnly(contract?.end_date),
  ].filter(Boolean).sort();
  return dates[0] || '';
}

function hasPaidContract(contract) {
  return contract?.payment_status === 'paid'
    || !!contract?.payment_date
    || contract?.manual_payment === true;
}

function hasRefund(contract) {
  return !!contract?.refund_status
    || Number(contract?.refund_amount || 0) > 0
    || contract?.payment_status === 'refunded';
}

function isVoidedSale(contract) {
  if (contract?.status === 'voided') return true;
  if (contract?.status !== 'cancelled') return false;

  const reason = String(contract?.cancellation_reason || '').toLowerCase();
  const reasonMarksVoided = [
    'venda não concretizada',
    'venda nao concretizada',
    'venda substituída',
    'venda substituida',
    'cliente nunca pagou',
    'descartad',
  ].some(marker => reason.includes(marker));
  const noMoneyMoved = TERMINAL_PAYMENT_STATUSES.has(contract?.payment_status)
    && !contract?.payment_date
    && !contract?.refund_amount
    && Number(contract?.cancellation_fee || 0) === 0;

  return reasonMarksVoided || noMoneyMoved;
}

function isOperativeContract(contract) {
  if (!OPERATIVE_STATUSES.has(contract?.status) || isVoidedSale(contract)) return false;
  return contract.status !== 'cancelled' || hasPaidContract(contract);
}

function isContractActiveAtEnd(contract, referenceDate) {
  if (!isOperativeContract(contract)) return false;

  const start = getContractStart(contract);
  const end = getEffectiveEnd(contract);
  if (!start || start > referenceDate) return false;

  // A vigencia encerra na data de fim; por isso o contrato nao entra na base
  // ao fim desse mesmo dia. A mesma regra vale para um cancelamento efetivo.
  return !end || end > referenceDate;
}

function isNonRenewal(contract) {
  const reason = String(contract?.cancellation_reason || '').toLowerCase();
  return [
    'não renovou',
    'nao renovou',
    'não vai renovar',
    'nao vai renovar',
    'não renovar',
    'nao renovar',
  ].some(marker => reason.includes(marker));
}

function hasContinuityAfterExit(contract, contracts, exitDate) {
  const continuationLimit = addDays(exitDate, 45);

  return contracts.some(other => {
    if (other?.id === contract?.id || other?.customer_id !== contract?.customer_id) return false;
    if (!isOperativeContract(other)) return false;
    if (other.parent_contract_id === contract.id) return true;

    const otherStart = getContractStart(other);
    if (!otherStart) return false;
    if (isContractActiveAtEnd(other, exitDate)) return true;

    return otherStart >= exitDate && otherStart <= continuationLimit;
  });
}

function getRealExitDate(contract, contracts, asOfDate) {
  if (!isOperativeContract(contract) || hasRefund(contract)) return '';

  let exitDate = '';
  if (contract.status === 'cancelled') {
    if (!hasPaidContract(contract)) return '';
    exitDate = dateOnly(contract.cancellation_date);
  } else if (contract.status === 'finished') {
    if (!isNonRenewal(contract)) return '';
    exitDate = dateOnly(contract.cancellation_date) || dateOnly(contract.end_date);
  } else if (['active', 'overdue', 'on_leave'].includes(contract.status) && isNonRenewal(contract)) {
    exitDate = dateOnly(contract.end_date);
  }

  const start = getContractStart(contract);
  if (!exitDate || exitDate > asOfDate || (start && exitDate < start)) return '';
  if (hasContinuityAfterExit(contract, contracts, exitDate)) return '';
  return exitDate;
}

function getStartKind(contract, contracts) {
  if (!isOperativeContract(contract)) return 'ignored';
  if (contract.parent_contract_id) return 'renewal';
  if (contract.prospect_customer_relationship === 'former_student' || contract.prospect_reactivated_at) return 'return';
  if (contract.prospect_customer_relationship === 'active_student') return 'continuity';

  const start = getContractStart(contract);
  if (!start || !contract.customer_id) return 'entry';

  const previousContracts = contracts.filter(other =>
    other?.id !== contract.id
    && other?.customer_id === contract.customer_id
    && isOperativeContract(other)
    && getContractStart(other)
    && getContractStart(other) < start
  );

  if (!previousContracts.length) return 'entry';

  const dayBeforeStart = addDays(start, -1);
  if (previousContracts.some(other => isContractActiveAtEnd(other, dayBeforeStart))) return 'continuity';

  const mostRecentEnd = previousContracts
    .map(getEffectiveEnd)
    .filter(end => end && end <= start)
    .sort()
    .at(-1);
  if (mostRecentEnd && daysBetween(mostRecentEnd, start) <= 45) return 'continuity';

  return 'return';
}

function contractMonthlyValue(contract, plansById) {
  const snapshot = contract?.plan_snapshot || {};
  const plan = plansById[contract?.plan_id] || {};
  return Number(snapshot.price_monthly ?? plan.price_monthly ?? 0) || 0;
}

function uniqueCustomerCount(contracts) {
  return new Set(contracts.map(contract => contract.customer_id).filter(Boolean)).size;
}

function inRange(date, from, to) {
  return !!date && date >= from && date < to;
}

function earliestKnownDate(contracts) {
  return contracts.flatMap(contract => [
    getContractStart(contract),
    dateOnly(contract?.cancellation_date),
    dateOnly(contract?.created_at),
  ]).filter(Boolean).sort()[0] || '';
}

function monthIsAvailable(start, end, earliest, asOfDate) {
  if (start > asOfDate) return false;
  return !earliest || end >= earliest;
}

export function getAssessmentIndicatorYears(contracts = [], now = new Date()) {
  const years = new Set([now.getFullYear()]);
  contracts.forEach(contract => {
    [
      getContractStart(contract),
      dateOnly(contract?.end_date),
      dateOnly(contract?.cancellation_date),
      dateOnly(contract?.created_at),
    ].forEach(date => {
      const year = Number(date?.slice(0, 4));
      if (Number.isInteger(year) && year >= 2000 && year <= 2100) years.add(year);
    });
  });
  return [...years].sort((left, right) => right - left);
}

export function buildAssessmentYearlyIndicators(contracts = [], plans = [], options = {}) {
  const requestedYear = Number(options.year);
  const asOfDate = dateOnly(options.asOf || new Date());
  const year = Number.isInteger(requestedYear) ? requestedYear : Number(asOfDate.slice(0, 4));
  const plansById = Object.fromEntries(plans.map(plan => [plan.id, plan]));
  const operativeContracts = contracts.filter(isOperativeContract);
  const earliest = earliestKnownDate(operativeContracts);
  const startKinds = new Map(operativeContracts.map(contract => [
    contract.id,
    getStartKind(contract, operativeContracts),
  ]));
  const exitDates = new Map(operativeContracts.map(contract => [
    contract.id,
    getRealExitDate(contract, operativeContracts, asOfDate),
  ]));

  const months = Array.from({ length: 12 }, (_, monthIndex) => {
    const start = monthStart(year, monthIndex);
    const nextStart = nextMonthStart(year, monthIndex);
    const end = monthEnd(year, monthIndex);
    const available = monthIsAvailable(start, end, earliest, asOfDate);
    const isFuture = start > asOfDate;
    const isPartial = available && asOfDate >= start && asOfDate < end;
    const referenceEnd = isPartial ? asOfDate : end;

    if (!available) {
      return {
        key: start.slice(0, 7),
        label: MONTH_LABELS[monthIndex],
        start,
        end,
        available: false,
        isFuture,
        isPartial: false,
        baseStart: null,
        entries: null,
        returns: null,
        renewals: null,
        exits: null,
        continuities: null,
        netGrowth: null,
        baseEnd: null,
        churnRate: null,
        mrr: null,
      };
    }

    const startsThisMonth = operativeContracts.filter(contract => {
      const startDate = getContractStart(contract);
      return inRange(startDate, start, nextStart) && startDate <= referenceEnd;
    });
    const baseStartRows = operativeContracts.filter(contract =>
      isContractActiveAtEnd(contract, addDays(start, -1))
    );
    const baseEndRows = operativeContracts.filter(contract =>
      isContractActiveAtEnd(contract, referenceEnd)
    );
    const entries = startsThisMonth.filter(contract => startKinds.get(contract.id) === 'entry');
    const returns = startsThisMonth.filter(contract => startKinds.get(contract.id) === 'return');
    const renewals = startsThisMonth.filter(contract => startKinds.get(contract.id) === 'renewal');
    const continuities = startsThisMonth.filter(contract => startKinds.get(contract.id) === 'continuity');
    const exits = operativeContracts.filter(contract => inRange(exitDates.get(contract.id), start, nextStart));
    const entryCount = uniqueCustomerCount(entries);
    const returnCount = uniqueCustomerCount(returns);
    const exitCount = uniqueCustomerCount(exits);
    const baseStart = uniqueCustomerCount(baseStartRows);
    const baseEnd = uniqueCustomerCount(baseEndRows);

    return {
      key: start.slice(0, 7),
      label: MONTH_LABELS[monthIndex],
      start,
      end,
      available: true,
      isFuture: false,
      isPartial,
      baseStart,
      entries: entryCount,
      returns: returnCount,
      renewals: uniqueCustomerCount(renewals),
      exits: exitCount,
      continuities: uniqueCustomerCount(continuities),
      netGrowth: entryCount + returnCount - exitCount,
      baseEnd,
      churnRate: baseStart > 0 ? (exitCount / baseStart) * 100 : 0,
      mrr: baseEndRows.reduce((total, contract) => total + contractMonthlyValue(contract, plansById), 0),
    };
  });

  const visibleMonths = months.filter(month => month.available);
  const firstVisible = visibleMonths[0] || null;
  const lastVisible = visibleMonths.at(-1) || null;
  const sumMetric = key => visibleMonths.reduce((total, month) => total + (Number(month[key]) || 0), 0);

  return {
    year,
    asOfDate,
    earliest,
    months,
    summary: {
      baseStart: firstVisible?.baseStart || 0,
      baseEnd: lastVisible?.baseEnd || 0,
      entries: sumMetric('entries'),
      returns: sumMetric('returns'),
      renewals: sumMetric('renewals'),
      exits: sumMetric('exits'),
      netGrowth: sumMetric('netGrowth'),
      mrr: lastVisible?.mrr || 0,
      churnRate: lastVisible?.churnRate || 0,
      isPartial: lastVisible?.isPartial || false,
    },
  };
}
