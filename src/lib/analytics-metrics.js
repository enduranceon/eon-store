import {
  buildContractLifecycleRows,
  getContractTotalValue,
  isContractPaymentOverdue,
} from '@/lib/assessment-contract-lifecycle';
import { computeMrrHistory } from '@/lib/assessment-metrics';
import { toLocalDateStr } from '@/lib/utils';

const RECEIVED_PAYMENT_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
const OPEN_PROSPECT_STAGES = new Set(['new', 'proposal_ready', 'payment_link_sent']);
const EFFECTIVE_CONTRACT_STATUSES = new Set(['scheduled', 'active', 'overdue', 'on_leave', 'finished', 'cancelled']);

export const AGE_BANDS = [
  { key: 'under18', label: 'Até 17', min: 0, max: 17 },
  { key: '18-24', label: '18–24', min: 18, max: 24 },
  { key: '25-34', label: '25–34', min: 25, max: 34 },
  { key: '35-44', label: '35–44', min: 35, max: 44 },
  { key: '45-54', label: '45–54', min: 45, max: 54 },
  { key: '55-64', label: '55–64', min: 55, max: 64 },
  { key: '65plus', label: '65+', min: 65, max: 120 },
  { key: 'unknown', label: 'Não informado', min: null, max: null },
];

export const PERIOD_OPTIONS = [
  { value: '30d', label: 'Últimos 30 dias' },
  { value: '90d', label: 'Últimos 90 dias' },
  { value: '6m', label: 'Últimos 6 meses' },
  { value: '12m', label: 'Últimos 12 meses' },
  { value: 'ytd', label: 'Ano atual' },
  { value: 'all', label: 'Todo o histórico' },
];

const number = value => Number(value) || 0;
const sum = (rows, selector = value => value) => rows.reduce((total, row) => total + number(selector(row)), 0);
const unique = values => new Set(values.filter(Boolean));

function dateOnly(value) {
  if (!value) return '';
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : text.slice(0, 10);
}

function monthOnly(value) {
  const date = dateOnly(value);
  return date ? date.slice(0, 7) : '';
}

