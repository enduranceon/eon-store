export const EXTERNAL_CHARGE_METHODS = [
  { value: 'pix', label: 'PIX' },
  { value: 'boleto', label: 'Boleto' },
  ...Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return { value: `card_${n}x`, label: `Cartão ${n}x` };
  }),
];

const SELECTABLE_METHOD_LABELS = Object.fromEntries(
  EXTERNAL_CHARGE_METHODS.map(method => [method.value, method.label]),
);

// Nao e escolhida no cadastro: o contrato passa a ela quando as parcelas do Asaas sao importadas.
const EXTERNAL_CHARGE_METHOD_LABELS = {
  ...SELECTABLE_METHOD_LABELS,
  carne_boleto_pix: 'Boleto/PIX parcelado (carnê)',
};

export function normalizeExternalChargeMethod(method, installments = 1) {
  if (method === 'credit_card') return `card_${Math.max(Number(installments) || 1, 1)}x`;
  if (method === 'pix_asaas') return 'pix';
  if (method === 'boleto_asaas') return 'boleto';
  if (SELECTABLE_METHOD_LABELS[method]) return method;
  return Number(installments) > 1 ? `card_${installments}x` : 'pix';
}

export function externalChargeMethodLabel(method) {
  return EXTERNAL_CHARGE_METHOD_LABELS[method] || method || '-';
}
