import { useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Award,
  BarChart3, CalendarDays, CheckCircle2, CircleDollarSign, Database,
  DollarSign, Info, Layers, Loader2, MapPin, Minus, RefreshCw,
  Repeat2, ShoppingBag, Target, Timer, TrendingDown, TrendingUp,
  UserPlus, Users, Wallet,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend,
  Pie, PieChart, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { supabase } from '@/api/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePageData } from '@/hooks/usePageData';
import { AGE_BANDS, PERIOD_OPTIONS, buildAnalytics } from '@/lib/analytics-metrics';
import { cn, formatCurrency } from '@/lib/utils';

const COLORS = ['#2563eb', '#8b5cf6', '#f97316', '#10b981', '#eab308', '#ef4444', '#64748b', '#06b6d4'];

const INITIAL_DATA = {
  contracts: [],
  plans: [],
  modalities: [],
  coaches: [],
  customers: [],
  payments: [],
  presaleOrders: [],
  stockOrders: [],
  prospectSubmissions: [],
  returns: [],
  payoutItems: [],
};

async function fetchAllRows(table, columns) {
  const rows = [];
  let cursor = null;
  const pageSize = 1000;

  while (true) {
    let query = supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }

  return rows;
}

async function loadAnalyticsData() {
  const [
    contracts, plans, modalities, coaches, customers, payments,
    presaleOrders, stockOrders, prospectSubmissions, returns, payoutItems,
  ] = await Promise.all([
    fetchAllRows('assessment_contracts', [
      'id', 'customer_id', 'coach_id', 'plan_id', 'status', 'start_date', 'end_date',
      'created_at', 'updated_at', 'payment_status', 'payment_date', 'manual_payment',
      'asaas_charge_id', 'enrollment_fee', 'manual_discount', 'credit_balance',
      'refund_status', 'refund_amount', 'refund_date', 'cancellation_date',
      'cancellation_reason', 'parent_contract_id', 'due_date', 'plan_snapshot',
      'prospect_stage', 'prospect_proposal_ready_at', 'prospect_message_sent_at',
      'prospect_converted_at', 'prospect_lost_at', 'prospect_loss_reason_code',
      'prospect_customer_relationship', 'prospect_reactivated_at',
    ].join(',')),
    fetchAllRows('assessment_plans', 'id,modality_id,name,period,period_months,price_monthly,price_total,active'),
    fetchAllRows('assessment_modalities', 'id,name,active'),
    fetchAllRows('assessment_coaches', 'id,name,role,active'),
    fetchAllRows('presale_customers', 'id,gender,birth_date,address_city,address_state,created_date'),
    fetchAllRows('asaas_payments', 'id,order_id,order_type,status,value,net_value,payment_date,credit_date,due_date,created_at'),
    fetchAllRows('presale_orders', 'id,customer_id,payment_status,payment_date,manual_payment,asaas_charge_id,total_value,total_cost,created_date'),
    fetchAllRows('stock_orders', 'id,customer_id,payment_status,payment_date,manual_payment,asaas_charge_id,total_value,created_date'),
    fetchAllRows('assessment_prospect_submissions', 'id,contract_id,customer_id,source,region,landing_page,utm,submitted_at'),
    fetchAllRows('order_returns', 'id,order_id,order_type,refund_value,status,created_at,received_at,completed_at'),
    fetchAllRows('payout_monthly_statement_items', 'id,coach_id,contract_id,amount,reference_competence,source_type,expense_category,created_at'),
  ]);

  return {
    contracts, plans, modalities, coaches, customers, payments,
    presaleOrders, stockOrders, prospectSubmissions, returns, payoutItems,
  };
}

function formatCompactCurrency(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1_000_000) return `R$ ${(amount / 1_000_000).toFixed(1)} mi`;
  if (Math.abs(amount) >= 1000) return `R$ ${(amount / 1000).toFixed(1)} mil`;
  return formatCurrency(amount);
}

function formatPercent(value, digits = 1) {
  return `${(Number(value) || 0).toFixed(digits)}%`;
}

