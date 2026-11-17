// O que cancelar um pedido faz de verdade, para a tela não prometer o que não
// acontece:
// - a cobrança criada pela integração do Asaas é cancelada junto; já a fatura de
//   um link externo (https://www.asaas.com/i/...) NÃO: o sistema não altera nada
//   no Asaas, e o link sai do pedido (fica só no histórico);
// - em pedido da loja já entregue, as peças não voltam ao estoque na hora: voltam
//   pela devolução (Loja > Devoluções), quando chegarem de volta.

export function cancelOrderEffects(order) {
  const apiCharge = Boolean(order?.asaas_charge_id);
  const link = String(order?.external_payment_link || '').trim();
  return {
    delivered: order?.delivery_status === 'delivered',
    apiCharge,
    externalLink: !apiCharge && link ? link : null,
  };
}

// Texto do aviso de sucesso e o link da fatura que ficou para cancelar no Asaas.
// `result` é o que o servidor devolveu ao cancelar (`stock_restocked` = peças repostas).
export function cancelOrderResultNotice(order, result, orderType) {
  const { delivered, externalLink } = cancelOrderEffects(order);
  let message = 'Pedido cancelado.';
  if (orderType === 'stock') {
    if ((Number(result?.stock_restocked) || 0) > 0) {
      message = 'Pedido cancelado. As peças voltaram para o estoque.';
    } else if (delivered) {
      message = 'Pedido cancelado. Como já tinha sido entregue, o estoque não foi reposto: registre a devolução em Loja > Devoluções quando as peças voltarem.';
    }
  }
  return { message, externalLink };
}