function parseLocalDate(value) {
  const date = dateOnly(value);
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addMonths(value, amount) {
  const parsed = parseLocalDate(value);
  if (!parsed) return '';
  parsed.setMonth(parsed.getMonth() + amount);
  return toLocalDateStr(parsed);
}

function daysBetween(start, end) {
  const a = parseLocalDate(start);
  const b = parseLocalDate(end);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function percentage(value, total) {
  return total > 0 ? (value / total) * 100 : 0;
}

function average(values) {
  return values.length ? sum(values) / values.length : 0;
}

export function getAnalyticsPeriod(period, now = new Date(), earliestDate = '') {
  const today = toLocalDateStr(now);
  const start = new Date(`${today}T12:00:00`);

  if (period === 'all') {
    return {
      from: earliestDate || `${now.getFullYear()}-01-01`,
      to: today,
      label: 'Todo o histórico',
    };
  }

  if (period === 'ytd') {
    return { from: `${now.getFullYear()}-01-01`, to: today, label: 'Ano atual' };
  }

  if (period === '30d') start.setDate(start.getDate() - 29);
  else if (period === '90d') start.setDate(start.getDate() - 89);
  else if (period === '6m') start.setMonth(start.getMonth() - 6);
  else start.setMonth(start.getMonth() - 12);

  return {
    from: toLocalDateStr(start),
    to: today,
    label: PERIOD_OPTIONS.find(option => option.value === period)?.label || 'Período',
  };
}

export function calculateAge(birthDate, now = new Date()) {
  const birth = parseLocalDate(birthDate);
  if (!birth) return null;
  let age = now.getFullYear() - birth.getFullYear();
  const month = now.getMonth() - birth.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

export function ageBandKey(birthDate, now = new Date()) {
  const age = calculateAge(birthDate, now);
  if (age == null) return 'unknown';
  return AGE_BANDS.find(band => band.min != null && age >= band.min && age <= band.max)?.key || 'unknown';
}

function normalizeGender(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.startsWith('f')) return 'feminino';
  if (normalized.startsWith('m')) return 'masculino';
  if (normalized) return normalized;
  return 'unknown';
}

function inPeriod(value, period) {
  const date = dateOnly(value);
  return !!date && date >= period.from && date <= period.to;
}

function planForContract(contract, plansById) {
  return plansById[contract?.plan_id] || null;
}

function modalityForContract(contract, plansById, modalitiesById) {
  const plan = planForContract(contract, plansById);
  return plan ? modalitiesById[plan.modality_id] || null : null;
}

function customerMatches(customer, filters, now) {
  if (!customer) return filters.gender === 'all' && filters.age === 'all';
  if (filters.gender !== 'all' && normalizeGender(customer.gender) !== filters.gender) return false;
  if (filters.age !== 'all' && ageBandKey(customer.birth_date, now) !== filters.age) return false;
  return true;
}

function contractMatches(contract, context) {
  const { filters, plansById, modalitiesById, customersById, now } = context;
  const modality = modalityForContract(contract, plansById, modalitiesById);
  if (filters.modality !== 'all' && modality?.id !== filters.modality) return false;
  if (filters.plan !== 'all' && contract.plan_id !== filters.plan) return false;
  if (filters.coach !== 'all' && contract.coach_id !== filters.coach) return false;
  return customerMatches(customersById[contract.customer_id], filters, now);
}

function isEffectiveContract(contract) {
  return EFFECTIVE_CONTRACT_STATUSES.has(contract.status)
    && !['pending_sale', 'voided_sale'].includes(contract.lifecycle?.type);
}

function contractActiveAt(contract, referenceDate) {
  if (!isEffectiveContract(contract) || contract.status === 'draft') return false;
  const start = dateOnly(contract.start_date || contract.created_at);
  if (!start || start > referenceDate) return false;
  const cancellation = contract.status === 'cancelled'
    ? dateOnly(contract.cancellation_date || contract.updated_at)
    : '';
  const end = cancellation || dateOnly(contract.end_date);
  return !end || end >= referenceDate;
}

function buildMaps(data) {
  return {
    plansById: Object.fromEntries(data.plans.map(item => [item.id, item])),
    modalitiesById: Object.fromEntries(data.modalities.map(item => [item.id, item])),
    coachesById: Object.fromEntries(data.coaches.map(item => [item.id, item])),
    customersById: Object.fromEntries(data.customers.map(item => [item.id, item])),
    contractsById: Object.fromEntries(data.contracts.map(item => [item.id, item])),
    presaleOrdersById: Object.fromEntries(data.presaleOrders.map(item => [item.id, item])),
    stockOrdersById: Object.fromEntries(data.stockOrders.map(item => [item.id, item])),
  };
}

function paymentOwner(payment, maps) {
  if (payment.order_type === 'contract') {
    const contract = maps.contractsById[payment.order_id];
    return contract ? { unit: 'assessoria', customerId: contract.customer_id, contract } : null;
  }
  if (payment.order_type === 'stock') {
    const order = maps.stockOrdersById[payment.order_id];
    return order ? { unit: 'loja', customerId: order.customer_id, order } : null;
  }
  const order = maps.presaleOrdersById[payment.order_id];
  return order ? { unit: 'loja', customerId: order.customer_id, order } : null;
}

function ownerMatches(owner, context) {
  if (!owner) return false;
  if (owner.contract) return contractMatches(owner.contract, context);
  const { filters, customersById, now } = context;
  if (filters.modality !== 'all' || filters.plan !== 'all' || filters.coach !== 'all') return false;
  return customerMatches(customersById[owner.customerId], filters, now);
}

function receiptDate(payment) {
  return payment.payment_date || payment.credit_date || payment.created_at;
}

function buildReceiptRecords(data, maps, context) {
  const records = data.payments
    .filter(payment => RECEIVED_PAYMENT_STATUSES.has(payment.status))
    .map(payment => {
      const owner = paymentOwner(payment, maps);
      if (!ownerMatches(owner, context)) return null;
      return {
        id: payment.id,
        orderId: payment.order_id,
        unit: owner.unit,
        customerId: owner.customerId,
        contractId: owner.contract?.id || null,
        gross: number(payment.value),
        net: number(payment.net_value ?? payment.value),
        date: dateOnly(receiptDate(payment)),
      };
    })
    .filter(Boolean);

  const ordersWithReceipts = new Set(records.map(record => record.orderId));

  data.contracts.forEach(contract => {
    if (!contractMatches(contract, context)) return;
    if (contract.payment_status !== 'paid' || !contract.payment_date || ordersWithReceipts.has(contract.id)) return;
    if (!contract.manual_payment && contract.asaas_charge_id) return;
    const value = getContractTotalValue(contract, context.plansById);
    records.push({
      id: `manual-contract-${contract.id}`,
      orderId: contract.id,
      unit: 'assessoria',
      customerId: contract.customer_id,
      contractId: contract.id,
      gross: value,
      net: value,
      date: dateOnly(contract.payment_date),
    });
  });

  const appendManualOrder = (order, type) => {
    if (order.payment_status !== 'paid' || !order.payment_date || ordersWithReceipts.has(order.id)) return;
    if (!order.manual_payment && order.asaas_charge_id) return;
    const owner = { unit: 'loja', customerId: order.customer_id, order };
    if (!ownerMatches(owner, context)) return;
    const value = number(order.total_value);
    records.push({
      id: `manual-${type}-${order.id}`,
      orderId: order.id,
      unit: 'loja',
      customerId: order.customer_id,
      contractId: null,
      gross: value,
      net: value,
      date: dateOnly(order.payment_date),
    });
  };

  data.presaleOrders.forEach(order => appendManualOrder(order, 'presale'));
  data.stockOrders.forEach(order => appendManualOrder(order, 'stock'));
  return records.filter(record => record.date);
}

function buildRefundRecords(data, maps, context) {
  const contractRefunds = data.contracts
    .filter(contract => number(contract.refund_amount) > 0 && contractMatches(contract, context))
    .map(contract => ({
      id: `contract-refund-${contract.id}`,
      orderId: contract.id,
      unit: 'assessoria',
      customerId: contract.customer_id,
      contractId: contract.id,
      amount: number(contract.refund_amount),
      date: dateOnly(contract.refund_date || contract.updated_at),
    }));

  const storeRefunds = data.returns
    .filter(item => number(item.refund_value) > 0 && !['cancelled', 'rejected'].includes(item.status))
    .map(item => {
      const paymentType = item.order_type === 'stock' ? 'stock' : 'presale';
      const order = paymentType === 'stock'
        ? maps.stockOrdersById[item.order_id]
        : maps.presaleOrdersById[item.order_id];
      const owner = order ? { unit: 'loja', customerId: order.customer_id, order } : null;
      if (!ownerMatches(owner, context)) return null;
      return {
        id: `store-refund-${item.id}`,
        orderId: item.order_id,
        unit: 'loja',
        customerId: owner.customerId,
        contractId: null,
        amount: number(item.refund_value),
        date: dateOnly(item.completed_at || item.received_at || item.created_at),
      };
    })
    .filter(Boolean);

  return [...contractRefunds, ...storeRefunds].filter(record => record.date);
}

function monthSeries(period, receipts, refunds) {
  const first = parseLocalDate(period.from);
  const last = parseLocalDate(period.to);
  if (!first || !last) return [];

  const months = [];
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1, 12);
  const finalMonth = new Date(last.getFullYear(), last.getMonth(), 1, 12);
  while (cursor <= finalMonth) {
    months.push(toLocalDateStr(cursor).slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const visibleMonths = months.slice(-24);

  return visibleMonths.map(ym => {
    const monthReceipts = receipts.filter(item => monthOnly(item.date) === ym);
    const monthRefunds = refunds.filter(item => monthOnly(item.date) === ym);
    const date = new Date(`${ym}-01T12:00:00`);
    return {
      ym,
      label: date.toLocaleString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', ''),
      assessoria: sum(monthReceipts.filter(item => item.unit === 'assessoria'), item => item.net)
        - sum(monthRefunds.filter(item => item.unit === 'assessoria'), item => item.amount),
      loja: sum(monthReceipts.filter(item => item.unit === 'loja'), item => item.net)
        - sum(monthRefunds.filter(item => item.unit === 'loja'), item => item.amount),
    };
  });
}

function distribution(items, keySelector, labelSelector, preferredOrder = []) {
  const grouped = new Map();
  items.forEach(item => {
    const key = keySelector(item);
    const label = labelSelector(item, key);
    const current = grouped.get(key) || { key, name: label, value: 0 };
    current.value += 1;
    grouped.set(key, current);
  });
  return [...grouped.values()].sort((a, b) => {
    const ia = preferredOrder.indexOf(a.key);
    const ib = preferredOrder.indexOf(b.key);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return b.value - a.value;
  });
}

function buildCohorts(contracts, now) {
  const effective = contracts.filter(isEffectiveContract);
  const byCustomer = new Map();
  effective.forEach(contract => {
    if (!contract.customer_id) return;
    const rows = byCustomer.get(contract.customer_id) || [];
    rows.push(contract);
    byCustomer.set(contract.customer_id, rows);
  });

  const cohorts = new Map();
  byCustomer.forEach((rows, customerId) => {
    const starts = rows.map(row => dateOnly(row.start_date || row.created_at)).filter(Boolean).sort();
    if (!starts.length) return;
    const ym = starts[0].slice(0, 7);
    const members = cohorts.get(ym) || [];
    members.push({ customerId, rows, firstStart: starts[0] });
    cohorts.set(ym, members);
  });

  const today = toLocalDateStr(now);
  return [...cohorts.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12)
    .map(([ym, members]) => {
      const cohortStart = `${ym}-01`;
      const retentionAt = months => {
        const checkpoint = addMonths(cohortStart, months);
        if (!checkpoint || checkpoint > today) return null;
        const retained = members.filter(member => member.rows.some(row => contractActiveAt(row, checkpoint))).length;
        return percentage(retained, members.length);
      };
      const labelDate = new Date(`${ym}-01T12:00:00`);
      return {
        ym,
        label: labelDate.toLocaleString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', ''),
        size: members.length,
        m1: retentionAt(1),
        m3: retentionAt(3),
        m6: retentionAt(6),
        m12: retentionAt(12),
      };
    });
}

function buildProspectMetrics(data, context, period) {
  const submissionsByContract = new Map();
  data.prospectSubmissions.forEach(submission => {
    const rows = submissionsByContract.get(submission.contract_id) || [];
    rows.push(submission);
    submissionsByContract.set(submission.contract_id, rows);
  });

  const prospects = data.contracts
    .filter(contract => contract.prospect_stage && contractMatches(contract, context))
    .filter(contract => inPeriod(contract.created_at, period));
  const total = prospects.length;
  const isAtLeast = (contract, stage) => {
    if (stage === 'proposal_ready') {
      return !!contract.prospect_proposal_ready_at || ['proposal_ready', 'payment_link_sent', 'converted'].includes(contract.prospect_stage);
    }
    if (stage === 'payment_link_sent') {
      return !!contract.prospect_message_sent_at || ['payment_link_sent', 'converted'].includes(contract.prospect_stage);
    }
    return contract.prospect_stage === stage;
  };

  const converted = prospects.filter(item => item.prospect_stage === 'converted');
  const lost = prospects.filter(item => item.prospect_stage === 'lost');
  const closed = converted.length + lost.length;
  const conversionDays = converted
    .map(item => daysBetween(item.created_at, item.prospect_converted_at || item.updated_at))
    .filter(value => value >= 0);

  const sourceCounts = new Map();
  prospects.forEach(contract => {
    const submissions = submissionsByContract.get(contract.id) || [];
    const source = submissions[0]?.source || 'Manual';
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  });

  const lossReasonLabels = {
    price: 'Preço',
    no_response: 'Não respondeu',
    changed_mind: 'Desistiu',
    chose_competitor: 'Concorrente',
    coach_availability: 'Coach indisponível',
    other: 'Outro',
  };
  const lossCounts = new Map();
  lost.forEach(contract => {
    const key = contract.prospect_loss_reason_code || 'other';
    lossCounts.set(key, (lossCounts.get(key) || 0) + 1);
  });

  const former = prospects.filter(item => item.prospect_customer_relationship === 'former_student');
  const returnsConverted = converted.filter(item => item.prospect_customer_relationship === 'former_student');

  return {
    total,
    open: prospects.filter(item => OPEN_PROSPECT_STAGES.has(item.prospect_stage)).length,
    proposal: prospects.filter(item => isAtLeast(item, 'proposal_ready')).length,
    linkSent: prospects.filter(item => isAtLeast(item, 'payment_link_sent')).length,
    converted: converted.length,
    lost: lost.length,
    conversionRate: percentage(converted.length, closed),
    averageCloseDays: conversionDays.length ? average(conversionDays) : null,
    formerStudents: former.length,
    returnsConverted: returnsConverted.length,
    returnConversionRate: percentage(returnsConverted.length, former.length),
    funnel: [
      { key: 'new', name: 'Cadastros', value: total },
      { key: 'proposal', name: 'Proposta pronta', value: prospects.filter(item => isAtLeast(item, 'proposal_ready')).length },
      { key: 'link', name: 'Link enviado', value: prospects.filter(item => isAtLeast(item, 'payment_link_sent')).length },
      { key: 'converted', name: 'Convertidos', value: converted.length },
    ],
    sources: [...sourceCounts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    losses: [...lossCounts.entries()].map(([key, value]) => ({ key, name: lossReasonLabels[key] || 'Outro', value })).sort((a, b) => b.value - a.value),
  };
}

function metricBreakdowns(rows, receipts, refunds, period, context, data) {
  const active = rows.filter(row => row.lifecycle?.counts?.active);
  const entries = rows.filter(row => row.lifecycle?.counts?.entry && inPeriod(row.created_at, period));
  const exits = rows.filter(row => row.lifecycle?.counts?.exit && inPeriod(row.lifecycle.cancelDate, period));

  const receiptsByContract = new Map();
  receipts.filter(item => inPeriod(item.date, period) && item.contractId).forEach(item => {
    receiptsByContract.set(item.contractId, (receiptsByContract.get(item.contractId) || 0) + item.net);
  });
  refunds.filter(item => inPeriod(item.date, period) && item.contractId).forEach(item => {
    receiptsByContract.set(item.contractId, (receiptsByContract.get(item.contractId) || 0) - item.amount);
  });

  const build = (definitions, getId, getName) => definitions.map(definition => {
    const id = getId(definition);
    const subset = rows.filter(row => {
      if (definition.__kind === 'modality') {
        return modalityForContract(row, context.plansById, context.modalitiesById)?.id === id;
      }
      if (definition.__kind === 'coach') return row.coach_id === id;
      return row.plan_id === id;
    });
    const subsetIds = new Set(subset.map(row => row.id));
    const activeSubset = active.filter(row => subsetIds.has(row.id));
    const entrySubset = entries.filter(row => subsetIds.has(row.id));
    const exitSubset = exits.filter(row => subsetIds.has(row.id));
    const revenue = sum(subset, row => receiptsByContract.get(row.id) || 0);
    const activeStudents = unique(activeSubset.map(row => row.customer_id)).size;
    const mrr = sum(activeSubset, row => row.monthly);
    const churnBase = activeStudents + unique(exitSubset.map(row => row.customer_id)).size;
    return {
      id,
      name: getName(definition),
      activeStudents,
      contracts: activeSubset.length,
      entries: unique(entrySubset.map(row => row.customer_id)).size,
      exits: unique(exitSubset.map(row => row.customer_id)).size,
      mrr,
      ticket: activeStudents ? mrr / activeStudents : 0,
      revenue,
      churn: percentage(unique(exitSubset.map(row => row.customer_id)).size, churnBase),
    };
  }).filter(item => item.activeStudents || item.entries || item.exits || item.revenue)
    .sort((a, b) => b.mrr - a.mrr || b.activeStudents - a.activeStudents);

  const modalities = data.modalities.map(item => ({ ...item, __kind: 'modality' }));
  const coaches = data.coaches.map(item => ({ ...item, __kind: 'coach' }));
  return {
    modalities: build(modalities, item => item.id, item => item.name),
    plans: build(data.plans, item => item.id, item => item.name || `${context.modalitiesById[item.modality_id]?.name || 'Plano'} · ${item.period || ''}`),
    coaches: build(coaches, item => item.id, item => item.name),
  };
}

export function buildAnalytics(data, filters, now = new Date()) {
  const maps = buildMaps(data);
  const earliestDates = [
    ...data.contracts.map(item => dateOnly(item.created_at)),
    ...data.payments.map(item => dateOnly(item.created_at)),
    ...data.presaleOrders.map(item => dateOnly(item.created_date)),
  ].filter(Boolean).sort();
  const period = getAnalyticsPeriod(filters.period, now, earliestDates[0]);
  const context = { ...maps, filters, now };
  const lifecycleRows = buildContractLifecycleRows(data.contracts, {
    monthStart: period.from,
    plansById: maps.plansById,
    studentsById: maps.customersById,
    coachesById: maps.coachesById,
    modalitiesById: maps.modalitiesById,
  });
  const filteredRows = lifecycleRows.filter(row => contractMatches(row, context));
  const activeRows = filteredRows.filter(row => row.lifecycle?.counts?.active);
  const activeCustomerIds = unique(activeRows.map(row => row.customer_id));
  const activeCustomers = [...activeCustomerIds].map(id => maps.customersById[id]).filter(Boolean);
  const receipts = buildReceiptRecords(data, maps, context);
  const refunds = buildRefundRecords(data, maps, context);
  const periodReceipts = receipts.filter(item => inPeriod(item.date, period));
  const periodRefunds = refunds.filter(item => inPeriod(item.date, period));

  const entries = filteredRows.filter(row => row.lifecycle?.counts?.entry && inPeriod(row.created_at, period));
  const renewals = filteredRows.filter(row => row.lifecycle?.counts?.renewal && inPeriod(row.created_at, period));
  const exits = filteredRows.filter(row => row.lifecycle?.counts?.exit && inPeriod(row.lifecycle.cancelDate, period));
  const entryCustomers = unique(entries.map(row => row.customer_id));
  const exitCustomers = unique(exits.map(row => row.customer_id));

  const baseAtStart = unique(filteredRows
    .filter(row => contractActiveAt(row, period.from))
    .map(row => row.customer_id)).size;
  const churnBase = baseAtStart || activeCustomerIds.size + exitCustomers.size;
  const periodChurn = percentage(exitCustomers.size, churnBase);
  const periodMonths = Math.max(1, daysBetween(period.from, period.to) / 30.44);
  const monthlyChurn = periodChurn > 0
    ? (1 - Math.pow(1 - Math.min(periodChurn, 99.9) / 100, 1 / periodMonths)) * 100
    : 0;

  const mrr = sum(activeRows, row => row.monthly);
  const activeStudents = activeCustomerIds.size;
  const contractedTicket = activeStudents ? mrr / activeStudents : 0;
  const estimatedLtv = monthlyChurn > 0 ? contractedTicket / (monthlyChurn / 100) : null;
  const averageLifetimeMonths = monthlyChurn > 0 ? 100 / monthlyChurn : null;

  const grossRevenue = sum(periodReceipts, item => item.gross);
  const receivedNet = sum(periodReceipts, item => item.net);
  const refunded = sum(periodRefunds, item => item.amount);
  const netRevenue = receivedNet - refunded;
  const assessoriaNet = sum(periodReceipts.filter(item => item.unit === 'assessoria'), item => item.net)
    - sum(periodRefunds.filter(item => item.unit === 'assessoria'), item => item.amount);
  const storeNet = sum(periodReceipts.filter(item => item.unit === 'loja'), item => item.net)
    - sum(periodRefunds.filter(item => item.unit === 'loja'), item => item.amount);
  const fees = Math.max(0, grossRevenue - receivedNet);
  const payingCustomers = unique(periodReceipts.map(item => item.customerId));
  const receivedTicket = payingCustomers.size ? netRevenue / payingCustomers.size : 0;

  const realizedByCustomer = new Map();
  receipts.forEach(item => {
    if (!item.customerId) return;
    const current = realizedByCustomer.get(item.customerId) || { assessoria: 0, loja: 0 };
    current[item.unit] += item.net;
    realizedByCustomer.set(item.customerId, current);
  });
  refunds.forEach(item => {
    if (!item.customerId) return;
    const current = realizedByCustomer.get(item.customerId) || { assessoria: 0, loja: 0 };
    current[item.unit] -= item.amount;
    realizedByCustomer.set(item.customerId, current);
  });
  const realizedCustomers = [...realizedByCustomer.values()];
  const realizedLtvAssessoria = realizedCustomers.length ? average(realizedCustomers.map(item => item.assessoria)) : 0;
  const realizedLtvStore = realizedCustomers.length ? average(realizedCustomers.map(item => item.loja)) : 0;
  const realizedLtvTotal = realizedCustomers.length ? average(realizedCustomers.map(item => item.assessoria + item.loja)) : 0;

  const today = toLocalDateStr(now);
  const overdueRows = activeRows.filter(row => isContractPaymentOverdue(row, today));
  const overdueCustomers = unique(overdueRows.map(row => row.customer_id));
  const overdueAmount = sum(overdueRows, row => row.value || row.monthly);

  const profile = {
    gender: distribution(
      activeCustomers,
      customer => normalizeGender(customer.gender),
      (_customer, key) => ({ feminino: 'Feminino', masculino: 'Masculino', unknown: 'Não informado' })[key] || key,
      ['feminino', 'masculino', 'unknown'],
    ),
    age: distribution(
      activeCustomers,
      customer => ageBandKey(customer.birth_date, now),
      (_customer, key) => AGE_BANDS.find(band => band.key === key)?.label || 'Não informado',
      AGE_BANDS.map(band => band.key),
    ),
    region: distribution(
      activeCustomers,
      customer => customer.address_state || 'unknown',
      (customer, key) => key === 'unknown' ? 'Não informado' : (customer.address_state || key).toUpperCase(),
    ),
    status: distribution(
      activeRows,
      row => row.status,
      (_row, key) => ({ active: 'Ativo', overdue: 'Vencido', on_leave: 'Licença' })[key] || key,
    ),
  };

  const dataQuality = {
    total: activeCustomers.length,
    gender: activeCustomers.filter(customer => normalizeGender(customer.gender) !== 'unknown').length,
    birthDate: activeCustomers.filter(customer => !!customer.birth_date).length,
    city: activeCustomers.filter(customer => !!customer.address_city).length,
    complete: activeCustomers.filter(customer =>
      normalizeGender(customer.gender) !== 'unknown' && customer.birth_date && customer.address_city
    ).length,
  };

  const breakdowns = metricBreakdowns(filteredRows, receipts, refunds, period, context, data);
  const payouts = data.payoutItems.filter(item => {
    const reference = item.reference_competence ? `${String(item.reference_competence).slice(0, 7)}-01` : item.created_at;
    if (!inPeriod(reference, period)) return false;
    if (filters.coach !== 'all' && item.coach_id !== filters.coach) return false;
    if (item.contract_id) {
      const contract = maps.contractsById[item.contract_id];
      return contract ? contractMatches(contract, context) : false;
    }
    return filters.modality === 'all' && filters.plan === 'all' && filters.gender === 'all' && filters.age === 'all';
  });
  const payoutByCoach = new Map();
  payouts.forEach(item => payoutByCoach.set(item.coach_id, (payoutByCoach.get(item.coach_id) || 0) + number(item.amount)));
  breakdowns.coaches = breakdowns.coaches.map(coach => ({
    ...coach,
    payout: payoutByCoach.get(coach.id) || 0,
    contribution: coach.revenue - (payoutByCoach.get(coach.id) || 0),
  }));

  const planFilteredContracts = filteredRows.filter(row => isEffectiveContract(row));
  const cohorts = buildCohorts(planFilteredContracts, now);
  const prospects = buildProspectMetrics(data, context, period);
  const mrrHistory = computeMrrHistory(filteredRows, data.plans, 12);
  const revenueHistory = monthSeries(period, periodReceipts, periodRefunds);

  return {
    period,
    summary: {
      activeStudents,
      activeContracts: activeRows.length,
      mrr,
      contractedTicket,
      receivedTicket,
      grossRevenue,
      receivedNet,
      netRevenue,
      assessoriaNet,
      storeNet,
      refunded,
      fees,
      payingCustomers: payingCustomers.size,
      realizedLtvAssessoria,
      realizedLtvStore,
      realizedLtvTotal,
      estimatedLtv,
      averageLifetimeMonths,
      churn: periodChurn,
      monthlyChurn,
      entries: entryCustomers.size,
      renewals: renewals.length,
      exits: exitCustomers.size,
      netGrowth: entryCustomers.size - exitCustomers.size,
      overdueCustomers: overdueCustomers.size,
      overdueAmount,
      retention: Math.max(0, 100 - periodChurn),
    },
    profile,
    dataQuality,
    breakdowns,
    prospects,
    cohorts,
    mrrHistory,
    revenueHistory,
  };
}
