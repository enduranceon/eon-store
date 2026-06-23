import { Link } from 'react-router-dom';
import {
  TrendingUp, Users, Ticket, TrendingDown,
  AlertTriangle, Repeat, ArrowUpRight, ArrowDownRight, Minus,
} from 'lucide-react';
import { supabase } from '@/api/db';
import { formatCurrency } from '@/lib/utils';
import { computeAssessmentMetrics } from '@/lib/assessment-metrics';
import { usePageData } from '@/hooks/usePageData';

// Carrega contratos (todos os status) + planos pra calcular os KPIs.
async function loadPulseData() {
  const [contractsRes, plansRes] = await Promise.all([
    supabase.from('assessment_contracts')
      .select('id, customer_id, plan_id, plan_snapshot, status, end_date, created_at, updated_at, cancellation_date, parent_contract_id'),
    supabase.from('assessment_plans').select('id, price_monthly'),
  ]);
  return {
    contracts: contractsRes.data || [],
    plans: plansRes.data || [],
  };
}

function Kpi({ label, value, sub, icon: Icon, iconBg, iconColor, valueColor, trend, to }) {
  const inner = (
    <div className="bg-white border rounded-xl p-3.5 h-full hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className={`p-2 rounded-lg ${iconBg}`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
        {trend && (
          <span className={`flex items-center gap-0.5 text-[11px] font-semibold ${trend.color}`}>
            <trend.Icon className="w-3 h-3" />
            {trend.label}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mt-2.5 leading-tight">{label}</p>
      <p className={`text-xl font-bold mt-0.5 leading-tight ${valueColor || 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{sub}</p>}
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

// Avalia o churn: quanto menor, melhor (verde).
function churnTrend(churnRate) {
  if (churnRate <= 0) return { Icon: Minus, color: 'text-gray-400', label: '0%' };
  if (churnRate < 3)  return { Icon: ArrowDownRight, color: 'text-green-600', label: 'saudável' };
  if (churnRate < 6)  return { Icon: Minus, color: 'text-amber-600', label: 'atenção' };
  return { Icon: ArrowUpRight, color: 'text-red-600', label: 'alto' };
}

// Banda de KPIs executivos da assessoria. Aparece no topo do "Hoje".
export default function BusinessPulse() {
  const { data, loading } = usePageData({
    key: 'business-pulse',
    loader: loadPulseData,
    initialData: { contracts: [], plans: [] },
    tags: ['assessment_contracts', 'assessment_plans'],
    onError: error => console.error('Erro ao carregar pulso do negócio:', error),
  });

  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-white border rounded-xl p-3.5 animate-pulse h-[104px]" />
        ))}
      </div>
    );
  }

  const m = computeAssessmentMetrics(data.contracts, data.plans);

  // Sem contratos de assessoria ainda → não mostra a banda
  if (m.activeContracts === 0 && m.novosNoMes === 0) return null;

  const novosLabel = m.alunosNovos > 0
    ? `+${m.alunosNovos} aluno${m.alunosNovos !== 1 ? 's' : ''} este mês`
    : 'sem novos este mês';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <Kpi
        label="Receita recorrente (MRR)"
        value={formatCurrency(m.mrr)}
        sub={novosLabel}
        icon={TrendingUp}
        iconBg="bg-emerald-50" iconColor="text-emerald-600" valueColor="text-emerald-700"
        to="/assessoria/central-financeira"
      />
      <Kpi
        label="Alunos ativos"
        value={m.activeStudents}
        sub={`${m.activeContracts} contrato${m.activeContracts !== 1 ? 's' : ''} ativo${m.activeContracts !== 1 ? 's' : ''}`}
        icon={Users}
        iconBg="bg-blue-50" iconColor="text-blue-600" valueColor="text-blue-700"
        to="/assessoria/alunos"
      />
      <Kpi
        label="Ticket médio / aluno"
        value={formatCurrency(m.ticketMedio)}
        sub="mensalidade média"
        icon={Ticket}
        iconBg="bg-violet-50" iconColor="text-violet-600" valueColor="text-violet-700"
        to="/assessoria/planos"
      />
      <Kpi
        label="Churn do mês"
        value={`${m.churnRate.toFixed(1)}%`}
        sub={`${m.saidasNoMes} saída${m.saidasNoMes !== 1 ? 's' : ''} · saldo ${m.saldoAlunos >= 0 ? '+' : ''}${m.saldoAlunos}`}
        icon={TrendingDown}
        iconBg="bg-rose-50" iconColor="text-rose-600"
        valueColor={m.churnRate < 3 ? 'text-green-700' : m.churnRate < 6 ? 'text-amber-700' : 'text-red-700'}
        trend={churnTrend(m.churnRate)}
      />
      <Kpi
        label="LTV estimado"
        value={m.ltv != null ? formatCurrency(m.ltv) : '—'}
        sub={m.avgMonths != null ? `~${m.avgMonths.toFixed(0)} meses de permanência` : 'sem saídas p/ calcular'}
        icon={Repeat}
        iconBg="bg-indigo-50" iconColor="text-indigo-600" valueColor="text-indigo-700"
      />
      <Kpi
        label="Inadimplentes"
        value={m.inadimplentes}
        sub={m.inadimplenciaValor > 0 ? `${formatCurrency(m.inadimplenciaValor)}/mês em risco` : 'tudo em dia'}
        icon={AlertTriangle}
        iconBg="bg-amber-50" iconColor="text-amber-600"
        valueColor={m.inadimplentes > 0 ? 'text-amber-700' : 'text-gray-900'}
        to="/assessoria/central-financeira"
      />
    </div>
  );
}
