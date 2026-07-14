import { todayLocalStr, toLocalDateStr, utcToLocalDateStr } from '@/lib/utils';

export const ACTIVE_CONTRACT_STATUSES = new Set(['active', 'overdue', 'on_leave']);
export const SCHEDULED_CONTRACT_STATUSES = new Set(['scheduled']);
export const OPEN_PAYMENT_STATUSES = new Set(['pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid']);
export const TERMINAL_PAYMENT_STATUSES = new Set(['cancelled', 'refunded']);

export const CONTRACT_LIFECYCLE_TYPES = {
  active: {
    label: 'Aluno ativo',
    tone: 'green',
    metric: 'Conta como ativo/MRR',
  },
  renewal: {
    label: 'Renovação',
    tone: 'blue',
    metric: 'Conta como renovação',
  },
  scheduled: {
    label: 'Contrato agendado',
    tone: 'blue',
    metric: 'Cobrança pode existir; fora de ativo/MRR até iniciar',
  },
  pending_sale: {
    label: 'Venda ainda não efetivada',
    tone: 'amber',
    metric: 'Fora de entrada, saída e MRR',
  },
  active_payment_pending: {
    label: 'Aluno ativo com cobrança pendente',
    tone: 'amber',
    metric: 'Conta como ativo; financeiro em aberto',
  },
  voided_sale: {
    label: 'Venda descartada',
    tone: 'slate',
    metric: 'Fora de entrada, saída e MRR',
  },
  plan_replaced: {
    label: 'Possível troca de plano',
    tone: 'violet',
    metric: 'Não deveria contar como saída',
  },
  financial_adjustment: {
    label: 'Ajuste financeiro/estorno',
    tone: 'orange',
    metric: 'Financeiro, não churn sozinho',
  },
  real_exit: {
    label: 'Possível saída real',
    tone: 'red',
    metric: 'Pode contar como saída',
  },
  finished: {
    label: 'Contrato concluído',
    tone: 'slate',
    metric: 'Fim natural, não churn',
  },
  needs_review: {
    label: 'Revisar manualmente',
    tone: 'rose',
    metric: 'Impacto incerto',
  },
};

export function getContractLocalDate(value) {
  if (!value) return '';
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return utcToLocalDateStr(str);
}

export function isRenewalContract(contract) {
  return !!contract?.parent_contract_id;
}

export function getContractKindLabel(contract) {
  return isRenewalContract(contract) ? 'Renovação' : 'Contrato novo';
}

export function getActivationStatusForContract(contract, today = todayLocalStr()) {
  const start = getContractLocalDate(contract?.start_date);
  return start && start > today ? 'scheduled' : 'active';
}

function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

export function getLifecycleMonthStart(now = new Date()) {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return toLocalDateStr(d);
}

export function currentLifecycleMonthStart() {
  return getLifecycleMonthStart(new Date(`${todayLocalStr()}T12:00:00`));
}

export function getContractCancellationDate(contract) {
  return contract?.cancellation_date || getContractLocalDate(contract?.updated_at);
}

export function isContractNonRenewal(contract) {
  const reason = (contract?.cancellation_reason || '').toLowerCase();
  return (
    reason.includes('não renovou') ||
    reason.includes('nao renovou') ||
    reason.includes('não vai renovar') ||
    reason.includes('nao vai renovar')
  );
}

export function getContractTotalValue(contract, plansById = {}) {
  const snap = contract?.plan_snapshot || {};
  const plan = plansById[contract?.plan_id] || {};
  const total =
    snap.price_total ??
    contract?.total_value ??
    plan.price_total ??
    0;
  const enroll = Number(contract?.enrollment_fee) || 0;
  const discount = Number(contract?.manual_discount) || 0;
  const credit = Number(contract?.credit_balance) || 0;
  return Math.max(0, Number(total) + enroll - discount - credit);
}

export function getContractMonthlyValue(contract, plansById = {}) {
  const snap = contract?.plan_snapshot || {};
  const plan = plansById[contract?.plan_id] || {};
  return Number(snap.price_monthly ?? plan.price_monthly ?? 0) || 0;
}

