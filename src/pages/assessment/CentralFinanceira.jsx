import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, TrendingUp, AlertTriangle, RefreshCw,
  Award, ChevronRight, UserPlus, UserMinus, Activity,
  Calendar, CheckCircle2, Clock, BarChart3, Wallet,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { cn } from '@/lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  buildContractLifecycleRows,
  getLifecycleMonthStart,
} from '@/lib/assessment-contract-lifecycle';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'short' })
    .replace('.', '');
}

function fullMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'long' });
}

function monthEndDate(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
}

function nextNMonths(n) {
  const today = new Date(); today.setDate(1);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    return toLocalDateStr(d).slice(0, 7);
  });
}

const MONTHS = nextNMonths(6);

// ─────────────────────────────────────────────────────────────────
// COMPONENTES AUXILIARES
// ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon: Icon, iconBg, iconColor, valueColor = 'text-gray-900', accent }) {
  return (
    <Card className={cn('border', accent)}>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={cn('p-2.5 rounded-xl shrink-0', iconBg)}>
            <Icon className={cn('w-5 h-5', iconColor)} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 font-medium truncate">{label}</p>
            <p className={cn('text-2xl font-bold mt-0.5 leading-none', valueColor)}>{value}</p>
            {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const URGENCY = {
  expired:  { cls: 'bg-red-50 border-red-200',     badge: 'bg-red-100 text-red-700' },
  critical: { cls: 'bg-orange-50 border-orange-200', badge: 'bg-orange-100 text-orange-700' },
  warning:  { cls: 'bg-amber-50 border-amber-200',  badge: 'bg-amber-100 text-amber-700' },
  normal:   { cls: 'bg-white border-gray-100',      badge: 'bg-green-100 text-green-700' },
};

function ContractExpirationRow({ contract }) {
  const u = URGENCY[contract.urgency];
  const daysLabel =
    contract.daysLeft < 0  ? `Venceu há ${Math.abs(contract.daysLeft)}d` :
    contract.daysLeft === 0 ? 'Vence hoje' :
    contract.daysLeft === 1 ? 'Amanhã' :
    `${contract.daysLeft} dias`;

  return (
    <Link
      to={`/assessoria/contratos/${contract.id}`}
      className={cn('flex items-center gap-3 p-3 rounded-lg border mb-1.5 hover:shadow-sm transition-shadow', u.cls)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-gray-900 truncate">
            {contract.customer?.full_name || '—'}
          </span>
          <span className="text-xs text-gray-400">#{contract.contract_number}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {contract.coach && <span className="text-xs text-gray-500">{contract.coach.name}</span>}
          {contract.modality && <span className="text-xs text-gray-400">· {contract.modality.name}</span>}
        </div>
      </div>
      <div className="text-right shrink-0">
        <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full', u.badge)}>{daysLabel}</span>
        <p className="text-xs text-gray-400 mt-0.5">{formatDate(contract.end_date)}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
    </Link>
  );
}

const PAID_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);

function CoachCard({ entry }) {
  const pct = entry.total > 0 ? (entry.received / entry.total) * 100 : 0;
  const days = Object.entries(entry.byDay).sort(([a], [b]) => Number(a) - Number(b));
  const maxDay = Math.max(...days.map(([, v]) => v), 1);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center shrink-0">
              <Award className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="font-semibold text-sm text-gray-900">{entry.coach?.name || 'Sem coach'}</p>
              <p className="text-xs text-gray-500">{entry.contracts} contrato{entry.contracts !== 1 ? 's' : ''} ativo{entry.contracts !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-bold text-gray-900">{formatCurrency(entry.total)}</p>
            <p className="text-xs text-gray-500">esperado</p>
          </div>
        </div>

        <div className="mb-3">
          <div className="flex justify-between text-xs mb-1">
            <span className="text-green-600 font-medium">{formatCurrency(entry.received)} recebido</span>
            <span className="text-gray-400">{pct.toFixed(0)}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          {entry.pending > 0 && <p className="text-xs text-amber-600 mt-1">{formatCurrency(entry.pending)} pendente</p>}
        </div>

        {days.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 mb-1.5">Distribuição no mês</p>
            <div className="flex items-end gap-0.5 h-8">
              {days.map(([day, val]) => (
                <div
                  key={day}
                  className="flex-1 h-full flex flex-col justify-end"
                  title={`Dia ${day}: ${formatCurrency(val)}`}
                >
                  <div
                    className="w-full bg-blue-300 rounded-sm"
                    style={{ height: `${(val / maxDay) * 100}%`, minHeight: 2 }}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-gray-300 mt-0.5">
              <span>{days[0]?.[0]}</span>
              <span>{days[days.length - 1]?.[0]}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ForecastTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold text-gray-900 mb-1 capitalize">{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ background: p.fill }} />
          <span className="text-gray-600">{p.name}:</span>
          <span className="font-semibold">{formatCurrency(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// PÁGINA PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export default function CentralFinanceira() {
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState({
    contracts: [], plans: [], modalities: [], coaches: [],
    customers: [], payments: [], todayStr: todayLocalStr(),
  });

  const load = useCallback(async () => {
    const todayStr = todayLocalStr();
    const rangeStart = MONTHS[0] + '-01';
    const rangeEnd   = monthEndDate(MONTHS[MONTHS.length - 1]);

    const [contractsRes, plansRes, modalitiesRes, coachesRes, customersRes, paymentsRes] = await Promise.all([
      supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, status, payment_status, payment_date, manual_payment, start_date, end_date, due_date, created_at, updated_at, parent_contract_id, cancellation_date, cancellation_fee, cancellation_reason, refund_status, refund_amount, enrollment_fee, manual_discount, credit_balance, plan_snapshot, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link')
        .neq('status', 'draft')
        .order('created_at', { ascending: false }),
      supabase.from('assessment_plans').select('id, name, price_monthly, price_total, period, period_months, modality_id'),
      supabase.from('assessment_modalities').select('id, name'),
      supabase.from('assessment_coaches').select('id, name, email'),
      supabase.from('presale_customers').select('id, full_name'),
      supabase
        .from('asaas_payments')
        .select('id, order_id, order_type, credit_date, value, status, source')
        .eq('order_type', 'contract')
        .gte('credit_date', rangeStart)
        .lte('credit_date', rangeEnd)
        .neq('status', 'CANCELLED'),
    ]);

    setData({
      contracts: contractsRes.data || [],
      plans:     plansRes.data || [],
      modalities: modalitiesRes.data || [],
      coaches:   coachesRes.data || [],
      customers: customersRes.data || [],
      payments:  paymentsRes.data || [],
      todayStr,
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      load().catch(console.error).finally(() => setLoading(false));
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load().catch(console.error);
    setRefreshing(false);
  };

  // ── Mapas de lookup ──────────────────────────────────────────
  const planMap     = useMemo(() => Object.fromEntries(data.plans.map(p     => [p.id, p])), [data.plans]);
  const coachMap    = useMemo(() => Object.fromEntries(data.coaches.map(c   => [c.id, c])), [data.coaches]);
  const customerMap = useMemo(() => Object.fromEntries(data.customers.map(c => [c.id, c])), [data.customers]);
  const modalityMap = useMemo(() => Object.fromEntries(data.modalities.map(m => [m.id, m])), [data.modalities]);
  const lifecycleMonthStart = useMemo(
    () => getLifecycleMonthStart(new Date(`${data.todayStr}T12:00:00`)),
    [data.todayStr]
  );
  const lifecycleRows = useMemo(
    () => buildContractLifecycleRows(data.contracts, {
      monthStart: lifecycleMonthStart,
      plansById: planMap,
      studentsById: customerMap,
      coachesById: coachMap,
      modalitiesById: modalityMap,
    }),
    [data.contracts, lifecycleMonthStart, planMap, customerMap, coachMap, modalityMap]
  );
  const contractMap = useMemo(() => Object.fromEntries(lifecycleRows.map(c => [c.id, c])), [lifecycleRows]);

  // ── KPIs ────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const curMonthKey = data.todayStr.slice(0, 7);
    const active = lifecycleRows.filter(c => c.lifecycle?.counts?.active);
    const overdueCount = active.filter(c => c.status === 'overdue').length;

    const newThisMonth = lifecycleRows.filter(c => c.lifecycle?.counts?.entry);
    const exitsThisMonth = lifecycleRows.filter(c =>
      c.lifecycle?.counts?.exit &&
      c.lifecycle?.cancelDate?.slice(0, 7) === curMonthKey
    );

    const mrr = active.reduce((sum, c) => sum + (Number(c.monthly) || 0), 0);

    const churnPct = (active.length + exitsThisMonth.length) > 0
      ? (exitsThisMonth.length / (active.length + exitsThisMonth.length)) * 100
      : 0;

    const guaranteedThisMonth = data.payments
      .filter(p => p.credit_date?.slice(0, 7) === curMonthKey)
      .reduce((sum, p) => sum + (Number(p.value) || 0), 0);

    return { active: active.length, overdueCount, newThisMonth: newThisMonth.length, exitsThisMonth: exitsThisMonth.length, mrr, churnPct, guaranteedThisMonth };
  }, [data.payments, data.todayStr, lifecycleRows]);

  // ── Previsão de receita ──────────────────────────────────────
  const forecastData = useMemo(() => {
    return MONTHS.map(yyyymm => {
      const monthStart = yyyymm + '-01';
      const end        = monthEndDate(yyyymm);

      const guaranteed = data.payments
        .filter(p => p.credit_date?.slice(0, 7) === yyyymm)
        .reduce((sum, p) => sum + (Number(p.value) || 0), 0);

      const projected = lifecycleRows
        .filter(c => c.lifecycle?.counts?.active)
        .filter(c => c.start_date <= end && (c.end_date || '9999-12-31') >= monthStart)
        .reduce((sum, c) => sum + (Number(c.monthly) || 0), 0);

      return {
        month: yyyymm,
        label: monthLabel(yyyymm),
        fullLabel: fullMonthLabel(yyyymm),
        guaranteed,
        projected,
      };
    });
  }, [data.payments, lifecycleRows]);

  // ── Scoreboard por coach (mês atual) ────────────────────────
  const coachScoreboard = useMemo(() => {
    const curMonthKey = data.todayStr.slice(0, 7);
    const monthPayments = data.payments.filter(p => p.credit_date?.slice(0, 7) === curMonthKey);
    const activeContracts = lifecycleRows.filter(c => c.lifecycle?.counts?.active);

    const coachContractCount = {};
    activeContracts
      .forEach(c => {
        if (c.coach_id) coachContractCount[c.coach_id] = (coachContractCount[c.coach_id] || 0) + 1;
      });

    const coachData = {};

    // Preenche dados de coaches com contratos ativos (mesmo sem pagamentos registrados)
    activeContracts
      .filter(c => c.coach_id)
      .forEach(c => {
        if (!coachData[c.coach_id]) {
          coachData[c.coach_id] = {
            coach: coachMap[c.coach_id],
            contracts: coachContractCount[c.coach_id] || 0,
            total: 0, received: 0, pending: 0, byDay: {},
          };
        }
        coachData[c.coach_id].total += Number(c.monthly) || 0;
      });

    for (const payment of monthPayments) {
      const contract = contractMap[payment.order_id];
      if (!contract?.coach_id) continue;
      const coachId = contract.coach_id;

      if (!coachData[coachId]) {
        coachData[coachId] = {
          coach: coachMap[coachId],
          contracts: coachContractCount[coachId] || 0,
          total: 0, received: 0, pending: 0, byDay: {},
        };
      }

      const amount = Number(payment.value) || 0;
      if (PAID_STATUSES.has(payment.status)) coachData[coachId].received += amount;

      const day = payment.credit_date.slice(8, 10);
      coachData[coachId].byDay[day] = (coachData[coachId].byDay[day] || 0) + amount;
    }

    return Object.values(coachData)
      .map(entry => ({ ...entry, pending: Math.max(0, entry.total - entry.received) }))
      .sort((a, b) => b.total - a.total);
  }, [data.payments, data.todayStr, lifecycleRows, contractMap, coachMap]);

  // ── Contratos ativos ordenados por vencimento ────────────────
  const activeContractsSorted = useMemo(() => {
    const today = new Date(data.todayStr + 'T12:00:00');

    return lifecycleRows
      .filter(c => c.lifecycle?.counts?.active)
      .map(c => {
        const plan     = c.plan || planMap[c.plan_id];
        const modality = c.modality || modalityMap[plan?.modality_id];
        const coach    = c.coach || coachMap[c.coach_id];
        const customer = c.student || customerMap[c.customer_id];

        const endDate  = c.end_date ? new Date(c.end_date + 'T12:00:00') : null;
        const daysLeft = endDate ? Math.round((endDate - today) / 86400000) : 9999;

        let urgency = 'normal';
        if (daysLeft < 0)        urgency = 'expired';
        else if (daysLeft <= 7)  urgency = 'critical';
        else if (daysLeft <= 30) urgency = 'warning';

        return { ...c, plan, modality, coach, customer, daysLeft, urgency };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [data.todayStr, lifecycleRows, planMap, modalityMap, coachMap, customerMap]);

  const urgentContracts  = activeContractsSorted.filter(c => ['expired', 'critical'].includes(c.urgency));
  const warningContracts = activeContractsSorted.filter(c => c.urgency === 'warning');
  const normalContracts  = activeContractsSorted.filter(c => c.urgency === 'normal');

  // ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const curMonthKey  = data.todayStr.slice(0, 7);
  const curMonthFull = fullMonthLabel(curMonthKey);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Central Financeira</h1>
          <p className="text-sm text-gray-500 mt-0.5 capitalize">{curMonthFull} · Assessoria Esportiva</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          Atualizar
        </Button>
      </div>

      {/* ── KPIs ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          label="Alunos ativos"
          value={kpis.active}
          sub={kpis.overdueCount > 0 ? `${kpis.overdueCount} em atraso` : undefined}
          icon={Users} iconBg="bg-blue-50" iconColor="text-blue-600" valueColor="text-blue-700"
        />
        <KpiCard
          label="Entradas no mês"
          value={kpis.newThisMonth}
          icon={UserPlus} iconBg="bg-green-50" iconColor="text-green-600"
          valueColor={kpis.newThisMonth > 0 ? 'text-green-700' : 'text-gray-500'}
        />
        <KpiCard
          label="Saídas no mês"
          value={kpis.exitsThisMonth}
          icon={UserMinus} iconBg="bg-red-50" iconColor="text-red-500"
          valueColor={kpis.exitsThisMonth > 0 ? 'text-red-600' : 'text-gray-500'}
        />
        <KpiCard
          label="MRR"
          value={formatCurrency(kpis.mrr)}
          sub="receita mensal recorrente"
          icon={TrendingUp} iconBg="bg-purple-50" iconColor="text-purple-600" valueColor="text-purple-700"
        />
        <KpiCard
          label="Churn do mês"
          value={`${kpis.churnPct.toFixed(1)}%`}
          icon={Activity}
          iconBg={kpis.churnPct > 5 ? 'bg-red-50' : 'bg-gray-50'}
          iconColor={kpis.churnPct > 5 ? 'text-red-500' : 'text-gray-400'}
          valueColor={kpis.churnPct > 5 ? 'text-red-600' : 'text-gray-600'}
        />
        <KpiCard
          label="Garantido este mês"
          value={formatCurrency(kpis.guaranteedThisMonth)}
          sub="pagamentos registrados"
          icon={Wallet} iconBg="bg-emerald-50" iconColor="text-emerald-600" valueColor="text-emerald-700"
        />
      </div>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {[
          { key: 'overview',   label: 'Previsão de receita', icon: BarChart3 },
          { key: 'coaches',    label: 'Por treinador',       icon: Award },
          { key: 'contratos',  label: 'Contratos ativos',    icon: Calendar },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── TAB: Previsão de receita ──────────────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-gray-900">
                Receita prevista — próximos 6 meses
              </CardTitle>
              <p className="text-sm text-gray-500">
                <strong>Garantido</strong>: pagamentos registrados no sistema ·{' '}
                <strong>Projetado</strong>: baseado nos contratos ativos
              </p>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={forecastData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false}
                    tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  />
                  <Tooltip content={<ForecastTooltip />} />
                  <Bar dataKey="projected" name="Projetado" fill="#dbeafe" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="guaranteed" name="Garantido" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left text-xs text-gray-400 font-medium px-5 py-3">Mês</th>
                      <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Garantido</th>
                      <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Projetado</th>
                      <th className="text-right text-xs text-gray-400 font-medium px-5 py-3">Cobertura</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecastData.map(row => {
                      const coverage = row.projected > 0 ? (row.guaranteed / row.projected) * 100 : 0;
                      const isCurrent = row.month === curMonthKey;
                      return (
                        <tr
                          key={row.month}
                          className={cn('border-b border-gray-50 last:border-0', isCurrent ? 'bg-blue-50/50' : 'hover:bg-gray-50')}
                        >
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-gray-900 capitalize">{row.fullLabel}</span>
                              {isCurrent && (
                                <span className="text-[10px] bg-blue-100 text-blue-700 font-semibold px-1.5 py-0.5 rounded-full">atual</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-semibold text-blue-700">{formatCurrency(row.guaranteed)}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{formatCurrency(row.projected)}</td>
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, coverage)}%` }} />
                              </div>
                              <span className={cn(
                                'text-xs font-medium w-10 text-right',
                                coverage >= 80 ? 'text-green-600' : coverage >= 50 ? 'text-amber-600' : 'text-gray-400'
                              )}>
                                {coverage.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── TAB: Por treinador ───────────────────────────── */}
      {activeTab === 'coaches' && (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-gray-900">
            Recebimentos por treinador — <span className="capitalize">{curMonthFull}</span>
          </h2>

          {coachScoreboard.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-gray-400">
                <Award className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Nenhum dado para este período</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Card className="border-blue-100 bg-blue-50/30">
                  <CardContent className="p-4 flex items-center gap-3">
                    <Wallet className="w-5 h-5 text-blue-500" />
                    <div>
                      <p className="text-xs text-gray-500">Total esperado</p>
                      <p className="font-bold text-blue-700">{formatCurrency(coachScoreboard.reduce((s, e) => s + e.total, 0))}</p>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-green-100 bg-green-50/30">
                  <CardContent className="p-4 flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                    <div>
                      <p className="text-xs text-gray-500">Total recebido</p>
                      <p className="font-bold text-green-700">{formatCurrency(coachScoreboard.reduce((s, e) => s + e.received, 0))}</p>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-amber-100 bg-amber-50/30">
                  <CardContent className="p-4 flex items-center gap-3">
                    <Clock className="w-5 h-5 text-amber-500" />
                    <div>
                      <p className="text-xs text-gray-500">Total pendente</p>
                      <p className="font-bold text-amber-700">{formatCurrency(coachScoreboard.reduce((s, e) => s + e.pending, 0))}</p>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {coachScoreboard.map((entry, i) => (
                  <CoachCard key={entry.coach?.id || i} entry={entry} />
                ))}
              </div>
            </>
          )}

          {/* Calendário tabular */}
          {data.payments.filter(p => p.credit_date?.slice(0, 7) === curMonthKey).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-gray-700">Calendário de recebimentos</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left text-gray-400 font-medium px-4 py-2 whitespace-nowrap">Treinador</th>
                        {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).filter(d =>
                          data.payments.some(p => p.credit_date?.slice(0, 7) === curMonthKey && p.credit_date?.slice(8, 10) === d)
                        ).map(d => (
                          <th key={d} className="text-center text-gray-400 font-medium px-1.5 py-2 min-w-[32px]">{Number(d)}</th>
                        ))}
                        <th className="text-right text-gray-400 font-medium px-4 py-2">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coachScoreboard.filter(e => e.total > 0).map((entry, i) => {
                        const activeDays = Array.from({ length: 31 }, (_, j) => String(j + 1).padStart(2, '0')).filter(d =>
                          data.payments.some(p => p.credit_date?.slice(0, 7) === curMonthKey && p.credit_date?.slice(8, 10) === d)
                        );
                        return (
                          <tr key={entry.coach?.id || i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="px-4 py-2 font-medium text-gray-700 whitespace-nowrap">{entry.coach?.name || 'Sem coach'}</td>
                            {activeDays.map(d => {
                              const val = entry.byDay[d] || 0;
                              return (
                                <td key={d} className="px-1.5 py-2 text-center">
                                  {val > 0
                                    ? <span className="text-blue-700 font-semibold">{val >= 1000 ? `${(val / 1000).toFixed(1)}k` : formatCurrency(val).replace('R$ ', '')}</span>
                                    : <span className="text-gray-200">—</span>
                                  }
                                </td>
                              );
                            })}
                            <td className="px-4 py-2 text-right font-bold text-gray-900">{formatCurrency(entry.total)}</td>
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
      )}

      {/* ── TAB: Contratos ativos ───────────────────────── */}
      {activeTab === 'contratos' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            {[
              { cls: 'bg-red-100 text-red-700',      label: 'Vencido' },
              { cls: 'bg-orange-100 text-orange-700', label: 'Crítico (≤7 dias)' },
              { cls: 'bg-amber-100 text-amber-700',   label: 'Atenção (8-30 dias)' },
              { cls: 'bg-green-100 text-green-700',   label: 'Normal (>30 dias)' },
            ].map(l => (
              <span key={l.label} className={cn('px-2.5 py-1 rounded-full font-medium', l.cls)}>{l.label}</span>
            ))}
          </div>

          {activeContractsSorted.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-gray-400">
                <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Nenhum contrato ativo</p>
              </CardContent>
            </Card>
          )}

          {urgentContracts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-red-600 mb-2 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Vencidos ou expirando em breve ({urgentContracts.length})
              </h3>
              {urgentContracts.map(c => <ContractExpirationRow key={c.id} contract={c} />)}
            </div>
          )}

          {warningContracts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-amber-600 mb-2 flex items-center gap-1.5">
                <Clock className="w-4 h-4" />
                Vencem nos próximos 30 dias ({warningContracts.length})
              </h3>
              {warningContracts.map(c => <ContractExpirationRow key={c.id} contract={c} />)}
            </div>
          )}

          {normalContracts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 mb-2 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                Em dia ({normalContracts.length})
              </h3>
              {normalContracts.map(c => <ContractExpirationRow key={c.id} contract={c} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
