import {
  createOrderCharge,
  markAssessmentContractNonRenewal as markAssessmentContractNonRenewalApi,
  saveAssessmentContractExternalCharge,
} from '@/api/client';
import { isSafePaymentUrl } from '@/lib/sales';
import { normalizeExternalChargeMethod } from '@/lib/external-charge';

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

  const result = await saveAssessmentContractExternalCharge(contract.id, {
    externalLink: cleanLink,
    dueDate: cleanDueDate,
    paymentMethod: normalizedPaymentMethod,
    invoiceNumber: cleanInvoiceNumber || null,
    source,
    expectedUpdatedAt: contract.updated_at,
  });
  const updatedContract = result.contract;
  const updates = {
    external_payment_link: updatedContract.external_payment_link,
    due_date: updatedContract.due_date,
    payment_method: updatedContract.payment_method,
    external_invoice_number: updatedContract.external_invoice_number,
    payment_status: updatedContract.payment_status,
    status: updatedContract.status,
    updated_at: updatedContract.updated_at,
  };

  return {
    updates,
    paymentMethod: updatedContract.payment_method,
    hadExternalLink: result.had_external_link,
  };
}

export async function markAssessmentContractNonRenewal({
  contract,
}) {
  if (!contract?.id) throw new Error('Contrato anterior não encontrado');
  if (!contract.end_date) throw new Error('Contrato sem data final');
  const result = await markAssessmentContractNonRenewalApi(
    contract.id,
    contract.updated_at,
  );

  return {
    shouldFinishNow: result.should_finish_now,
    statusAfter: result.status_after || result.contract?.status,
  };
}
