import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, CalendarDays,
  CheckCircle2, CircleDollarSign, Clock3, CreditCard, Landmark,
  RefreshCw, TrendingUp, Wallet,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { listFinancialDataQuality, listFinancialMovements } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePageData } from '@/hooks/usePageData';
import {
  FINANCIAL_DASHBOARD_PERIOD_OPTIONS,
  FINANCIAL_UNIT_META,
  buildFinancialDashboard,
  financialMovementDate,
  financialUnitLabel,
} from '@/lib/financial-dashboard';
import { financialQualitySeverityLabel } from '@/lib/financial-ledger';
import {
  financialQualityTypeMeta,
  financialQualityUnitLabel,
  summarizeFinancialQuality,
} from '@/lib/financial-quality';
import { cn, formatCurrency, formatDate, toLocalDateStr } from '@/lib/utils';

const MOVEMENT_LABEL = {
  receipt: 'Recebimento',
  refund: 'Estorno',
  expense: 'Despesa',
  payout: 'Repasse',
  payout_adjustment: 'Ajuste de repasse',
};

const MOVEMENT_TONE = {
  receipt: 'bg-emerald-100 text-emerald-700',
  refund: 'bg-rose-100 text-rose-700',
  expense: 'bg-orange-100 text-orange-700',
  payout: 'bg-violet-100 text-violet-700',
  payout_adjustment: 'bg-blue-100 text-blue-700',
};

function monthsAgo(amount) {
  const date = new Date();
  date.setMonth(date.getMonth() - amount);
  date.setDate(1);
  return toLocalDateStr(date);
}

async function loadManagementDashboard() {
  const [actualMovements, receivablesMovements, qualityIssues] = await Promise.all([
    listFinancialMovements({
      isActual: true,
      scheduledFrom: monthsAgo(13),
      sort: '-scheduled_on',
    }).catch(error => {
      console.error('[Dashboard] Erro ao carregar realizados:', error);
      return [];
    }),
    listFinancialMovements({
      movementKind: 'receivable',
      isActual: false,
      sort: 'due_on',
    }).catch(error => {
      console.error('[Dashboard] Erro ao carregar recebíveis:', error);
      return [];
    }),
    listFinancialDataQuality().catch(error => {
      console.error('[Dashboard] Erro ao carregar qualidade financeira:', error);
      return [];
    }),
  ]);

  const movements = new Map();
  [...actualMovements, ...receivablesMovements].forEach(movement => {
    movements.set(movement.movement_id, movement);
  });

  return { movements: [...movements.values()], qualityIssues };
}

function formatCompactCurrency(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1_000_000) return `R$ ${(amount / 1_000_000).toFixed(1)} mi`;
  if (Math.abs(amount) >= 1_000) return `R$ ${(amount / 1_000).toFixed(1)} mil`;
  return formatCurrency(amount);
}

function MetricCard({ label, value, sub, icon: Icon, tone = 'blue', to }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    orange: 'bg-orange-50 text-orange-700 border-orange-100',
    red: 'bg-rose-50 text-rose-700 border-rose-100',
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
  };
  const content = (
    <Card className={cn('h-full transition-shadow', to && 'hover:shadow-sm')}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 truncate">{value}</p>
            {sub && <p className="mt-1 text-[11px] text-muted-foreground truncate">{sub}</p>}
          </div>
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', tones[tone])}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return to ? <Link to={to} className="block h-full">{content}</Link> : content;
}

function CurrencyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-white p-3 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold">{label}</p>
      {payload.map(item => (
        <div key={item.dataKey} className="flex justify-between gap-6" style={{ color: item.color }}>
          <span>{item.name}</span><b>{formatCurrency(item.value)}</b>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="flex h-64 items-center justify-center rounded-lg border border-dashed bg-gray-50 px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function QualitySummary({ issues }) {
  const summary = summarizeFinancialQuality(issues);
  const visibleGroups = summary.groups.slice(0, 3);

  return (
    <Card className={summary.totalCount ? 'border-amber-200' : 'border-emerald-200'}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className={cn('w-4 h-4', summary.totalCount ? 'text-amber-600' : 'text-emerald-600')} />
            Qualidade financeira
          </CardTitle>
          <Link to="/financeiro/conciliacao" className="text-xs font-semibold text-blue-700 hover:underline">Abrir fila</Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {summary.totalCount === 0 ? (
          <p className="py-1 text-sm text-emerald-700">Sem pendências de conciliação.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-700">
              {summary.totalCount} registro{summary.totalCount !== 1 ? 's' : ''} em {summary.groupCount} grupo{summary.groupCount !== 1 ? 's' : ''}
              {summary.highCount ? `, sendo ${summary.highCount} de prioridade alta` : ''}.
            </p>
            <div className="divide-y">
              {visibleGroups.map(group => {
                const meta = financialQualityTypeMeta(group.issueType);
                return (
                <div key={group.key} className="flex items-center gap-3 py-2.5 first:pt-0">
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    group.severity === 'high' ? 'bg-rose-100 text-rose-700' : group.severity === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700',
                  )}>{financialQualitySeverityLabel(group.severity)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-800">{meta.label}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {financialQualityUnitLabel(group.businessUnit)} · {group.count} registro{group.count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-gray-800">{formatCurrency(group.totalAmount)}</span>
                </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [period, setPeriod] = useState('month');
  const { data, loading, refreshing, refresh } = usePageData({
    key: 'management-dashboard:v1',
    loader: loadManagementDashboard,
    initialData: { movements: [], qualityIssues: [] },
    maxAge: 60_000,
    tags: ['financial_movements', 'financial_data_quality', 'asaas_payments', 'event_expenses', 'payout_monthly_closings'],
  });
  const dashboard = useMemo(
    () => buildFinancialDashboard(data.movements, { period }),
    [data.movements, period],
  );
  const { summary } = dashboard;
  const receiptMargin = summary.netReceipts > 0
    ? `${((summary.operatingResult / summary.netReceipts) * 100).toFixed(1)}% sobre o recebido líquido`
    : 'Aguardando recebimentos no período';
  const unitKeys = ['assessoria', 'loja', 'pre_venda', 'eventos'];

  if (loading) {
    return (
      <div className="flex min-h-[55vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <RefreshCw className="h-7 w-7 animate-spin text-blue-600" />
        <p className="text-sm">Montando a visão geral do negócio...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Landmark className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Visão geral</h1>
              <p className="text-sm text-muted-foreground">Caixa, cobranças e resultado por área.</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[168px] bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FINANCIAL_DASHBOARD_PERIOD_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" title="Atualizar dados" onClick={() => refresh({ force: true })} disabled={refreshing}>
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="Recebido líquido"
          value={formatCompactCurrency(summary.netReceipts)}
          sub={`${formatCurrency(summary.grossReceipts)} bruto · ${formatCurrency(summary.fees)} em taxas`}
          icon={Wallet}
          tone="green"
          to="/financeiro/fluxo-caixa"
        />
        <MetricCard
          label="Resultado de caixa"
          value={formatCompactCurrency(summary.operatingResult)}
          sub={receiptMargin}
          icon={summary.operatingResult >= 0 ? TrendingUp : ArrowDownRight}
          tone={summary.operatingResult >= 0 ? 'blue' : 'red'}
          to="/analytics"
        />
        <MetricCard
          label="Cobranças em aberto"
          value={formatCompactCurrency(summary.openReceivables)}
          sub={`${summary.receivableCount} cobrança${summary.receivableCount !== 1 ? 's' : ''} já registrada${summary.receivableCount !== 1 ? 's' : ''}`}
          icon={CreditCard}
          tone="orange"
          to="/financeiro"
        />
        <MetricCard
          label="Vencido para receber"
          value={formatCompactCurrency(summary.overdueReceivables)}
          sub={summary.dueSoonReceivables ? `${formatCurrency(summary.dueSoonReceivables)} vence nos próximos 7 dias` : 'Sem vencimentos próximos'}
          icon={AlertTriangle}
          tone={summary.overdueReceivables > 0 ? 'red' : 'violet'}
          to="/financeiro"
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="h-4 w-4 text-blue-600" /> Movimento de caixa</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">Entradas líquidas e saídas efetivamente registradas.</p>
              </div>
              <span className="text-xs font-semibold text-muted-foreground">{dashboard.period.label}</span>
            </div>
          </CardHeader>
          <CardContent>
            {dashboard.monthlySeries.some(row => row.receipts || row.outflows) ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboard.monthlySeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={value => formatCompactCurrency(value).replace('R$ ', '')} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                    <Tooltip content={<CurrencyTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="receipts" name="Recebido líquido" fill="#059669" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="outflows" name="Saídas" fill="#f97316" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyState>Nenhum lançamento confirmado no período selecionado.</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><CircleDollarSign className="h-4 w-4 text-violet-600" /> Composição do resultado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: 'Recebimentos líquidos', value: summary.netReceipts, className: 'text-emerald-700' },
              { label: 'Estornos', value: -summary.refunds, className: 'text-rose-700' },
              { label: 'Despesas operacionais', value: -summary.expenses, className: 'text-orange-700' },
              { label: 'Repasses pagos', value: -summary.payouts, className: 'text-violet-700' },
            ].map(row => (
              <div key={row.label} className="flex items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0">
                <span className="text-sm text-muted-foreground">{row.label}</span>
                <span className={cn('shrink-0 text-sm font-bold', row.className)}>{formatCurrency(row.value)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <span className="font-semibold text-gray-900">Resultado de caixa</span>
              <span className={cn('text-lg font-bold', summary.operatingResult >= 0 ? 'text-emerald-700' : 'text-rose-700')}>
                {formatCurrency(summary.operatingResult)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Áreas do negócio</h2>
            <p className="text-xs text-muted-foreground">Resultado de caixa no período e cobranças abertas atuais.</p>
          </div>
          <Link to="/analytics" className="text-sm font-semibold text-blue-700 hover:underline">Ver análises</Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {unitKeys.map(unit => {
            const values = summary.byUnit[unit] || {};
            const meta = FINANCIAL_UNIT_META[unit];
            const result = Number(values.operatingResult) || 0;
            return (
              <div key={unit} className="border bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-gray-800">{meta.label}</span>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: meta.color }} />
                </div>
                <p className={cn('mt-3 text-xl font-bold', result >= 0 ? 'text-gray-900' : 'text-rose-700')}>{formatCurrency(result)}</p>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Recebido {formatCurrency(values.netReceipts || 0)}</span>
                  <span>{formatCurrency(values.openReceivables || 0)} aberto</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Lançamentos recentes</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">Caixa confirmado no período selecionado.</p>
              </div>
              <Link to="/financeiro/fluxo-caixa" className="text-xs font-semibold text-blue-700 hover:underline">Fluxo de caixa</Link>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {dashboard.recentMovements.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhum lançamento confirmado neste período.</p>
            ) : (
              <div className="divide-y">
                {dashboard.recentMovements.map(movement => {
                  const amount = Number(movement.signed_net_amount) || 0;
                  return (
                    <div key={movement.movement_id} className="flex items-center gap-3 py-3">
                      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', MOVEMENT_TONE[movement.movement_kind] || 'bg-gray-100 text-gray-600')}>
                        {MOVEMENT_LABEL[movement.movement_kind] || 'Movimento'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-800">{movement.description || movement.reference || 'Lançamento financeiro'}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{financialUnitLabel(movement.business_unit)} · {formatDate(financialMovementDate(movement))}</p>
                      </div>
                      <span className={cn('shrink-0 text-sm font-bold', amount >= 0 ? 'text-emerald-700' : 'text-rose-700')}>
                        {amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(amount))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base"><Clock3 className="h-4 w-4 text-amber-600" /> Próximos recebimentos</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">Cobranças criadas que ainda não viraram caixa.</p>
              </div>
              <Link to="/financeiro" className="text-xs font-semibold text-blue-700 hover:underline">Cobranças</Link>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {dashboard.openReceivables.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma cobrança registrada em aberto.</p>
            ) : (
              <div className="divide-y">
                {dashboard.openReceivables.map(movement => {
                  const dueOn = financialMovementDate(movement);
                  const overdue = dueOn && dueOn < dashboard.period.to;
                  return (
                    <div key={movement.movement_id} className="flex items-center gap-3 py-3">
                      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', overdue ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700')}>
                        {overdue ? 'Vencida' : 'Em aberto'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-800">{movement.description || movement.reference || 'Cobrança'}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{financialUnitLabel(movement.business_unit)} · {dueOn ? `vence ${formatDate(dueOn)}` : 'sem vencimento'}</p>
                      </div>
                      <span className="shrink-0 text-sm font-bold text-gray-900">{formatCurrency(movement.gross_amount)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <QualitySummary issues={data.qualityIssues} />

      <div className="flex flex-wrap gap-2 border-t pt-5">
        <Link to="/financeiro"><Button variant="outline" size="sm"><CreditCard className="mr-1.5 h-3.5 w-3.5" />Cobranças</Button></Link>
        <Link to="/financeiro/fluxo-caixa"><Button variant="outline" size="sm"><CalendarDays className="mr-1.5 h-3.5 w-3.5" />Fluxo de caixa</Button></Link>
        <Link to="/analytics"><Button variant="outline" size="sm"><ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />Analytics</Button></Link>
      </div>
    </div>
  );
}
