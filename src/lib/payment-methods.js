// Métodos de pagamento — usados em pedidos da loja e contratos da assessoria

// Dias de vencimento default para lançamentos/cobranças.
// Editável pelo usuário no modal de "Gerar cobrança" — esta constante é só o ponto de partida.
export const DEFAULT_PAYMENT_DUE_DAYS = 5;
export const DEFAULT_ASAAS_DUE_DAYS = DEFAULT_PAYMENT_DUE_DAYS;

// Helper: retorna o vencimento default formatado YYYY-MM-DD
export function defaultPaymentDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_PAYMENT_DUE_DAYS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const defaultAsaasDueDate = defaultPaymentDueDate;

export const PAYMENT_METHODS = [
  // ── Pagamentos manuais ──
  { value: 'pix_manual',    label: 'PIX manual',        description: 'Cliente pagou direto via PIX', group: 'manual' },
  { value: 'cash',          label: 'Dinheiro',          description: 'Pagamento em espécie',         group: 'manual' },
  { value: 'card_machine',  label: 'Máquina de cartão', description: 'Pagamento presencial',          group: 'manual' },
  { value: 'bank_transfer', label: 'Transferência',     description: 'TED, DOC ou transferência',     group: 'manual' },
  // ── Pagamentos via Asaas ──
  { value: 'pix',           label: 'PIX (via Asaas)',   description: 'Recebido via Asaas',            group: 'asaas' },
  { value: 'boleto',        label: 'Boleto',            description: 'Recebido via boleto bancário',  group: 'asaas' },
  { value: 'credit_card',   label: 'Cartão de crédito', description: 'Crédito via Asaas',             group: 'asaas' },
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