export function isContractVoidedSale(contract) {
  if (contract?.status === 'voided') return true;
  if (contract?.status !== 'cancelled') return false;

  const reason = (contract.cancellation_reason || '').toLowerCase();
  const reasonMarksVoided =
    reason.includes('venda não concretizada') ||
    reason.includes('venda nao concretizada') ||
    reason.includes('venda substituída') ||
    reason.includes('venda substituida') ||
    reason.includes('cliente nunca pagou') ||
    reason.includes('descartad');

  const noMoneyMoved =
    TERMINAL_PAYMENT_STATUSES.has(contract.payment_status) &&
    !contract.payment_date &&
    !contract.refund_amount &&
    Number(contract.cancellation_fee || 0) === 0;

  return reasonMarksVoided || noMoneyMoved;
}

export function isContractPaymentOverdue(contract, today = todayLocalStr()) {
  if (!contract?.due_date) return false;
  if (!OPEN_PAYMENT_STATUSES.has(contract.payment_status)) return false;

  const dueDate = getContractLocalDate(contract.due_date);
  return !!dueDate && dueDate < today;
}

function getReplacementContract(contract, allContracts = []) {
  if (!contract?.customer_id) return null;
  const cancelDate =
    getContractCancellationDate(contract) ||
    getContractLocalDate(contract.updated_at) ||
    getContractLocalDate(contract.created_at);
  const upperBound = addDays(cancelDate, 45);
  const candidates = allContracts
    .filter(other =>
      other.id !== contract.id &&
      other.customer_id === contract.customer_id &&
      !['voided', 'draft'].includes(other.status) &&
      !isContractVoidedSale(other)
    )
    .map(other => ({ ...other, createdLocal: getContractLocalDate(other.created_at) }))
    .filter(other => {
      if (!other.createdLocal || !cancelDate) return false;
      return other.createdLocal >= cancelDate && (!upperBound || other.createdLocal <= upperBound);
    })
    .sort((a, b) => a.createdLocal.localeCompare(b.createdLocal));

  return candidates[0] || null;
}

function hasFutureOrActiveContract(contract, allContracts = []) {
  if (!contract?.customer_id) return false;
  return allContracts.some(other =>
    other.id !== contract.id &&
    other.customer_id === contract.customer_id &&
    (ACTIVE_CONTRACT_STATUSES.has(other.status) || SCHEDULED_CONTRACT_STATUSES.has(other.status))
  );
}

