import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  DollarSign, Calendar, CheckCircle2, Clock, AlertTriangle,
  TrendingDown, ChevronRight, RefreshCw, CreditCard, Banknote,
  Zap, ArrowUpRight, ArrowDownRight, Minus, Wallet, Receipt,
  BarChart3, Target, RotateCcw, CheckCheck,
} from 'lucide-react';
import { calcGatewayFee } from '@/lib/payment-methods';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from 'recharts';

// ─────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────
const RECEIVABLES_CACHE_KEY = 'asaas_receivables_cache_v1';
const RECEIVABLES_CACHE_TTL = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function getTodayStr()      { return todayLocalStr(); }
function getMonthStartStr() { const d = new Date(); d.setDate(1); return toLocalDateStr(d); }
function getLastMonthStart() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return toLocalDateStr(d);
}
function getLastMonthEnd() {
  const d = new Date(); d.setDate(0); return toLocalDateStr(d); // dia 0 do mês atual = último dia do mês anterior
}

function daysDiff(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'short' })
    .replace('.', '');
}

function trendIcon(current, previous) {
  if (!previous || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 1) return { icon: Minus, color: 'text-gray-400', label: '0%' };
  if (pct > 0) return { icon: ArrowUpRight, color: 'text-green-600', label: `+${pct.toFixed(0)}%` };
  return { icon: ArrowDownRight, color: 'text-red-500', label: `${pct.toFixed(0)}%` };
}

// Para contratos parcelados (card_6x, card_3x…), apenas 1 parcela é creditada por mês.
// Retorna o número de parcelas extraído de payment_method ou do campo installments.
function getInstallmentN(o) {
  if (o.installments && o.installments > 1) return o.installments;
  const pm = (o.payment_method || '').toLowerCase();
  const m = pm.match(/^card_(\d+)x$/);
  if (m) return parseInt(m[1]);
  return 1;
}

// Valor efetivo que chega em caixa por mês para um pedido/contrato.
function effectiveMonthlyValue(o) {
  return (o.total_value || 0) / getInstallmentN(o);
}

// Taxa de gateway proporcional à parcela mensal.
function effectiveMonthlyFee(o) {
  const n = getInstallmentN(o);
  const mVal = (o.total_value || 0) / n;
  const mManualFee = (o.manual_fee != null && o.manual_fee !== '') ? (Number(o.manual_fee) / n) : null;
  return calcGatewayFee(mVal, o.payment_method, mManualFee);
}

// ─────────────────────────────────────────────────────────────────
// SUB-COMPONENTES
// ─────────────────────────────────────────────────────────────────
function DueChip({ dateStr }) {
  const diff = daysDiff(dateStr);
  let label, cls;
  if (diff < 0)       { label = `${Math.abs(diff)}d em atraso`; cls = 'bg-red-100 text-red-700'; }
  else if (diff === 0){ label = 'Vence hoje';                   cls = 'bg-orange-100 text-orange-700'; }
  else if (diff === 1){ label = 'Amanhã';                       cls = 'bg-orange-50 text-orange-600'; }
  else if (diff <= 7) { label = `Em ${diff} dias`;              cls = 'bg-amber-50 text-amber-700'; }
  else                { label = formatDate(dateStr);             cls = 'bg-blue-50 text-blue-700'; }
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{label}</span>
  );
}

