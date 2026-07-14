import { defaultAsaasDueDate } from '@/lib/payment-methods';
import { todayLocalStr } from '@/lib/utils';

export function hasAssessmentChargeInfo(contract) {
  return Boolean(
    contract?.asaas_charge_id ||
    contract?.asaas_payment_link ||
    contract?.asaas_pix_copy ||
    contract?.external_payment_link
  );
}

function notPastDate(dateStr) {
  if (!dateStr) return '';
  const today = todayLocalStr();
  return dateStr < today ? today : dateStr;
}

export function suggestedAssessmentChargeDueDate(contract) {
  const fallback = defaultAsaasDueDate();
  const savedDueDate = contract?.due_date || '';
  const isRenewal = Boolean(contract?.parent_contract_id);

  if (!isRenewal) return savedDueDate || fallback;
  if (hasAssessmentChargeInfo(contract) || contract?.payment_message_sent_at) {
    return savedDueDate || fallback;
  }

  const startDate = contract?.start_date || '';
  const endDate = contract?.end_date || '';

  if (startDate && (!savedDueDate || savedDueDate === endDate)) {
    return notPastDate(startDate);
  }

  return savedDueDate || (startDate ? notPastDate(startDate) : fallback);
}
