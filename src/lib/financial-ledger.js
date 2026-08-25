export const FINANCIAL_MOVEMENT_KIND = Object.freeze({
  RECEIPT: 'receipt',
  RECEIVABLE: 'receivable',
  REFUND: 'refund',
  EXPENSE: 'expense',
  PAYOUT: 'payout',
  PAYOUT_ADJUSTMENT: 'payout_adjustment',
});

export const FINANCIAL_TERMS = Object.freeze({
  expected: 'Valor de venda ainda sem recebimento confirmado.',
  receivable: 'Cobranca criada e ainda pendente de entrada em caixa.',
  grossReceipt: 'Valor bruto confirmado antes das taxas.',
  fee: 'Taxa registrada pelo meio de pagamento.',
  netReceipt: 'Valor liquido apos as taxas.',
  expense: 'Saida operacional registrada.',
  operatingResult: 'Entradas liquidas menos estornos, despesas e repasses pagos.',
});

export function isActualReceipt(movement) {
  return movement?.movement_kind === FINANCIAL_MOVEMENT_KIND.RECEIPT
    && movement?.is_actual === true;
}

export function movementAmount(movement, field = 'gross_amount') {
  return Number(movement?.[field]) || 0;
}

export function toPaymentRecord(movement) {
  return {
    id: movement.movement_id,
    asaas_payment_id: movement.metadata?.asaas_payment_id || null,
    order_id: movement.order_id,
    order_type: movement.order_type,
    status: movement.status,
    source: movement.source,
    value: movementAmount(movement),
    net_value: movementAmount(movement, 'net_amount'),
    credit_date: movement.scheduled_on || movement.occurred_on || null,
    payment_date: movement.recognition_on || movement.occurred_on || null,
    due_date: movement.due_on || null,
    billing_type: movement.payment_method || null,
    installment_number: movement.metadata?.installment_number || null,
    total_installments: movement.metadata?.total_installments || null,
    description: movement.description || null,
    external_reference: movement.metadata?.external_reference || movement.reference || null,
    payment_method_id: null,
    revenue_center_id: movement.revenue_center_id || null,
    occurred_on: movement.occurred_on || null,
    is_legacy: movement.is_legacy === true,
  };
}

export function financialQualityPath(issue) {
  if (!issue?.source_id) return '/financeiro';
  if (issue.order_type === 'presale') return `/pedidos/${issue.source_id}`;
  if (issue.order_type === 'stock') return `/estoque/pedidos/${issue.source_id}`;
  if (issue.order_type === 'contract') return `/assessoria/contratos/${issue.source_id}`;
  return '/eventos';
}

export function financialQualitySeverityLabel(severity) {
  return {
    high: 'Alta',
    medium: 'Media',
    low: 'Baixa',
  }[severity] || 'Revisar';
}
