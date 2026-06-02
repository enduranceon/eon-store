// Helpers para registro manual de pagamento usando a configuração payment_methods.
// Gera parcelas projetadas em asaas_payments com source='manual' e status='CONFIRMED'.

import { supabase } from '@/api/db';

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
// Retorna array de { number, total, due_date, credit_date }.
export function projectInstallments(methodConfig, paymentDate) {
  if (!methodConfig || !paymentDate) return [];
  const n = Math.max(1, Math.min(12, Number(methodConfig.installments) || 1));
  const first = Number(methodConfig.credit_days_first) || 0;
  const step = Number(methodConfig.credit_days_between) || 30;
  const result = [];
  for (let i = 1; i <= n; i++) {
    const offset = first + (i - 1) * step;
    const creditDate = addDaysLocal(paymentDate, offset);
    result.push({
      number: i,
      total: n,
      due_date: creditDate,
      credit_date: creditDate,
    });
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
  const fee = calcFee(methodConfig, totalV);
  const netTotal = Math.max(0, totalV - fee);

  const parcels = projectInstallments(methodConfig, paymentDate);
  const valuePerInst = totalV / parcels.length;
  const netPerInst = netTotal / parcels.length;

  // Limpa parcelas anteriores antes de re-inserir.
  // - Manuais: sempre deletadas (re-registro substitui)
  // - Asaas PENDING/OVERDUE: deletadas (cliente pagou por fora; cobrança Asaas pendente
  //   é descartada para evitar duplicação caso o webhook chegue depois)
  // - Asaas RECEIVED/CONFIRMED: PROTEGIDAS (Asaas já recebeu de verdade; nesse caso
  //   o front deveria ter bloqueado o registro manual)
  await supabase.from('asaas_payments')
    .delete()
    .eq('order_id', orderRef.order_id)
    .eq('order_type', orderRef.order_type)
    .eq('source', 'manual');

  await supabase.from('asaas_payments')
    .delete()
    .eq('order_id', orderRef.order_id)
    .eq('order_type', orderRef.order_type)
    .eq('source', 'asaas')
    .in('status', ['PENDING', 'OVERDUE']);

  const rows = parcels.map(p => ({
    asaas_payment_id:    `manual_${orderRef.order_id}_${p.number}_${Date.now()}`,
    source:              'manual',
    payment_method_id:   methodConfig.id,
    installment_number:  p.number,
    total_installments:  p.total,
    billing_type:        methodConfig.kind?.toUpperCase() || null,
    status:              'CONFIRMED',
    value:               Math.round(valuePerInst * 100) / 100,
    net_value:           Math.round(netPerInst * 100) / 100,
    due_date:            p.due_date,
    credit_date:         p.credit_date,
    payment_date:        paymentDate,
    description:         `Pagamento manual — ${methodConfig.name}${parcels.length > 1 ? ` (parcela ${p.number}/${p.total})` : ''}`,
    external_reference:  orderRef.external_reference || null,
    order_id:            orderRef.order_id,
    order_type:          orderRef.order_type,
    raw:                 null,
    last_synced_at:      new Date().toISOString(),
  }));

  const { error } = await supabase.from('asaas_payments').insert(rows);
  if (error) throw error;

  return {
    installments: parcels.length,
    total_gross: totalV,
    total_fee:   Math.round(fee * 100) / 100,
    total_net:   Math.round(netTotal * 100) / 100,
    value_per_installment: Math.round(valuePerInst * 100) / 100,
  };
}