function MetricCard({ label, value, sub, icon: Icon, tone = 'blue', trend, help }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    green: 'bg-green-50 text-green-700 border-green-100',
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
    orange: 'bg-orange-50 text-orange-700 border-orange-100',
    red: 'bg-red-50 text-red-700 border-red-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
  };
  const TrendIcon = trend > 0 ? ArrowUpRight : trend < 0 ? ArrowDownRight : Minus;
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              {help && <span title={help}><Info className="w-3.5 h-3.5 text-gray-300" /></span>}
            </div>
            <p className="text-2xl font-bold text-gray-900 mt-1 truncate">{value}</p>
            <div className="flex items-center gap-1.5 mt-1 min-h-4">
              {trend != null && (
                <span className={cn('inline-flex items-center text-[11px] font-semibold', trend > 0 ? 'text-green-600' : trend < 0 ? 'text-red-600' : 'text-gray-400')}>
                  <TrendIcon className="w-3 h-3" /> {trend > 0 ? '+' : ''}{trend}
                </span>
              )}
              <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
            </div>
          </div>
          <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center shrink-0', tones[tone])}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionCard({ title, description, icon: Icon, children, className }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-start gap-2">
          {Icon && <Icon className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />}
          <span>
            {title}
            {description && <span className="block text-xs text-muted-foreground font-normal mt-0.5">{description}</span>}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function EmptyChart({ message = 'Ainda não há dados suficientes para este recorte.' }) {
  return (
    <div className="h-56 flex flex-col items-center justify-center text-center text-muted-foreground border border-dashed rounded-xl bg-gray-50/50 px-6">
      <BarChart3 className="w-7 h-7 text-gray-300 mb-2" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function CurrencyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border shadow-lg rounded-lg p-3 text-xs">
      <p className="font-semibold mb-1.5">{label}</p>
      {payload.map(item => (
        <div key={item.dataKey} className="flex justify-between gap-6" style={{ color: item.color }}>
          <span>{item.name}</span><b>{formatCurrency(item.value)}</b>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ data, centerLabel, centerValue }) {
  if (!data.some(item => item.value > 0)) return <EmptyChart />;
  return (
    <div className="relative h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={88} paddingAngle={2}>
            {data.map((item, index) => <Cell key={item.key || item.name} fill={COLORS[index % COLORS.length]} />)}
          </Pie>
          <Tooltip formatter={(value, name) => [value, name]} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-7">
        <span className="text-2xl font-bold text-gray-900">{centerValue}</span>
        <span className="text-[10px] text-muted-foreground">{centerLabel}</span>
      </div>
    </div>
  );
}

function ProgressRows({ data, formatter = value => value, color = 'bg-blue-500' }) {
  const max = Math.max(...data.map(item => Number(item.value) || 0), 0);
  if (!data.length || max === 0) return <EmptyChart />;
  return (
    <div className="space-y-3">
      {data.map(item => (
        <div key={item.key || item.name}>
          <div className="flex items-center justify-between gap-3 text-sm mb-1">
            <span className="font-medium truncate">{item.name}</span>
            <span className="font-semibold shrink-0">{formatter(item.value, item)}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function OverviewTab({ analytics }) {
  const { summary, mrrHistory, revenueHistory, period } = analytics;
  const revenueData = revenueHistory.map(item => ({ ...item, total: item.assessoria + item.loja }));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard label="Alunos ativos" value={summary.activeStudents} sub={`${summary.activeContracts} contratos ativos`} icon={Users} tone="blue" />
        <MetricCard label="MRR contratado" value={formatCompactCurrency(summary.mrr)} sub="receita mensal da carteira atual" icon={TrendingUp} tone="green" help="Soma do valor mensal dos contratos ativos." />
        <MetricCard label="Ticket contratado" value={formatCurrency(summary.contractedTicket)} sub="MRR ÷ alunos ativos" icon={CircleDollarSign} tone="violet" />
        <MetricCard label="Receita líquida" value={formatCompactCurrency(summary.netRevenue)} sub={`${period.label.toLowerCase()} · após taxas e estornos`} icon={Wallet} tone="green" />
        <MetricCard label="LTV realizado médio" value={formatCurrency(summary.realizedLtvTotal)} sub="assessoria + loja por cliente pagante" icon={Database} tone="blue" help="Receita líquida histórica média efetivamente recebida por cliente, já descontando estornos registrados." />
        <MetricCard label="LTV estimado" value={summary.estimatedLtv ? formatCompactCurrency(summary.estimatedLtv) : '—'} sub={summary.averageLifetimeMonths ? `${summary.averageLifetimeMonths.toFixed(1)} meses estimados` : 'churn insuficiente para estimar'} icon={Repeat2} tone="violet" />
        <MetricCard label="Churn do período" value={formatPercent(summary.churn)} sub={`${summary.exits} saídas reais · mensalizado ${formatPercent(summary.monthlyChurn)}`} icon={TrendingDown} tone={summary.churn > 5 ? 'red' : 'slate'} />
        <MetricCard label="Saldo de alunos" value={`${summary.netGrowth >= 0 ? '+' : ''}${summary.netGrowth}`} sub={`${summary.entries} entradas · ${summary.exits} saídas`} icon={UserPlus} tone={summary.netGrowth >= 0 ? 'green' : 'red'} trend={summary.netGrowth} />
      </div>

      <div className="grid xl:grid-cols-2 gap-5">
        <SectionCard title="Evolução do MRR" description="Histórico reconstruído pela vigência dos contratos" icon={Activity}>
          {mrrHistory.some(item => item.mrr > 0) ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mrrHistory} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mrrFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563eb" stopOpacity={0.28} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={value => formatCompactCurrency(value).replace('R$ ', '')} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip content={<CurrencyTooltip />} />
                  <Area type="monotone" dataKey="mrr" name="MRR" stroke="#2563eb" strokeWidth={2.5} fill="url(#mrrFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart />}
        </SectionCard>

        <SectionCard title="Receita recebida" description="Valores líquidos por unidade, descontando estornos" icon={DollarSign}>
          {revenueData.some(item => item.total !== 0) ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenueData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={value => formatCompactCurrency(value).replace('R$ ', '')} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip content={<CurrencyTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="assessoria" name="Assessoria" stackId="revenue" fill="#2563eb" radius={[0, 0, 3, 3]} />
                  <Bar dataKey="loja" name="Loja" stackId="revenue" fill="#f97316" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart />}
        </SectionCard>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="Composição da receita" icon={Layers} className="lg:col-span-2">
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { label: 'Assessoria', value: summary.assessoriaNet, icon: Activity, color: 'text-blue-700', bg: 'bg-blue-50' },
              { label: 'Loja', value: summary.storeNet, icon: ShoppingBag, color: 'text-orange-700', bg: 'bg-orange-50' },
            ].map(item => (
              <div key={item.label} className={cn('rounded-xl p-4 border', item.bg)}>
                <div className="flex items-center justify-between">
                  <span className={cn('text-sm font-semibold', item.color)}>{item.label}</span>
                  <item.icon className={cn('w-4 h-4', item.color)} />
                </div>
                <p className="text-2xl font-bold mt-2">{formatCurrency(item.value)}</p>
                <p className="text-xs text-muted-foreground mt-1">{formatPercent(item.value / (summary.netRevenue || 1) * 100)} da receita líquida</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3 mt-4 text-center">
            <div className="rounded-lg border p-3"><p className="text-[11px] text-muted-foreground">Bruto recebido</p><p className="font-bold mt-1">{formatCurrency(summary.grossRevenue)}</p></div>
            <div className="rounded-lg border p-3"><p className="text-[11px] text-muted-foreground">Taxas Asaas</p><p className="font-bold mt-1 text-amber-700">{formatCurrency(summary.fees)}</p></div>
            <div className="rounded-lg border p-3"><p className="text-[11px] text-muted-foreground">Estornos</p><p className="font-bold mt-1 text-red-600">{formatCurrency(summary.refunded)}</p></div>
          </div>
        </SectionCard>
        <SectionCard title="Risco financeiro" icon={AlertTriangle}>
          <div className="space-y-4">
            <div><p className="text-xs text-muted-foreground">Alunos inadimplentes</p><p className="text-3xl font-bold text-red-600">{summary.overdueCustomers}</p></div>
            <div><p className="text-xs text-muted-foreground">Valor em atraso</p><p className="text-xl font-bold">{formatCurrency(summary.overdueAmount)}</p></div>
            <div className="pt-3 border-t"><p className="text-xs text-muted-foreground">Ticket efetivamente recebido</p><p className="text-xl font-bold text-green-700">{formatCurrency(summary.receivedTicket)}</p><p className="text-[11px] text-muted-foreground">{summary.payingCustomers} clientes pagantes no período</p></div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function ProfileTab({ analytics }) {
  const { profile, dataQuality, summary, breakdowns } = analytics;
  const qualityItems = [
    { label: 'Gênero', value: dataQuality.gender, icon: Users },
    { label: 'Nascimento', value: dataQuality.birthDate, icon: CalendarDays },
    { label: 'Cidade', value: dataQuality.city, icon: MapPin },
    { label: 'Cadastro completo', value: dataQuality.complete, icon: CheckCircle2 },
  ];
  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
        {qualityItems.map(item => {
          const pct = dataQuality.total ? item.value / dataQuality.total * 100 : 0;
          return <MetricCard key={item.label} label={item.label} value={`${formatPercent(pct, 0)}`} sub={`${item.value} de ${dataQuality.total} alunos ativos`} icon={item.icon} tone={pct >= 90 ? 'green' : pct >= 70 ? 'orange' : 'red'} />;
        })}
      </div>

      <div className="grid xl:grid-cols-3 gap-5">
        <SectionCard title="Distribuição por gênero" description="Alunos ativos" icon={Users}>
          <DonutChart data={profile.gender} centerLabel="ativos" centerValue={summary.activeStudents} />
        </SectionCard>
        <SectionCard title="Faixas etárias" description="Alunos ativos" icon={CalendarDays} className="xl:col-span-2">
          {profile.age.some(item => item.value > 0) ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={profile.age}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip />
                  <Bar dataKey="value" name="Alunos" fill="#8b5cf6" radius={[5, 5, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyChart />}
        </SectionCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <SectionCard title="Alunos por modalidade" description="Carteira ativa e participação" icon={Activity}>
          <ProgressRows data={breakdowns.modalities.map(item => ({ ...item, value: item.activeStudents }))} formatter={(value, item) => `${value} · ${formatCurrency(item.mrr)} MRR`} />
        </SectionCard>
        <SectionCard title="Distribuição geográfica" description="Estado informado no cadastro" icon={MapPin}>
          <ProgressRows data={profile.region.slice(0, 10)} color="bg-emerald-500" />
        </SectionCard>
      </div>
    </div>
  );
}

function CommercialTab({ analytics }) {
  const { prospects } = analytics;
  const maxFunnel = Math.max(prospects.total, 1);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard label="Prospects" value={prospects.total} sub={`${prospects.open} ainda em aberto`} icon={Target} tone="blue" />
        <MetricCard label="Conversão" value={formatPercent(prospects.conversionRate)} sub={`${prospects.converted} convertidos · ${prospects.lost} perdidos`} icon={TrendingUp} tone="green" />
        <MetricCard label="Tempo para fechar" value={prospects.averageCloseDays == null ? '—' : `${prospects.averageCloseDays.toFixed(1)} dias`} sub="cadastro até conversão" icon={Timer} tone="violet" />
        <MetricCard label="Retornos" value={prospects.formerStudents} sub={`${prospects.returnsConverted} reativações · ${formatPercent(prospects.returnConversionRate)}`} icon={Repeat2} tone="orange" />
      </div>

      <div className="grid xl:grid-cols-2 gap-5">
        <SectionCard title="Funil comercial" description="Avanço dos prospects no período selecionado" icon={Target}>
          {prospects.total ? (
            <div className="space-y-3 py-2">
              {prospects.funnel.map((stage, index) => {
                const pct = stage.value / maxFunnel * 100;
                return (
                  <div key={stage.key} className="relative">
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="font-medium"><span className="text-muted-foreground mr-2">0{index + 1}</span>{stage.name}</span>
                      <span className="font-bold">{stage.value} <span className="text-xs text-muted-foreground font-normal">({formatPercent(pct, 0)})</span></span>
                    </div>
                    <div className="h-9 bg-gray-100 rounded-lg overflow-hidden">
                      <div className="h-full rounded-lg flex items-center px-3 text-xs font-semibold text-white transition-all" style={{ width: `${Math.max(4, pct)}%`, backgroundColor: COLORS[index] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <EmptyChart message="Os testes foram removidos. O funil começará a formar histórico com os próximos cadastros reais." />}
        </SectionCard>

        <SectionCard title="Origem dos leads" description="Formulário, campanha ou entrada manual" icon={MapPin}>
          {prospects.sources.length ? <DonutChart data={prospects.sources} centerLabel="cadastros" centerValue={prospects.total} /> : <EmptyChart message="As origens aparecerão quando os próximos formulários forem enviados." />}
        </SectionCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <SectionCard title="Motivos de perda" description="Por que os prospects não fecharam" icon={TrendingDown}>
          {prospects.losses.length ? <ProgressRows data={prospects.losses} color="bg-red-500" /> : <EmptyChart message="Nenhuma perda classificada neste período." />}
        </SectionCard>
        <SectionCard title="Leitura do funil" icon={Info}>
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3"><b>{prospects.proposal}</b> prospects chegaram à proposta.</div>
            <div className="rounded-xl bg-violet-50 border border-violet-100 p-3"><b>{prospects.linkSent}</b> receberam link de pagamento.</div>
            <div className="rounded-xl bg-green-50 border border-green-100 p-3"><b>{prospects.converted}</b> viraram contratos efetivos.</div>
            <p className="text-xs text-muted-foreground">Retorno só considera ex-aluno com contrato anterior de assessoria, nunca apenas uma compra na loja.</p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function PlansTab({ analytics }) {
  const { breakdowns } = analytics;
  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-2 gap-4">
        {breakdowns.modalities.map((item, index) => (
          <Card key={item.id} className="overflow-hidden">
            <div className="h-1.5" style={{ backgroundColor: COLORS[index] }} />
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div><p className="text-xs text-muted-foreground uppercase tracking-wide">Modalidade</p><h3 className="text-xl font-bold capitalize mt-1">{item.name}</h3></div>
                <Activity className="w-5 h-5 text-blue-600" />
              </div>
              <div className="grid grid-cols-2 gap-3 mt-5">
                <div><p className="text-xs text-muted-foreground">Alunos ativos</p><p className="text-2xl font-bold">{item.activeStudents}</p></div>
                <div><p className="text-xs text-muted-foreground">MRR</p><p className="text-2xl font-bold text-green-700">{formatCurrency(item.mrr)}</p></div>
                <div><p className="text-xs text-muted-foreground">Ticket</p><p className="font-bold">{formatCurrency(item.ticket)}</p></div>
                <div><p className="text-xs text-muted-foreground">Churn</p><p className="font-bold">{formatPercent(item.churn)}</p></div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <SectionCard title="Performance por plano" description="Carteira atual e movimentação no período" icon={Layers}>
        {breakdowns.plans.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[850px]">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="text-left py-2.5 font-medium">Plano</th>
                  <th className="text-right py-2.5 font-medium">Ativos</th>
                  <th className="text-right py-2.5 font-medium">MRR</th>
                  <th className="text-right py-2.5 font-medium">Ticket</th>
                  <th className="text-right py-2.5 font-medium">Entradas</th>
                  <th className="text-right py-2.5 font-medium">Saídas</th>
                  <th className="text-right py-2.5 font-medium">Churn</th>
                  <th className="text-right py-2.5 font-medium">Recebido</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {breakdowns.plans.map(item => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="py-3 font-medium max-w-[300px] truncate">{item.name}</td>
                    <td className="py-3 text-right font-bold text-blue-700">{item.activeStudents}</td>
                    <td className="py-3 text-right font-semibold text-green-700">{formatCurrency(item.mrr)}</td>
                    <td className="py-3 text-right">{formatCurrency(item.ticket)}</td>
                    <td className="py-3 text-right text-green-600">{item.entries ? `+${item.entries}` : '—'}</td>
                    <td className="py-3 text-right text-red-600">{item.exits ? `−${item.exits}` : '—'}</td>
                    <td className="py-3 text-right">{formatPercent(item.churn)}</td>
                    <td className="py-3 text-right">{formatCurrency(item.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyChart />}
      </SectionCard>
    </div>
  );
}

function CoachesTab({ analytics }) {
  const { breakdowns } = analytics;
  const chartData = breakdowns.coaches.slice(0, 10).map(item => ({ name: item.name.split(' ')[0], mrr: item.mrr, ativos: item.activeStudents }));
  return (
    <div className="space-y-5">
      <SectionCard title="Carteira e MRR por treinador" description="Comparação dos treinadores no recorte atual" icon={Award}>
        {chartData.length ? (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 25 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={value => formatCompactCurrency(value).replace('R$ ', '')} tick={{ fontSize: 10 }} axisLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} axisLine={false} tickLine={false} />
                <Tooltip content={<CurrencyTooltip />} />
                <Bar dataKey="mrr" name="MRR" fill="#2563eb" radius={[0, 5, 5, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : <EmptyChart />}
      </SectionCard>

      <SectionCard title="Performance por treinador" description="Receita é caixa recebido; repasse considera fechamentos já registrados" icon={Award}>
        {breakdowns.coaches.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[950px]">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="text-left py-2.5 font-medium">Treinador</th>
                  <th className="text-right py-2.5 font-medium">Ativos</th>
                  <th className="text-right py-2.5 font-medium">Entradas</th>
                  <th className="text-right py-2.5 font-medium">Saídas</th>
                  <th className="text-right py-2.5 font-medium">MRR</th>
                  <th className="text-right py-2.5 font-medium">Recebido</th>
                  <th className="text-right py-2.5 font-medium">Repasse fechado</th>
                  <th className="text-right py-2.5 font-medium">Contribuição</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {breakdowns.coaches.map(item => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="py-3 font-medium">{item.name}</td>
                    <td className="py-3 text-right font-bold text-blue-700">{item.activeStudents}</td>
                    <td className="py-3 text-right text-green-600">{item.entries ? `+${item.entries}` : '—'}</td>
                    <td className="py-3 text-right text-red-600">{item.exits ? `−${item.exits}` : '—'}</td>
                    <td className="py-3 text-right font-semibold">{formatCurrency(item.mrr)}</td>
                    <td className="py-3 text-right text-green-700">{formatCurrency(item.revenue)}</td>
                    <td className="py-3 text-right text-violet-700">{formatCurrency(item.payout)}</td>
                    <td className={cn('py-3 text-right font-semibold', item.contribution >= 0 ? 'text-blue-700' : 'text-red-600')}>{formatCurrency(item.contribution)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyChart />}
      </SectionCard>
    </div>
  );
}

function RetentionTab({ analytics }) {
  const { summary, cohorts } = analytics;
  const formatCohort = value => value == null ? '—' : formatPercent(value, 0);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard label="Retenção do período" value={formatPercent(summary.retention)} sub={`${summary.renewals} renovações registradas`} icon={Repeat2} tone="green" />
        <MetricCard label="Permanência estimada" value={summary.averageLifetimeMonths ? `${summary.averageLifetimeMonths.toFixed(1)} meses` : '—'} sub="calculada pelo churn mensalizado" icon={Timer} tone="violet" />
        <MetricCard label="LTV assessoria" value={formatCurrency(summary.realizedLtvAssessoria)} sub="realizado médio por cliente" icon={Activity} tone="blue" />
        <MetricCard label="LTV loja" value={formatCurrency(summary.realizedLtvStore)} sub="realizado médio por cliente" icon={ShoppingBag} tone="orange" />
      </div>

      <SectionCard title="Coortes de retenção" description="Percentual de cada turma que ainda possuía contrato vigente após 1, 3, 6 e 12 meses" icon={Repeat2}>
        {cohorts.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[650px]">
              <thead className="border-b text-xs text-muted-foreground">
                <tr><th className="text-left py-2.5 font-medium">Mês de entrada</th><th className="text-right py-2.5 font-medium">Alunos</th><th className="text-right py-2.5 font-medium">Mês 1</th><th className="text-right py-2.5 font-medium">Mês 3</th><th className="text-right py-2.5 font-medium">Mês 6</th><th className="text-right py-2.5 font-medium">Mês 12</th></tr>
              </thead>
              <tbody className="divide-y">
                {cohorts.map(row => (
                  <tr key={row.ym} className="hover:bg-gray-50">
                    <td className="py-3 font-medium capitalize">{row.label}</td>
                    <td className="py-3 text-right font-bold">{row.size}</td>
                    {[row.m1, row.m3, row.m6, row.m12].map((value, index) => (
                      <td key={index} className="py-3 text-right">
                        <span className={cn('inline-flex min-w-14 justify-center px-2 py-1 rounded-md text-xs font-semibold', value == null ? 'bg-gray-50 text-gray-400' : value >= 80 ? 'bg-green-100 text-green-700' : value >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700')}>
                          {formatCohort(value)}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyChart />}
      </SectionCard>

      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
        <div><p className="text-sm font-semibold text-blue-900">Como interpretar</p><p className="text-xs text-blue-800 mt-1">“—” significa que a coorte ainda não atingiu aquela idade. O histórico atual começa em 2026; os indicadores de 6 e 12 meses ganharão precisão conforme o sistema acumular tempo.</p></div>
      </div>
    </div>
  );
}

function FilterSelect({ value, onValueChange, placeholder, children, className }) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={cn('bg-white min-w-[160px]', className)}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

export default function Analytics() {
  const [filters, setFilters] = useState({
    period: '12m',
    modality: 'all',
    plan: 'all',
    coach: 'all',
    gender: 'all',
    age: 'all',
  });
  const { data, loading, refreshing, refresh } = usePageData({
    key: 'analytics:center:v1',
    loader: loadAnalyticsData,
    initialData: INITIAL_DATA,
    maxAge: 60_000,
    tags: [
      'assessment_contracts', 'assessment_plans', 'assessment_modalities', 'assessment_coaches',
      'presale_customers', 'asaas_payments', 'presale_orders', 'stock_orders',
      'assessment_prospect_submissions', 'order_returns', 'payout_monthly_statement_items',
    ],
    onError: error => {
      console.error('[Analytics]', error);
      toast.error(`Erro ao carregar Analytics: ${error.message || 'falha desconhecida'}`);
    },
  });

  const analytics = useMemo(() => buildAnalytics(data, filters), [data, filters]);
  const availablePlans = filters.modality === 'all'
    ? data.plans
    : data.plans.filter(plan => plan.modality_id === filters.modality);
  const hasFilters = Object.entries(filters).some(([key, value]) => value !== (key === 'period' ? '12m' : 'all'));
  const updateFilter = (key, value) => setFilters(current => ({
    ...current,
    [key]: value,
    ...(key === 'modality' && current.plan !== 'all' && !data.plans.some(plan => plan.id === current.plan && (value === 'all' || plan.modality_id === value)) ? { plan: 'all' } : {}),
  }));

  if (loading) return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="w-7 h-7 animate-spin text-blue-600" />
      <div className="text-center"><p className="font-medium text-gray-700">Montando sua Central de Analytics</p><p className="text-xs mt-1">Cruzando contratos, clientes, pagamentos e prospects…</p></div>
    </div>
  );

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center"><BarChart3 className="w-5 h-5" /></div>
            <div><h1 className="text-2xl font-bold text-gray-900">Analytics</h1><p className="text-sm text-muted-foreground">Visão estratégica da assessoria, comercial e loja</p></div>
          </div>
        </div>
        <Button variant="outline" onClick={() => refresh({ force: true })} disabled={refreshing}>
          <RefreshCw className={cn('w-4 h-4 mr-2', refreshing && 'animate-spin')} />
          {refreshing ? 'Atualizando…' : 'Atualizar dados'}
        </Button>
      </div>

      <Card className="border-blue-100 bg-gradient-to-r from-blue-50/70 to-white">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-blue-600" /><p className="text-sm font-semibold">Filtros globais</p></div>
            {hasFilters && <button type="button" onClick={() => setFilters({ period: '12m', modality: 'all', plan: 'all', coach: 'all', gender: 'all', age: 'all' })} className="text-xs text-blue-600 hover:underline">Limpar filtros</button>}
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2">
            <FilterSelect value={filters.period} onValueChange={value => updateFilter('period', value)}>{PERIOD_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</FilterSelect>
            <FilterSelect value={filters.modality} onValueChange={value => updateFilter('modality', value)}><SelectItem value="all">Todas modalidades</SelectItem>{data.modalities.map(item => <SelectItem key={item.id} value={item.id}><span className="capitalize">{item.name}</span></SelectItem>)}</FilterSelect>
            <FilterSelect value={filters.plan} onValueChange={value => updateFilter('plan', value)}><SelectItem value="all">Todos os planos</SelectItem>{availablePlans.map(item => <SelectItem key={item.id} value={item.id}>{item.name || `${item.period || 'Plano'} · ${item.period_months || 1}m`}</SelectItem>)}</FilterSelect>
            <FilterSelect value={filters.coach} onValueChange={value => updateFilter('coach', value)}><SelectItem value="all">Todos treinadores</SelectItem>{data.coaches.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</FilterSelect>
            <FilterSelect value={filters.gender} onValueChange={value => updateFilter('gender', value)}><SelectItem value="all">Todos os gêneros</SelectItem><SelectItem value="feminino">Feminino</SelectItem><SelectItem value="masculino">Masculino</SelectItem><SelectItem value="unknown">Não informado</SelectItem></FilterSelect>
            <FilterSelect value={filters.age} onValueChange={value => updateFilter('age', value)}><SelectItem value="all">Todas as idades</SelectItem>{AGE_BANDS.map(item => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</FilterSelect>
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">Período afeta receitas, movimentações e funil. Alunos ativos e MRR representam a carteira de hoje, respeitando os demais filtros.</p>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="space-y-4">
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto min-w-max bg-white border shadow-sm p-1">
            <TabsTrigger value="overview" className="gap-1.5"><TrendingUp className="w-3.5 h-3.5" />Visão geral</TabsTrigger>
            <TabsTrigger value="profile" className="gap-1.5"><Users className="w-3.5 h-3.5" />Perfil</TabsTrigger>
            <TabsTrigger value="commercial" className="gap-1.5"><Target className="w-3.5 h-3.5" />Comercial</TabsTrigger>
            <TabsTrigger value="plans" className="gap-1.5"><Layers className="w-3.5 h-3.5" />Planos</TabsTrigger>
            <TabsTrigger value="coaches" className="gap-1.5"><Award className="w-3.5 h-3.5" />Treinadores</TabsTrigger>
            <TabsTrigger value="retention" className="gap-1.5"><Repeat2 className="w-3.5 h-3.5" />Retenção & LTV</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview"><OverviewTab analytics={analytics} /></TabsContent>
        <TabsContent value="profile"><ProfileTab analytics={analytics} /></TabsContent>
        <TabsContent value="commercial"><CommercialTab analytics={analytics} /></TabsContent>
        <TabsContent value="plans"><PlansTab analytics={analytics} /></TabsContent>
        <TabsContent value="coaches"><CoachesTab analytics={analytics} /></TabsContent>
        <TabsContent value="retention"><RetentionTab analytics={analytics} /></TabsContent>
      </Tabs>
    </div>
  );
}
