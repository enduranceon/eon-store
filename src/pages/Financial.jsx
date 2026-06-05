import { useCallback, useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  DollarSign, Calendar, CheckCircle2, Clock, AlertTriangle,
  ChevronRight, RefreshCw, Zap, Wallet, Receipt,
  BarChart3, RotateCcw, CheckCheck, MessageCircle,
  Copy, ExternalLink, Link2, Check,
} from 'lucide-react';
import { calcGatewayFee, defaultPaymentDueDate } from '@/lib/payment-methods';
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

const EFFECTIVE_OPEN_PAYMENT_STATUSES = new Set(['charge_sent', 'partially_paid', 'pending']);

function isEffectiveOpenSale(order) {
  if (['paid', 'cancelled', 'refunded'].includes(order.payment_status)) return false;
  if (order.asaas_charge_id || order.asaas_payment_link || order.asaas_pix_copy || order.external_payment_link) return true;
  return EFFECTIVE_OPEN_PAYMENT_STATUSES.has(order.payment_status);
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

function PaymentStageChip({ status, hasAsaasCharge }) {
  let label = status || 'Pendente';
  let cls = 'bg-gray-100 text-gray-600';

  if (status === 'awaiting_charge') {
    label = 'Pedido recebido';
    cls = 'bg-gray-100 text-gray-700';
  } else if (status === 'charge_sent') {
    label = hasAsaasCharge ? 'Asaas enviado' : 'Cobrança enviada';
    cls = 'bg-blue-50 text-blue-700';
  } else if (status === 'partially_paid') {
    label = 'Parcial';
    cls = 'bg-amber-50 text-amber-700';
  } else if (status === 'paid') {
    label = 'Pago';
    cls = 'bg-green-50 text-green-700';
  }

  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || '';
}

function paymentLinkFor(order, externalLink = order?.external_payment_link) {
  return order?.asaas_payment_link || externalLink?.trim() || '';
}

function buildCollectionMessage(order, externalLink = order?.external_payment_link) {
  if (!order) return '';
  const link = paymentLinkFor(order, externalLink);
  const pixCopy = order.asaas_pix_copy;
  const due = order.due_date ? formatDate(order.due_date) : null;
  const isOverdue = order.due_date && order.due_date < todayLocalStr();
  const saleType = order.type === 'contract' ? 'contrato' : 'pedido';
  const customer = firstName(order.customer);

  let msg = customer ? `Olá, ${customer}! Tudo bem?\n\n` : 'Olá! Tudo bem?\n\n';
  if (isOverdue) {
    msg += `Estou passando porque a cobrança do seu ${saleType} *${order.order_number}*, no valor de *${formatCurrency(order.total_value || 0)}*, venceu${due ? ` em *${due}*` : ''}.\n\n`;
  } else {
    msg += `Segue novamente a cobrança do seu ${saleType} *${order.order_number}*, no valor de *${formatCurrency(order.total_value || 0)}*${due ? `, com vencimento em *${due}*` : ''}.\n\n`;
  }

  if (pixCopy) msg += `PIX Copia e Cola:\n\`${pixCopy}\`\n\n`;
  if (link) msg += `Link de pagamento:\n${link}\n\n`;
  msg += 'Se o pagamento já foi realizado, pode desconsiderar esta mensagem. Qualquer dúvida, estou por aqui.';
  return msg;
}

function OrderRow({ o, onEditDueDate, onCollectPayment }) {
  const link = o.type === 'stock'    ? `/estoque/pedidos/${o.id}`
             : o.type === 'contract' ? `/assessoria/contratos/${o.id}`
             : `/pedidos/${o.id}`;
  const canEditDueDate = !!onEditDueDate && !['paid', 'refunded', 'cancelled'].includes(o.payment_status);
  const canCollect = !!onCollectPayment && !['paid', 'refunded', 'cancelled'].includes(o.payment_status);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors group">
      <Link to={link} className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-blue-700">{o.order_number}</span>
          {o.type === 'stock' && (
            <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Loja</span>
          )}
          {o.type === 'contract' && (
            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">🏃 Assessoria</span>
          )}
          <PaymentStageChip status={o.payment_status} hasAsaasCharge={!!o.asaas_charge_id} />
          {o.external_payment_link && !o.asaas_payment_link && (
            <span className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-medium">Link externo salvo</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{o.customer}</p>
      </Link>
      <div className="flex items-center justify-end gap-2 shrink-0 flex-wrap">
        {o.due_date ? (
          <DueChip dateStr={o.due_date} />
        ) : o.payment_date ? (
          <span className="text-xs text-muted-foreground">{formatDate(o.payment_date)}</span>
        ) : (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 whitespace-nowrap">
            Sem vencimento
          </span>
        )}
        <span className="font-semibold text-sm">{formatCurrency(o.total_value)}</span>
        {canCollect && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs border-green-200 text-green-700 hover:bg-green-50"
            onClick={() => onCollectPayment(o)}
          >
            <MessageCircle className="w-3.5 h-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Cobrar</span>
          </Button>
        )}
        {canEditDueDate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onEditDueDate(o)}
          >
            <Calendar className="w-3.5 h-3.5 sm:mr-1" />
            <span className="hidden sm:inline">{o.due_date ? 'Alterar' : 'Definir'}</span>
          </Button>
        )}
        <Link to={link} aria-label={`Abrir ${o.order_number}`}>
          <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>
      </div>
    </div>
  );
}