function OrderRow({ o }) {
  const link = o.type === 'stock'    ? `/estoque/pedidos/${o.id}`
             : o.type === 'contract' ? `/assessoria/contratos/${o.id}`
             : `/pedidos/${o.id}`;
  return (
    <Link to={link} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-blue-700">{o.order_number}</span>
          {o.type === 'stock' && (
            <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Loja</span>
          )}
          {o.type === 'contract' && (
            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">🏃 Assessoria</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{o.customer}</p>
      </div>
      {o.due_date && <DueChip dateStr={o.due_date} />}
      {o.payment_date && !o.due_date && (
        <span className="text-xs text-muted-foreground">{formatDate(o.payment_date)}</span>
      )}
      <span className="font-semibold text-sm">{formatCurrency(o.total_value)}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

function OrderSection({ title, icon: Icon, iconCls, orders, emptyMsg, border, badgeCls, total }) {
  if (orders.length === 0) return null;
  return (
    <Card className={border || ''}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className={`text-base flex items-center gap-2 ${iconCls || 'text-gray-800'}`}>
            <Icon className="w-4 h-4" />
            {title}
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badgeCls || 'bg-gray-100 text-gray-600'}`}>
              {orders.length}
            </span>
          </CardTitle>
          {total != null && (
            <span className="font-bold text-sm">{formatCurrency(total)}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {orders.length === 0
          ? <p className="text-sm text-muted-foreground py-4 text-center">{emptyMsg}</p>
          : <div className="divide-y">{orders.map(o => <OrderRow key={o.id + o.type} o={o} />)}</div>
        }
      </CardContent>
    </Card>
  );
}

// KPI Card com trend arrow
function KpiCard({ label, value, sub, icon: Icon, iconBg, iconColor, valueColor, trend }) {
  const t = trend;
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${valueColor || 'text-gray-900'}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
            {t && (
              <div className={`flex items-center gap-0.5 mt-1 text-xs font-semibold ${t.color}`}>
                <t.icon className="w-3 h-3" />
                <span>{t.label} vs mês anterior</span>
              </div>
            )}
          </div>
          <div className={`p-2.5 rounded-full shrink-0 ${iconBg}`}>
            <Icon className={`w-5 h-5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Tooltip customizado para o gráfico
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold text-gray-700 mb-1 capitalize">{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} className="text-green-700 font-bold">{formatCurrency(p.value)}</p>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────
export default function Financial() {
  const [loading, setLoading]             = useState(true);
  const [orders, setOrders]               = useState([]);
  const [centers, setCenters]             = useState([]);
  const [receivables, setReceivables]     = useState([]);
  const [loadingRec, setLoadingRec]       = useState(false);
  const [fetchedAt, setFetchedAt]         = useState(null);
  const [pendingRefunds, setPendingRefunds] = useState([]);
  const [refundDoneModal, setRefundDoneModal] = useState(null); // { contract } | null
  const [refundDoneForm, setRefundDoneForm]   = useState({ date: '', notes: '' });
  const [savingRefund, setSavingRefund]       = useState(false);

  // ── Fetch Asaas ───────────────────────────────────────────────
  const fetchReceivables = async (force = false) => {
    if (!force) {
      try {
        const cached = localStorage.getItem(RECEIVABLES_CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < RECEIVABLES_CACHE_TTL) {
            setReceivables(data); setFetchedAt(new Date(timestamp)); return;
          }
        }
      } catch { /* ignora */ }
    }
    setLoadingRec(true);
    try {
      const { data, error } = await supabase.functions.invoke('fetch-asaas-receivables');
      if (error) {
        let msg = error.message;
        try { if (error.context?.json) { const b = await error.context.json(); if (b?.error) msg = b.error; } } catch { /* */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      const payments = data?.payments || [];
      setReceivables(payments);
      const now = Date.now(); setFetchedAt(new Date(now));
      try { localStorage.setItem(RECEIVABLES_CACHE_KEY, JSON.stringify({ data: payments, timestamp: now })); } catch { /* */ }
    } catch (e) {
      toast.error('Erro ao buscar recebíveis: ' + (e.message || 'desconhecido'));
    } finally { setLoadingRec(false); }
  };

  useEffect(() => { fetchReceivables(false); }, []);

  // ── Fetch pedidos/contratos ────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [presaleRes, stockRes, contractRes, plansRes, customersRes, centersRes, stockProductsRes] = await Promise.all([
          supabase.from('presale_orders')
            .select('id, order_number, checkout_name, total_value, payment_status, payment_date, due_date, asaas_charge_id, payment_method, manual_fee, items')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('stock_orders')
            .select('id, order_number, customer_name, total_value, payment_status, payment_date, due_date, asaas_charge_id, payment_method, manual_fee, items')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('assessment_contracts')
            .select('id, contract_number, customer_id, plan_id, payment_status, payment_date, due_date, asaas_charge_id, payment_method, manual_fee, enrollment_fee, manual_discount, status, installments, plan_snapshot')
            .neq('status', 'cancelled').neq('status', 'draft').neq('payment_status', 'refunded'),
          supabase.from('assessment_plans').select('id, price_total, name, revenue_center_id'),
          supabase.from('presale_customers').select('id, full_name'),
          supabase.from('revenue_centers').select('id, name, color'),
          supabase.from('stock_products').select('id, revenue_center_id'),
        ]);

        const plansMap         = Object.fromEntries((plansRes.data         || []).map(p => [p.id, p]));
        const customersMap     = Object.fromEntries((customersRes.data     || []).map(c => [c.id, c]));
        const stockProductsMap = Object.fromEntries((stockProductsRes.data || []).map(p => [p.id, p]));
        const orderCenter = (items) => {
          if (!items?.length) return null;
          return stockProductsMap[items[0].product_id]?.revenue_center_id || null;
        };

        const presale   = (presaleRes.data   || []).map(o => ({ ...o, type: 'presale',  customer: o.checkout_name,  revenue_center_id: orderCenter(o.items) }));
        const stock     = (stockRes.data     || []).map(o => ({ ...o, type: 'stock',    customer: o.customer_name,  revenue_center_id: orderCenter(o.items) }));
        const contracts = (contractRes.data  || []).map(c => {
          const plan = plansMap[c.plan_id];
          // Preserva histórico financeiro: snapshot tem prioridade sobre o plano vivo
          const snapPrice = c.plan_snapshot?.price_total;
          const base = snapPrice != null ? Number(snapPrice) : (plan ? Number(plan.price_total) : 0);
          const total_value = Math.max(0, base + (Number(c.enrollment_fee) || 0) - (Number(c.manual_discount) || 0));
          return {
            id: c.id, order_number: c.contract_number,
            customer: customersMap[c.customer_id]?.full_name || '—',
            total_value, payment_status: c.payment_status, payment_method: c.payment_method,
            payment_date: c.payment_date, due_date: c.due_date,
            asaas_charge_id: c.asaas_charge_id, manual_fee: c.manual_fee,
            type: 'contract',
            revenue_center_id: c.plan_snapshot?.revenue_center_id || plan?.revenue_center_id || null,
            installments: c.installments || 1,
          };
        });

        setOrders([...presale, ...stock, ...contracts]);
        setCenters(centersRes.data || []);

        // ── Estornos pendentes ──────────────────────────────────────
        const { data: refundContracts } = await supabase
          .from('assessment_contracts')
          .select('id, contract_number, customer_id, refund_amount, refund_status, payment_method, cancellation_reason, updated_at')
          .eq('refund_status', 'pending');

        if (refundContracts?.length) {
          const customerIds = [...new Set(refundContracts.map(c => c.customer_id).filter(Boolean))];
          const { data: rfCustomers } = await supabase
            .from('presale_customers').select('id, full_name').in('id', customerIds);
          const rfCustMap = Object.fromEntries((rfCustomers || []).map(c => [c.id, c]));
          setPendingRefunds(refundContracts.map(c => ({
            ...c,
            customer_name: rfCustMap[c.customer_id]?.full_name || '—',
          })));
        } else {
          setPendingRefunds([]);
        }
      } catch (e) {
        console.error('Erro ao carregar Financeiro:', e);
      } finally { setLoading(false); }
    };
    load();
  }, []);

  // ── Cálculos ──────────────────────────────────────────────────
  const todayStr       = getTodayStr();
  const monthStart     = getMonthStartStr();
  const lastMonthStart = getLastMonthStart();
  const lastMonthEnd   = getLastMonthEnd();

  const activeOrders = orders.filter(o => o.payment_status !== 'paid');

  const paidThisMonth = orders
    .filter(o => o.payment_status === 'paid' && o.payment_date >= monthStart)
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  const paidLastMonth = orders
    .filter(o => o.payment_status === 'paid' && o.payment_date >= lastMonthStart && o.payment_date <= lastMonthEnd);

  const overdue    = activeOrders.filter(o => o.due_date && o.due_date < todayStr).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const upcoming   = activeOrders.filter(o => o.due_date && o.due_date >= todayStr).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const chargedNoDate = activeOrders.filter(o => !o.due_date && o.asaas_charge_id);
  const noCharge   = activeOrders.filter(o => ['awaiting_charge', 'message_sent'].includes(o.payment_status));

  // KPI valores — contratos parcelados contribuem apenas 1 parcela/mês
  const receivedMonth = paidThisMonth.reduce((s, o) => s + effectiveMonthlyValue(o), 0);
  const feesMonth     = paidThisMonth.reduce((s, o) => s + effectiveMonthlyFee(o), 0);
  const netMonth      = receivedMonth - feesMonth;
  const receivedLast  = paidLastMonth.reduce((s, o) => s + effectiveMonthlyValue(o), 0);
  const netLast       = receivedLast  - paidLastMonth.reduce((s, o) => s + effectiveMonthlyFee(o), 0);

  const toReceive    = orders.filter(o => ['charge_sent', 'partially_paid'].includes(o.payment_status)).reduce((s, o) => s + (o.total_value || 0), 0);
  const overdueTotal = overdue.reduce((s, o) => s + (o.total_value || 0), 0);
  const upcomingTotal = upcoming.reduce((s, o) => s + (o.total_value || 0), 0);
  const noChargeTotal = noCharge.reduce((s, o) => s + (o.total_value || 0), 0);

  // ticket médio
  const avgTicket = paidThisMonth.length > 0 ? receivedMonth / paidThisMonth.length : 0;

  // pipeline total (overdue + toReceive + upcoming)
  const pipelineTotal = overdueTotal + toReceive + upcomingTotal + noChargeTotal;

  // ── Gráfico: últimos 6 meses ──────────────────────────────────
  const chartData = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(toLocalDateStr(d).slice(0, 7));
    }
    return months.map(ym => {
      const paid = orders.filter(o => o.payment_status === 'paid' && o.payment_date?.startsWith(ym));
      const gross = paid.reduce((s, o) => s + effectiveMonthlyValue(o), 0);
      const fees  = paid.reduce((s, o) => s + effectiveMonthlyFee(o), 0);
      return { month: monthLabel(ym), ym, bruto: gross, liquido: gross - fees, count: paid.length };
    });
  }, [orders]);

  const maxChart = useMemo(() => Math.max(...chartData.map(d => d.bruto), 1), [chartData]);
  const currentYM = monthStart.slice(0, 7);

  // ── Recebíveis Asaas agrupados ────────────────────────────────
  const receivablesByMonth = useMemo(() => {
    const byMonth = {};
    for (const p of receivables) {
      const date = p.creditDate || p.dueDate; if (!date) continue;
      const key = date.slice(0, 7);
      if (!byMonth[key]) byMonth[key] = { month: key, total: 0, netTotal: 0, count: 0, confirmed: 0, pending: 0, overdue: 0, items: [] };
      const m = byMonth[key];
      m.total    += Number(p.value)    || 0;
      m.netTotal += Number(p.netValue) || Number(p.value) || 0;
      m.count++;
      if (p.status === 'CONFIRMED') m.confirmed++;
      if (p.status === 'PENDING')   m.pending++;
      if (p.status === 'OVERDUE')   m.overdue++;
      m.items.push(p);
    }
    return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
  }, [receivables]);

  const grandTotalNet = useMemo(() => receivablesByMonth.reduce((s, m) => s + m.netTotal, 0), [receivablesByMonth]);

  // ── Centros de receita ────────────────────────────────────────
  const centerBreakdown = useMemo(() => {
    if (!centers.length || !paidThisMonth.length) return { rows: [], semCentro: 0 };
    const byCenter = {}; let semCentro = 0;
    for (const o of paidThisMonth) {
      const mVal = effectiveMonthlyValue(o);
      if (o.revenue_center_id) byCenter[o.revenue_center_id] = (byCenter[o.revenue_center_id] || 0) + mVal;
      else semCentro += mVal;
    }
    const rows = centers.map(c => ({ ...c, value: byCenter[c.id] || 0 }))
      .filter(c => c.value > 0).sort((a, b) => b.value - a.value);
    return { rows, semCentro };
  }, [centers, paidThisMonth]);

  const openRefundDone = (contract) => {
    setRefundDoneForm({ date: todayLocalStr(), notes: '' });
    setRefundDoneModal(contract);
  };

  const markRefundDone = async () => {
    if (!refundDoneForm.date) return toast.error('Informe a data do estorno');
    setSavingRefund(true);
    try {
      const { error } = await supabase
        .from('assessment_contracts')
        .update({
          refund_status: 'done',
          refund_date:   refundDoneForm.date,
          refund_notes:  refundDoneForm.notes || null,
          updated_at:    new Date().toISOString(),
        })
        .eq('id', refundDoneModal.id);
      if (error) throw error;
      toast.success('Estorno marcado como realizado!');
      setRefundDoneModal(null);
      // Remove da lista local sem recarregar tudo
      setPendingRefunds(prev => prev.filter(r => r.id !== refundDoneModal.id));
    } catch (e) { toast.error(e.message); }
    finally { setSavingRefund(false); }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-2">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm text-muted-foreground">Carregando dados financeiros...</p>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">

      {/* ── Cabeçalho ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Wallet className="w-5 h-5 text-blue-600" />
            Fluxo de Caixa
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">Loja · Pré-venda · Assessoria</p>
        </div>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Recebido esse mês"
          value={formatCurrency(receivedMonth)}
          sub={`${paidThisMonth.length} pagamento${paidThisMonth.length !== 1 ? 's' : ''}`}
          icon={CheckCircle2}
          iconBg="bg-green-50" iconColor="text-green-600" valueColor="text-green-600"
          trend={trendIcon(receivedMonth, receivedLast)}
        />
        <KpiCard
          label="Líquido esse mês"
          value={formatCurrency(netMonth)}
          sub={feesMonth > 0 ? `− ${formatCurrency(feesMonth)} em taxas` : 'Sem taxas de gateway'}
          icon={Wallet}
          iconBg="bg-emerald-50" iconColor="text-emerald-600" valueColor="text-emerald-700"
          trend={trendIcon(netMonth, netLast)}
        />
        <KpiCard
          label="Em atraso"
          value={formatCurrency(overdueTotal)}
          sub={`${overdue.length} cobrança${overdue.length !== 1 ? 's' : ''}`}
          icon={AlertTriangle}
          iconBg={overdueTotal > 0 ? 'bg-red-50' : 'bg-gray-50'}
          iconColor={overdueTotal > 0 ? 'text-red-600' : 'text-gray-400'}
          valueColor={overdueTotal > 0 ? 'text-red-600' : 'text-gray-400'}
        />
        <KpiCard
          label="Previsão 30 dias"
          value={formatCurrency(upcomingTotal)}
          sub={`${upcoming.length} vencimento${upcoming.length !== 1 ? 's' : ''}`}
          icon={Calendar}
          iconBg="bg-amber-50" iconColor="text-amber-600" valueColor="text-amber-600"
        />
      </div>

      {/* ── Linha 2: Ticket médio + Pipeline ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Ticket médio */}
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="p-3 rounded-full bg-blue-50 shrink-0">
              <Target className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Ticket médio (mês)</p>
              <p className="text-xl font-bold text-blue-700">{formatCurrency(avgTicket)}</p>
              <p className="text-xs text-muted-foreground">{paidThisMonth.length} transações</p>
            </div>
          </CardContent>
        </Card>

        {/* Pipeline */}
        <Card className="lg:col-span-2">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-gray-500" /> Pipeline de cobranças
              </p>
              <span className="text-sm font-bold text-gray-800">{formatCurrency(pipelineTotal)}</span>
            </div>
            {pipelineTotal > 0 ? (
              <>
                <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
                  {overdueTotal  > 0 && <div className="bg-red-400 transition-all"   style={{ width: `${(overdueTotal   / pipelineTotal) * 100}%` }} />}
                  {toReceive     > 0 && <div className="bg-blue-400 transition-all"  style={{ width: `${(toReceive      / pipelineTotal) * 100}%` }} />}
                  {upcomingTotal > 0 && <div className="bg-amber-300 transition-all" style={{ width: `${(upcomingTotal  / pipelineTotal) * 100}%` }} />}
                  {noChargeTotal > 0 && <div className="bg-gray-200 transition-all"  style={{ width: `${(noChargeTotal  / pipelineTotal) * 100}%` }} />}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-muted-foreground">
                  {overdueTotal  > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> Em atraso {formatCurrency(overdueTotal)}</span>}
                  {toReceive     > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400" /> Cobrança enviada {formatCurrency(toReceive)}</span>}
                  {upcomingTotal > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-300" /> A vencer {formatCurrency(upcomingTotal)}</span>}
                  {noChargeTotal > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300" /> Sem cobrança {formatCurrency(noChargeTotal)}</span>}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-2">Nenhuma cobrança pendente 🎉</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Gráfico de barras: últimos 6 meses ───────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-600" />
            Recebimentos — últimos 6 meses
          </CardTitle>
          <p className="text-xs text-muted-foreground">Valor bruto por mês — contratos parcelados contam apenas a parcela do mês</p>
        </CardHeader>
        <CardContent>
          {chartData.every(d => d.bruto === 0) ? (
            <p className="text-sm text-muted-foreground text-center py-8">Sem dados de recebimento nos últimos 6 meses.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} barCategoryGap="30%" margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  axisLine={false} tickLine={false}
                  tickFormatter={v => v === 0 ? '' : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  width={36}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f9fafb' }} />
                <Bar dataKey="bruto" radius={[4, 4, 0, 0]} maxBarSize={56}>
                  {chartData.map(d => (
                    <Cell key={d.ym} fill={d.ym === currentYM ? '#2563eb' : '#93c5fd'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {/* Legenda simples */}
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground justify-end">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#2563eb]" /> Mês atual</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#93c5fd]" /> Meses anteriores</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <Tabs defaultValue="cobrancas">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="cobrancas" className="flex items-center gap-1.5">
            <Receipt className="w-3.5 h-3.5" />
            Cobranças
            {(overdue.length + noCharge.length) > 0 && (
              <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5 py-0.5 font-bold">
                {overdue.length + noCharge.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="centros" className="flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5" />
            Por centro
          </TabsTrigger>
          <TabsTrigger value="asaas" className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Recebíveis Asaas
            {receivablesByMonth.length > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground font-normal">
                {formatCurrency(grandTotalNet)}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab: Cobranças ──────────────────────────────────── */}
        <TabsContent value="cobrancas" className="space-y-4 mt-4">

          {/* ── Estornos pendentes ─────────────────────────────── */}
          {pendingRefunds.length > 0 && (
            <Card className="border-orange-200">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2 text-orange-700">
                    <RotateCcw className="w-4 h-4" />
                    Estornos pendentes
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                      {pendingRefunds.length}
                    </span>
                  </CardTitle>
                  <span className="font-bold text-sm text-orange-700">
                    {formatCurrency(pendingRefunds.reduce((s, r) => s + (r.refund_amount || 0), 0))}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Contratos cancelados aguardando estorno manual ao aluno
                </p>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="divide-y">
                  {pendingRefunds.map(r => {
                    const pm = (r.payment_method || '').toLowerCase();
                    const isCard = pm === 'credit_card' || (pm.startsWith('card_') && pm !== 'card_machine');
                    const methodLabel = isCard ? '💳 Cartão (via Asaas)'
                      : pm === 'pix' || pm === 'pix_manual' ? '⚡ PIX'
                      : pm === 'boleto' ? '📄 Boleto'
                      : pm === 'cash' ? '💵 Dinheiro'
                      : pm === 'bank_transfer' ? '🏦 Transferência'
                      : pm === 'card_machine' ? '🖥️ Maquininha'
                      : '—';
                    const daysPending = Math.round(
                      (new Date() - new Date(r.updated_at)) / 86400000
                    );
                    return (
                      <div key={r.id} className="flex items-center gap-3 px-3 py-3 hover:bg-orange-50 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Link to={`/assessoria/contratos/${r.id}`}
                              className="font-mono text-sm font-semibold text-blue-700 hover:underline">
                              {r.contract_number}
                            </Link>
                            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">🏃 Assessoria</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{r.customer_name}</p>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-[11px] text-muted-foreground">{methodLabel}</span>
                            <span className={`text-[11px] font-medium ${daysPending > 7 ? 'text-red-600' : daysPending > 3 ? 'text-orange-600' : 'text-gray-500'}`}>
                              há {daysPending}d
                            </span>
                          </div>
                        </div>
                        <span className="font-bold text-orange-700 shrink-0">
                          {formatCurrency(r.refund_amount)}
                        </span>
                        <Button size="sm" variant="outline"
                          className="border-green-300 text-green-700 hover:bg-green-50 shrink-0"
                          onClick={() => openRefundDone(r)}>
                          <CheckCheck className="w-3.5 h-3.5 mr-1" /> Realizado
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
          <OrderSection
            title="Em atraso" icon={AlertTriangle} iconCls="text-red-600"
            badgeCls="bg-red-100 text-red-700" border="border-red-200"
            orders={overdue} total={overdueTotal}
          />
          <OrderSection
            title="Próximos vencimentos" icon={Calendar} iconCls="text-blue-600"
            badgeCls="bg-blue-100 text-blue-700"
            orders={upcoming} total={upcomingTotal}
          />
          <OrderSection
            title="Cobrança enviada — sem data" icon={Clock} iconCls="text-gray-500"
            badgeCls="bg-gray-100 text-gray-600"
            orders={chargedNoDate}
          />
          <OrderSection
            title="Sem cobrança ainda" icon={TrendingDown} iconCls="text-gray-500"
            badgeCls="bg-gray-100 text-gray-600"
            orders={noCharge} total={noChargeTotal}
            emptyMsg="Todos os pedidos já têm cobrança gerada."
          />
          <OrderSection
            title="Recebidos esse mês" icon={CheckCircle2} iconCls="text-green-700"
            badgeCls="bg-green-100 text-green-700"
            orders={paidThisMonth} total={receivedMonth}
          />
          {activeOrders.length === 0 && paidThisMonth.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center py-16 text-center">
                <DollarSign className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">Nenhum pedido encontrado</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Tab: Por centro de receita ───────────────────────── */}
        <TabsContent value="centros" className="mt-4">
          {centerBreakdown.rows.length === 0 && centerBreakdown.semCentro === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-16 text-center">
                <BarChart3 className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">Sem dados de centros de receita para este mês.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 text-blue-700">
                  <CheckCircle2 className="w-4 h-4" />
                  Recebido por centro de receita (mês)
                </CardTitle>
                <p className="text-xs text-muted-foreground">Divisão do recebimento bruto de {formatCurrency(receivedMonth)}</p>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {centerBreakdown.rows.map(c => (
                    <div key={c.id}>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                          <span className="font-medium">{c.name}</span>
                        </span>
                        <div className="text-right">
                          <span className="font-bold text-green-700">{formatCurrency(c.value)}</span>
                          <span className="text-xs text-muted-foreground ml-2">
                            {receivedMonth > 0 ? `${Math.round((c.value / receivedMonth) * 100)}%` : '0%'}
                          </span>
                        </div>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${Math.round((c.value / receivedMonth) * 100)}%`, backgroundColor: c.color }}
                        />
                      </div>
                    </div>
                  ))}
                  {centerBreakdown.semCentro > 0 && (
                    <div>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full bg-gray-300 shrink-0" />
                          <span className="text-muted-foreground">Sem centro atribuído</span>
                        </span>
                        <div className="text-right">
                          <span className="font-medium text-muted-foreground">{formatCurrency(centerBreakdown.semCentro)}</span>
                          <span className="text-xs text-muted-foreground ml-2">
                            {receivedMonth > 0 ? `${Math.round((centerBreakdown.semCentro / receivedMonth) * 100)}%` : '0%'}
                          </span>
                        </div>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-gray-300 transition-all duration-500"
                          style={{ width: `${Math.round((centerBreakdown.semCentro / receivedMonth) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Tab: Recebíveis Asaas ────────────────────────────── */}
        <TabsContent value="asaas" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="w-4 h-4 text-purple-600" />
                    Recebíveis Asaas
                    {receivablesByMonth.length > 0 && (
                      <span className="text-sm font-bold text-purple-700 ml-1">{formatCurrency(grandTotalNet)}</span>
                    )}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Cobranças pendentes / confirmadas com previsão de crédito
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {fetchedAt && (
                    <span className="text-[11px] text-muted-foreground hidden sm:block">
                      Atualizado {fetchedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => fetchReceivables(true)} disabled={loadingRec}>
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingRec ? 'animate-spin' : ''}`} />
                    <span className="ml-1.5">{loadingRec ? 'Buscando...' : 'Atualizar'}</span>
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingRec && receivables.length === 0 ? (
                <div className="flex items-center justify-center py-10 gap-3 text-muted-foreground">
                  <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm">Carregando recebíveis do Asaas...</span>
                </div>
              ) : receivablesByMonth.length === 0 ? (
                <div className="text-center py-10">
                  <Zap className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">Nenhuma cobrança pendente no Asaas.</p>
                  <p className="text-xs text-muted-foreground mt-1">Clique em "Atualizar" para buscar dados.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {receivablesByMonth.map(m => {
                    const [y, mo] = m.month.split('-');
                    const mLabel = new Date(Number(y), Number(mo) - 1, 1)
                      .toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
                    return (
                      <details key={m.month} className="border rounded-xl bg-white group" open={m.month === currentYM}>
                        <summary className="cursor-pointer p-4 flex items-center justify-between hover:bg-gray-50 rounded-xl list-none">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <Calendar className="w-4 h-4 text-purple-500 shrink-0" />
                            <div>
                              <p className="font-semibold capitalize text-sm">{mLabel}</p>
                              <div className="flex flex-wrap gap-2 mt-0.5 text-xs">
                                <span className="text-muted-foreground">{m.count} cobrança{m.count !== 1 ? 's' : ''}</span>
                                {m.confirmed > 0 && <span className="text-green-700 font-medium">✓ {m.confirmed} confirmada{m.confirmed !== 1 ? 's' : ''}</span>}
                                {m.pending   > 0 && <span className="text-amber-700 font-medium">⏳ {m.pending} pendente{m.pending !== 1 ? 's' : ''}</span>}
                                {m.overdue   > 0 && <span className="text-red-700 font-medium">⚠ {m.overdue} vencida{m.overdue !== 1 ? 's' : ''}</span>}
                              </div>
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-4">
                            <p className="font-bold text-purple-700">{formatCurrency(m.netTotal)}</p>
                            {m.total !== m.netTotal && (
                              <p className="text-[11px] text-muted-foreground">bruto {formatCurrency(m.total)}</p>
                            )}
                          </div>
                        </summary>
                        <div className="border-t divide-y">
                          {m.items
                            .sort((a, b) => (a.creditDate || a.dueDate).localeCompare(b.creditDate || b.dueDate))
                            .map(item => {
                              const displayDate = item.creditDate || item.dueDate;
                              const statusColor =
                                item.status === 'CONFIRMED' ? 'bg-green-100 text-green-700'
                                : item.status === 'PENDING' ? 'bg-amber-100 text-amber-700'
                                : item.status === 'OVERDUE' ? 'bg-red-100 text-red-700'
                                : 'bg-gray-100 text-gray-600';
                              const billingIcon = item.billingType === 'PIX'    ? <Zap className="w-3 h-3" />
                                               : item.billingType === 'BOLETO'  ? <Banknote className="w-3 h-3" />
                                               : <CreditCard className="w-3 h-3" />;
                              return (
                                <div key={item.id} className="flex items-center gap-3 p-3 text-sm hover:bg-gray-50">
                                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 w-24">
                                    {billingIcon}
                                    <span>{formatDate(displayDate)}</span>
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium truncate">
                                      {item.externalReference || item.description || item.id.slice(0, 12)}
                                    </p>
                                    {item.installmentNumber && (
                                      <p className="text-[11px] text-muted-foreground">Parcela {item.installmentNumber}</p>
                                    )}
                                  </div>
                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColor} shrink-0`}>
                                    {item.status === 'CONFIRMED' ? 'Cairá em conta'
                                     : item.status === 'PENDING' ? 'Aguardando'
                                     : item.status === 'OVERDUE' ? 'Vencida'
                                     : item.status}
                                  </span>
                                  <span className="font-semibold shrink-0">{formatCurrency(item.netValue)}</span>
                                </div>
                              );
                            })}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Modal: confirmar estorno realizado ─────────────── */}
      <Dialog open={!!refundDoneModal} onOpenChange={open => !open && setRefundDoneModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-700">
              <CheckCheck className="w-5 h-5" /> Confirmar estorno realizado
            </DialogTitle>
          </DialogHeader>
          {refundDoneModal && (
            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contrato</span>
                  <span className="font-mono font-semibold">{refundDoneModal.contract_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Aluno</span>
                  <span className="font-medium">{refundDoneModal.customer_name}</span>
                </div>
                <div className="flex justify-between border-t border-green-200 pt-1 mt-1">
                  <span className="text-muted-foreground">Valor estornado</span>
                  <span className="font-bold text-green-700">{formatCurrency(refundDoneModal.refund_amount)}</span>
                </div>
              </div>
              <div>
                <Label>Data do estorno</Label>
                <Input type="date" className="mt-1"
                  value={refundDoneForm.date} max={todayLocalStr()}
                  onChange={e => setRefundDoneForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div>
                <Label>Observações (opcional)</Label>
                <Textarea rows={2} className="mt-1"
                  placeholder="ID da transação Asaas, comprovante PIX, etc."
                  value={refundDoneForm.notes}
                  onChange={e => setRefundDoneForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => setRefundDoneModal(null)}>Cancelar</Button>
                <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={markRefundDone} disabled={savingRefund}>
                  <CheckCheck className="w-4 h-4 mr-1.5" />
                  {savingRefund ? 'Salvando...' : 'Confirmar estorno'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
