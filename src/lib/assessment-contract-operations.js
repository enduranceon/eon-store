import { AssessmentContract, AssessmentContractEvent } from '@/api/entities';
import { createOrderCharge } from '@/api/client';
import { supabase } from '@/api/db';
import { todayLocalStr } from '@/lib/utils';
import { isSafePaymentUrl } from '@/lib/sales';
import { externalChargeMethodLabel, normalizeExternalChargeMethod } from '@/lib/external-charge';

async function logContractEvent(contractId, eventType, payload = {}, notes = null) {
  try {
    await AssessmentContractEvent.create({
      contract_id: contractId,
      event_type: eventType,
      payload,
      notes,
    });
  } catch (e) {
    console.warn(`[contract_event] falha ao registrar ${eventType}:`, e.message);
  }
}

export async function generateAssessmentContractCharge({
  contract,
  customer,
  billingType = 'PIX',
  dueDate,
  source = 'contract_detail',
}) {
  if (!contract?.id) throw new Error('Contrato inválido');
  if (!customer?.cpf) throw new Error('Cadastre o CPF do aluno antes de gerar cobrança');
  if (!dueDate) throw new Error('Informe a data de vencimento');

  return createOrderCharge('contract', contract.id, {
    billingType,
    dueDate,
    source,
  });
}

export async function registerExternalAssessmentContractCharge({
  contract,
  link,
  dueDate,
  paymentMethod,
  invoiceNumber = '',
  source = 'contract_detail',
}) {
  if (!contract?.id) throw new Error('Contrato inválido');
  const cleanLink = String(link || '').trim();
  const cleanDueDate = dueDate || '';
  const cleanInvoiceNumber = String(invoiceNumber || '').trim();
  const normalizedPaymentMethod = normalizeExternalChargeMethod(paymentMethod, contract.installments);

  if (!cleanLink) throw new Error('Informe o link de cobrança');
  if (!isSafePaymentUrl(cleanLink)) throw new Error('Link inválido — deve começar com https://');
  if (!cleanDueDate) throw new Error('Informe a data de vencimento');
  if (contract.asaas_charge_id) throw new Error('Esta venda já tem cobrança Asaas');

  const hadExternalLink = !!contract.external_payment_link;
  const updates = {
    external_payment_link: cleanLink,
    due_date: cleanDueDate,
    payment_method: normalizedPaymentMethod,
    external_invoice_number: cleanInvoiceNumber || null,
  };
  if (['pending', 'awaiting_charge'].includes(contract.payment_status)) {
    updates.payment_status = 'charge_sent';
  }

  await AssessmentContract.update(contract.id, updates);
  await logContractEvent(
    contract.id,
    hadExternalLink ? 'external_charge_updated' : 'external_charge_registered',
    {
      link: cleanLink,
      due_date: cleanDueDate,
      payment_method: normalizedPaymentMethod,
      method_label: externalChargeMethodLabel(normalizedPaymentMethod),
      invoice_number: cleanInvoiceNumber || null,
      previous_invoice_number: contract.external_invoice_number || null,
      previous_link: contract.external_payment_link || null,
      previous_due_date: contract.due_date || null,
      previous_payment_method: contract.payment_method || null,
      previous_method_label: externalChargeMethodLabel(normalizeExternalChargeMethod(contract.payment_method, contract.installments)),
      source,
    },
    source === 'renewals_page'
      ? 'Cobrança externa da renovação registrada pela aba de Renovações'
      : null,
  );

  return {
    updates,
    paymentMethod: normalizedPaymentMethod,
    hadExternalLink,
  };
}

export async function markAssessmentContractNonRenewal({
  contract,
}) {
  if (!contract?.id) throw new Error('Contrato anterior não encontrado');
  if (!contract.end_date) throw new Error('Contrato sem data final');
  if (
    contract.refund_status
    || Number(contract.refund_amount || 0) !== 0
    || contract.refund_date
    || String(contract.refund_notes || '').trim()
    || ['refunded', 'partially_refunded'].includes(contract.payment_status)
  ) {
    throw new Error('O contrato possui movimentação de estorno e precisa de conferência');
  }
  if (
    String(contract.cancellation_reason || '').trim()
    || Number(contract.cancellation_fee || 0) !== 0
    || contract.cancellation_date
  ) {
    throw new Error('O contrato já possui outro registro de encerramento');
  }

  const { data: openRenewals, error: renewalLookupError } = await supabase
    .from('assessment_contracts')
    .select('id, contract_number')
    .eq('parent_contract_id', contract.id)
    .in('status', ['draft', 'scheduled', 'active', 'overdue', 'on_leave'])
    .limit(1);
  if (renewalLookupError) throw renewalLookupError;
  if (openRenewals?.length) {
    throw new Error(`Resolva primeiro a venda de renovação ${openRenewals[0].contract_number}`);
  }

  const shouldFinishNow = contract.end_date <= todayLocalStr();
  const updates = {
    renewal_generated: true,
    cancellation_date: contract.end_date,
    cancellation_fee: 0,
    cancellation_reason: 'Não renovou',
    ...(shouldFinishNow ? { status: 'finished' } : {}),
  };

  await AssessmentContract.update(contract.id, updates);

  await logContractEvent(contract.id, 'renewal_declined', {
    discarded_draft_id: null,
    discarded_draft_number: null,
    effective_end_date: contract.end_date,
    status_after: shouldFinishNow ? 'finished' : contract.status,
    no_financial_penalty: true,
  }, 'Aluno não vai renovar. Encerramento sem multa, estorno ou nova cobrança.');

  return {
    shouldFinishNow,
    statusAfter: shouldFinishNow ? 'finished' : contract.status,
  };
}
