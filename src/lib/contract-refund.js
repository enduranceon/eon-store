// Regras de tela do registro de estorno de contrato. As regras que valem
// estão no banco (register_assessment_contract_refund); aqui ficam os
// rótulos e as contas que a tela mostra enquanto o operador preenche.

export const REFUND_METHODS = [
  { value: 'pix', label: 'PIX' },
  { value: 'bank_transfer', label: 'Transferência' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'card_asaas', label: 'Estorno no cartão (Asaas)' },
  { value: 'card_machine', label: 'Estorno no cartão (maquininha)' },
  { value: 'other', label: 'Outro' },
];

const METHOD_LABELS = Object.fromEntries(REFUND_METHODS.map(method => [method.value, method.label]));

export function refundMethodLabel(method) {
  return METHOD_LABELS[method] || method || '';
}

export function isCardRefundMethod(method) {
  return method === 'card_asaas' || method === 'card_machine';
}

function cents(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? Math.round(number * 100) : NaN;
}

// Uma parcela já tinha caído na conta quando a data prevista de crédito é o
// dia do estorno ou antes. O operador corrige olhando o Asaas.
export function defaultAlreadyCredited(creditDate, refundDate) {
  if (!creditDate || !refundDate) return false;
  return String(creditDate).slice(0, 10) <= String(refundDate).slice(0, 10);
}

// Soma do que foi distribuído entre as parcelas, em centavos, e o que falta
// para fechar o valor devolvido. Parcela acima do próprio valor é erro.
export function refundAllocationStatus(installments, values, amount) {
  const amountCents = cents(amount);
  let allocatedCents = 0;
  const errors = {};
  for (const installment of installments || []) {
    const raw = values?.[installment.id];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const valueCents = cents(raw);
    if (!Number.isFinite(valueCents) || valueCents < 0) {
      errors[installment.id] = 'Valor inválido';
      continue;
    }
    if (valueCents > Math.round(Number(installment.value) * 100)) {
      errors[installment.id] = 'Acima do valor da parcela';
    }
    allocatedCents += valueCents;
  }
  const remainingCents = Number.isFinite(amountCents) ? amountCents - allocatedCents : NaN;
  return {
    allocated: allocatedCents / 100,
    remaining: remainingCents / 100,
    errors,
    complete: Number.isFinite(amountCents) && amountCents > 0 && remainingCents === 0
      && allocatedCents > 0 && Object.keys(errors).length === 0,
  };
}

// Corpo das parcelas para a API: só as que tiveram valor estornado.
export function refundAllocationsPayload(installments, values, credited) {
  return (installments || [])
    .filter(installment => cents(values?.[installment.id]) > 0)
    .map(installment => ({
      payment_id: installment.id,
      value: cents(values[installment.id]) / 100,
      already_credited: Boolean(credited?.[installment.id]),
    }));
}

export function isDifferentFromCalculated(amount, calculated) {
  const amountCents = cents(amount);
  const calculatedCents = cents(calculated);
  return Number.isFinite(amountCents) && Number.isFinite(calculatedCents) && amountCents !== calculatedCents;
}