export function classifyContractLifecycle(contract, context = {}) {
  const allContracts = context.contracts || [];
  const monthStart = context.monthStart || getLifecycleMonthStart();
  const createdLocal = getContractLocalDate(contract.created_at);
  const cancelDate = getContractCancellationDate(contract);
  const reasons = [];
  const warnings = [];
  const actions = [];

  const base = {
    type: 'needs_review',
    severity: 'medium',
    reasons,
    warnings,
    actions,
    createdLocal,
    cancelDate,
    counts: {
      active: false,
      entry: false,
      renewal: false,
      exit: false,
      mrr: false,
      financial: false,
    },
  };

  const hasCharge =
    !!contract.asaas_charge_id ||
    !!contract.asaas_payment_link ||
    !!contract.asaas_pix_copy ||
    !!contract.external_payment_link;
  const hasPaid =
    contract.payment_status === 'paid' ||
    !!contract.payment_date ||
    contract.manual_payment === true;
  const hasRefund =
    !!contract.refund_status ||
    Number(contract.refund_amount || 0) > 0 ||
    contract.payment_status === 'refunded';

  if (contract.status === 'draft') {
    base.type = contract.parent_contract_id ? 'renewal' : 'pending_sale';
    base.severity = 'low';
    reasons.push(contract.parent_contract_id ? 'Rascunho de renovação ainda não ativado.' : 'Prospect/rascunho ainda não virou contrato efetivo.');
    actions.push('Não contar como entrada, saída ou MRR até ativar.');
    return base;
  }

  if (SCHEDULED_CONTRACT_STATUSES.has(contract.status)) {
    base.type = 'scheduled';
    base.severity = OPEN_PAYMENT_STATUSES.has(contract.payment_status) ? 'medium' : 'low';
    reasons.push(contract.parent_contract_id
      ? 'Renovação aprovada, mas vigência ainda não começou.'
      : 'Contrato aprovado, mas vigência ainda não começou.');
    if (contract.start_date) reasons.push(`Início previsto em ${getContractLocalDate(contract.start_date)}.`);
    actions.push('Não contar como aluno ativo nem MRR até a data de início.');
    if (contract.parent_contract_id && createdLocal >= monthStart) {
      base.counts.renewal = true;
      reasons.push('Aprovado neste mês a partir de contrato pai: renovação agendada.');
    }
    if (OPEN_PAYMENT_STATUSES.has(contract.payment_status)) {
      warnings.push('Há cobrança/pagamento pendente antes do início da vigência.');
      actions.push('Tratar a cobrança no financeiro sem encerrar o contrato atual.');
    }
    return base;
  }

  if (isContractVoidedSale(contract)) {
    base.type = 'voided_sale';
    base.severity = 'low';
    reasons.push('Marcado como venda descartada ou sem dinheiro movimentado.');
    actions.push('Manter fora das métricas de entrada, saída e MRR.');
    return base;
  }

  if (ACTIVE_CONTRACT_STATUSES.has(contract.status) && isContractNonRenewal(contract)) {
    const effectiveEnd = getContractLocalDate(contract.end_date);
    if (effectiveEnd && effectiveEnd < todayLocalStr()) {
      base.type = 'real_exit';
      base.severity = 'medium';
      base.counts.exit = true;
      reasons.push('Vigência encerrada e aluno informou que não vai renovar.');
      actions.push('Contar como saída por não renovação, sem multa ou estorno.');
      return base;
    }
  }

  if (ACTIVE_CONTRACT_STATUSES.has(contract.status)) {
    base.type = 'active';
    base.severity = 'ok';
    base.counts.active = true;
    base.counts.mrr = true;
    reasons.push('Contrato operacionalmente ativo.');
    if (createdLocal >= monthStart && !contract.parent_contract_id) {
      base.counts.entry = true;
      reasons.push('Criado neste mês sem contrato pai: candidato a entrada real.');
    }
    if (createdLocal >= monthStart && contract.parent_contract_id) {
      base.counts.renewal = true;
      reasons.push('Criado neste mês a partir de contrato pai: renovação.');
    }
    if (OPEN_PAYMENT_STATUSES.has(contract.payment_status)) {
      base.type = 'active_payment_pending';
      base.severity = hasCharge ? 'medium' : 'high';
      warnings.push(hasCharge ? 'Aluno/contrato ativo com cobrança ainda em aberto.' : 'Contrato ativo sem cobrança ou pagamento resolvido.');
      actions.push('Manter como aluno ativo, mas tratar cobrança/pagamento no financeiro.');
    }
    return base;
  }

  if (contract.status === 'finished') {
    const replacement = getReplacementContract(contract, allContracts);
    const customerStillActive = hasFutureOrActiveContract(contract, allContracts);

    base.type = 'finished';
    base.severity = 'low';
    reasons.push('Contrato chegou ao fim natural.');
    if (contract.parent_contract_id) reasons.push('Contrato faz parte de uma cadeia de renovação.');

    if (isContractNonRenewal(contract) && !replacement && !customerStillActive) {
      base.type = 'real_exit';
      base.severity = 'medium';
      base.counts.exit = true;
      reasons.push('Aluno informou que não vai renovar e não há contrato ativo/substituto detectado.');
      actions.push('Contar como saída por não renovação, sem multa ou estorno.');
    }

    return base;
  }

  if (contract.status === 'cancelled') {
    const replacement = getReplacementContract(contract, allContracts);
    const customerStillActive = hasFutureOrActiveContract(contract, allContracts);

    if (replacement || customerStillActive) {
      base.type = hasRefund ? 'financial_adjustment' : 'plan_replaced';
      base.severity = hasRefund ? 'medium' : 'high';
      base.counts.financial = hasRefund;
      reasons.push(replacement
        ? `Existe outro contrato do mesmo aluno após o cancelamento: ${replacement.contract_number || 'sem número'}.`
        : 'Aluno ainda possui outro contrato ativo.');
      warnings.push('Se o aluno continuou, este cancelamento não deveria virar saída/churn.');
      actions.push('Classificar como troca de plano ou ajuste financeiro, não como saída real.');
      return base;
    }

    if (hasRefund) {
      base.type = 'financial_adjustment';
      base.severity = 'medium';
      base.counts.financial = true;
      reasons.push('Cancelado com estorno ou refund registrado.');
      warnings.push('Estorno financeiro não prova sozinho que o aluno saiu da assessoria.');
      actions.push('Confirmar se houve encerramento real do aluno ou apenas ajuste/correção.');
      return base;
    }

    if (hasPaid) {
      base.type = 'real_exit';
      base.severity = 'medium';
      base.counts.exit = true;
      reasons.push('Contrato pago foi cancelado e não há outro contrato ativo/substituto detectado.');
      actions.push('Pode contar como saída se o aluno realmente encerrou a assessoria.');
      return base;
    }

    base.type = 'needs_review';
    base.severity = 'high';
    warnings.push('Cancelado sem pagamento claro, mas também não caiu na regra de venda descartada.');
    actions.push('Revisar motivo e cobrança antes de contar como saída.');
    return base;
  }

  if (OPEN_PAYMENT_STATUSES.has(contract.payment_status)) {
    base.type = 'pending_sale';
    base.severity = hasCharge ? 'medium' : 'high';
    reasons.push(hasCharge ? 'Há cobrança/link em aberto.' : 'Pagamento em aberto sem link/cobrança identificada.');
    actions.push('Tratar como pendência financeira, não como movimento de aluno.');
    return base;
  }

  warnings.push(`Status operacional não mapeado: ${contract.status || 'sem status'}.`);
  actions.push('Revisar manualmente antes de usar em métricas.');
  return base;
}

