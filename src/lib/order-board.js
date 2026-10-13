// Quadro de pedidos (loja e pré-venda) em esteira: cobrança → fornecedor →
// separação → entrega. A coluna sai do pagamento e da etapa de entrega do
// pedido; nada aqui grava. Mudar de etapa usa a mesma regra da tela do pedido
// (update_order_fulfillment: só para frente, data na entrega).

const DAY = 24 * 60 * 60 * 1000;
const SAO_PAULO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});

export const DELIVERED_WINDOW_DAYS = 30;

export const ORDER_BOARD_COLUMNS = Object.freeze([
  { id: 'awaiting_charge', title: 'Aguardando cobrança', hint: 'Cobrança ainda não enviada.', dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-700' },
  { id: 'charge_sent', title: 'Cobrança enviada', hint: 'Esperando o pagamento.', dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800' },
  { id: 'supplier', title: 'Com fornecedor', hint: 'Pré-venda paga em produção ou compra.', dot: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  { id: 'to_separate', title: 'A separar', hint: 'Pago e com o produto disponível.', dot: 'bg-violet-500', badge: 'bg-violet-100 text-violet-700' },
  { id: 'ready', title: 'Pronto para entregar', hint: 'Separado, falta entregar ou retirar.', dot: 'bg-orange-500', badge: 'bg-orange-100 text-orange-800' },
  { id: 'delivered', title: 'Entregue', hint: `Últimos ${DELIVERED_WINDOW_DAYS} dias.`, dot: 'bg-green-500', badge: 'bg-green-100 text-green-700' },
  { id: 'cancelled', title: 'Cancelados', hint: 'Cobrança cancelada, reembolsada ou entrega interrompida.', dot: 'bg-red-400', badge: 'bg-red-100 text-red-700' },
]);

const UNCHARGED = new Set([null, undefined, '', 'pending', 'awaiting_charge']);

export function localDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : SAO_PAULO_DATE.format(date);
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
}

// Pedido sem etapa registrada (legado) conta como o começo do fluxo da origem.
function deliveryStage(order) {
  return order.delivery_status || (order.type === 'presale' ? 'awaiting_supplier' : 'awaiting_delivery');
}

export function orderBoardColumn(order) {
  if (order.delivery_status === 'cancelled' || ['cancelled', 'refunded'].includes(order.payment_status)) return 'cancelled';
  // Separado ou entregue vale mais que o pagamento: o card mostra se ainda falta pagar.
  if (order.delivery_status === 'delivered') return 'delivered';
  if (order.delivery_status === 'separated') return 'ready';
  if (order.payment_status !== 'paid') return UNCHARGED.has(order.payment_status) ? 'awaiting_charge' : 'charge_sent';
  const stage = deliveryStage(order);
  if (order.type === 'presale' && ['awaiting_supplier', 'supplier_ordered'].includes(stage)) return 'supplier';
  return 'to_separate';
}

const NEXT_STEP = {
  presale: {
    awaiting_supplier: { status: 'supplier_ordered', short: 'Pedido feito', label: 'Marcar pedido ao fornecedor' },
    supplier_ordered: { status: 'received', short: 'Chegou', label: 'Marcar que chegou do fornecedor' },
    received: { status: 'separated', short: 'Separado', label: 'Marcar como separado' },
    separated: { status: 'delivered', short: 'Entregue', label: 'Marcar como entregue' },
  },
  stock: {
    awaiting_delivery: { status: 'separated', short: 'Separado', label: 'Marcar como separado' },
    separated: { status: 'delivered', short: 'Entregue', label: 'Marcar como entregue' },
  },
};

// Próxima etapa de entrega que o card pode dar. Nas colunas de cobrança não há
// atalho: o pagamento é registrado dentro do pedido.
export function nextFulfillmentStep(order) {
  const column = orderBoardColumn(order);
  if (!['supplier', 'to_separate', 'ready'].includes(column)) return null;
  const step = NEXT_STEP[order.type]?.[deliveryStage(order)];
  return step ? { ...step, needsDate: step.status === 'delivered' } : null;
}

// Selos e números do card, calculados em datas de São Paulo.
export function orderCardSignals(order, today) {
  const column = orderBoardColumn(order);
  const since = localDate(order.status_changed_at || order.created_date);
  const signals = {
    column,
    daysInStage: Math.max(0, daysBetween(since, today) ?? 0),
    overdueDays: 0,
    unpaid: false,
    // Pedido de hoje ou de ontem.
    isNew: (daysBetween(localDate(order.created_date), today) ?? 99) <= 1,
  };
  if (['awaiting_charge', 'charge_sent'].includes(column)) {
    const late = daysBetween(localDate(order.due_date), today);
    if (order.payment_status === 'overdue' || (late !== null && late > 0)) signals.overdueDays = Math.max(1, late ?? 1);
  }
  if (['ready', 'delivered'].includes(column) && order.payment_status !== 'paid') signals.unpaid = true;
  return signals;
}

function deliveredOn(order) {
  return localDate(order.delivery_date || order.status_changed_at || order.updated_date || order.created_date);
}

// Monta as colunas. Entregues antigos e cancelados ficam de fora (contados),
// para o quadro mostrar só o que ainda pede ação.
export function buildOrderBoard(orders, { today, showCancelled = false, deliveredWindowDays = DELIVERED_WINDOW_DAYS } = {}) {
  const buckets = new Map(ORDER_BOARD_COLUMNS.map(column => [column.id, []]));
  let olderDelivered = 0;
  for (const order of orders) {
    const column = orderBoardColumn(order);
    if (column === 'delivered') {
      const age = daysBetween(deliveredOn(order), today);
      if (age !== null && age > deliveredWindowDays) {
        olderDelivered += 1;
        continue;
      }
    }
    buckets.get(column).push({ order, signals: orderCardSignals(order, today) });
  }
  // Pedido mais novo no topo; em Entregue, a entrega mais recente.
  const time = value => Date.parse(value || '') || 0;
  for (const [id, items] of buckets) {
    items.sort((a, b) => (id === 'delivered'
      ? String(deliveredOn(b.order) || '').localeCompare(String(deliveredOn(a.order) || ''))
      : 0)
      || time(b.order.created_date) - time(a.order.created_date)
      || String(b.order.order_number || '').localeCompare(String(a.order.order_number || '')));
  }
  const columns = ORDER_BOARD_COLUMNS
    .filter(column => showCancelled || column.id !== 'cancelled')
    .map(column => {
      const items = buckets.get(column.id);
      return { ...column, items, total: items.reduce((sum, item) => sum + (Number(item.order.total) || 0), 0) };
    });
  return { columns, olderDelivered, cancelled: buckets.get('cancelled').length };
}
