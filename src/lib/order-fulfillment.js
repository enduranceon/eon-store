export const LEGACY_DELIVERY_STATUS = '__legacy_unset__';

// O banco mantém códigos diferentes quando existe uma etapa real de fornecedor
// (pré-venda). A interface, porém, usa os mesmos nomes para as etapas comuns.
export const ORDER_FULFILLMENT = Object.freeze({
  presale: {
    initialStatus: 'awaiting_supplier',
    flowLabel: 'Pré-venda',
    flowHint: 'A pré-venda passa pelo fornecedor antes de os itens poderem ser separados.',
    statuses: {
      awaiting_supplier: {
        label: 'Aguardando fornecedor',
        hint: 'Aguardando produção ou reposição.',
        badge: 'secondary',
        next: ['supplier_ordered', 'cancelled'],
      },
      supplier_ordered: {
        label: 'Pedido ao fornecedor',
        hint: 'Produção ou compra já foi solicitada.',
        badge: 'info',
        next: ['received', 'cancelled'],
      },
      received: {
        label: 'Disponível para separar',
        hint: 'Os itens chegaram e podem ser separados para o cliente.',
        badge: 'info',
        next: ['separated', 'cancelled'],
      },
      separated: {
        label: 'Separado para entrega',
        hint: 'Produto separado, pronto para entregar ou enviar.',
        badge: 'warning',
        next: ['shipped', 'delivered', 'cancelled'],
      },
      shipped: {
        label: 'Enviado',
        hint: 'Saiu pelo correio ou transportadora; falta chegar ao cliente.',
        badge: 'info',
        next: ['delivered', 'cancelled'],
      },
      delivered: {
        label: 'Entregue',
        hint: 'Entrega concluída ao cliente.',
        badge: 'success',
        next: [],
      },
      cancelled: {
        label: 'Entrega interrompida',
        hint: 'O pedido não seguirá para entrega.',
        badge: 'destructive',
        next: [],
      },
    },
  },
  stock: {
    initialStatus: 'awaiting_delivery',
    flowLabel: 'Loja',
    flowHint: 'Na loja o estoque já está reservado; basta separar e entregar o pedido.',
    statuses: {
      awaiting_delivery: {
        label: 'Aguardando separação',
        hint: 'O estoque está reservado e o pedido aguarda separação.',
        badge: 'secondary',
        next: ['separated', 'cancelled'],
      },
      separated: {
        label: 'Separado para entrega',
        hint: 'Produto separado, pronto para entregar ou enviar.',
        badge: 'warning',
        next: ['shipped', 'delivered', 'cancelled'],
      },
      shipped: {
        label: 'Enviado',
        hint: 'Saiu pelo correio ou transportadora; falta chegar ao cliente.',
        badge: 'info',
        next: ['delivered', 'cancelled'],
      },
      delivered: {
        label: 'Entregue',
        hint: 'Entrega concluída ao cliente.',
        badge: 'success',
        next: [],
      },
      cancelled: {
        label: 'Entrega interrompida',
        hint: 'O pedido não seguirá para entrega.',
        badge: 'destructive',
        next: [],
      },
    },
  },
});

export function fulfillmentDefinition(orderType) {
  return ORDER_FULFILLMENT[orderType] || ORDER_FULFILLMENT.stock;
}

export function fulfillmentStatus(orderType, status) {
  const definition = fulfillmentDefinition(orderType);
  return definition.statuses[status] || {
    label: status || 'Sem etapa definida',
    hint: 'Pedido legado sem etapa física registrada. Nenhum status será alterado automaticamente.',
    badge: 'secondary',
    next: [],
  };
}

// Enviado não aparece na troca de etapa: ele pede rastreio e quanto foi pago,
// e por isso tem o próprio botão (Marcar como enviado). Continua visível quando
// já é a etapa atual.
export function fulfillmentStatusOptions(orderType, currentStatus) {
  const definition = fulfillmentDefinition(orderType);
  const current = currentStatus || definition.initialStatus;
  const next = (definition.statuses[current]?.next || []).filter(status => status !== 'shipped');

  return [...new Set([
    ...(currentStatus ? [currentStatus] : []),
    ...(currentStatus ? next : [current, ...next]),
  ])];
}

// Enviado só entra no fluxo de pedido com frete.
export function fulfillmentFlowText(orderType, deliveryMethod = null) {
  const definition = fulfillmentDefinition(orderType);
  return Object.entries(definition.statuses)
    .filter(([status]) => status !== 'cancelled' && (status !== 'shipped' || deliveryMethod === 'shipping'))
    .map(([, meta]) => meta.label)
    .join(' → ');
}