function OrderSection({ title, icon: Icon, iconCls, orders, emptyMsg, border, badgeCls, total, onEditDueDate, onCollectPayment }) {
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
          : <div className="divide-y">{orders.map(o => (
            <OrderRow
              key={o.id + o.type}
              o={o}
              onEditDueDate={onEditDueDate}
              onCollectPayment={onCollectPayment}
            />
          ))}</div>
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
  const bruto  = (payload.find(p => p.dataKey === 'liquido')?.value || 0) + (payload.find(p => p.dataKey === 'taxas')?.value || 0);
  const liquido = payload.find(p => p.dataKey === 'liquido')?.value || 0;
  const taxas   = payload.find(p => p.dataKey === 'taxas')?.value || 0;
  return (
    <div className="bg-white border rounded-lg shadow-lg p-3 text-sm min-w-40">
      <p className="font-semibold text-gray-700 mb-2 capitalize">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Bruto</span>
          <span className="font-medium">{formatCurrency(bruto)}</span>
        </div>
        {taxas > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-orange-500 flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-orange-400 inline-block" /> Taxas
            </span>
            <span className="text-orange-600 font-medium">− {formatCurrency(taxas)}</span>
          </div>
        )}
        <div className="flex justify-between gap-4 border-t pt-1 mt-1">
          <span className="font-semibold text-blue-700">Líquido</span>
          <span className="font-bold text-blue-700">{formatCurrency(liquido)}</span>
        </div>
      </div>
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
  const [dueDateModal, setDueDateModal]       = useState(null);
  const [dueDateForm, setDueDateForm]         = useState({ date: '' });
  const [savingDueDate, setSavingDueDate]     = useState(false);
  const [collectionModal, setCollectionModal] = useState(null);
  const [collectionForm, setCollectionForm]   = useState({ externalLink: '', message: '' });
  const [collectionCopied, setCollectionCopied] = useState(false);
  const [savingCollection, setSavingCollection] = useState(false);
  const [asaasPayments, setAsaasPayments] = useState([]);     // cache local (asaas_payments)
  const [syncingAsaas, setSyncingAsaas]   = useState(false);

  // ── Fetch Asaas ───────────────────────────────────────────────
  const fetchReceivables = useCallback(async (force = false) => {
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
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { fetchReceivables(false); }, 0);
    return () => clearTimeout(timer);
  }, [fetchReceivables]);

  // ── Fetch pedidos/contratos ────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        // Janela ampla pra puxar pagamentos: hoje − 7 meses para cobrir gráfico de 6 meses
        const sevenMonthsAgo = new Date();
        sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
        sevenMonthsAgo.setDate(1);
        const apFromStr = toLocalDateStr(sevenMonthsAgo);

        const [presaleRes, stockRes, contractRes, plansRes, customersRes, centersRes, stockProductsRes, paymentsRes] = await Promise.all([
          supabase.from('presale_orders')
            .select('id, order_number, checkout_name, checkout_whatsapp, customer_whatsapp, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, manual_fee, items')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('stock_orders')
            .select('id, order_number, customer_name, customer_whatsapp, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, manual_fee, items')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('assessment_contracts')
            .select('id, contract_number, customer_id, plan_id, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, manual_fee, enrollment_fee, manual_discount, status, installments, plan_snapshot')
            .neq('status', 'cancelled').neq('status', 'draft').neq('payment_status', 'refunded'),
          supabase.from('assessment_plans').select('id, price_total, name, revenue_center_id'),
          supabase.from('presale_customers').select('id, full_name, whatsapp'),
          supabase.from('revenue_centers').select('id, name, color'),
          supabase.from('stock_products').select('id, revenue_center_id'),
          // Pagamentos reais do Asaas — fonte de verdade do fluxo de caixa
          supabase.from('asaas_payments')
            .select('id, asaas_payment_id, order_id, order_type, status, value, net_value, credit_date, payment_date, due_date, billing_type, installment_number, total_installments')
            .in('status', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
            .gte('credit_date', apFromStr)
            .order('credit_date', { ascending: false }),
        ]);
        setAsaasPayments(paymentsRes.data || []);

        const plansMap         = Object.fromEntries((plansRes.data         || []).map(p => [p.id, p]));
        const customersMap     = Object.fromEntries((customersRes.data     || []).map(c => [c.id, c]));
        const stockProductsMap = Object.fromEntries((stockProductsRes.data || []).map(p => [p.id, p]));
        const orderCenter = (items) => {
          if (!items?.length) return null;
          return stockProductsMap[items[0].product_id]?.revenue_center_id || null;
        };

        const presale   = (presaleRes.data   || []).map(o => ({
          ...o,
          type: 'presale',
          customer: o.checkout_name,
          customer_whatsapp: o.checkout_whatsapp || o.customer_whatsapp || null,
          revenue_center_id: orderCenter(o.items),
        }));
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
            customer_whatsapp: customersMap[c.customer_id]?.whatsapp || null,
            total_value, payment_status: c.payment_status, payment_method: c.payment_method,
            payment_date: c.payment_date, due_date: c.due_date,
            asaas_charge_id: c.asaas_charge_id,
            asaas_payment_link: c.asaas_payment_link,
            asaas_pix_copy: c.asaas_pix_copy,
            external_payment_link: c.external_payment_link,
            payment_message_sent_at: c.payment_message_sent_at,
            manual_fee: c.manual_fee,
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

  // Set de order_id (qualquer tipo) que tem pagamentos reais cacheados.
  // Pra esses, asaas_payments é fonte de verdade; orders pulam o fallback.
  const ordersWithAsaasCache = useMemo(() => {
    const set = new Set();
    for (const p of asaasPayments) if (p.order_id) set.add(p.order_id);
    return set;
  }, [asaasPayments]);

  // Calcula bruto + líquido recebidos num período (yyyymm) ou entre 2 datas
  const sumReceived = (predicateAsaas, predicateOrder) => {
    // 1) Fonte de verdade: net_value dos pagamentos Asaas
    let bruto = 0, liquido = 0;
    for (const p of asaasPayments) {
      if (!predicateAsaas(p)) continue;
      const v  = Number(p.value) || 0;
      const nv = p.net_value != null ? Number(p.net_value) : v;
      bruto   += v;
      liquido += nv;
    }
    // 2) Fallback: orders pagos que NÃO têm cache (pagamentos manuais ou ainda não sincronizados)
    for (const o of orders) {
      if (o.payment_status !== 'paid') continue;
      if (ordersWithAsaasCache.has(o.id)) continue;
      if (!predicateOrder(o)) continue;
      const mVal = effectiveMonthlyValue(o);
      const mFee = effectiveMonthlyFee(o);
      bruto   += mVal;
      liquido += (mVal - mFee);
    }
    return { bruto, liquido };
  };

  const activeOrders = orders.filter(isEffectiveOpenSale);

  const paidThisMonth = orders
    .filter(o => o.payment_status === 'paid' && o.payment_date >= monthStart)
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  const overdue    = activeOrders.filter(o => o.due_date && o.due_date < todayStr).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const upcoming   = activeOrders.filter(o => o.due_date && o.due_date >= todayStr).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const missingDueDate = activeOrders.filter(o => !o.due_date);
  const sentCharge = activeOrders.filter(o =>
    o.asaas_charge_id || ['charge_sent', 'partially_paid'].includes(o.payment_status)
  );
  const noCharge = activeOrders.filter(o => !o.asaas_charge_id && !o.asaas_payment_link && !o.external_payment_link);

  // KPI valores: combina asaas_payments (real) + orders manuais (fallback)
  const monthResult = sumReceived(
    p => p.credit_date >= monthStart,
    o => o.payment_date >= monthStart,
  );
  const lastResult = sumReceived(
    p => p.credit_date >= lastMonthStart && p.credit_date <= lastMonthEnd,
    o => o.payment_date >= lastMonthStart && o.payment_date <= lastMonthEnd,
  );
  const receivedMonth = monthResult.bruto;
  const feesMonth     = monthResult.bruto - monthResult.liquido;
  const netMonth      = monthResult.liquido;
  const receivedLast  = lastResult.bruto;
  const netLast       = lastResult.liquido;

  const openSalesTotal = activeOrders.reduce((s, o) => s + (o.total_value || 0), 0);
  const overdueTotal = overdue.reduce((s, o) => s + (o.total_value || 0), 0);
  const upcomingTotal = upcoming.reduce((s, o) => s + (o.total_value || 0), 0);
  const missingDueDateTotal = missingDueDate.reduce((s, o) => s + (o.total_value || 0), 0);
  const sentChargeTotal = sentCharge.reduce((s, o) => s + (o.total_value || 0), 0);
  const noChargeTotal = noCharge.reduce((s, o) => s + (o.total_value || 0), 0);

  // ticket médio
  const avgTicket = paidThisMonth.length > 0 ? receivedMonth / paidThisMonth.length : 0;

  const pipelineTotal = openSalesTotal;

  // ── Gráfico: últimos 6 meses ──────────────────────────────────
  // Combina asaas_payments (real, via credit_date) + orders manuais sem cache
  const chartData = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(toLocalDateStr(d).slice(0, 7));
    }
    return months.map(ym => {
      let bruto = 0, liquido = 0, count = 0;
      // 1) Asaas payments — fonte de verdade
      for (const p of asaasPayments) {
        if (!p.credit_date?.startsWith(ym)) continue;
        const v  = Number(p.value) || 0;
        const nv = p.net_value != null ? Number(p.net_value) : v;
        bruto   += v;
        liquido += nv;
        count++;
      }
      // 2) Orders manuais (sem cache Asaas)
      for (const o of orders) {
        if (o.payment_status !== 'paid') continue;
        if (ordersWithAsaasCache.has(o.id)) continue;
        if (!o.payment_date?.startsWith(ym)) continue;
        const mVal = effectiveMonthlyValue(o);
        const mFee = effectiveMonthlyFee(o);
        bruto   += mVal;
        liquido += (mVal - mFee);
        count++;
      }
      return { month: monthLabel(ym), ym, bruto, liquido, taxas: bruto - liquido, count };
    });
  }, [orders, asaasPayments, ordersWithAsaasCache]);

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

  // Backfill manual: chama edge function que busca parcelas no Asaas e upserta o cache
  const syncAsaasPayments = async () => {
    setSyncingAsaas(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-asaas-payments', {
        body: { since_days: 365 },
      });
      if (error) {
        let msg = error.message;
        try { if (error.context?.json) { const b = await error.context.json(); if (b?.error) msg = b.error; } } catch { /* */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      toast.success(`Sincronizado! ${data.upserted} pagamentos atualizados de ${data.scanned} cobranças.`);
      // Recarrega cache local
      const sevenMonthsAgo = new Date();
      sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
      sevenMonthsAgo.setDate(1);
      const { data: payments } = await supabase.from('asaas_payments')
        .select('id, asaas_payment_id, order_id, order_type, status, value, net_value, credit_date, payment_date, due_date, billing_type, installment_number, total_installments')
        .in('status', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
        .gte('credit_date', toLocalDateStr(sevenMonthsAgo))
        .order('credit_date', { ascending: false });
      setAsaasPayments(payments || []);
    } catch (e) {
      toast.error('Erro ao sincronizar: ' + (e.message || ''));
    } finally {
      setSyncingAsaas(false);
    }
  };

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

  const openDueDateEditor = (order) => {
    setDueDateForm({ date: order.due_date || defaultPaymentDueDate() });
    setDueDateModal(order);
  };

  const saveDueDate = async () => {
    if (!dueDateForm.date) return toast.error('Informe o vencimento');
    if (!dueDateModal) return;

    const tableByType = {
      presale: 'presale_orders',
      stock: 'stock_orders',
      contract: 'assessment_contracts',
    };
    const tableName = tableByType[dueDateModal.type];
    if (!tableName) return toast.error('Tipo de venda inválido');

    setSavingDueDate(true);
    try {
      const { error } = await supabase
        .from(tableName)
        .update({ due_date: dueDateForm.date })
        .eq('id', dueDateModal.id);
      if (error) throw error;

      if (dueDateModal.type === 'contract') {
        supabase.from('assessment_contract_event').insert({
          contract_id: dueDateModal.id,
          event_type: 'due_date_changed',
          payload: {
            from: dueDateModal.due_date || null,
            to: dueDateForm.date,
            source: 'financial_open_sales',
          },
          notes: 'Vencimento ajustado em Vendas em aberto',
        }).then(({ error: eventError }) => {
          if (eventError) console.warn('[contract_event] falha ao registrar due_date_changed:', eventError.message);
        });
      }

      setOrders(prev => prev.map(o =>
        o.id === dueDateModal.id && o.type === dueDateModal.type
          ? { ...o, due_date: dueDateForm.date }
          : o
      ));
      toast.success('Vencimento atualizado');
      setDueDateModal(null);
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar vencimento');
    } finally {
      setSavingDueDate(false);
    }
  };

  const openCollectionEditor = (order) => {
    const externalLink = order.external_payment_link || '';
    setCollectionModal(order);
    setCollectionForm({
      externalLink,
      message: buildCollectionMessage(order, externalLink),
    });
    setCollectionCopied(false);
  };

  const updateCollectionExternalLink = (externalLink) => {
    setCollectionForm({
      externalLink,
      message: buildCollectionMessage(collectionModal, externalLink),
    });
    setCollectionCopied(false);
  };

  const copyCollectionMessage = async () => {
    try {
      await navigator.clipboard.writeText(collectionForm.message);
      setCollectionCopied(true);
      setTimeout(() => setCollectionCopied(false), 2000);
    } catch {
      toast.error('Não consegui copiar a mensagem');
    }
  };

  const openCollectionWhatsApp = () => {
    if (!collectionModal?.customer_whatsapp) {
      toast.error('Cliente sem WhatsApp cadastrado');
      return;
    }
    const phone = '55' + collectionModal.customer_whatsapp.replace(/\D/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(collectionForm.message)}`, '_blank');
  };

  const markCollectionSent = async () => {
    if (!collectionModal) return;
    const tableByType = {
      presale: 'presale_orders',
      stock: 'stock_orders',
      contract: 'assessment_contracts',
    };
    const tableName = tableByType[collectionModal.type];
    if (!tableName) return toast.error('Tipo de venda inválido');

    const externalLink = collectionForm.externalLink.trim();
    const nowIso = new Date().toISOString();
    const hasAsaasPaymentInfo = !!(collectionModal.asaas_payment_link || collectionModal.asaas_pix_copy);
    const updates = { payment_message_sent_at: nowIso };
    if (!hasAsaasPaymentInfo) {
      updates.external_payment_link = externalLink || null;
      if (!collectionModal.due_date) {
        updates.due_date = defaultPaymentDueDate();
      }
    }
    if (['awaiting_charge', 'pending'].includes(collectionModal.payment_status)) {
      updates.payment_status = 'charge_sent';
    }

    setSavingCollection(true);
    try {
      const { error } = await supabase.from(tableName).update(updates).eq('id', collectionModal.id);
      if (error) throw error;

      if (collectionModal.type === 'contract') {
        supabase.from('assessment_contract_event').insert({
          contract_id: collectionModal.id,
          event_type: 'payment_message_sent',
          payload: {
            due_date: collectionModal.due_date || null,
            has_asaas_link: !!collectionModal.asaas_payment_link,
            has_external_link: !!externalLink,
            source: 'financial_open_sales',
          },
          notes: 'Mensagem de cobrança enviada em Vendas em aberto',
        }).then(({ error: eventError }) => {
          if (eventError) console.warn('[contract_event] falha ao registrar payment_message_sent:', eventError.message);
        });
      }

      setOrders(prev => prev.map(o =>
        o.id === collectionModal.id && o.type === collectionModal.type
          ? {
              ...o,
              external_payment_link: !hasAsaasPaymentInfo ? (externalLink || null) : o.external_payment_link,
              payment_message_sent_at: nowIso,
              payment_status: updates.payment_status || o.payment_status,
              due_date: updates.due_date || o.due_date,
            }
          : o
      ));
      toast.success('Mensagem registrada');
      setCollectionModal(null);
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar mensagem');
    } finally {
      setSavingCollection(false);
    }
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            Vendas em aberto
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cobranças pendentes — quem ainda não pagou · Loja · Pré-venda · Assessoria
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/financeiro/fluxo-caixa">
            <Button variant="outline" size="sm">
              <Wallet className="w-3.5 h-3.5 mr-1.5" /> Ver fluxo de caixa
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={syncAsaasPayments} disabled={syncingAsaas}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncingAsaas ? 'animate-spin' : ''}`} />
            {syncingAsaas ? 'Sincronizando...' : 'Sincronizar Asaas'}
          </Button>
        </div>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total em aberto"
          value={formatCurrency(openSalesTotal)}
          sub={`${activeOrders.length} venda${activeOrders.length !== 1 ? 's' : ''} aguardando pagamento`}
          icon={Wallet}
          iconBg="bg-blue-50" iconColor="text-blue-600" valueColor="text-blue-700"
        />
        <KpiCard
          label="Em atraso"
          value={formatCurrency(overdueTotal)}
          sub={`${overdue.length} cobrança${overdue.length !== 1 ? 's' : ''} vencida${overdue.length !== 1 ? 's' : ''}`}
          icon={AlertTriangle}
          iconBg={overdueTotal > 0 ? 'bg-red-50' : 'bg-gray-50'}
          iconColor={overdueTotal > 0 ? 'text-red-600' : 'text-gray-400'}
          valueColor={overdueTotal > 0 ? 'text-red-600' : 'text-gray-400'}
        />
        <KpiCard
          label="A vencer"
          value={formatCurrency(upcomingTotal)}
          sub={`${upcoming.length} vencimento${upcoming.length !== 1 ? 's' : ''}`}
          icon={Calendar}
          iconBg="bg-amber-50" iconColor="text-amber-600" valueColor="text-amber-600"
        />
        <KpiCard
          label="Sem cobrança gerada"
          value={formatCurrency(noChargeTotal)}
          sub={`${noCharge.length} venda${noCharge.length !== 1 ? 's' : ''} pra acionar`}
          icon={MessageCircle}
          iconBg={noCharge.length > 0 ? 'bg-orange-50' : 'bg-gray-50'}
          iconColor={noCharge.length > 0 ? 'text-orange-600' : 'text-gray-400'}
          valueColor={noCharge.length > 0 ? 'text-orange-600' : 'text-gray-400'}
        />
      </div>

      {/* ── Pipeline ────────────────────────────────────────── */}
      {pipelineTotal > 0 && (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-gray-500" /> Composição das vendas em aberto
              </p>
              <span className="text-sm font-bold text-gray-800">{formatCurrency(pipelineTotal)}</span>
            </div>
            <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
              {overdueTotal  > 0 && <div className="bg-red-400 transition-all"   style={{ width: `${(overdueTotal   / pipelineTotal) * 100}%` }} />}
              {upcomingTotal > 0 && <div className="bg-amber-300 transition-all" style={{ width: `${(upcomingTotal  / pipelineTotal) * 100}%` }} />}
              {missingDueDateTotal > 0 && <div className="bg-gray-200 transition-all"  style={{ width: `${(missingDueDateTotal  / pipelineTotal) * 100}%` }} />}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-muted-foreground">
              {overdueTotal  > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> Em atraso {formatCurrency(overdueTotal)}</span>}
              {upcomingTotal > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-300" /> A vencer {formatCurrency(upcomingTotal)}</span>}
              {missingDueDateTotal > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300" /> Sem vencimento {formatCurrency(missingDueDateTotal)}</span>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground border-t pt-2">
              <span>{sentCharge.length} com cobrança enviada · {formatCurrency(sentChargeTotal)}</span>
              <span>{noCharge.length} sem cobrança · {formatCurrency(noChargeTotal)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <Tabs defaultValue="abertas">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="abertas" className="flex items-center gap-1.5">
            <Receipt className="w-3.5 h-3.5" />
            Vendas em aberto
            {activeOrders.length > 0 && (
              <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5 py-0.5 font-bold">
                {activeOrders.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="centros" className="flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5" />
            Por centro
          </TabsTrigger>
        </TabsList>

        {/* ── Tab: Vendas em aberto ───────────────────────────── */}
        <TabsContent value="abertas" className="space-y-4 mt-4">

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
            onEditDueDate={openDueDateEditor}
            onCollectPayment={openCollectionEditor}
          />
          <OrderSection
            title="A vencer" icon={Calendar} iconCls="text-blue-600"
            badgeCls="bg-blue-100 text-blue-700"
            orders={upcoming} total={upcomingTotal}
            onEditDueDate={openDueDateEditor}
            onCollectPayment={openCollectionEditor}
          />
          <OrderSection
            title="Sem vencimento" icon={Clock} iconCls="text-gray-500"
            badgeCls="bg-gray-100 text-gray-600"
            orders={missingDueDate} total={missingDueDateTotal}
            onEditDueDate={openDueDateEditor}
            onCollectPayment={openCollectionEditor}
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

      </Tabs>

      {/* ── Call-to-action: Fluxo de caixa ───────────────────── */}
      <Card className="border-emerald-200 bg-emerald-50/40">
        <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-100">
              <Wallet className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <p className="font-semibold text-sm text-gray-900">Quer ver o que já está confirmado pra entrar?</p>
              <p className="text-xs text-muted-foreground mt-0.5">Parcelas de cartão, recebíveis Asaas e histórico ficam agora no Fluxo de Caixa.</p>
            </div>
          </div>
          <Link to="/financeiro/fluxo-caixa">
            <Button className="bg-emerald-600 hover:bg-emerald-700">
              Abrir Fluxo de Caixa
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* ── Modal: mensagem de cobrança ─────────────────────── */}
      <Dialog open={!!collectionModal} onOpenChange={open => !open && setCollectionModal(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" />
              Mensagem de cobrança
            </DialogTitle>
          </DialogHeader>
          {collectionModal && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3 text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Venda</span>
                  <span className="font-mono font-semibold text-right">{collectionModal.order_number}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Cliente</span>
                  <span className="font-medium text-right truncate">{collectionModal.customer}</span>
                </div>
                <div className="flex justify-between gap-3 border-t pt-1 mt-1">
                  <span className="text-muted-foreground">Vencimento</span>
                  <span className="font-medium">
                    {collectionModal.due_date ? formatDate(collectionModal.due_date) : 'Sem vencimento'}
                  </span>
                </div>
              </div>

              {collectionModal.asaas_payment_link || collectionModal.asaas_pix_copy ? (
                <div className="flex items-start gap-2 text-xs bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  <Zap className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                  <span className="text-blue-800">Cobrança Asaas encontrada. Link/PIX entram automaticamente na mensagem.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <Link2 className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                    <span className="text-amber-800">Cobrança externa. Informe o link para salvar e reenviar depois.</span>
                  </div>
                  <div>
                    <Label className="text-xs">Link externo</Label>
                    <Input
                      className="mt-1 font-mono text-xs"
                      placeholder="https://..."
                      value={collectionForm.externalLink}
                      onChange={e => updateCollectionExternalLink(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div>
                <Label className="text-xs">Mensagem</Label>
                <Textarea
                  rows={9}
                  className="mt-1 font-mono text-xs"
                  value={collectionForm.message}
                  onChange={e => {
                    setCollectionForm(f => ({ ...f, message: e.target.value }));
                    setCollectionCopied(false);
                  }}
                />
              </div>

              <div className="flex gap-2">
                <Button className="flex-1" variant="outline" onClick={copyCollectionMessage}>
                  {collectionCopied
                    ? <><Check className="w-4 h-4 mr-1.5 text-green-600" />Copiado</>
                    : <><Copy className="w-4 h-4 mr-1.5" />Copiar</>}
                </Button>
                <Button
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                  onClick={openCollectionWhatsApp}
                  disabled={!collectionModal.customer_whatsapp}
                >
                  <ExternalLink className="w-4 h-4 mr-1.5" />
                  WhatsApp
                </Button>
              </div>

              <Button className="w-full" onClick={markCollectionSent} disabled={savingCollection}>
                <CheckCheck className="w-4 h-4 mr-1.5" />
                {savingCollection ? 'Registrando...' : 'Registrar envio'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Modal: definir vencimento ────────────────────────── */}
      <Dialog open={!!dueDateModal} onOpenChange={open => !open && setDueDateModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-blue-600" />
              Definir vencimento
            </DialogTitle>
          </DialogHeader>
          {dueDateModal && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3 text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Venda</span>
                  <span className="font-mono font-semibold text-right">{dueDateModal.order_number}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Cliente</span>
                  <span className="font-medium text-right truncate">{dueDateModal.customer}</span>
                </div>
                <div className="flex justify-between gap-3 border-t pt-1 mt-1">
                  <span className="text-muted-foreground">Valor</span>
                  <span className="font-bold">{formatCurrency(dueDateModal.total_value)}</span>
                </div>
              </div>

              <div>
                <Label>Vencimento</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={dueDateForm.date}
                  onChange={e => setDueDateForm({ date: e.target.value })}
                />
              </div>

              {dueDateModal.asaas_charge_id && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  Esta venda já tem cobrança Asaas. Aqui o vencimento interno do lançamento será ajustado.
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => setDueDateModal(null)}>
                  Cancelar
                </Button>
                <Button className="flex-1" onClick={saveDueDate} disabled={savingDueDate}>
                  {savingDueDate ? 'Salvando...' : 'Salvar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
