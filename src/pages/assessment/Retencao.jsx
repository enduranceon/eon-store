import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingDown, Users, Clock, Award, BarChart3, AlertTriangle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/api/db';
import { formatCurrency, utcToLocalDateStr, toLocalDateStr } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';

// ─────────────────────────────────────────────────────────────────
// DATA LOADER
// ─────────────────────────────────────────────────────────────────

async function loadData() {
  const [contractsRes, plansRes, coachesRes, modalitiesRes, customersRes] = await Promise.all([
    supabase
      .from('assessment_contracts')
      .select('id, customer_id, coach_id, plan_id, plan_snapshot, status, start_date, end_date, cancellation_date, created_at, updated_at')
      .neq('status', 'draft'),
    supabase.from('assessment_plans').select('id, name, modality_id, price_monthly'),
    supabase.from('assessment_coaches').select('id, name'),
    supabase.from('assessment_modalities').select('id, name'),
    supabase.from('presale_customers').select('id, full_name'),
  ]);
  return {
    contracts: contractsRes.data || [],
    plans: plansRes.data || [],
    coaches: coachesRes.data || [],
    modalities: modalitiesRes.data || [],
    customers: customersRes.data || [],
  };
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

// Returns tenure in months (float) for a cancelled/finished contract
function tenureMonths(c) {
  const start = c.start_date;
  if (!start) return null;
  const endStr = c.cancellation_date || utcToLocalDateStr(c.updated_at);
  if (!endStr) return null;
  const startD = new Date(start + 'T12:00:00');
  const endD = new Date(endStr + 'T12:00:00');
  const days = (endD - startD) / 86400000;
  return Math.max(0, days / 30);
}

// Returns YYYY-MM of when a contract was cancelled/finished
function churnMonth(c) {
  const d = c.cancellation_date || utcToLocalDateStr(c.updated_at);
  return d ? d.slice(0, 7) : null;
}

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'short' })
    .replace('.', '');
}

