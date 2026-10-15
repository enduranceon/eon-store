// Pedaços da mensagem de cobrança vencida, iguais aos do banco
// ({dias_atraso} e {referente} em communication_template_context).

export function overdueDaysText(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  return `${days} dia${days === 1 ? '' : 's'}`;
}

// Item único do pedido ("Boné x2"); vazio quando há mais de um.
export function singleItemLabel(items) {
  const list = Array.isArray(items) ? items.filter(item => item?.label) : [];
  if (list.length !== 1) return '';
  const quantity = Math.max(1, Number(list[0].quantity) || 1);
  return quantity > 1 ? `${list[0].label} x${quantity}` : list[0].label;
}

// Contrato: "referente ao seu plano Corrida - Trimestral (ASS-000123)".
// Pedido e inscrição: "do seu pedido (Boné)", sem o número interno; com mais
// de um item, só "do seu pedido" e a lista vai em {itens_bloco}.
export function chargeReference({ sourceType, orderNumber, planLabel, items } = {}) {
  const number = orderNumber || '';
  if (sourceType === 'contract') {
    return planLabel
      ? `referente ao seu plano ${planLabel}${number ? ` (${number})` : ''}`
      : `referente ao seu contrato${number ? ` ${number}` : ''}`;
  }
  const label = sourceType === 'event' ? 'da sua inscrição' : 'do seu pedido';
  const item = singleItemLabel(items);
  return item ? `${label} (${item})` : label;
}

// Lista de itens só com mais de um item: o item único já está no {referente}.
export function itemsBlock(items, itemsText) {
  return Array.isArray(items) && items.length > 1 && itemsText ? `Itens:\n${itemsText}\n\n` : '';
}
