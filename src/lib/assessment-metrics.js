// Métricas executivas da assessoria — calculadas a partir da camada central
// de lifecycle dos contratos. Isso evita que cada tela interprete "cancelado",
// "descartado", "troca de plano" e "estorno" de um jeito diferente.

import { todayLocalStr, toLocalDateStr, utcToLocalDateStr } from '@/lib/utils';
import {
  buildContractLifecycleRows,
  getContractMonthlyValue,
  getLifecycleMonthStart,
  isContractPaymentOverdue,
  isContractVoidedSale,
} from '@/lib/assessment-contract-lifecycle';

// Recebe contratos (todos os status) + lista de planos.
// Retorna o pacote de KPIs do mês corrente.
export function computeAssessmentMetrics(contracts = [], plans = []) {
  const plansMap = Object.fromEntries(plans.map(p => [p.id, p]));

  const today = todayLocalStr();
  const monthStart = getLifecycleMonthStart();
  const in30days = (() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return toLocalDateStr(d);
  })();
  const lifecycleRows = buildContractLifecycleRows(contracts, { monthStart, plansById: plansMap });

  // ── Base ativa ──────────────────────────────────────────────────
  const active = lifecycleRows.filter(c => c.lifecycle.counts.active);
  const overdue = active.filter(c => isContractPaymentOverdue(c, today));
  const overdueStudentIds = new Set(overdue.map(c => c.customer_id).filter(Boolean));
  const activeStudentIds = new Set(active.map(c => c.customer_id));

  // ── MRR (receita recorrente mensal) ─────────────────────────────
  const mrr = active.reduce((acc, c) => acc + (c.monthly || 0), 0);

  // ── Ticket médio (receita mensal ÷ alunos ativos) ───────────────
  const activeStudents = activeStudentIds.size;
  const ticketMedio = activeStudents > 0 ? mrr / activeStudents : 0;

  // ── Movimentação do mês ─────────────────────────────────────────
  const novosContratos = lifecycleRows.filter(c => c.lifecycle.counts.entry);
  const renovacoesNoMes = lifecycleRows.filter(c => c.lifecycle.counts.renewal);

  const idsAntesDoMes = new Set(
    lifecycleRows
      .filter(c =>
        (c.lifecycle.createdLocal || utcToLocalDateStr(c.created_at)) < monthStart &&
        !['pending_sale', 'voided_sale'].includes(c.lifecycle.type)
      )
      .map(c => c.customer_id)
  );
  const alunosNovosUnicos = new Set(
    novosContratos.filter(c => !idsAntesDoMes.has(c.customer_id)).map(c => c.customer_id)
  );

  // Saídas reais: somente encerramento real do aluno, não troca de plano ou ajuste financeiro.
  const saidasNoMes = lifecycleRows.filter(c =>
    c.lifecycle.counts.exit && c.lifecycle.cancelDate >= monthStart
  );

  // ── Churn (saídas / base no início do mês) ──────────────────────
  const churnDenom = active.length + saidasNoMes.length;
  const churnRate = churnDenom > 0 ? (saidasNoMes.length / churnDenom) * 100 : 0;

  // ── LTV estimado (ticket médio ÷ churn mensal) ──────────────────
  // Se o churn for ~0, o LTV tende ao infinito → retorna null pra UI tratar.
  const ltv = churnRate > 0 ? ticketMedio / (churnRate / 100) : null;
  // Permanência média estimada em meses (1 / churn mensal)
  const avgMonths = churnRate > 0 ? 100 / churnRate : null;

  // ── Inadimplência financeira: cobrança vencida em contrato ativo ─
  const inadimplenciaValor = overdue.reduce((acc, c) => acc + (c.value || c.monthly || 0), 0);

  // ── Contratos vencendo nos próximos 30 dias ─────────────────────
  const expiring = lifecycleRows.filter(c =>
    c.lifecycle.counts.active && c.status === 'active' && c.end_date >= today && c.end_date <= in30days
  );

  // ── Saldo de alunos (novos − saídas) ────────────────────────────
  const saldoAlunos = alunosNovosUnicos.size - saidasNoMes.length;

  return {
    mrr,
    plansMap,
    activeContracts: active.length,
    activeStudents,
    ticketMedio,
    churnRate,
    ltv,
    avgMonths,
    novosNoMes: novosContratos.length,
    alunosNovos: alunosNovosUnicos.size,
    renovacoesNoMes: renovacoesNoMes.length,
    saidasNoMes: saidasNoMes.length,
    saldoAlunos,
    inadimplentes: overdueStudentIds.size,
    inadimplenciaValor,
    expiring: expiring.length,
  };
}

// Reconstrói o MRR histórico dos últimos N meses a partir das datas dos contratos.
// Para cada mês, considera "ativo" o contrato cuja vigência (start_date → end_date,
// ou cancelamento, o que vier primeiro) cobre o último dia daquele mês.
// É uma aproximação — não temos snapshot mensal — mas dá a tendência de crescimento.
export function computeMrrHistory(contracts = [], plans = [], months = 6) {
  const plansMap = Object.fromEntries(plans.map(p => [p.id, p]));

  const series = [];
  const base = new Date(); base.setDate(1);

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    // último dia do mês de referência
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const refStr = toLocalDateStr(monthEnd);
    const ym = refStr.slice(0, 7);

    let mrr = 0;
    let count = 0;
    for (const c of contracts) {
      if (c.status === 'draft' || c.status === 'scheduled' || isContractVoidedSale(c)) continue;
      const start = c.start_date || utcToLocalDateStr(c.created_at);
      if (!start || start > refStr) continue; // ainda não tinha começado

      // Data efetiva de término: cancelamento (se houve) ou fim de vigência
      const cancel = c.status === 'cancelled'
        ? (c.cancellation_date || utcToLocalDateStr(c.updated_at))
        : null;
      const endRef = cancel || c.end_date || null;
      if (endRef && endRef < refStr) continue; // já tinha encerrado antes do mês

      mrr += getContractMonthlyValue(c, plansMap);
      count += 1;
    }

    series.push({
      ym,
      month: monthEnd.toLocaleString('pt-BR', { month: 'short' }).replace('.', ''),
      mrr,
      count,
    });
  }

  return series;
}
