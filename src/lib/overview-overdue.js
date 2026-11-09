// Vencido em aberto na Visão geral: saldo ainda aberto de cobranças e parcelas
// cujo vencimento é ANTERIOR a hoje no dia local. Hoje ainda é "vence hoje";
// sem vencimento é uma categoria separada e nunca é tratada como atraso.
//
// Usa as mesmas linhas da lista de Cobranças (loadOpenSalesOrders +
// selectActiveOpenOrders): contrato com carnê é substituído pelas parcelas sem
// registro, então o contrato inteiro não soma junto com as parcelas. Cada
// parcela vencida da mesma pessoa continua sendo uma obrigação.

const cents = value => Math.round((Number(value) || 0) * 100);

function personKey(order) {
  if (order.customer_id) return `id:${order.customer_id}`;
  const phone = String(order.customer_whatsapp || '').replace(/\D/g, '');
  if (phone) return `tel:${phone}`;
  return `nome:${String(order.customer || '').trim().toLowerCase()}`;
}

function bucket(items) {
  return {
    count: items.length,
    total: items.reduce((sum, order) => sum + cents(order.total_value), 0) / 100,
    people: new Set(items.map(personKey)).size,
    items,
  };
}

export function summarizeOpenSales(activeOrders = [], today) {
  const open = activeOrders.filter(order => cents(order.total_value) > 0);
  const overdue = open.filter(order => order.due_date && order.due_date < today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dueToday = open.filter(order => order.due_date === today);
  const noDueDate = open.filter(order => !order.due_date);
  return {
    overdue: bucket(overdue),
    dueToday: bucket(dueToday),
    noDueDate: bucket(noDueDate),
  };
}
