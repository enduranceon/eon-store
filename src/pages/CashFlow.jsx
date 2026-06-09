import { useMemo, useState } from 'react';
import {
  TrendingUp, Calendar, Wallet, RefreshCw,
  ChevronDown, ChevronRight, Zap, Banknote, CreditCard,
  ArrowUpRight, ArrowDownRight, Minus, BarChart3, PieChart as PieIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, LineChart, Line,
} from 'recharts';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function monthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : '';
}

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'short' })
    .replace('.', '');
}

function fullMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
}

function trendIcon(current, previous) {
  if (!previous || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 1) return { Icon: Minus, color: 'text-gray-400', label: '0%' };
  if (pct > 0) return { Icon: ArrowUpRight, color: 'text-green-600', label: `+${pct.toFixed(0)}%` };
  return { Icon: ArrowDownRight, color: 'text-red-500', label: `${pct.toFixed(0)}%` };
}

function nextNMonths(n) {
  const today = new Date(); today.setDate(1);
  const months = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    months.push(toLocalDateStr(d).slice(0, 7));
  }
  return months;
}

function lastNMonths(n) {
  const today = new Date(); today.setDate(1);
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push(toLocalDateStr(d).slice(0, 7));
  }
  return months;
}

// ─────────────────────────────────────────────────────────────────
// COMPONENTES
// ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon: Icon, iconBg, iconColor, valueColor, trend, accent }) {
  return (
    <Card className={accent || ''}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className={`p-2.5 rounded-lg ${iconBg}`}>
            <Icon className={`w-5 h-5 ${iconColor}`} />
          </div>
          {trend && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold ${trend.color}`}>
              <trend.Icon className="w-3.5 h-3.5" />
              {trend.label}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-3">{label}</p>
        <p className={`text-2xl font-bold mt-0.5 ${valueColor || 'text-gray-900'}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function MonthlyChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="bg-white border rounded-lg shadow-lg p-3 text-xs space-y-1">
      <p className="font-semibold text-gray-900 capitalize">{fullMonthLabel(data.ym)}</p>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Bruto</span>
        <span className="font-semibold">{formatCurrency(data.bruto)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-orange-600">Taxas</span>
        <span className="font-semibold text-orange-600">− {formatCurrency(data.taxas)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 border-t pt-1">
        <span className="text-green-700 font-semibold">Líquido</span>
        <span className="font-bold text-green-700">{formatCurrency(data.liquido)}</span>
      </div>
      <p className="text-[10px] text-muted-foreground pt-0.5">
        {data.count} parcela{data.count !== 1 ? 's' : ''}
      </p>
    </div>
  );
}

async function loadCashFlowPayments() {
  const start = new Date();
  start.setMonth(start.getMonth() - 12);
  start.setDate(1);
  const end = new Date();
  end.setMonth(end.getMonth() + 12);

  const { data, error } = await supabase
    .from('asaas_payments')
    .select('id, asaas_payment_id, order_id, order_type, status, source, value, net_value, credit_date, payment_date, due_date, billing_type, installment_number, total_installments, description, external_reference, payment_method_id')
    .gte('credit_date', toLocalDateStr(start))
    .lte('credit_date', toLocalDateStr(end))
    .in('status', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
    .order('credit_date', { ascending: true });

  if (error) throw error;
  return data || [];
}

// ─────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────
export default function CashFlow() {
  const { data: payments, loading, refreshing, refresh } = usePageData({
    key: 'cash-flow:payments',
    loader: loadCashFlowPayments,
    initialData: [],
    tags: ['asaas_payments'],
    onError: error => console.error('Erro ao carregar fluxo de caixa:', error),
  });
  const [expandedMonth, setExpandedMonth] = useState(null);

  const handleRefresh = () => {
    refresh({ force: true }).catch(() => {});
  };

  // ── Cálculos ────────────────────────────────────────────────────
  const todayStr = todayLocalStr();
  const currentYM = todayStr.slice(0, 7);

  // Futuros (a partir do mês atual)
  const futurePayments = useMemo(
    () => payments.filter(p => p.credit_date && p.credit_date >= currentYM + '-01'),
    [payments, currentYM]
  );

  // Próximos 6 meses (projeção principal)
  const next6Months = useMemo(() => nextNMonths(6), []);
  const next6Data = useMemo(() => {
    return next6Months.map(ym => {
      const monthPayments = payments.filter(p => monthKey(p.credit_date) === ym);
      const bruto = monthPayments.reduce((s, p) => s + (Number(p.value) || 0), 0);
      const liquido = monthPayments.reduce((s, p) => s + (Number(p.net_value) || Number(p.value) || 0), 0);
      return {
        ym,
        month: monthLabel(ym),
        bruto,
        liquido,
        taxas: bruto - liquido,
        count: monthPayments.length,
        items: monthPayments,
      };
    });
  }, [payments, next6Months]);

  // Últimos 6 meses (histórico)
  const last6Months = useMemo(() => lastNMonths(6), []);
  const last6Data = useMemo(() => {
    return last6Months.map(ym => {
      const monthPayments = payments.filter(p => monthKey(p.credit_date) === ym);
      const bruto = monthPayments.reduce((s, p) => s + (Number(p.value) || 0), 0);
      const liquido = monthPayments.reduce((s, p) => s + (Number(p.net_value) || Number(p.value) || 0), 0);
      return {
        ym,
        month: monthLabel(ym),
        bruto,
        liquido,
        taxas: bruto - liquido,
        count: monthPayments.length,
      };
    });
  }, [payments, last6Months]);

  // KPIs principais
  const totalFutureGross = futurePayments.reduce((s, p) => s + (Number(p.value) || 0), 0);
  const totalFutureNet   = futurePayments.reduce((s, p) => s + (Number(p.net_value) || Number(p.value) || 0), 0);

  const nextMonth = next6Data[1]; // [0] = mês atual, [1] = próximo
  const currentMonth = next6Data[0];

  // Média mensal projetada
  const avgMonthlyProjection = totalFutureNet / Math.max(1, next6Data.filter(d => d.bruto > 0).length);

  // Recebido este mês
  const receivedThisMonth = payments
    .filter(p => monthKey(p.credit_date) === currentYM && p.credit_date <= todayStr)
    .reduce((s, p) => s + (Number(p.net_value) || Number(p.value) || 0), 0);

  // Mês anterior
  const lastMonthYM = (() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1); d.setDate(1);
    return toLocalDateStr(d).slice(0, 7);
  })();
  const receivedLastMonth = payments
    .filter(p => monthKey(p.credit_date) === lastMonthYM)
    .reduce((s, p) => s + (Number(p.net_value) || Number(p.value) || 0), 0);

  // Por origem (cartão Asaas vs Manual)
  const bySource = useMemo(() => {
    const map = {};
    for (const p of futurePayments) {
      const key = p.source || 'desconhecido';
      if (!map[key]) map[key] = { source: key, value: 0, count: 0 };
      map[key].value += Number(p.net_value) || Number(p.value) || 0;
      map[key].count++;
    }
    return Object.values(map).sort((a, b) => b.value - a.value);
  }, [futurePayments]);

  // Normaliza billing_type para chave única (cartão vem como CREDIT, CREDIT_CARD, etc.)
  const normalizeBillingType = (t) => {
    if (!t) return 'OUTROS';
    const up = String(t).toUpperCase();
    if (up === 'CREDIT' || up === 'CREDIT_CARD' || up.includes('CARD') || up.includes('CREDIT')) return 'CREDIT_CARD';
    if (up === 'DEBIT' || up === 'DEBIT_CARD') return 'DEBIT_CARD';
    return up;
  };

  // Por forma de pagamento (billing_type)
  const byBillingType = useMemo(() => {
    const map = {};
    for (const p of futurePayments) {
      const key = normalizeBillingType(p.billing_type);
      if (!map[key]) map[key] = { type: key, value: 0, count: 0 };
      map[key].value += Number(p.net_value) || Number(p.value) || 0;
      map[key].count++;
    }
    return Object.values(map).sort((a, b) => b.value - a.value);
  }, [futurePayments]);

  // ── Render ──────────────────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-2">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm text-muted-foreground">Carregando fluxo de caixa...</p>
      </div>
    </div>
  );

  const billingLabel = (type) => ({
    PIX: 'PIX', BOLETO: 'Boleto', CREDIT_CARD: 'Cartão de crédito', CREDIT: 'Cartão de crédito',
    DEBIT_CARD: 'Cartão de débito', CASH: 'Dinheiro', BANK_TRANSFER: 'Transferência',
    UNDEFINED: 'Não informado', OUTROS: 'Outros',
  }[type] || type);

  const billingIcon = (type) => {
    if (type === 'PIX')         return <Zap className="w-3.5 h-3.5" />;
    if (type === 'BOLETO')      return <Banknote className="w-3.5 h-3.5" />;
    if (type?.includes('CARD')) return <CreditCard className="w-3.5 h-3.5" />;
    if (type?.includes('CREDIT'))return <CreditCard className="w-3.5 h-3.5" />;
    return <Wallet className="w-3.5 h-3.5" />;
  };

  return (
    <div className="space-y-6">

      {/* ── Cabeçalho ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-emerald-600" />
            Fluxo de Caixa
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Previsibilidade de recebimentos · {futurePayments.length} parcelas confirmadas a receber
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Atualizando...' : 'Atualizar'}
        </Button>
      </div>

      {/* ── KPIs ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="A receber (próximos 6 meses)"
          value={formatCurrency(totalFutureNet)}
          sub={`${futurePayments.length} parcelas · bruto ${formatCurrency(totalFutureGross)}`}
          icon={Wallet}
          iconBg="bg-emerald-50" iconColor="text-emerald-600" valueColor="text-emerald-700"
          accent="border-emerald-200"
        />
        <KpiCard
          label="Recebido este mês"
          value={formatCurrency(receivedThisMonth)}
          sub={currentMonth ? `${currentMonth.count} parcela${currentMonth.count !== 1 ? 's' : ''} no mês` : ''}
          icon={TrendingUp}
          iconBg="bg-blue-50" iconColor="text-blue-600" valueColor="text-blue-700"
          trend={trendIcon(receivedThisMonth, receivedLastMonth)}
        />
        <KpiCard
          label="Próximo mês"
          value={formatCurrency(nextMonth?.liquido || 0)}
          sub={nextMonth ? `${nextMonth.count} parcela${nextMonth.count !== 1 ? 's' : ''} · ${fullMonthLabel(nextMonth.ym)}` : ''}
          icon={Calendar}
          iconBg="bg-amber-50" iconColor="text-amber-600" valueColor="text-amber-700"
        />
        <KpiCard
          label="Média mensal projetada"
          value={formatCurrency(avgMonthlyProjection)}
          sub="próximos 6 meses"
          icon={BarChart3}
          iconBg="bg-purple-50" iconColor="text-purple-600" valueColor="text-purple-700"
        />
      </div>

      {/* ── GRÁFICO PRINCIPAL: Projeção dos próximos 6 meses ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-600" />
            Projeção dos próximos 6 meses
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Parcelas confirmadas — combinação de cartão Asaas e pagamentos manuais parcelados
          </p>
        </CardHeader>
        <CardContent>
          {next6Data.every(d => d.bruto === 0) ? (
            <div className="text-center py-12">
              <Calendar className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Sem recebimentos projetados nos próximos 6 meses.</p>
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={next6Data} barCategoryGap="25%" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#6b7280' }}
                    axisLine={false} tickLine={false}
                    tickFormatter={v => v === 0 ? '' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}
                    width={42}
                  />
                  <Tooltip content={<MonthlyChartTooltip />} cursor={{ fill: '#f9fafb' }} />
                  <Bar dataKey="liquido" stackId="a" radius={[0, 0, 0, 0]} maxBarSize={64}>
                    {next6Data.map(d => (
                      <Cell key={d.ym} fill={d.ym === currentYM ? '#059669' : '#6ee7b7'} />
                    ))}
                  </Bar>
                  <Bar dataKey="taxas" stackId="a" radius={[6, 6, 0, 0]} maxBarSize={64} fill="#fb923c" />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs text-muted-foreground border-t pt-3">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Líquido (mês atual)</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-300" /> Líquido (futuro)</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-orange-400" /> Taxas de gateway</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Detalhamento mensal expansível ──────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="w-4 h-4 text-blue-600" />
            Detalhamento por mês
          </CardTitle>
          <p className="text-xs text-muted-foreground">Clique em um mês para ver as parcelas individuais</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {next6Data.filter(m => m.count > 0).map(m => {
              const isOpen = expandedMonth === m.ym;
              const isCurrent = m.ym === currentYM;
              return (
                <div key={m.ym} className={`border rounded-xl bg-white ${isCurrent ? 'border-emerald-300 bg-emerald-50/30' : ''}`}>
                  <button
                    onClick={() => setExpandedMonth(isOpen ? null : m.ym)}
                    className="w-full p-3.5 flex items-center justify-between hover:bg-gray-50 rounded-xl text-left"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {isOpen ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                      <div>
                        <p className="font-semibold capitalize text-sm">
                          {fullMonthLabel(m.ym)}
                          {isCurrent && <span className="ml-2 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium uppercase">Mês atual</span>}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {m.count} parcela{m.count !== 1 ? 's' : ''} · bruto {formatCurrency(m.bruto)} · taxas {formatCurrency(m.taxas)}
                        </p>
                      </div>
                    </div>
                    <p className="font-bold text-emerald-700 shrink-0 ml-3">{formatCurrency(m.liquido)}</p>
                  </button>
                  {isOpen && (
                    <div className="border-t divide-y">
                      {m.items
                        .sort((a, b) => (a.credit_date || '').localeCompare(b.credit_date || ''))
                        .map(item => (
                          <div key={item.id} className="flex items-center gap-3 p-3 text-sm hover:bg-gray-50">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 w-20">
                              {billingIcon(item.billing_type)}
                              <span>{formatDate(item.credit_date)}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate text-xs">
                                {item.description || item.external_reference || `Parcela #${item.installment_number || '?'}`}
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {item.source === 'manual' ? '✋ Manual' : '⚡ Asaas'}
                                {item.installment_number && item.total_installments > 1 &&
                                  ` · ${item.installment_number}/${item.total_installments}`}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-semibold text-sm">{formatCurrency(item.net_value || item.value)}</p>
                              {item.value !== item.net_value && (
                                <p className="text-[10px] text-muted-foreground">bruto {formatCurrency(item.value)}</p>
                              )}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
            {next6Data.filter(m => m.count > 0).length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">Nenhuma parcela projetada para os próximos meses.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Composição: origem + forma de pagamento ─────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Por origem */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <PieIcon className="w-4 h-4 text-blue-600" />
              Por origem
            </CardTitle>
            <p className="text-xs text-muted-foreground">Asaas vs registro manual</p>
          </CardHeader>
          <CardContent>
            {bySource.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">Sem dados.</p>
            ) : (
              <div className="space-y-3">
                {bySource.map(s => {
                  const pct = totalFutureNet > 0 ? (s.value / totalFutureNet) * 100 : 0;
                  const color = s.source === 'asaas' ? 'bg-purple-500' : 'bg-blue-500';
                  const label = s.source === 'asaas' ? '⚡ Cobrança Asaas' :
                                s.source === 'manual' ? '✋ Registro manual' : s.source;
                  return (
                    <div key={s.source}>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="font-medium">{label}</span>
                        <div className="text-right">
                          <span className="font-bold text-emerald-700">{formatCurrency(s.value)}</span>
                          <span className="text-xs text-muted-foreground ml-2">{pct.toFixed(0)}% · {s.count}p</span>
                        </div>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Por forma de pagamento */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-blue-600" />
              Por forma de pagamento
            </CardTitle>
            <p className="text-xs text-muted-foreground">Distribuição das parcelas futuras</p>
          </CardHeader>
          <CardContent>
            {byBillingType.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">Sem dados.</p>
            ) : (
              <div className="space-y-3">
                {byBillingType.map(b => {
                  const pct = totalFutureNet > 0 ? (b.value / totalFutureNet) * 100 : 0;
                  return (
                    <div key={b.type}>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="font-medium flex items-center gap-1.5">
                          {billingIcon(b.type)}
                          {billingLabel(b.type)}
                        </span>
                        <div className="text-right">
                          <span className="font-bold text-emerald-700">{formatCurrency(b.value)}</span>
                          <span className="text-xs text-muted-foreground ml-2">{pct.toFixed(0)}% · {b.count}p</span>
                        </div>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Histórico: últimos 6 meses ──────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-600" />
            Histórico — últimos 6 meses
          </CardTitle>
          <p className="text-xs text-muted-foreground">Recebimentos realizados</p>
        </CardHeader>
        <CardContent>
          {last6Data.every(d => d.bruto === 0) ? (
            <p className="text-sm text-muted-foreground text-center py-6">Sem histórico de recebimentos.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={last6Data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  axisLine={false} tickLine={false}
                  tickFormatter={v => v === 0 ? '' : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  width={36}
                />
                <Tooltip content={<MonthlyChartTooltip />} />
                <Line type="monotone" dataKey="liquido" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 4, fill: '#3b82f6' }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
