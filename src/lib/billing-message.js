// Pedaços da mensagem de cobrança vencida, iguais aos do banco
// ({dias_atraso} e {referente} em communication_template_context).

export function overdueDaysText(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  return `${days} dia${days === 1 ? '' : 's'}`;
}

// Contrato: "referente ao seu plano Corrida - Trimestral (ASS-000123)".
// Pedido e inscrição: só "do seu pedido" / "da sua inscrição", sem o número
// interno; os itens vão na lista ({itens_bloco}).
export function chargeReference({ sourceType, orderNumber, planLabel } = {}) {
  const number = orderNumber || '';
  if (sourceType === 'contract') {
    return planLabel
      ? `referente ao seu plano ${planLabel}${number ? ` (${number})` : ''}`
      : `referente ao seu contrato${number ? ` ${number}` : ''}`;
  }
  return sourceType === 'event' ? 'da sua inscrição' : 'do seu pedido';
}

export function itemsBlock(itemsText) {
  return itemsText ? `Itens:\n${itemsText}\n\n` : '';
}
