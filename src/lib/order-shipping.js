// Frete cobrado depois do envio. O pedido com frete passa por Enviado
// (rastreio e quanto foi pago) e, se houver valor a cobrar, ganha a cobrança do
// frete: um pedido da loja só com o item "Frete", ligado ao pedido de origem
// (shipping_parent_type/id). Quem grava é mark_order_shipped; aqui só se lê.

export const SHIPPING_MONEY_MAX = 100000;
export const TRACKING_CODE_MAX = 80;

const CLOSED_PAYMENTS = new Set(['cancelled', 'refunded']);

export function isShippingCharge(order) {
  return Boolean(order?.shipping_parent_id);
}

export function shipsByCarrier(order) {
  return order?.delivery_method === 'shipping' && !isShippingCharge(order);
}

// Aceita "30,50" e "30.50"; vazio ou texto vira NaN.
export function parseShippingMoney(value) {
  const text = String(value ?? '').trim();
  if (!text) return Number.NaN;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return Number.NaN;
  return Math.round(Number(normalized) * 100) / 100;
}

// Confere o formulário do envio. Devolve a mensagem do primeiro erro ou null.
export function shipmentFormError({ trackingCode = '', cost, price, chargeExists = false }) {
  if (String(trackingCode || '').trim().length > TRACKING_CODE_MAX) return 'Código de rastreio muito longo';
  const paid = parseShippingMoney(cost);
  if (!Number.isFinite(paid) || paid > SHIPPING_MONEY_MAX) return 'Informe quanto você pagou no frete';
  if (chargeExists) return null;
  const charged = parseShippingMoney(price);
  if (!Number.isFinite(charged) || charged > SHIPPING_MONEY_MAX) return 'Informe quanto vai cobrar (0 para frete grátis)';
  return null;
}

// Cobrança do frete que vale: a mais recente que não foi cancelada nem
// estornada. Sem ela, a mais recente (para mostrar que foi cancelada).
export function currentShippingCharge(charges = []) {
  const sorted = [...charges].sort((a, b) =>
    String(b.created_date || '').localeCompare(String(a.created_date || '')));
  return sorted.find(charge => !CLOSED_PAYMENTS.has(charge.payment_status)) || sorted[0] || null;
}

export function isOpenShippingCharge(charge) {
  return Boolean(charge) && !CLOSED_PAYMENTS.has(charge.payment_status);
}

// Cobranças de frete por pedido de origem ("stock:<id>" ou "presale:<id>").
export function shippingChargesByParent(stockOrders = []) {
  const groups = new Map();
  for (const order of stockOrders) {
    if (!isShippingCharge(order)) continue;
    const key = `${order.shipping_parent_type}:${order.shipping_parent_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  return new Map([...groups].map(([key, charges]) => [key, currentShippingCharge(charges)]));
}

// Selo do frete no card do pedido de origem.
export function shippingChargeTag(charge) {
  if (!isOpenShippingCharge(charge)) return null;
  if (charge.payment_status === 'paid') return { label: 'Frete pago', tone: 'green' };
  if (['pending', 'awaiting_charge', null, undefined, ''].includes(charge.payment_status)) {
    return { label: 'Frete a cobrar', tone: 'amber' };
  }
  return { label: 'Frete cobrado', tone: 'blue' };
}
