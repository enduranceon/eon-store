export const TERMINAL_PAYMENT_STATUSES = new Set(['cancelled', 'refunded']);
export const PAID_PAYMENT_STATUSES = new Set(['paid', 'partially_paid']);
export const BILLABLE_PROSPECT_STAGES = new Set(['proposal_ready', 'payment_link_sent']);
export const OPEN_PAYMENT_STATUSES = new Set([
  'pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid',
]);

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

export function isBillableProspectOpenSale(order) {
  return Boolean(
    order &&
    order.status === 'draft' &&
    !order.parent_contract_id &&
    BILLABLE_PROSPECT_STAGES.has(order.prospect_stage) &&
    isEffectiveOpenSale(order)
  );
}

// A contract becomes a financial open sale as soon as it is operationally
// approved. Unlike a draft prospect, it must remain visible even before a
// charge/link has been generated, otherwise a renewal can disappear from the
// collection queue.
export function isBillableAssessmentContractOpenSale(order) {
  return Boolean(
    order &&
    (order.type === 'contract' || order.contract_number) &&
    !['draft', 'voided', 'cancelled'].includes(order.status) &&
    OPEN_PAYMENT_STATUSES.has(order.payment_status) &&
    !TERMINAL_PAYMENT_STATUSES.has(order.payment_status)
  );
}

export function isOpenSaleForFinancial(order) {
  if (order?.status === 'draft') return isBillableProspectOpenSale(order);
  return isBillableAssessmentContractOpenSale(order) || isEffectiveOpenSale(order);
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
