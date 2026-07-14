import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Users, FileText, AlertTriangle, TrendingUp, RefreshCw,
  ChevronRight, CheckCircle2, Clock, XCircle, RotateCcw,
  UserPlus, UserMinus, Activity, Award, TrendingDown,
  Cake,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AssessmentContract, AssessmentPlan, AssessmentModality,
  AssessmentCoach, PreSaleCustomer,
} from '@/api/entities';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { computeMrrHistory } from '@/lib/assessment-metrics';
import {
  buildContractLifecycleRows,
  getLifecycleMonthStart,
  isContractPaymentOverdue,
} from '@/lib/assessment-contract-lifecycle';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { toast } from 'sonner';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';

function periodLabel(plan) {
  const m = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  const names = { 1: '1 mês', 2: '2 meses', 3: '3 meses', 6: '6 meses', 12: '12 meses' };
  return names[m] || `${m} meses`;
}

function calculateAge(birthDate) {
  if (!birthDate) return null;
  const birth = new Date(`${String(birthDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const STATUS_CLS = {
  active:    'bg-green-100 text-green-700',
  overdue:   'bg-red-100 text-red-700',
  on_leave:  'bg-amber-100 text-amber-700',
  finished:  'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-500',
  voided:    'bg-amber-100 text-amber-700',
};
const STATUS_LABEL = {
  active: 'Ativo', overdue: 'Vencido', on_leave: 'Licença',
  finished: 'Concluído', cancelled: 'Cancelado',
  voided: 'Descartado',
};

export default function Painel() {
  const navigate = useNavigate();
  const [contracts,   setContracts]   = useState([]);
  const [plans,       setPlans]       = useState([]);
  const [modalities,  setModalities]  = useState([]);
  const [coaches,     setCoaches]     = useState([]);
  const [customers,   setCustomers]   = useState([]);
  const [loading,     setLoading]     = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Failsafe: nunca trava em "Carregando..." por mais de 10s
    const failsafe = setTimeout(() => {
      console.warn('Painel: timeout 10s — forçando saída do loading');
      setLoading(false);
    }, 10000);
    try {
      const [c, p, m, co, cu] = await Promise.all([
        AssessmentContract.list('-created_at').catch(e => { console.error('contracts:', e); return []; }),
        AssessmentPlan.list().catch(e => { console.error('plans:', e); return []; }),
        AssessmentModality.list().catch(e => { console.error('modalities:', e); return []; }),
        AssessmentCoach.list().catch(e => { console.error('coaches:', e); return []; }),
        PreSaleCustomer.list('full_name').catch(e => { console.error('customers:', e); return []; }),
      ]);

      // Auto-transição:
      // - não renovou: conclui no fim da vigência, sem pendência financeira;
      // - demais contratos vencidos seguem como overdue para revisão/cobrança.
      const nowStr = todayLocalStr();
      const isNonRenewal = (ct) => {
        const reason = (ct.cancellation_reason || '').toLowerCase();
        return reason.includes('não renovou') || reason.includes('nao renovou')
          || reason.includes('não vai renovar') || reason.includes('nao vai renovar');
      };
      const expiredActive = c.filter(ct => ct.status === 'active' && ct.end_date < nowStr);
      const toMarkFinished = expiredActive.filter(isNonRenewal);
      const toMarkOverdue = expiredActive.filter(ct => !isNonRenewal(ct));
      if (toMarkFinished.length > 0) {
        await Promise.allSettled(
          toMarkFinished.map(ct => AssessmentContract.update(ct.id, { status: 'finished' }))
        );
        toMarkFinished.forEach(ct => { ct.status = 'finished'; });
      }
      if (toMarkOverdue.length > 0) {
        await Promise.allSettled(
          toMarkOverdue.map(ct => AssessmentContract.update(ct.id, { status: 'overdue' }))
        );
        toMarkOverdue.forEach(ct => { ct.status = 'overdue'; });
      }

      setContracts(c); setPlans(p); setModalities(m);
      setCoaches(co);  setCustomers(cu);
    } catch (e) {
      console.error('Erro ao carregar Painel:', e);
      toast.error('Erro ao carregar painel: ' + (e.message || 'desconhecido'));
    } finally {
      clearTimeout(failsafe);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const today      = todayLocalStr();
  const inRenewalWindow = (() => {
    const d = new Date(); d.setDate(d.getDate() + RENEWAL_ATTENTION_WINDOW_DAYS);
    return toLocalDateStr(d);
  })();
  const monthStart = getLifecycleMonthStart();
  const monthLabel = new Date().toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
  const plansById = Object.fromEntries(plans.map(p => [p.id, p]));
  const lifecycleRows = buildContractLifecycleRows(contracts, { monthStart, plansById });

  const active     = lifecycleRows.filter(c => c.lifecycle.counts.active);
  const expiring   = lifecycleRows.filter(c => c.lifecycle.counts.active && c.status === 'active' && c.end_date >= today && c.end_date <= inRenewalWindow);

  const monthlyRevenue = active.reduce((acc, c) => acc + (c.monthly || 0), 0);

  // Evolução do MRR nos últimos 6 meses (aproximação por vigência dos contratos)
  const mrrHistory = computeMrrHistory(contracts, plans, 6);
  const mrrPrev = mrrHistory.length >= 2 ? mrrHistory[mrrHistory.length - 2].mrr : 0;
  const mrrGrowthPct = mrrPrev > 0 ? ((monthlyRevenue - mrrPrev) / mrrPrev) * 100 : null;

  // Contratos com auto_renewal que já venceram e ainda não foram renovados
  const pendingRenewal = active.filter(c =>
    c.auto_renewal &&
    !c.renewal_generated &&
    c.end_date < today
  );

  // ── Enrich helper ────────────────────────────────────────────────────────────
  const enrich = (c) => {
    const plan     = plans.find(p => p.id === c.plan_id);
    const modality = plan && modalities.find(m => m.id === plan.modality_id);
    const coach    = coaches.find(co => co.id === c.coach_id);
    const customer = customers.find(cu => cu.id === c.customer_id);
    return { ...c, plan, modality, coach, customer };
  };

  // Alunos únicos ativos
  const activeStudentIds = new Set(active.map(c => c.customer_id).filter(Boolean));
  const customersById = Object.fromEntries(customers.map(c => [c.id, c]));
  const activeCustomers = [...activeStudentIds].map(id => customersById[id]).filter(Boolean);
  const activeAges = activeCustomers.map(c => calculateAge(c.birth_date)).filter(age => age != null);
  const avgActiveAge = average(activeAges);
  const overduePayments = active.filter(c => isContractPaymentOverdue(c, today));
  const overdueStudentIds = new Set(overduePayments.map(c => c.customer_id).filter(Boolean));
  const overdueAmount = overduePayments.reduce((acc, c) => acc + (c.value || c.monthly || 0), 0);

  // Perfil por modalidade: alunos únicos, contratos e MRR.
  const modalityStats = modalities.map(m => {
    const mContracts = active.filter(c => {
      const p = plans.find(pl => pl.id === c.plan_id);
      return p?.modality_id === m.id;
    });
    const studentIds = new Set(mContracts.map(c => c.customer_id).filter(Boolean));
    const ages = [...studentIds]
      .map(id => calculateAge(customersById[id]?.birth_date))
      .filter(age => age != null);
    return {
      name:         m.name,
      studentCount: studentIds.size,
      contractCount: mContracts.length,
      revenue:      mContracts.reduce((acc, c) => acc + (c.monthly || 0), 0),
      averageAge:   average(ages),
    };
  }).filter(m => m.studentCount > 0).sort((a, b) => b.studentCount - a.studentCount || b.revenue - a.revenue);

  // ── Movimentação do mês ───────────────────────────────────────────────────
  const novosContratos  = lifecycleRows.filter(c => c.lifecycle.counts.entry);
  const renovacoesNoMes = lifecycleRows.filter(c => c.lifecycle.counts.renewal);
  const idsAntesDoMes = new Set(
    lifecycleRows
      .filter(c =>
        (c.lifecycle.createdLocal || '') < monthStart &&
        !['pending_sale', 'voided_sale'].includes(c.lifecycle.type)
      )
      .map(c => c.customer_id)
  );
  const contratosDeAlunosNovos = novosContratos.filter(c => !idsAntesDoMes.has(c.customer_id));
  const alunosNovosUnicos = new Set(
    contratosDeAlunosNovos.map(c => c.customer_id)
  );

  // Saídas reais: contratos efetivados que foram cancelados nesse mês.
  // Registros descartados antes do pagamento são ignorados nas métricas.
  const saidasNoMes = lifecycleRows.filter(c =>
    c.lifecycle.counts.exit && c.lifecycle.cancelDate >= monthStart
  );

  // Churn rate (proxy): saídas / (ativos + saídas)
  const churnDenom = active.length + saidasNoMes.length;
  const churnRate  = churnDenom > 0 ? (saidasNoMes.length / churnDenom) * 100 : 0;

  // Saldo de alunos (entradas reais - saídas reais)
  const saldoAlunos = alunosNovosUnicos.size - saidasNoMes.length;

  // ── Performance por coach ──────────────────────────────────────────────────
  const coachStats = coaches
    .filter(co => co.active !== false)
    .map(co => {
      const cLifecycle = lifecycleRows.filter(c => c.coach_id === co.id);
      const cAtivos    = cLifecycle.filter(c => c.lifecycle.counts.active);
      const cNovosContratos = cLifecycle.filter(c => c.lifecycle.counts.entry);
      const cNovos = new Set(
        cNovosContratos.filter(c => !idsAntesDoMes.has(c.customer_id)).map(c => c.customer_id)
      );
      const cRenov     = cLifecycle.filter(c => c.lifecycle.counts.renewal);
      const cSaidas    = cLifecycle.filter(c => c.lifecycle.counts.exit && c.lifecycle.cancelDate >= monthStart);
      const cMrr = cAtivos.reduce((acc, c) => acc + (c.monthly || 0), 0);
      return {
        coach:   co,
        ativos:  cAtivos.length,
        novos:   cNovos.size,
        novosContratos: cNovosContratos.length,
        renov:   cRenov.length,
        saidas:  cSaidas.length,
        mrr:     cMrr,
      };
    })
    .filter(s => s.ativos > 0 || s.novos > 0 || s.saidas > 0)
    .sort((a, b) => b.mrr - a.mrr);

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando painel...</div>;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Painel da Assessoria</h2>
          <p className="text-sm text-muted-foreground">Visão geral em tempo real</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Atualizar
        </Button>
      </div>

      {/* Alerta de renovações pendentes */}
      {pendingRenewal.length > 0 && (
        <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-amber-600 shrink-0" />
            <p className="text-sm font-semibold text-amber-800">
              {pendingRenewal.length} contrato{pendingRenewal.length !== 1 ? 's' : ''} com renovação automática pendente
            </p>
          </div>
          <Link to="/assessoria/renovacoes" className="text-sm font-semibold text-amber-800 hover:text-amber-900 shrink-0">
            Ver renovações
          </Link>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center">
                <Users className="w-4.5 h-4.5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Alunos ativos</p>
                <p className="text-2xl font-bold text-gray-900">{activeStudentIds.size}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-4.5 h-4.5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Receita mensal</p>
                <p className="text-2xl font-bold text-green-700">{formatCurrency(monthlyRevenue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={overduePayments.length > 0 ? 'border-red-200' : ''}>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${overduePayments.length > 0 ? 'bg-red-100' : 'bg-gray-100'}`}>
                <AlertTriangle className={`w-4.5 h-4.5 ${overduePayments.length > 0 ? 'text-red-500' : 'text-gray-400'}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Inadimplentes</p>
                <p className={`text-2xl font-bold ${overduePayments.length > 0 ? 'text-red-600' : 'text-gray-900'}`}>{overdueStudentIds.size}</p>
              </div>
            </div>
            {overdueAmount > 0 && <p className="text-xs text-red-600 mt-2">{formatCurrency(overdueAmount)} vencido</p>}
          </CardContent>
        </Card>

        <Card className={expiring.length > 0 ? 'border-amber-200' : ''}>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${expiring.length > 0 ? 'bg-amber-100' : 'bg-gray-100'}`}>
                <Clock className={`w-4.5 h-4.5 ${expiring.length > 0 ? 'text-amber-600' : 'text-gray-400'}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Vencendo em {RENEWAL_ATTENTION_WINDOW_DAYS}d</p>
                <p className={`text-2xl font-bold ${expiring.length > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{expiring.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-violet-100 rounded-lg flex items-center justify-center">
                <Cake className="w-4.5 h-4.5 text-violet-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Idade média</p>
                <p className="text-2xl font-bold text-gray-900">
                  {avgActiveAge == null ? '—' : `${avgActiveAge.toFixed(0)}a`}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {activeAges.length}/{activeStudentIds.size} com nascimento
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Evolução do MRR — últimos 6 meses */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-600" />
                Evolução da receita recorrente (MRR)
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Últimos 6 meses — estimativa pela vigência dos contratos
              </p>
            </div>
            {mrrGrowthPct != null && (
              <span className={`flex items-center gap-1 text-sm font-semibold ${mrrGrowthPct >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {mrrGrowthPct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {mrrGrowthPct >= 0 ? '+' : ''}{mrrGrowthPct.toFixed(0)}% vs mês anterior
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {mrrHistory.every(d => d.mrr === 0) ? (
            <p className="text-sm text-muted-foreground text-center py-8">Sem dados suficientes para o histórico.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={mrrHistory} barCategoryGap="25%" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false}
                  tickFormatter={v => v === 0 ? '' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v} width={42}
                />
                <Tooltip
                  cursor={{ fill: '#f9fafb' }}
                  formatter={(value, name, props) => [
                    `${formatCurrency(value)} · ${props.payload.count} aluno${props.payload.count !== 1 ? 's' : ''}`,
                    'MRR',
                  ]}
                />
                <Bar dataKey="mrr" radius={[6, 6, 0, 0]} maxBarSize={64}>
                  {mrrHistory.map((d, i) => (
                    <Cell key={d.ym} fill={i === mrrHistory.length - 1 ? '#059669' : '#6ee7b7'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Dois alertas lado a lado */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Cobranças vencidas */}
        <Card className={overduePayments.length > 0 ? 'border-red-200' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <XCircle className="w-4 h-4 text-red-500" />
              Cobranças vencidas ({overduePayments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overduePayments.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4 flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Nenhuma cobrança vencida em contrato ativo
              </p>
            ) : (
              <div className="divide-y max-h-64 overflow-y-auto">
                {overduePayments.map(c => { const e = enrich(c); return (
                  <Link key={c.id} to={`/assessoria/contratos/${c.id}`} className="flex items-center gap-3 py-2 hover:bg-red-50 rounded px-1 -mx-1">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{e.customer?.full_name || '—'}</p>
                      <p className="text-xs text-muted-foreground capitalize">{e.modality?.name} · {periodLabel(e.plan)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono text-blue-700">{c.contract_number}</p>
                      <p className="text-xs text-red-600">venceu {formatDate(c.due_date)}</p>
                      <p className="text-xs font-semibold text-red-700">{formatCurrency(c.value || c.monthly || 0)}</p>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  </Link>
                ); })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Contratos dentro da janela de renovação */}
        <Card className={expiring.length > 0 ? 'border-amber-200' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-500" />
              Vencendo em {RENEWAL_ATTENTION_WINDOW_DAYS} dias ({expiring.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {expiring.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4 flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Nenhum contrato vencendo em breve
              </p>
            ) : (
              <div className="divide-y max-h-64 overflow-y-auto">
                {expiring.sort((a, b) => a.end_date.localeCompare(b.end_date)).map(c => { const e = enrich(c); return (
                  <Link key={c.id} to={`/assessoria/contratos/${c.id}`} className="flex items-center gap-3 py-2 hover:bg-amber-50 rounded px-1 -mx-1">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{e.customer?.full_name || '—'}</p>
                      <p className="text-xs text-muted-foreground capitalize">{e.modality?.name} · {periodLabel(e.plan)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono text-blue-700">{c.contract_number}</p>
                      <p className="text-xs text-amber-600 font-medium">vence {formatDate(c.end_date)}</p>
                    </div>
                    {c.auto_renewal
                      ? <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium shrink-0">auto</span>
                      : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    }
                  </Link>
                ); })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Movimentação do mês ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600" />
            Movimentação · <span className="capitalize text-muted-foreground font-normal">{monthLabel}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Entradas reais */}
            <div className="rounded-xl border border-green-200 bg-green-50/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <UserPlus className="w-4 h-4 text-green-600" />
                <p className="text-xs text-green-700 font-medium">Entradas reais</p>
              </div>
              <p className="text-2xl font-bold text-green-700">{alunosNovosUnicos.size}</p>
              <p className="text-xs text-green-600 mt-0.5">
                {novosContratos.length} contrato{novosContratos.length !== 1 ? 's' : ''} {novosContratos.length !== 1 ? 'reais' : 'real'}
              </p>
            </div>

            {/* Renovações */}
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <RotateCcw className="w-4 h-4 text-blue-600" />
                <p className="text-xs text-blue-700 font-medium">Renovações</p>
              </div>
              <p className="text-2xl font-bold text-blue-700">{renovacoesNoMes.length}</p>
              <p className="text-xs text-blue-600 mt-0.5">retenção</p>
            </div>

            {/* Saídas */}
            <div className={`rounded-xl border p-3 ${saidasNoMes.length > 0 ? 'border-red-200 bg-red-50/50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-1">
                <UserMinus className={`w-4 h-4 ${saidasNoMes.length > 0 ? 'text-red-600' : 'text-gray-400'}`} />
                <p className={`text-xs font-medium ${saidasNoMes.length > 0 ? 'text-red-700' : 'text-muted-foreground'}`}>Saídas reais</p>
              </div>
              <p className={`text-2xl font-bold ${saidasNoMes.length > 0 ? 'text-red-600' : 'text-gray-500'}`}>{saidasNoMes.length}</p>
              <p className="text-xs text-muted-foreground mt-0.5">cancelamentos</p>
            </div>

            {/* Churn % */}
            <div className={`rounded-xl border p-3 ${churnRate > 5 ? 'border-red-200 bg-red-50/50' : churnRate > 2 ? 'border-amber-200 bg-amber-50/50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-1">
                <TrendingDown className={`w-4 h-4 ${churnRate > 5 ? 'text-red-600' : churnRate > 2 ? 'text-amber-600' : 'text-gray-400'}`} />
                <p className="text-xs font-medium text-muted-foreground">Churn</p>
              </div>
              <p className={`text-2xl font-bold ${churnRate > 5 ? 'text-red-600' : churnRate > 2 ? 'text-amber-600' : 'text-gray-700'}`}>
                {churnRate.toFixed(1)}%
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                saldo: <span className={saldoAlunos >= 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                  {saldoAlunos >= 0 ? '+' : ''}{saldoAlunos}
                </span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Performance por coach ─────────────────────────────────────────────── */}
      {coachStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="w-4 h-4 text-purple-600" />
              Performance por coach
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left py-2 font-medium">Coach</th>
                    <th className="text-right py-2 font-medium">Ativos</th>
                    <th className="text-right py-2 font-medium" title="Alunos novos reais este mês">Entradas</th>
                    <th className="text-right py-2 font-medium" title="Renovações esse mês">Renov.</th>
                    <th className="text-right py-2 font-medium" title="Cancelamentos reais esse mês">Saídas</th>
                    <th className="text-right py-2 font-medium">MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {coachStats.map(s => (
                    <tr key={s.coach.id} className="hover:bg-gray-50">
                      <td className="py-2.5">
                        <p className="font-medium">{s.coach.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{s.coach.role}</p>
                      </td>
                      <td className="py-2.5 text-right font-bold text-blue-700">{s.ativos}</td>
                      <td className="py-2.5 text-right">
                        {s.novos > 0
                          ? <span className="text-green-600 font-semibold" title={`${s.novosContratos} contrato(s) real(is)`}>+{s.novos}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        {s.renov > 0
                          ? <span className="text-blue-600 font-semibold">↻{s.renov}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        {s.saidas > 0
                          ? <span className="text-red-600 font-semibold">−{s.saidas}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 text-right font-semibold text-green-700">{formatCurrency(s.mrr)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold bg-gray-50/50">
                    <td className="py-2.5">Total</td>
                    <td className="py-2.5 text-right text-blue-700">{coachStats.reduce((s, c) => s + c.ativos, 0)}</td>
                    <td className="py-2.5 text-right text-green-600">
                      {coachStats.reduce((s, c) => s + c.novos, 0) > 0
                        ? `+${coachStats.reduce((s, c) => s + c.novos, 0)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-blue-600">
                      {coachStats.reduce((s, c) => s + c.renov, 0) > 0
                        ? `↻${coachStats.reduce((s, c) => s + c.renov, 0)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-red-600">
                      {coachStats.reduce((s, c) => s + c.saidas, 0) > 0
                        ? `−${coachStats.reduce((s, c) => s + c.saidas, 0)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-green-700">
                      {formatCurrency(coachStats.reduce((s, c) => s + c.mrr, 0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Alunos por modalidade */}
      {modalityStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-600" />
              Alunos por modalidade
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {modalityStats.map(m => {
                const pct = activeStudentIds.size > 0 ? Math.round((m.studentCount / activeStudentIds.size) * 100) : 0;
                return (
                <div key={m.name}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium capitalize">{m.name}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground text-xs">
                        {m.studentCount} aluno{m.studentCount !== 1 ? 's' : ''}
                        {m.contractCount !== m.studentCount && ` · ${m.contractCount} contratos`}
                      </span>
                      {m.averageAge != null && (
                        <span className="text-muted-foreground text-xs">{m.averageAge.toFixed(0)}a média</span>
                      )}
                      <span className="font-bold text-green-700">{formatCurrency(m.revenue)}/mês</span>
                    </div>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              ); })}
              <div className="pt-2 border-t flex justify-between text-sm font-semibold">
                <span>{activeStudentIds.size} aluno{activeStudentIds.size !== 1 ? 's' : ''} ativo{activeStudentIds.size !== 1 ? 's' : ''}</span>
                <span className="text-green-700">{formatCurrency(monthlyRevenue)}/mês</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contratos ativos */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              Contratos ativos ({active.length})
            </CardTitle>
            <Button size="sm" onClick={() => navigate('/assessoria/contratos/novo')}>
              + Novo contrato
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Nenhum contrato ativo</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 px-1 font-medium text-muted-foreground text-xs">Aluno</th>
                    <th className="text-left py-2 px-1 font-medium text-muted-foreground text-xs">Modalidade</th>
                    <th className="text-left py-2 px-1 font-medium text-muted-foreground text-xs">Coach</th>
                    <th className="text-right py-2 px-1 font-medium text-muted-foreground text-xs">Vencimento</th>
                    <th className="text-center py-2 px-1 font-medium text-muted-foreground text-xs">Status</th>
                    <th className="text-center py-2 px-1 font-medium text-muted-foreground text-xs">Auto</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {active.map(c => { const e = enrich(c); return (
                    <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/contratos/${c.id}`)}>
                      <td className="py-2.5 px-1 font-medium">{e.customer?.full_name || '—'}</td>
                      <td className="py-2.5 px-1 text-muted-foreground text-xs capitalize">{e.modality?.name} · {periodLabel(e.plan)}</td>
                      <td className="py-2.5 px-1 text-muted-foreground text-xs">{e.coach?.name || '—'}</td>
                      <td className="py-2.5 px-1 text-right text-xs">{formatDate(c.end_date)}</td>
                      <td className="py-2.5 px-1 text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_CLS[c.status] || ''}`}>
                          {STATUS_LABEL[c.status] || c.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-1 text-center">
                        {c.auto_renewal
                          ? <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">auto</span>
                          : <span className="text-xs text-gray-300">—</span>
                        }
                      </td>
                      <td className="py-2.5 px-1"><ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /></td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
