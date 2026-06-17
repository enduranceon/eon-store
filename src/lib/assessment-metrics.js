// Métricas executivas da assessoria — calculadas a partir de contratos + planos.
// Centraliza a lógica de MRR, churn, ticket médio, LTV e inadimplência pra que
// o Painel e o dashboard "Hoje" mostrem os mesmos números.

import { todayLocalStr, toLocalDateStr, utcToLocalDateStr } from '@/lib/utils';

const ACTIVE_STATUSES = ['active', 'overdue', 'on_leave'];

// Valor mensal de um contrato (mensalidade do plano vinculado).
// Usa o snapshot do plano gravado no contrato quando existir (preserva histórico),
// caindo pro plano vivo se o snapshot não tiver o preço.
function monthlyValue(contract, plansMap) {
  const snap = contract.plan_snapshot;
  if (snap && snap.price_monthly != null) return Number(snap.price_monthly) || 0;
  const plan = plansMap[contract.plan_id];
  return plan ? Number(plan.price_monthly) || 0 : 0;
}

// Recebe contratos (todos os status) + lista de planos.
// Retorna o pacote de KPIs do mês corrente.
export function computeAssessmentMetrics(contracts = [], plans = []) {
  const plansMap = Object.fromEntries(plans.map(p => [p.id, p]));

  const today = todayLocalStr();
  const monthStart = (() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    return toLocalDateStr(d);
  })();
  const in30days = (() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return toLocalDateStr(d);
  })();

  // ── Base ativa ──────────────────────────────────────────────────
  const active = contracts.filter(c => ACTIVE_STATUSES.includes(c.status));
  const overdue = contracts.filter(c => c.status === 'overdue');
  const activeStudentIds = new Set(active.map(c => c.customer_id));

  // ── MRR (receita recorrente mensal) ─────────────────────────────
  const mrr = active.reduce((acc, c) => acc + monthlyValue(c, plansMap), 0);

  // ── Ticket médio (receita mensal ÷ alunos ativos) ───────────────
  const activeStudents = activeStudentIds.size;
  const ticketMedio = activeStudents > 0 ? mrr / activeStudents : 0;

  // ── Movimentação do mês ─────────────────────────────────────────
  const contratosNoMes = contracts.filter(c => utcToLocalDateStr(c.created_at) >= monthStart);
  const novosContratos = contratosNoMes.filter(c => !c.parent_contract_id);
  const renovacoesNoMes = contratosNoMes.filter(c => !!c.parent_contract_id);

  const idsAntesDoMes = new Set(
    contracts.filter(c => utcToLocalDateStr(c.created_at) < monthStart).map(c => c.customer_id)
  );
  const alunosNovosUnicos = new Set(
    novosContratos.filter(c => !idsAntesDoMes.has(c.customer_id)).map(c => c.customer_id)
  );

  // Saídas: contratos cancelados nesse mês (usa cancellation_date se houver)
  const saidasNoMes = contracts.filter(c => {
    if (c.status !== 'cancelled') return false;
    const cancelDate = c.cancellation_date || utcToLocalDateStr(c.updated_at);
    return cancelDate >= monthStart;
  });

  // ── Churn (saídas / base no início do mês) ──────────────────────
  const churnDenom = active.length + saidasNoMes.length;
  const churnRate = churnDenom > 0 ? (saidasNoMes.length / churnDenom) * 100 : 0;

  // ── LTV estimado (ticket médio ÷ churn mensal) ──────────────────
  // Se o churn for ~0, o LTV tende ao infinito → retorna null pra UI tratar.
  const ltv = churnRate > 0 ? ticketMedio / (churnRate / 100) : null;
  // Permanência média estimada em meses (1 / churn mensal)
  const avgMonths = churnRate > 0 ? 100 / churnRate : null;

  // ── Inadimplência (contratos vencidos/atrasados) ────────────────
  const inadimplenciaValor = overdue.reduce((acc, c) => acc + monthlyValue(c, plansMap), 0);

  // ── Contratos vencendo nos próximos 30 dias ─────────────────────
  const expiring = contracts.filter(c =>
    c.status === 'active' && c.end_date >= today && c.end_date <= in30days
  );

  // ── Saldo líquido (novos − saídas) ──────────────────────────────
  const saldoLiquido = novosContratos.length - saidasNoMes.length;

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
    saldoLiquido,
    inadimplentes: overdue.length,
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
      if (c.status === 'draft') continue;
      const start = c.start_date || utcToLocalDateStr(c.created_at);
      if (!start || start > refStr) continue; // ainda não tinha começado

      // Data efetiva de término: cancelamento (se houve) ou fim de vigência
      const cancel = c.status === 'cancelled'
        ? (c.cancellation_date || utcToLocalDateStr(c.updated_at))
        : null;
      const endRef = cancel || c.end_date || null;
      if (endRef && endRef < refStr) continue; // já tinha encerrado antes do mês

      const snap = c.plan_snapshot;
      const monthly = snap && snap.price_monthly != null
        ? Number(snap.price_monthly) || 0
        : (plansMap[c.plan_id] ? Number(plansMap[c.plan_id].price_monthly) || 0 : 0);
      mrr += monthly;
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
