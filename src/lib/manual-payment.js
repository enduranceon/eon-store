// Adaptadores do frontend para o ciclo de pagamento manual da API autenticada.

import {
  adjustManualPayment as adjustManualPaymentViaApi,
  listPaymentMethods,
  recordManualPayment as recordManualPaymentViaApi,
  reopenManualPayment as reopenManualPaymentViaApi,
} from '@/api/client';
import { nextBusinessDay } from '@/lib/business-days';

// Tabela de labels para payment_method (cobre códigos legacy + novos internal_codes).
const PAYMENT_METHOD_LABELS = {
  // Legacy / checkout
  pix_boleto: 'PIX ou Boleto',
  pix: 'PIX',
  boleto: 'Boleto',
  credit_card: 'Cartão de crédito',
  card_1x: 'Cartão 1x',  card_2x: 'Cartão 2x',  card_3x: 'Cartão 3x',
  card_4x: 'Cartão 4x',  card_5x: 'Cartão 5x',  card_6x: 'Cartão 6x',
  card_7x: 'Cartão 7x',  card_8x: 'Cartão 8x',  card_9x: 'Cartão 9x',
  card_10x: 'Cartão 10x', card_11x: 'Cartão 11x', card_12x: 'Cartão 12x',
  // Manual (sem gateway)
  pix_manual:    'PIX manual',
  cash:          'Dinheiro',
  card_machine:  'Máquina de cartão',
  bank_transfer: 'Transferência bancária',
  // Asaas (internal_code)
  pix_asaas:     'PIX (via Asaas)',
  boleto_asaas:  'Boleto (via Asaas)',
  card_asaas_3x: 'Cartão Asaas 3x',
  card_asaas_12x:'Cartão Asaas 12x',
};

// Retorna label legível para um payment_method code. Faz fallback para card_Nx genérico.
export function getPaymentMethodLabel(code) {
  if (!code) return '—';
  if (PAYMENT_METHOD_LABELS[code]) return PAYMENT_METHOD_LABELS[code];
  // Fallback: card_Nx genérico (1..99)
  const m = code.match(/^card_(\d+)x$/);
  if (m) return `Cartão ${m[1]}x`;
  // Último fallback: capitaliza e troca _
  return code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Carrega métodos ativos, agrupados por group_name.
export async function loadActivePaymentMethods() {
  const data = await listPaymentMethods();

  const map = {};
  for (const m of data || []) {
    if (!map[m.group_name]) map[m.group_name] = [];
    map[m.group_name].push(m);
  }
  // Ordena: Asaas → Sem gateway → outros alfabético
  return Object.entries(map).sort(([a], [b]) => {
    if (a === 'Asaas') return -1;
    if (b === 'Asaas') return 1;
    if (a === 'Sem gateway') return -1;
    if (b === 'Sem gateway') return 1;
    return a.localeCompare(b);
  });
}

function normalizedPaymentCode(code) {
  const value = String(code || '').trim().toLowerCase();
  const gatewayAliases = {
    pix_asaas: 'pix',
    boleto_asaas: 'boleto',
    card_asaas_3x: 'card_3x',
    card_asaas_12x: 'card_12x',
  };
  if (gatewayAliases[value]) return gatewayAliases[value];
  if (value === 'card' || value === 'credit') return 'credit_card';
  if (value === 'pix_boleto') return 'pix';
  return value;
}

function candidatePaymentCodes(code) {
  const normalized = normalizedPaymentCode(code);
  if (!normalized) return [];
  const candidates = [normalized];
  const cardMatch = normalized.match(/^card_(\d+)x$/);
  if (cardMatch && cardMatch[1] === '1') candidates.push('credit_card');
  if (normalized === 'credit_card') candidates.push('card_1x');
  if (normalized === 'pix') candidates.push('pix_asaas');
  if (normalized === 'boleto') candidates.push('boleto_asaas');
  return [...new Set(candidates)];
}

export function findPreferredPaymentMethod(methodGroups, preferredCode, fallbackCode = 'pix_manual') {
  const allMethods = (methodGroups || []).flatMap(([, list]) => list || []);
  const byInternalCode = code => allMethods.find(method => normalizedPaymentCode(method.internal_code) === code);

  for (const candidate of candidatePaymentCodes(preferredCode)) {
    const exact = allMethods.find(method => method.internal_code === candidate);
    if (exact) return exact;
    const normalized = byInternalCode(candidate);
    if (normalized) return normalized;
  }

  return byInternalCode(fallbackCode) || allMethods[0] || null;
}

// Preview usado pelo formulário. O backend recalcula a mesma projeção e é a
// fonte de verdade no momento da gravação.
function addDaysLocal(yyyymmdd, days) {
  const [year, month, day] = yyyymmdd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function projectInstallments(methodConfig, paymentDate) {
  if (!methodConfig || !paymentDate) return [];
  const installments = Math.max(1, Math.min(12, Number(methodConfig.installments) || 1));
  const firstOffset = Number(methodConfig.credit_days_first) || 0;
  const nextOffset = Number(methodConfig.credit_days_between) || 32;
  const projection = [];
  let previousDate = paymentDate;

  for (let number = 1; number <= installments; number += 1) {
    const rawDate = addDaysLocal(previousDate, number === 1 ? firstOffset : nextOffset);
    const creditDate = nextBusinessDay(rawDate);
    projection.push({
      number,
      total: installments,
      due_date: creditDate,
      credit_date: creditDate,
    });
    previousDate = creditDate;
  }

  return projection;
}

// Registra o pagamento e suas parcelas em uma única transação no backend.
export async function createManualInstallments(methodConfig, paymentDate, orderRef, totalValue) {
  if (!methodConfig) throw new Error('Método de pagamento obrigatório');
  if (!paymentDate)  throw new Error('Data de pagamento obrigatória');
  if (!orderRef?.order_id || !orderRef?.order_type) throw new Error('order_id e order_type obrigatórios');

  return recordManualPaymentViaApi(orderRef.order_type, orderRef.order_id, {
    paymentMethodId: methodConfig.id,
    paymentDate,
    total: Number(totalValue) || 0,
  });
}

// Recalcula proporcionalmente os valores das parcelas manuais de um pedido
// quando o total_value muda (ex: cancelamento parcial de item, mudança de desconto).
// - Só toca em source='manual' (Asaas real é gerenciado pelo gateway/webhook)
// - Mantém o número de parcelas e as datas de crédito originais
// - Recalcula value e net_value pelo mesmo valor
//
// orderRef = { order_id, order_type }
// O backend lê o total atual da própria venda para não confiar no navegador.
export async function adjustManualInstallmentsValue(orderRef, adjustment) {
  if (!orderRef?.order_id || !orderRef?.order_type) return { adjusted: false };
  return adjustManualPaymentViaApi(orderRef.order_type, orderRef.order_id, adjustment);
}

export async function reopenManualPayment(orderRef) {
  if (!orderRef?.order_id || !orderRef?.order_type) {
    throw new Error('order_id e order_type obrigatórios');
  }
  return reopenManualPaymentViaApi(orderRef.order_type, orderRef.order_id);
}
