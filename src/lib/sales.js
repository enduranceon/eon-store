export const TERMINAL_PAYMENT_STATUSES = new Set(['cancelled', 'refunded']);
export const PAID_PAYMENT_STATUSES = new Set(['paid', 'partially_paid']);

export function isNonCancelledOrder(order) {
  return Boolean(
    order &&
    order.payment_status !== 'cancelled' &&
    order.delivery_status !== 'cancelled'
  );
}

export function hasChargeEvidence(order) {
  if (!order) return false;
  return Boolean(
    order.asaas_charge_id ||
    order.asaas_payment_link ||
    order.asaas_pix_copy ||
    order.external_payment_link ||
    order.payment_message_sent_at
  );
}

export function isEffectiveSale(order) {
  if (order?.status === 'voided') return false;
  if (!order || TERMINAL_PAYMENT_STATUSES.has(order.payment_status)) return false;
  return PAID_PAYMENT_STATUSES.has(order.payment_status) || hasChargeEvidence(order);
}

export function isEffectiveOpenSale(order) {
  if (!isEffectiveSale(order)) return false;
  return !PAID_PAYMENT_STATUSES.has(order.payment_status);
}

export function isAwaitingCharge(order) {
  return Boolean(
    order &&
    !TERMINAL_PAYMENT_STATUSES.has(order.payment_status) &&
    !PAID_PAYMENT_STATUSES.has(order.payment_status) &&
    !hasChargeEvidence(order)
  );
}

export function publicTrackingToken(order) {
  return order?.public_token || order?.id || '';
}

export function isSafePaymentUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
