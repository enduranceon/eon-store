// Helpers para registro manual de pagamento usando a configuração payment_methods.
// Gera parcelas projetadas em asaas_payments com source='manual' e status='CONFIRMED'.

import { supabase } from '@/api/db';
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
  const { data, error } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('active', true)
    .order('order_index', { ascending: true });
  if (error) throw error;

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

// Calcula a taxa total em R$ a partir da configuração do método.
export function calcFee(methodConfig, value) {
  if (!methodConfig) return 0;
  const v = Number(value) || 0;
  const pct = Number(methodConfig.fee_percent) || 0;
  const fix = Number(methodConfig.fee_fixed) || 0;
  return (v * pct / 100) + fix;
}

// Adiciona N dias a uma string de data YYYY-MM-DD e retorna no mesmo formato.
function addDaysLocal(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Calcula as datas de cada parcela a partir da data de pagamento + configuração.
// Cada parcela cai N dias depois da anterior (não do pagamento original).
// Se cair em fim de semana ou feriado nacional, joga pro próximo dia útil.
// Retorna array de { number, total, due_date, credit_date }.
export function projectInstallments(methodConfig, paymentDate) {
  if (!methodConfig || !paymentDate) return [];
  const n = Math.max(1, Math.min(12, Number(methodConfig.installments) || 1));
  const first = Number(methodConfig.credit_days_first) || 0;
  const step = Number(methodConfig.credit_days_between) || 32;
  const result = [];
  let lastDate = paymentDate;
  for (let i = 1; i <= n; i++) {
    // Primeira parcela: paymentDate + credit_days_first
    // Demais: parcela anterior + credit_days_between
    const offset = i === 1 ? first : step;
    const raw = addDaysLocal(lastDate, offset);
    const creditDate = nextBusinessDay(raw);
    result.push({
      number: i,
      total: n,
      due_date: creditDate,
      credit_date: creditDate,
    });
    lastDate = creditDate;
  }
  return result;
}

// Cria as N entradas em asaas_payments para um pagamento manual.
// `orderRef` = { order_id, order_type, total_value, external_reference (opcional) }
export async function createManualInstallments(methodConfig, paymentDate, orderRef, totalValue) {
  if (!methodConfig) throw new Error('Método de pagamento obrigatório');
  if (!paymentDate)  throw new Error('Data de pagamento obrigatória');
  if (!orderRef?.order_id || !orderRef?.order_type) throw new Error('order_id e order_type obrigatórios');

  const totalV = Number(totalValue) || 0;
  const parcels = projectInstallments(methodConfig, paymentDate);
  const { data, error } = await supabase.rpc('record_manual_payment', {
    p_order_type: orderRef.order_type,
    p_order_id: orderRef.order_id,
    p_payment_method_id: methodConfig.id,
    p_payment_date: paymentDate,
    p_total: totalV,
    p_installments: parcels,
  });
  if (error) throw error;
  return data;
}

// Recalcula proporcionalmente os valores das parcelas manuais de um pedido
// quando o total_value muda (ex: cancelamento parcial de item, mudança de desconto).
// - Só toca em source='manual' (Asaas real é gerenciado pelo gateway/webhook)
// - Mantém o número de parcelas e as datas de crédito originais
// - Recalcula value e net_value proporcionalmente, preservando a taxa%
//
// orderRef = { order_id, order_type }
// newTotalValue = novo valor bruto total do pedido
//
// Retorna { adjusted: bool, installments: N, new_value_per_inst, new_net_per_inst }
export async function adjustManualInstallmentsValue(orderRef, newTotalValue) {
  if (!orderRef?.order_id || !orderRef?.order_type) return { adjusted: false };
  const newTotal = Math.max(0, Number(newTotalValue) || 0);

  // Busca parcelas manuais atuais
  const { data: rows, error: fetchErr } = await supabase
    .from('asaas_payments')
    .select('id, value, net_value, payment_method_id')
    .eq('order_id', orderRef.order_id)
    .eq('order_type', orderRef.order_type)
    .eq('source', 'manual')
    .in('status', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

  if (fetchErr || !rows?.length) return { adjusted: false };

  const n = rows.length;
  if (newTotal === 0) {
    // Cancelamento total — marca como CANCELLED em vez de ajustar
    await supabase.from('asaas_payments')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .in('id', rows.map(r => r.id));
    return { adjusted: true, installments: n, cancelled: true };
  }

  // Calcula a taxa% proporcional original (mesma para todas as parcelas)
  const oldGrossTotal = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const oldNetTotal   = rows.reduce((s, r) => s + (Number(r.net_value) || 0), 0);
  const feeRate = oldGrossTotal > 0 ? (oldGrossTotal - oldNetTotal) / oldGrossTotal : 0;

  const newPerInst    = Math.round((newTotal / n) * 100) / 100;
  const newNetPerInst = Math.round((newTotal / n) * (1 - feeRate) * 100) / 100;

  // Atualiza cada linha (preserva datas, ID, método)
  for (const r of rows) {
    await supabase.from('asaas_payments')
      .update({
        value:      newPerInst,
        net_value:  newNetPerInst,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id);
  }

  return {
    adjusted: true,
    installments: n,
    new_value_per_inst: newPerInst,
    new_net_per_inst:   newNetPerInst,
  };
}