function last6Months() {
  const result = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push(toLocalDateStr(d).slice(0, 7));
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon: Icon, iconBg, iconColor, valueColor = 'text-gray-900' }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={`p-2.5 rounded-xl shrink-0 ${iconBg}`}>
            <Icon className={`w-5 h-5 ${iconColor}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 font-medium">{label}</p>
            <p className={`text-2xl font-bold mt-0.5 leading-none ${valueColor}`}>{value}</p>
            {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const TENURE_BUCKETS = [
  { label: '< 1 mês',   min: 0,  max: 1 },
  { label: '1-3 meses', min: 1,  max: 3 },
  { label: '3-6 meses', min: 3,  max: 6 },
  { label: '6-12 m',    min: 6,  max: 12 },
  { label: '12m+',      min: 12, max: Infinity },
];

function ChurnTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold text-gray-900 mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ background: p.fill }} />
          <span className="font-semibold text-gray-700">{p.value} saída{p.value !== 1 ? 's' : ''}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────

export default function Retencao() {
  const { data, loading } = usePageData({
    key: 'retencao',
    loader: loadData,
    initialData: { contracts: [], plans: [], coaches: [], modalities: [], customers: [] },
    tags: ['assessment_contracts', 'assessment_plans', 'assessment_coaches', 'assessment_modalities'],
    onError: e => console.error('Retenção:', e),
  });

  const plansMap      = useMemo(() => Object.fromEntries(data.plans.map(p => [p.id, p])), [data.plans]);
  const coachesMap    = useMemo(() => Object.fromEntries(data.coaches.map(c => [c.id, c])), [data.coaches]);
  const modalitiesMap = useMemo(() => Object.fromEntries(data.modalities.map(m => [m.id, m])), [data.modalities]);

  // Active contracts
  const active = useMemo(
    () => data.contracts.filter(c => ['active', 'overdue', 'on_leave'].includes(c.status)),
    [data.contracts]
  );

  // Churned contracts (cancelled or finished)
  const churned = useMemo(
    () => data.contracts.filter(c => ['cancelled', 'finished'].includes(c.status)),
    [data.contracts]
  );

  // Average tenure
  const avgTenure = useMemo(() => {
    const tenures = churned.map(tenureMonths).filter(t => t != null);
    if (!tenures.length) return null;
    return tenures.reduce((a, b) => a + b, 0) / tenures.length;
  }, [churned]);

  // Monthly churn (last 6 months)
  const months6 = useMemo(() => last6Months(), []);
  const monthlyChurn = useMemo(() => {
    const countByMonth = {};
    for (const c of churned) {
      const m = churnMonth(c);
      if (m) countByMonth[m] = (countByMonth[m] || 0) + 1;
    }
    return months6.map(ym => ({
      ym,
      label: monthLabel(ym),
      count: countByMonth[ym] || 0,
    }));
  }, [churned, months6]);

  const recentChurnTotal = monthlyChurn.slice(-3).reduce((s, m) => s + m.count, 0);

  // Churn by coach
  const churnByCoach = useMemo(() => {
    const map = {};
    for (const c of churned) {
      const coachId = c.coach_id;
      if (!coachId) continue;
      if (!map[coachId]) map[coachId] = { coach: coachesMap[coachId], churned: 0, active: 0 };
      map[coachId].churned++;
    }
    for (const c of active) {
      const coachId = c.coach_id;
      if (!coachId) continue;
      if (!map[coachId]) map[coachId] = { coach: coachesMap[coachId], churned: 0, active: 0 };
      map[coachId].active++;
    }
    return Object.values(map)
      .map(e => ({
        ...e,
        total: e.churned + e.active,
        churnRate: (e.churned + e.active) > 0 ? (e.churned / (e.churned + e.active)) * 100 : 0,
      }))
      .sort((a, b) => b.churned - a.churned);
  }, [churned, active, coachesMap]);

  // Churn by modality
  const churnByModality = useMemo(() => {
    const map = {};
    const getModalityId = c => {
      const snap = c.plan_snapshot;
      if (snap?.modality_id) return snap.modality_id;
      return plansMap[c.plan_id]?.modality_id;
    };
    for (const c of churned) {
      const mid = getModalityId(c);
      if (!mid) continue;
      if (!map[mid]) map[mid] = { modality: modalitiesMap[mid], churned: 0, active: 0 };
      map[mid].churned++;
    }
    for (const c of active) {
      const mid = getModalityId(c);
      if (!mid) continue;
      if (!map[mid]) map[mid] = { modality: modalitiesMap[mid], churned: 0, active: 0 };
      map[mid].active++;
    }
    return Object.values(map)
      .map(e => ({
        ...e,
        total: e.churned + e.active,
        churnRate: (e.churned + e.active) > 0 ? (e.churned / (e.churned + e.active)) * 100 : 0,
      }))
      .sort((a, b) => b.churned - a.churned);
  }, [churned, active, plansMap, modalitiesMap]);

  // Permanence histogram
  const permanenceHistogram = useMemo(() => {
    const tenures = churned.map(tenureMonths).filter(t => t != null);
    return TENURE_BUCKETS.map(b => ({
      label: b.label,
      count: tenures.filter(t => t >= b.min && t < b.max).length,
    }));
  }, [churned]);

  const maxHistogram = Math.max(...permanenceHistogram.map(b => b.count), 1);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Retenção & Churn</h1>
        <p className="text-sm text-gray-500 mt-0.5">Análise de saídas e permanência dos alunos</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Alunos ativos"
          value={active.length}
          sub={`${new Set(active.map(c => c.customer_id)).size} alunos únicos`}
          icon={Users}
          iconBg="bg-blue-50" iconColor="text-blue-600" valueColor="text-blue-700"
        />
        <KpiCard
          label="Total de saídas"
          value={churned.length}
          sub={`${recentChurnTotal} nos últimos 3 meses`}
          icon={TrendingDown}
          iconBg="bg-rose-50" iconColor="text-rose-500" valueColor="text-rose-700"
        />
        <KpiCard
          label="Permanência média"
          value={avgTenure != null ? `${avgTenure.toFixed(1)} meses` : '—'}
          sub="dos contratos encerrados"
          icon={Clock}
          iconBg="bg-amber-50" iconColor="text-amber-600" valueColor="text-amber-700"
        />
        <KpiCard
          label="Saídas (3 meses)"
          value={recentChurnTotal}
          sub={`vs ${active.length} ativos`}
          icon={AlertTriangle}
          iconBg="bg-orange-50" iconColor="text-orange-500"
          valueColor={recentChurnTotal > active.length * 0.1 ? 'text-orange-700' : 'text-gray-700'}
        />
      </div>

      {/* Churn mensal */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-rose-500" />
            Saídas por mês (últimos 6 meses)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {monthlyChurn.every(m => m.count === 0) ? (
            <p className="text-sm text-gray-400 text-center py-8">Nenhuma saída registrada nesse período</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthlyChurn} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChurnTooltip />} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={44}>
                  {monthlyChurn.map((entry, i) => (
                    <Cell key={i} fill={entry.count > 0 ? '#f43f5e' : '#fecdd3'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Permanência (histograma) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-gray-900">
              Distribuição de permanência
            </CardTitle>
            <p className="text-xs text-gray-400">Quanto tempo os alunos ficaram antes de sair</p>
          </CardHeader>
          <CardContent>
            {churned.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">Sem dados de saída ainda</p>
            ) : (
              <div className="space-y-2">
                {permanenceHistogram.map(b => (
                  <div key={b.label} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-20 shrink-0">{b.label}</span>
                    <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-rose-400 rounded-full transition-all"
                        style={{ width: `${(b.count / maxHistogram) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-gray-700 w-6 text-right">{b.count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Saídas por modalidade */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-gray-900">
              Churn por modalidade
            </CardTitle>
          </CardHeader>
          <CardContent>
            {churnByModality.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">Sem dados</p>
            ) : (
              <div className="space-y-3">
                {churnByModality.map((e, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-gray-800">{e.modality?.name || 'Sem modalidade'}</span>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span>{e.active} ativo{e.active !== 1 ? 's' : ''}</span>
                        <span className="text-rose-600 font-semibold">{e.churned} saída{e.churned !== 1 ? 's' : ''}</span>
                        <span className={`font-bold ${e.churnRate > 30 ? 'text-red-600' : e.churnRate > 15 ? 'text-amber-600' : 'text-green-600'}`}>
                          {e.churnRate.toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${e.churnRate > 30 ? 'bg-red-500' : e.churnRate > 15 ? 'bg-amber-500' : 'bg-green-500'}`}
                        style={{ width: `${Math.min(100, e.churnRate)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Churn por coach */}
      {churnByCoach.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Award className="w-4 h-4 text-blue-500" />
              Retenção por treinador
            </CardTitle>
            <p className="text-xs text-gray-400">Ativos vs. saídas por coach</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left text-xs text-gray-400 font-medium px-5 py-3">Treinador</th>
                    <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Ativos</th>
                    <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Saídas</th>
                    <th className="text-right text-xs text-gray-400 font-medium px-5 py-3">Taxa churn</th>
                  </tr>
                </thead>
                <tbody>
                  {churnByCoach.map((e, i) => (
                    <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 bg-blue-100 rounded-full flex items-center justify-center shrink-0">
                            <Award className="w-3.5 h-3.5 text-blue-600" />
                          </div>
                          <span className="font-medium text-gray-900">{e.coach?.name || 'Sem coach'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-blue-700 font-semibold">{e.active}</td>
                      <td className="px-4 py-3 text-right text-rose-600 font-semibold">{e.churned}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${e.churnRate > 30 ? 'bg-red-500' : e.churnRate > 15 ? 'bg-amber-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(100, e.churnRate)}%` }}
                            />
                          </div>
                          <span className={`text-xs font-bold w-10 text-right ${e.churnRate > 30 ? 'text-red-600' : e.churnRate > 15 ? 'text-amber-600' : 'text-green-600'}`}>
                            {e.churnRate.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de saídas recentes */}
      {churned.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-gray-900">
              Saídas recentes
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left text-xs text-gray-400 font-medium px-5 py-3">Aluno</th>
                    <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Coach</th>
                    <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Permanência</th>
                    <th className="text-right text-xs text-gray-400 font-medium px-5 py-3">Saiu em</th>
                  </tr>
                </thead>
                <tbody>
                  {[...churned]
                    .sort((a, b) => {
                      const da = a.cancellation_date || utcToLocalDateStr(a.updated_at) || '';
                      const db = b.cancellation_date || utcToLocalDateStr(b.updated_at) || '';
                      return db.localeCompare(da);
                    })
                    .slice(0, 15)
                    .map((c, i) => {
                      const customer = data.customers.find(cu => cu.id === c.customer_id);
                      const coach = coachesMap[c.coach_id];
                      const tenure = tenureMonths(c);
                      const exitDate = c.cancellation_date || utcToLocalDateStr(c.updated_at);
                      return (
                        <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                          <td className="px-5 py-3">
                            <Link to={`/assessoria/contratos/${c.id}`} className="font-medium text-gray-900 hover:text-blue-600">
                              {customer?.full_name || '—'}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-gray-500">{coach?.name || '—'}</td>
                          <td className="px-4 py-3 text-right text-amber-700 font-medium">
                            {tenure != null ? `${tenure.toFixed(1)}m` : '—'}
                          </td>
                          <td className="px-5 py-3 text-right text-gray-400 text-xs">
                            {exitDate ? new Date(exitDate + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
