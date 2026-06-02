// Métodos de pagamento — usados em pedidos da loja e contratos da assessoria
// Cada método informa se já é considerado "pago" e quanto cobra de taxa de gateway

export const PAYMENT_METHODS = [
  // ── Pagamentos manuais (sem taxa de gateway) ──
  { value: 'pix_manual',    label: 'PIX manual',        description: 'Cliente pagou direto via PIX, sem gateway', group: 'manual', fee: 0 },
  { value: 'cash',          label: 'Dinheiro',          description: 'Pagamento em espécie',                       group: 'manual', fee: 0 },
  { value: 'card_machine',  label: 'Máquina de cartão', description: 'Cielo, Stone, etc. (presencial)',            group: 'manual', fee: 0 },
  { value: 'bank_transfer', label: 'Transferência',     description: 'TED, DOC bancário',                          group: 'manual', fee: 0 },
  // ── Pagamentos via Asaas (com taxa) ──
  { value: 'pix',           label: 'PIX (via Asaas)',   description: 'Recebido via gateway Asaas',                 group: 'asaas',  fee: 'pix' },
  { value: 'boleto',        label: 'Boleto',            description: 'Recebido via boleto bancário',               group: 'asaas',  fee: 'boleto' },
  { value: 'credit_card',   label: 'Cartão de crédito', description: 'Crédito 1x via gateway',                     group: 'asaas',  fee: 'credit_1x' },
];

// Lookup rápido — inclui os internal_codes da nova tabela payment_methods
// para evitar códigos "crus" aparecendo em telas legacy (Reports, PublicOrderTracking, etc.)
export const PAYMENT_METHOD_LABELS = {
  ...Object.fromEntries(PAYMENT_METHODS.map(m => [m.value, m.label])),
  // Internal codes da tabela payment_methods (banco)
  pix_asaas:      'PIX (via Asaas)',
  boleto_asaas:   'Boleto (via Asaas)',
  card_asaas_3x:  'Cartão Asaas 3x',
  card_asaas_12x: 'Cartão Asaas 12x',
  // Preferências de checkout que faltavam no map original
  pix_boleto:     'PIX ou Boleto',
  card_2x:        'Cartão 2x',
  card_3x:        'Cartão 3x',
  card_4x:        'Cartão 4x',
  card_5x:        'Cartão 5x',
  card_6x:        'Cartão 6x',
  card_7x:        'Cartão 7x',
  card_8x:        'Cartão 8x',
  card_9x:        'Cartão 9x',
  card_10x:       'Cartão 10x',
  card_11x:       'Cartão 11x',
  card_12x:       'Cartão 12x',
};

// Calcula taxa do gateway Asaas
// PIX: 0,99% · Boleto: R$ 3,49 fixo · Cartão: 2,99% na 1x + 0,5% por parcela adicional
// Pagamentos manuais (pix_manual, cash, transfer, card_machine) = taxa zero
// Se `manualFee` for fornecido (não null/undefined), tem PRIORIDADE sobre o cálculo padrão.
export function calcGatewayFee(totalValue, paymentMethod, manualFee = null) {
  // Override manual tem prioridade (pode ser 0 explícito também)
  if (manualFee !== null && manualFee !== undefined && manualFee !== '') {
    return Number(manualFee) || 0;
  }
  if (!paymentMethod || !totalValue) return 0;

  // Normaliza códigos novos (internal_codes da tabela payment_methods)
  // para reaproveitar a lógica legacy
  let pm = paymentMethod;
  if (pm === 'pix_asaas')    pm = 'pix';
  if (pm === 'boleto_asaas') pm = 'boleto';
  const asaasCard = pm.match(/^card_asaas_(\d+)x$/);
  if (asaasCard) pm = `card_${asaasCard[1]}x`;

  if (pm === 'pix')    return totalValue * 0.0099;
  if (pm === 'boleto') return 3.49;
  if (pm.startsWith('card_')) {
    const m = pm.match(/card_(\d+)x/);
    const n = m ? parseInt(m[1]) : 1;
    return totalValue * (0.0299 + (n - 1) * 0.005);
  }
  if (pm === 'credit_card') return totalValue * 0.0299;
  return 0;
}

// Sugere taxa default em % baseada no método (pra UI sugerir valor no campo)
export function suggestFeePercent(paymentMethod) {
  if (!paymentMethod) return 0;
  if (paymentMethod === 'pix')         return 0.99;
  if (paymentMethod === 'credit_card') return 2.99;
  if (paymentMethod === 'card_machine') return 2.99;  // taxa típica de maquininha (Cielo/Stone)
  if (paymentMethod.startsWith('card_')) {
    const m = paymentMethod.match(/card_(\d+)x/);
    const n = m ? parseInt(m[1]) : 1;
    return 2.99 + (n - 1) * 0.5;
  }
  return 0;  // pix_manual, cash, bank_transfer → sem taxa
}