export function buildContractLifecycleRows(contracts = [], lookups = {}) {
  const monthStart = lookups.monthStart || getLifecycleMonthStart();
  const plansById = lookups.plansById || {};
  const studentsById = lookups.studentsById || {};
  const coachesById = lookups.coachesById || {};
  const modalitiesById = lookups.modalitiesById || {};

  return contracts.map(contract => {
    const plan = plansById[contract.plan_id] || null;
    const modality = plan ? modalitiesById[plan.modality_id] : null;
    const lifecycle = classifyContractLifecycle(contract, { contracts, monthStart });
    return {
      ...contract,
      audit: lifecycle,
      lifecycle,
      student: studentsById[contract.customer_id] || null,
      coach: coachesById[contract.coach_id] || null,
      plan,
      modality,
      value: getContractTotalValue(contract, plansById),
      monthly: getContractMonthlyValue(contract, plansById),
    };
  });
}

export function summarizeContractLifecycle(rows = [], monthStart = getLifecycleMonthStart()) {
  const summary = {
    total: rows.length,
    active: 0,
    entries: 0,
    renewals: 0,
    realExits: 0,
    voidedSales: 0,
    planReplaced: 0,
    financialAdjustments: 0,
    activePaymentPending: 0,
    pendingSales: 0,
    needsReview: 0,
    currentMonthCreated: 0,
    possibleWrongExits: 0,
    possibleWrongEntries: 0,
    mrr: 0,
  };

  for (const row of rows) {
    const type = row.lifecycle?.type || row.audit?.type;
    const counts = row.lifecycle?.counts || row.audit?.counts || {};
    const createdLocal = row.lifecycle?.createdLocal || row.audit?.createdLocal || getContractLocalDate(row.created_at);

    if (counts.active) summary.active += 1;
    if (counts.entry) summary.entries += 1;
    if (counts.renewal) summary.renewals += 1;
    if (counts.exit) summary.realExits += 1;
    if (counts.mrr) summary.mrr += row.monthly || 0;
    if (createdLocal >= monthStart) summary.currentMonthCreated += 1;

    if (type === 'voided_sale') summary.voidedSales += 1;
    if (type === 'plan_replaced') summary.planReplaced += 1;
    if (type === 'financial_adjustment') summary.financialAdjustments += 1;
    if (type === 'active_payment_pending') summary.activePaymentPending += 1;
    if (type === 'pending_sale') summary.pendingSales += 1;
    if (type === 'needs_review') summary.needsReview += 1;

    if (['plan_replaced', 'financial_adjustment', 'needs_review'].includes(type) && row.status === 'cancelled') {
      summary.possibleWrongExits += 1;
    }
    if (createdLocal >= monthStart && !row.parent_contract_id && ['pending_sale', 'voided_sale', 'needs_review'].includes(type)) {
      summary.possibleWrongEntries += 1;
    }
  }

  return summary;
}
