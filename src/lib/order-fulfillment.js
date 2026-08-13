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
        hint: 'Produto separado, pronto para entregar.',
        badge: 'warning',
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
        hint: 'Produto separado, pronto para entregar.',
        badge: 'warning',
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

export function fulfillmentStatusOptions(orderType, currentStatus) {
  const definition = fulfillmentDefinition(orderType);
  const current = currentStatus || definition.initialStatus;
  const next = definition.statuses[current]?.next || [];

  return [...new Set([
    ...(currentStatus ? [currentStatus] : []),
    ...(currentStatus ? next : [current, ...next]),
  ])];
}

export function fulfillmentFlowText(orderType) {
  const definition = fulfillmentDefinition(orderType);
  return Object.entries(definition.statuses)
    .filter(([status]) => status !== 'cancelled')
    .map(([, meta]) => meta.label)
    .join(' → ');
}
