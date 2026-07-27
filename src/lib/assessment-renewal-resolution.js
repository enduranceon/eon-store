const ALLOWED_STATUSES = new Set(['draft', 'scheduled', 'active', 'overdue']);
const ALLOWED_PAYMENT_STATUSES = new Set([
  'pending',
  'awaiting_charge',
  'charge_sent',
  'overdue',
]);

export function canResolveAssessmentRenewal(contract) {
  const hasOrphanAsaasReference = !contract?.asaas_charge_id && !!(
    contract?.asaas_payment_link
    || contract?.asaas_pix_copy
    || contract?.asaas_pix_qrcode
  );

  return !!contract
    && ALLOWED_STATUSES.has(contract.status)
    && ALLOWED_PAYMENT_STATUSES.has(contract.payment_status)
    && !contract.manual_payment
    && !contract.payment_date
    && !contract.refund_status
    && Number(contract.refund_amount || 0) === 0
    && !contract.refund_date
    && !String(contract.refund_notes || '').trim()
    && !hasOrphanAsaasReference;
}
