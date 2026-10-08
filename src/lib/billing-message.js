// Pedaços da mensagem de cobrança vencida, iguais aos do banco
// ({dias_atraso} e {referente} em communication_template_context).

export function overdueDaysText(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  return `${days} dia${days === 1 ? '' : 's'}`;
}

// "referente ao seu plano Corrida - Trimestral (ASS-000123)".
export function chargeReference({ sourceType, orderNumber, planLabel } = {}, item = '') {
  const number = orderNumber || '';
  if (sourceType === 'contract') {
    return planLabel
      ? `referente ao seu plano ${planLabel}${number ? ` (${number})` : ''}`
      : `referente ao seu contrato${number ? ` ${number}` : ''}`;
  }
  const label = sourceType === 'event' ? 'referente à sua inscrição' : 'referente ao seu pedido';
  return `${label}${number ? ` ${number}` : ''}${item ? ` (${item})` : ''}`;
}
