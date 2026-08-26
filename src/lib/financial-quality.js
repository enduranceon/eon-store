const TYPE_META = Object.freeze({
  receipt_without_payment_row: {
    label: 'Recebimento sem parcela confirmada',
    actionLabel: 'Conferir pagamento',
    description: 'Confira o pagamento que originou o recebimento.',
  },
  open_sale_without_due_date: {
    label: 'Venda aberta sem vencimento',
    actionLabel: 'Definir vencimento',
    description: 'Defina o vencimento ou envie a cobrança da venda.',
  },
  movement_without_revenue_center: {
    label: 'Movimento sem centro de receita',
    actionLabel: 'Classificar receita',
    description: 'Vincule o movimento ao centro de receita correto.',
  },
  pending_refund: {
    label: 'Estorno pendente',
    actionLabel: 'Concluir estorno',
    description: 'Confirme a devolução financeira ao cliente.',
  },
  event_refund_without_details: {
    label: 'Estorno de evento sem detalhes',
    actionLabel: 'Registrar estorno',
    description: 'Informe o valor e a data do estorno do evento.',
  },
});

const UNIT_LABELS = Object.freeze({
  assessoria: 'Assessoria',
  eventos: 'Eventos',
  loja: 'Loja',
  pre_venda: 'Pré-venda',
  outros: 'Outros',
});

const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

function issueDate(issue) {
  return String(issue?.occurred_on || '');
}

function compareIssueRecency(left, right) {
  return issueDate(right).localeCompare(issueDate(left));
}

export function financialQualityTypeMeta(issueType) {
  return TYPE_META[issueType] || {
    label: 'Pendência financeira',
    actionLabel: 'Revisar origem',
    description: 'Revise os dados financeiros associados a este registro.',
  };
}

export function financialQualityUnitLabel(unit) {
  return UNIT_LABELS[unit] || UNIT_LABELS.outros;
}

export function financialQualityPriorityRank(severity) {
  return SEVERITY_RANK[severity] ?? 3;
}

export function filterFinancialQualityIssues(issues = [], filters = {}) {
  const {
    severity = 'all',
    businessUnit = 'all',
    issueType = 'all',
  } = filters;

  return issues.filter(issue => (
    (severity === 'all' || issue.severity === severity)
    && (businessUnit === 'all' || issue.business_unit === businessUnit)
    && (issueType === 'all' || issue.issue_type === issueType)
  ));
}

export function groupFinancialQualityIssues(issues = []) {
  const groupsByKey = new Map();

  issues.filter(Boolean).forEach(issue => {
    const severity = issue.severity || 'low';
    const businessUnit = issue.business_unit || 'outros';
    const issueType = issue.issue_type || 'unknown';
    const key = [severity, businessUnit, issueType].join(':');
    const group = groupsByKey.get(key) || {
      key,
      severity,
      businessUnit,
      issueType,
      count: 0,
      totalAmount: 0,
      issues: [],
    };

    group.count += 1;
    group.totalAmount += Math.abs(Number(issue.amount) || 0);
    group.issues.push(issue);
    groupsByKey.set(key, group);
  });

  return [...groupsByKey.values()]
    .map(group => {
      const issuesInGroup = [...group.issues].sort(compareIssueRecency);
      return {
        ...group,
        issues: issuesInGroup,
        representative: issuesInGroup[0] || null,
        latestOccurredOn: issueDate(issuesInGroup[0]),
      };
    })
    .sort((left, right) => {
      const priority = financialQualityPriorityRank(left.severity) - financialQualityPriorityRank(right.severity);
      if (priority !== 0) return priority;
      const amount = right.totalAmount - left.totalAmount;
      if (amount !== 0) return amount;
      const count = right.count - left.count;
      if (count !== 0) return count;
      return right.latestOccurredOn.localeCompare(left.latestOccurredOn);
    });
}

export function summarizeFinancialQuality(issues = []) {
  const groups = groupFinancialQualityIssues(issues);
  const counts = issues.reduce((summary, issue) => {
    const severity = issue?.severity;
    if (severity === 'high') summary.highCount += 1;
    if (severity === 'medium') summary.mediumCount += 1;
    if (severity === 'low') summary.lowCount += 1;
    return summary;
  }, { highCount: 0, mediumCount: 0, lowCount: 0 });

  return {
    ...counts,
    groups,
    groupCount: groups.length,
    totalCount: issues.length,
    totalAmount: groups.reduce((total, group) => total + group.totalAmount, 0),
  };
}
