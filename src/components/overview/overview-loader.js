// Leitura da Visão geral. Só consulta: abrir, atualizar ou trocar de ano não
// grava contrato, pagamento, mensagem nem estorno, e não chama o Asaas.
//
// Cada bloco carrega e falha sozinho (status "ok" ou "error"): um erro no caixa
// não derruba a assessoria, e um erro nunca vira lista vazia com total zero.

import { supabase } from '@/api/db';
import { listCommunicationCases, listFinancialMovements } from '@/api/client';
import { fetchAllPages } from '@/lib/fetch-all-pages';
import { loadAssessmentMetricContracts, loadAssessmentMetricPlans } from '@/lib/assessment-metric-data';
import { financialMovementDate } from '@/lib/financial-dashboard';
import { loadOpenSalesOrders, selectActiveOpenOrders } from '@/lib/open-sales-source';
import { buildAttentionGroups } from '@/lib/overview-attention';
import { buildYearCash } from '@/lib/overview-cash';
import { summarizeOpenSales } from '@/lib/overview-overdue';
import { buildOverviewStudents } from '@/lib/overview-students';

const MOVEMENTS_LIMIT = 20000;

function localDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

async function settle(promise) {
  try {
    return { status: 'ok', data: await promise };
  } catch (error) {
    console.error('[Visão geral] Erro ao carregar bloco:', error);
    return { status: 'error', error: error?.message || 'Não foi possível carregar.' };
  }
}

function check(result) {
  if (result?.error) throw result.error;
  return result?.data ?? [];
}

async function loadStudents(today) {
  const [contracts, plans, modalitiesRes, customersRes] = await Promise.all([
    loadAssessmentMetricContracts(supabase),
    loadAssessmentMetricPlans(supabase),
    supabase.from('assessment_modalities').select('id, name'),
    fetchAllPages(() => supabase.from('presale_customers').select('id, full_name').order('id', { ascending: true })),
  ]);
  return buildOverviewStudents({
    contracts,
    plans,
    modalities: check(modalitiesRes),
    customers: check(customersRes),
    today,
  });
}

// Mesma fonte e mesmo filtro da lista de Cobranças.
async function loadOpenSales(today, now) {
  const sevenMonthsAgo = new Date(now);
  sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
  sevenMonthsAgo.setDate(1);
  const [orders, receipts] = await Promise.all([
    loadOpenSalesOrders(supabase),
    listFinancialMovements({
      movementKind: 'receipt',
      isActual: true,
      scheduledFrom: localDate(sevenMonthsAgo),
      sort: '-scheduled_on',
    }),
  ]);
  const receiptOrderIds = new Set(receipts.filter(item => item.order_id).map(item => item.order_id));
  return summarizeOpenSales(selectActiveOpenOrders(orders, receiptOrderIds), today);
}

export async function loadCashYear(year, now = new Date()) {
  const [movements, earliest] = await Promise.all([
    listFinancialMovements({
      isActual: true,
      scheduledFrom: `${year}-01-01`,
      scheduledTo: `${year}-12-31`,
      sort: '-scheduled_on',
      limit: MOVEMENTS_LIMIT,
    }),
    listFinancialMovements({ isActual: true, sort: 'scheduled_on', limit: 1 }),
  ]);
  const coverageFrom = earliest[0] ? financialMovementDate(earliest[0]) || null : null;
  const truncated = movements.length >= MOVEMENTS_LIMIT;
  return {
    year,
    movements,
    coverageFrom,
    cash: buildYearCash(movements, { year, now, coverageFrom, truncated }),
  };
}

async function count(query) {
  const { count: total, error } = await query;
  if (error || total == null) throw error || new Error('Contagem indisponível');
  return total;
}

// Cada contagem é independente; a que falhar fica indisponível e é avisada.
async function loadAttentionSources() {
  const [refunds, renewalCharges, contacts] = await Promise.all([
    settle(count(supabase.from('assessment_contracts').select('id', { count: 'exact', head: true }).eq('refund_status', 'pending'))),
    settle(count(supabase.from('assessment_contracts').select('id', { count: 'exact', head: true })
      .not('parent_contract_id', 'is', null).eq('renewal_stage', 'charge_pending'))),
    settle(listCommunicationCases({ state: 'to_do', limit: 1 }).then(page => {
      if (page?.rollout?.enabled === false) return { preparing: true, count: 0 };
      if (!page?.counts) throw new Error('Contagem de contatos indisponível');
      return { preparing: false, count: Number(page.counts.to_do ?? 0) };
    })),
  ]);
  return { refunds, renewalCharges, contacts };
}

export async function loadOverviewBlocks() {
  const now = new Date();
  const today = localDate(now);
  const year = now.getFullYear();
  const [students, openSales, cash, sources] = await Promise.all([
    settle(loadStudents(today)),
    settle(loadOpenSales(today, now)),
    settle(loadCashYear(year, now)),
    loadAttentionSources(),
  ]);

  const unavailable = [];
  if (openSales.status !== 'ok') unavailable.push('cobranças em atraso');
  if (sources.refunds.status !== 'ok') unavailable.push('estornos');
  if (sources.renewalCharges.status !== 'ok') unavailable.push('renovações');
  if (sources.contacts.status !== 'ok') unavailable.push('contatos');
  const contactsPreparing = sources.contacts.status === 'ok' && sources.contacts.data.preparing;

  return {
    generatedAt: now.toISOString(),
    today,
    year,
    students,
    openSales,
    cash,
    attention: {
      groups: buildAttentionGroups({
        overdue: openSales.status === 'ok' ? openSales.data.overdue : undefined,
        refunds: sources.refunds.status === 'ok' ? sources.refunds.data : undefined,
        renewalCharges: sources.renewalCharges.status === 'ok' ? sources.renewalCharges.data : undefined,
        contacts: sources.contacts.status === 'ok' && !contactsPreparing ? sources.contacts.data.count : undefined,
      }),
      unavailable,
      contactsPreparing,
    },
  };
}
