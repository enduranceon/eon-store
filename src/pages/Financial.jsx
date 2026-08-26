import { useCallback, useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  DollarSign, Calendar, CheckCircle2, Clock, AlertTriangle,
  ChevronRight, RefreshCw, Wallet, Receipt,
  BarChart3, RotateCcw, MessageCircle,
} from 'lucide-react';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { listFinancialDataQuality, listFinancialMovements, updateOrderDueDate } from '@/api/client';
import { supabase } from '@/api/db';
import { financialQualitySeverityLabel, toPaymentRecord } from '@/lib/financial-ledger';
import {
  financialQualityTypeMeta,
  financialQualityUnitLabel,
  summarizeFinancialQuality,
} from '@/lib/financial-quality';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import {
  hasChargeEvidence,
  isAwaitingCharge,
  isBillableProspectOpenSale,
  isOpenCollectionSale,
} from '@/lib/sales';
import { TASK_BUCKET, TASK_KIND } from '@/lib/communication-tasks';
import { DEFAULT_COMMUNICATION_RULES, loadCommunicationConfig } from '@/lib/communication-config';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { readPageCache, writePageCache } from '@/lib/page-cache';
import { buildContractLifecycleRows } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────
const RECEIVABLES_CACHE_KEY = 'asaas_receivables_cache_v1';
const RECEIVABLES_CACHE_TTL = 5 * 60 * 1000;
const FINANCIAL_PAGE_CACHE_TTL = 60 * 1000;
const FINANCIAL_PAGE_CACHE_KEY = 'financial:overview:v4';
const ADJUSTABLE_DUE_DATE_STATUSES = new Set([
  'pending',
  'awaiting_charge',
  'charge_sent',
  'overdue',
]);

function writeFinancialPageCache(data) {
  writePageCache(FINANCIAL_PAGE_CACHE_KEY, data, [
    'presale_orders',
    'stock_orders',
    'assessment_contracts',
    'assessment_plans',
    'events',
    'event_registration_types',
    'event_registrations',
    'presale_customers',
    'revenue_centers',
    'stock_products',
    'asaas_payments',
    'financial_movements',
    'financial_data_quality',
  ]);
}

function patchFinancialPageCache(partial) {
  const cached = readPageCache(FINANCIAL_PAGE_CACHE_KEY);
  if (!cached?.data) return;
  writeFinancialPageCache({ ...cached.data, ...partial });
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function getTodayStr()      { return todayLocalStr(); }
function getMonthStartStr() { const d = new Date(); d.setDate(1); return toLocalDateStr(d); }
function newDueDateOperationKey() { return crypto.randomUUID(); }

function daysDiff(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
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

  if (status === 'awaiting_charge' || status === 'pending') {
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

function addDaysStr(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

// Constrói a task de cobrança desta venda no MESMO formato da Central de
// Comunicação: mesmo texto (regras configuráveis), mesmo registro de histórico
// e mesma baixa de etapa na fila. O botão daqui é só um atalho contextual —
// a fila da Central reconhece o envio e não oferece a mesma etapa de novo.
function collectionTaskFor(order, rules = DEFAULT_COMMUNICATION_RULES) {
  const todayStr = todayLocalStr();
  const isOverdue = Boolean(order.due_date && order.due_date < todayStr);
  const lastSent = order.payment_message_sent_at ? toLocalDateStr(order.payment_message_sent_at) : '';
  const activeRules = (rules || []).filter(r => r.active !== false);

  let kind = TASK_KIND.CHARGE_SEND;
  let rule = activeRules.find(r => r.task_kind === 'charge_send') || null;
  let title = order.payment_message_sent_at ? 'Reenviar cobrança' : 'Enviar cobrança';
  if (isOverdue) {
    kind = TASK_KIND.CHARGE_OVERDUE;
    rule = activeRules
      .filter(r => r.task_kind === 'charge_overdue')
      .sort((a, b) => (Number(a.days_offset) || 0) - (Number(b.days_offset) || 0))
      .find(r => {
        const trigger = addDaysStr(order.due_date, Math.max(0, Number(r.days_offset) || 0));
        return trigger && trigger <= todayStr && (!lastSent || lastSent < trigger);
      }) || null;
    title = rule?.name || 'Reenviar cobrança vencida';
  }

  const items = (order.items || [])
    .filter(it => it && !it.cancelled)
    .map((it, i) => {
      const quantity = Math.max(1, Number(it.quantity) || 1);
      const name = String(it.product_name || it.name || `Item ${i + 1}`).trim();
      const variation = String(it.variation || '').trim();
      const label = variation && !name.toLowerCase().includes(variation.toLowerCase()) ? `${name} - ${variation}` : name;
      const unit = (Number(it.sale_price ?? it.price ?? 0) || 0) + (Number(it.extras_total) || 0);
      return { label, quantity, lineTotal: Math.max(0, unit * quantity) };
    });

  const tableByType = {
    presale: 'presale_orders',
    stock: 'stock_orders',
    contract: 'assessment_contracts',
    event: 'event_registrations',
  };
  const hrefByType = {
    presale: `/pedidos/${order.id}`,
    stock: `/estoque/pedidos/${order.id}`,
    contract: `/assessoria/contratos/${order.id}`,
    event: `/eventos/${order.event_id || ''}`,
  };

  return {
    id: `open-sale:${order.type}:${order.id}:${order.payment_message_sent_at || ''}`,
    kind,
    bucket: TASK_BUCKET.CHARGES,
    sourceType: order.type,
    tableName: tableByType[order.type],
    sourceId: order.id,
    sourceLabel: order.type === 'contract' ? 'Contrato' : order.type === 'event' ? 'Inscrição de evento' : 'Pedido',
    orderNumber: order.order_number,
    customerName: order.customer || 'Cliente',
    customerWhatsapp: order.customer_whatsapp || '',
    totalValue: Number(order.total_value) || 0,
    paymentStatus: order.payment_status,
    dueDate: order.due_date || '',
    asaasChargeId: order.asaas_charge_id,
    asaasPaymentLink: order.asaas_payment_link,
    asaasPixCopy: order.asaas_pix_copy,
    externalPaymentLink: order.external_payment_link,
    paymentMessageSentAt: order.payment_message_sent_at,
    updatedAt: order.updated_at,
    items,
    itemSummary: items[0]?.label || '',
    href: hrefByType[order.type],
    title,
    statusLabel: order.due_date ? `vence em ${formatDate(order.due_date)}` : 'definir vencimento',
    ruleId: rule?.id || null,
    ruleSlug: rule?.slug || null,
    ruleName: rule?.name || null,
    messageTemplate: rule?.message_template || '',
  };
}


function OrderRow({ o, onEditDueDate, onCollectPayment }) {
  const link = o.is_prospect         ? '/assessoria/prospects'
             : o.type === 'stock'    ? `/estoque/pedidos/${o.id}`
             : o.type === 'contract' ? `/assessoria/contratos/${o.id}`
             : o.type === 'event'    ? `/eventos/${o.event_id || o.id}`
             : `/pedidos/${o.id}`;
  const hasUnsupportedInstallment = !!o.asaas_charge_id && getInstallmentN(o) > 1;
  const canEditDueDate = !!onEditDueDate
    && ADJUSTABLE_DUE_DATE_STATUSES.has(o.payment_status)
    && !hasUnsupportedInstallment;
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
          {o.type === 'event' && (
            <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">Evento</span>
          )}
          {o.is_prospect && (
            <span className="text-[10px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded font-medium">Prospect</span>
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
              key={o.list_key || o.id + o.type}
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

function FinancialDataQuality({ issues }) {
  const summary = summarizeFinancialQuality(issues);
  const visibleGroups = summary.groups.slice(0, 3);
  const severityClass = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-amber-100 text-amber-700',
    low: 'bg-blue-100 text-blue-700',
  };

  return (
    <Card className={summary.totalCount ? 'border-amber-200' : 'border-emerald-200'}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className={`w-4 h-4 ${summary.totalCount ? 'text-amber-600' : 'text-emerald-600'}`} />
            Qualidade financeira
          </CardTitle>
          <div className="flex items-center gap-3">
            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${summary.totalCount ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>
              {summary.totalCount ? `${summary.totalCount} registro${summary.totalCount !== 1 ? 's' : ''}` : 'Sem pendencias'}
            </span>
            <Link to="/financeiro/conciliacao" className="text-xs font-semibold text-blue-700 hover:underline">Abrir fila</Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {visibleGroups.length === 0 ? (
          <p className="text-sm text-emerald-700 py-1">Nenhuma pendencia financeira identificada.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-700">
              {summary.groupCount} grupo{summary.groupCount !== 1 ? 's' : ''} para revisar
              {summary.highCount ? `, com ${summary.highCount} registro${summary.highCount !== 1 ? 's' : ''} de prioridade alta` : ''}.
            </p>
            <div className="divide-y">
            {visibleGroups.map(group => {
              const meta = financialQualityTypeMeta(group.issueType);
              return (
              <div key={group.key} className="flex items-center gap-3 py-3 first:pt-1">
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${severityClass[group.severity] || 'bg-gray-100 text-gray-600'}`}>
                  {financialQualitySeverityLabel(group.severity)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-800 truncate">{meta.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {financialQualityUnitLabel(group.businessUnit)} · {group.count} registro{group.count !== 1 ? 's' : ''}
                  </p>
                </div>
                <span className="text-xs font-semibold text-gray-800 shrink-0">{formatCurrency(group.totalAmount)}</span>
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

// ─────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────
export default function Financial() {
  const [initialFinancialCache] = useState(() => readPageCache(FINANCIAL_PAGE_CACHE_KEY));
  const cachedFinancialData = initialFinancialCache?.data;
  const [loading, setLoading]             = useState(!cachedFinancialData);
  const [orders, setOrders]               = useState(() => cachedFinancialData?.orders || []);
  const [centers, setCenters]             = useState(() => cachedFinancialData?.centers || []);
  const [receivables, setReceivables]     = useState([]);
  const [loadingRec, setLoadingRec]       = useState(false);
  const [fetchedAt, setFetchedAt]         = useState(null);
  const [pendingRefunds, setPendingRefunds] = useState(() => cachedFinancialData?.pendingRefunds || []);
  const [qualityIssues, setQualityIssues] = useState(() => cachedFinancialData?.qualityIssues || []);
  const [dueDateModal, setDueDateModal]       = useState(null);
  const [dueDateForm, setDueDateForm]         = useState({ date: '', idempotencyKey: '' });
  const [savingDueDate, setSavingDueDate]     = useState(false);
  const [collectionTask, setCollectionTask] = useState(null);
  const [commConfig, setCommConfig] = useState({ rules: DEFAULT_COMMUNICATION_RULES, communityLink: '' });

  useEffect(() => {
    let alive = true;
    loadCommunicationConfig()
      .then(cfg => { if (alive) setCommConfig({ rules: cfg.rules || DEFAULT_COMMUNICATION_RULES, communityLink: cfg.communityLink || '' }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [financialMovements, setFinancialMovements] = useState(() => cachedFinancialData?.financialMovements || []);
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
    let active = true;

    const load = async () => {
      const cacheIsFresh = initialFinancialCache
        && Date.now() - initialFinancialCache.updatedAt < FINANCIAL_PAGE_CACHE_TTL;
      if (cacheIsFresh) return;

      if (!initialFinancialCache?.data) setLoading(true);
      try {
        // Janela ampla pra puxar pagamentos: hoje − 7 meses para cobrir gráfico de 6 meses
        const sevenMonthsAgo = new Date();
        sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
        sevenMonthsAgo.setDate(1);
        const apFromStr = toLocalDateStr(sevenMonthsAgo);

        const [presaleRes, stockRes, contractRes, plansRes, customersRes, centersRes, stockProductsRes, eventRegsRes, eventTypesRes, eventsRes, paymentsRes, qualityRes] = await Promise.all([
          supabase.from('presale_orders')
            .select('id, order_number, checkout_name, checkout_whatsapp, customer_whatsapp, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, payment_method, items')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('stock_orders')
            .select('id, order_number, customer_name, customer_whatsapp, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, payment_method, items')
            .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
          supabase.from('assessment_contracts')
            .select('id, contract_number, customer_id, plan_id, payment_status, payment_date, manual_payment, due_date, start_date, end_date, created_at, updated_at, parent_contract_id, cancellation_date, cancellation_fee, cancellation_reason, refund_status, refund_amount, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, payment_method, enrollment_fee, manual_discount, credit_balance, status, installments, plan_snapshot, prospect_stage')
            .not('status', 'in', '("cancelled","voided")').neq('payment_status', 'refunded'),
          supabase.from('assessment_plans').select('id, price_total, price_monthly, name, revenue_center_id'),
          supabase.from('presale_customers').select('id, full_name, whatsapp, email, cpf'),
          supabase.from('revenue_centers').select('id, name, color'),
          supabase.from('stock_products').select('id, revenue_center_id'),
          supabase.from('event_registrations')
            .select('id, registration_number, event_id, registration_type_id, customer_id, coach_id, payment_status, payment_method, payment_date, due_date, manual_payment, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, customer_link_confirmed_at, customer_link_confirmed_by, created_at, updated_at')
            .neq('payment_status', 'cancelled')
            .neq('payment_status', 'refunded'),
          supabase.from('event_registration_types').select('id, event_id, name, price'),
          supabase.from('events').select('id, name, revenue_center_id, status'),
          listFinancialMovements({
            movementKind: 'receipt',
            isActual: true,
            scheduledFrom: apFromStr,
            sort: '-scheduled_on',
          }).catch(error => {
            console.error('[Financial] Erro ao carregar recebimentos:', error);
            return [];
          }),
          listFinancialDataQuality().catch(error => {
            console.error('[Financial] Erro ao carregar qualidade financeira:', error);
            return [];
          }),
        ]);
        const nextFinancialMovements = paymentsRes.map(toPaymentRecord);
        const nextQualityIssues = qualityRes;

        const plansMap         = Object.fromEntries((plansRes.data         || []).map(p => [p.id, p]));
        const customersMap     = Object.fromEntries((customersRes.data     || []).map(c => [c.id, c]));
        const stockProductsMap = Object.fromEntries((stockProductsRes.data || []).map(p => [p.id, p]));
        const eventTypesMap    = Object.fromEntries((eventTypesRes.data    || []).map(t => [t.id, t]));
        const eventsMap        = Object.fromEntries((eventsRes.data        || []).map(e => [e.id, e]));
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
        const contractRows = contractRes.data || [];
        await applyAssessmentContractTransitions(contractRows);
        const contracts = buildContractLifecycleRows(contractRows, { plansById: plansMap })
          .filter(c => {
            if (c.lifecycle?.type === 'voided_sale') return false;
            if (c.lifecycle?.type === 'pending_sale') return isBillableProspectOpenSale(c);
            return (
              c.lifecycle?.counts?.active ||
              c.payment_status === 'paid' ||
              isOpenCollectionSale(c)
            );
          })
          .map(c => {
            const plan = plansMap[c.plan_id];
            return {
              id: c.id, order_number: c.contract_number,
              customer: customersMap[c.customer_id]?.full_name || '—',
              customer_whatsapp: customersMap[c.customer_id]?.whatsapp || null,
              total_value: Number(c.value) || 0,
              payment_status: c.payment_status,
              payment_method: c.payment_method,
              payment_date: c.payment_date, due_date: c.due_date,
              asaas_charge_id: c.asaas_charge_id,
              asaas_payment_link: c.asaas_payment_link,
              asaas_pix_copy: c.asaas_pix_copy,
              external_payment_link: c.external_payment_link,
              external_invoice_number: c.external_invoice_number,
              payment_message_sent_at: c.payment_message_sent_at,
              updated_at: c.updated_at,
              status: c.status,
              parent_contract_id: c.parent_contract_id,
              prospect_stage: c.prospect_stage,
              is_prospect: isBillableProspectOpenSale(c),
              type: 'contract',
              revenue_center_id: c.plan_snapshot?.revenue_center_id || plan?.revenue_center_id || null,
              installments: c.installments || 1,
            };
          });
        const eventOrders = (eventRegsRes.data || [])
          .map(reg => {
            const type = eventTypesMap[reg.registration_type_id] || {};
            const eventRecord = eventsMap[reg.event_id] || {};
            const customer = customersMap[reg.customer_id] || {};
            const value = Number(type.price) || 0;
            return {
              id: reg.id,
              order_number: reg.registration_number,
              customer: customer.full_name || 'Cliente',
              customer_whatsapp: customer.whatsapp || null,
              customer_email: customer.email || null,
              customer_cpf: customer.cpf || null,
              total_value: value,
              payment_status: reg.payment_status,
              payment_method: reg.payment_method,
              payment_date: reg.payment_date,
              due_date: reg.due_date,
              asaas_charge_id: reg.asaas_charge_id,
              asaas_payment_link: reg.asaas_payment_link,
              asaas_pix_copy: reg.asaas_pix_copy,
              external_payment_link: reg.external_payment_link,
              payment_message_sent_at: reg.payment_message_sent_at,
              updated_at: reg.updated_at,
              created_at: reg.created_at,
              type: 'event',
              event_id: reg.event_id,
              event_name: eventRecord.name || 'Evento',
              registration_type_name: type.name || 'Inscrição',
              revenue_center_id: eventRecord.revenue_center_id || null,
              items: [{
                name: [eventRecord.name, type.name].filter(Boolean).join(' - ') || 'Inscrição de evento',
                quantity: 1,
                sale_price: value,
              }],
            };
          })
          .filter(o => o.total_value > 0);

        const nextOrders = [...presale, ...stock, ...contracts, ...eventOrders];
        const nextCenters = centersRes.data || [];

        // ── Estornos pendentes ──────────────────────────────────────
        const { data: refundContracts } = await supabase
          .from('assessment_contracts')
          .select('id, contract_number, customer_id, refund_amount, refund_status, payment_method, cancellation_reason, updated_at')
          .eq('refund_status', 'pending');

        let nextPendingRefunds = [];
        if (refundContracts?.length) {
          const customerIds = [...new Set(refundContracts.map(c => c.customer_id).filter(Boolean))];
          const { data: rfCustomers } = await supabase
            .from('presale_customers').select('id, full_name').in('id', customerIds);
          const rfCustMap = Object.fromEntries((rfCustomers || []).map(c => [c.id, c]));
          nextPendingRefunds = refundContracts.map(c => ({
            ...c,
            customer_name: rfCustMap[c.customer_id]?.full_name || '—',
          }));
        }

        if (!active) return;
        const nextData = {
          orders: nextOrders,
          centers: nextCenters,
          financialMovements: nextFinancialMovements,
          pendingRefunds: nextPendingRefunds,
          qualityIssues: nextQualityIssues,
        };
        setOrders(nextOrders);
        setCenters(nextCenters);
        setFinancialMovements(nextFinancialMovements);
        setPendingRefunds(nextPendingRefunds);
        setQualityIssues(nextQualityIssues);
        writeFinancialPageCache(nextData);
      } catch (e) {
        console.error('Erro ao carregar Financeiro:', e);
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [initialFinancialCache]);

  // ── Cálculos ──────────────────────────────────────────────────
  const todayStr       = getTodayStr();
  const monthStart     = getMonthStartStr();

  // A fonte unica inclui parcelas Asaas, pagamentos manuais e o fallback legado.
  const ordersWithReceiptMovement = useMemo(() => {
    const set = new Set();
    for (const p of financialMovements) if (p.order_id) set.add(p.order_id);
    return set;
  }, [financialMovements]);

  // Calcula recebimentos sem inferir valor de pedidos ou contratos.
  const sumReceived = (predicateMovement) => {
    let total = 0;
    for (const p of financialMovements) {
      if (!predicateMovement(p)) continue;
      const v  = Number(p.value) || 0;
      total += v;
    }
    return { total };
  };

  // A fila operacional inclui pedidos que ainda aguardam a primeira cobranca.
  // O livro-caixa continua usando somente movimentos/recebiveis ja registrados.
  const activeOrders = orders.filter(o =>
    isOpenCollectionSale(o) &&
    !ordersWithReceiptMovement.has(o.id)
  );

  const ordersByMovementKey = useMemo(
    () => new Map(orders.map(order => [`${order.type}:${order.id}`, order])),
    [orders]
  );
  const paidThisMonth = financialMovements
    .filter(payment => payment.credit_date >= monthStart && payment.credit_date <= todayStr)
    .map(payment => {
      const order = ordersByMovementKey.get(`${payment.order_type}:${payment.order_id}`);
      return {
        ...order,
        id: payment.order_id || payment.id,
        list_key: payment.id,
        order_number: order?.order_number || payment.external_reference || 'Recebimento',
        customer: order?.customer || 'Cliente',
        total_value: Number(payment.value) || 0,
        payment_status: 'paid',
        payment_date: payment.credit_date,
        type: payment.order_type || order?.type,
        revenue_center_id: payment.revenue_center_id || order?.revenue_center_id || null,
      };
    })
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  const overdue    = activeOrders.filter(o => o.due_date && o.due_date < todayStr).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const upcoming   = activeOrders.filter(o => o.due_date && o.due_date >= todayStr).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const missingDueDate = activeOrders.filter(o => !o.due_date);
  const sentCharge = activeOrders.filter(o =>
    hasChargeEvidence(o) || o.payment_status === 'charge_sent'
  );
  const noCharge = activeOrders.filter(isAwaitingCharge);

  // KPI de recebimentos confirmados na fonte financeira unica.
  const monthResult = sumReceived(
    p => p.credit_date >= monthStart && p.credit_date <= todayStr,
  );
  const receivedMonth = monthResult.total;

  const openSalesTotal = activeOrders.reduce((s, o) => s + (o.total_value || 0), 0);
  const overdueTotal = overdue.reduce((s, o) => s + (o.total_value || 0), 0);
  const upcomingTotal = upcoming.reduce((s, o) => s + (o.total_value || 0), 0);
  const missingDueDateTotal = missingDueDate.reduce((s, o) => s + (o.total_value || 0), 0);
  const sentChargeTotal = sentCharge.reduce((s, o) => s + (o.total_value || 0), 0);
  const noChargeTotal = noCharge.reduce((s, o) => s + (o.total_value || 0), 0);

  const pipelineTotal = openSalesTotal;

  // ── Recebíveis Asaas agrupados ────────────────────────────────
  const receivablesByMonth = useMemo(() => {
    const byMonth = {};
    for (const p of receivables) {
      const date = p.creditDate || p.dueDate; if (!date) continue;
      const key = date.slice(0, 7);
      if (!byMonth[key]) byMonth[key] = { month: key, total: 0, count: 0, confirmed: 0, pending: 0, overdue: 0, items: [] };
      const m = byMonth[key];
      m.total    += Number(p.value)    || 0;
      m.count++;
      if (p.status === 'CONFIRMED') m.confirmed++;
      if (p.status === 'PENDING')   m.pending++;
      if (p.status === 'OVERDUE')   m.overdue++;
      m.items.push(p);
    }
    return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
  }, [receivables]);

  const receivablesTotal = useMemo(() => receivablesByMonth.reduce((s, m) => s + m.total, 0), [receivablesByMonth]);

  // ── Centros de receita ────────────────────────────────────────
  const centerBreakdown = useMemo(() => {
    if (!centers.length || !paidThisMonth.length) return { rows: [], semCentro: 0 };
    const byCenter = {}; let semCentro = 0;
    for (const payment of paidThisMonth) {
      const value = Number(payment.total_value) || 0;
      if (payment.revenue_center_id) byCenter[payment.revenue_center_id] = (byCenter[payment.revenue_center_id] || 0) + value;
      else semCentro += value;
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
      const movements = await listFinancialMovements({
        movementKind: 'receipt',
        isActual: true,
        scheduledFrom: toLocalDateStr(sevenMonthsAgo),
        sort: '-scheduled_on',
      });
      const nextMovements = movements.map(toPaymentRecord);
      setFinancialMovements(nextMovements);
      patchFinancialPageCache({ financialMovements: nextMovements });
    } catch (e) {
      toast.error('Erro ao sincronizar: ' + (e.message || ''));
    } finally {
      setSyncingAsaas(false);
    }
  };

  const openDueDateEditor = (order) => {
    setDueDateForm({
      date: order.due_date || defaultPaymentDueDate(),
      idempotencyKey: newDueDateOperationKey(),
    });
    setDueDateModal(order);
  };

  const saveDueDate = async () => {
    if (!dueDateForm.date) return toast.error('Informe o vencimento');
    if (!dueDateModal) return;

    setSavingDueDate(true);
    try {
      const result = await updateOrderDueDate(
        dueDateModal.type,
        dueDateModal.id,
        dueDateForm.date,
        dueDateForm.idempotencyKey || newDueDateOperationKey(),
      );
      const savedDueDate = result?.due_date || dueDateForm.date;

      const nextOrders = orders.map(o =>
        o.id === dueDateModal.id && o.type === dueDateModal.type
          ? { ...o, due_date: savedDueDate }
          : o
      );
      setOrders(nextOrders);
      patchFinancialPageCache({ orders: nextOrders });
      toast.success('Vencimento atualizado');
      setDueDateModal(null);
    } catch (e) {
      if (e.code === 'reconciliation_required') {
        const operationId = e.details?.operation_id;
        toast.error(`${e.message || 'Alteração pendente de conferência'}${operationId ? ` · Protocolo ${operationId}` : ''}`);
      } else if (e.code === 'operation_in_progress') {
        toast.error('Esta alteração já está em processamento. Aguarde alguns segundos e tente novamente.');
      } else {
        toast.error(e.message || 'Erro ao salvar vencimento');
      }
    } finally {
      setSavingDueDate(false);
    }
  };

  const openCollectionEditor = (order) => {
    setCollectionTask(collectionTaskFor(order, commConfig.rules));
  };

  // Pós-envio: o registro no banco (link, vencimento, status, evento de histórico)
  // é feito pelo registerCommunicationSend dentro do diálogo compartilhado — aqui
  // só refletimos na lista local o que o backend já gravou.
  const handleCollectionSent = () => {
    const t = collectionTask;
    setCollectionTask(null);
    if (!t) return;
    const nowIso = new Date().toISOString();
    setOrders(prev => {
      const next = prev.map(o => (o.id === t.sourceId && o.type === t.sourceType)
        ? {
            ...o,
            payment_message_sent_at: nowIso,
            payment_status: ['awaiting_charge', 'pending'].includes(o.payment_status) ? 'charge_sent' : o.payment_status,
            due_date: o.due_date || defaultPaymentDueDate(),
          }
        : o);
      patchFinancialPageCache({ orders: next });
      return next;
    });
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
            Vendas que ainda precisam de cobrança ou pagamento · Loja · Pré-venda · Assessoria · Eventos
          </p>
          {(loadingRec || fetchedAt) && (
            <p className="text-xs text-muted-foreground mt-1">
              {loadingRec
                ? 'Atualizando recebíveis Asaas...'
                : `Recebíveis Asaas atualizados às ${fetchedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
            </p>
          )}
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

      <FinancialDataQuality issues={qualityIssues} />

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

          {/* Atalho para a Central de Estornos. A lista completa, o
              historico e os comprovantes vivem la; aqui fica so o alerta. */}
          {pendingRefunds.length > 0 && (
            <Card className="border-orange-200">
              <CardContent className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-orange-700" />
                  <span className="text-sm font-semibold text-orange-800">
                    {pendingRefunds.length} estorno{pendingRefunds.length !== 1 ? 's' : ''} a fazer
                  </span>
                  <span className="font-bold text-sm text-orange-700">
                    {formatCurrency(pendingRefunds.reduce((s, r) => s + (r.refund_amount || 0), 0))}
                  </span>
                </div>
                <Link
                  to="/estornos"
                  className="text-sm font-semibold text-orange-700 hover:underline"
                >
                  Abrir Central de Estornos →
                </Link>
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
                <p className="text-xs text-muted-foreground">Divisão dos recebimentos de {formatCurrency(receivedMonth)}</p>
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
              <p className="text-xs text-muted-foreground mt-0.5">
                {receivablesTotal > 0
                  ? `Recebíveis Asaas carregados: ${formatCurrency(receivablesTotal)}. Parcelas e histórico ficam no Fluxo de Caixa.`
                  : 'Parcelas de cartão, recebíveis Asaas e histórico ficam agora no Fluxo de Caixa.'}
              </p>
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

      {/* ── Cobrança: mesmo diálogo/motor da Central de Comunicação ── */}
      <CommunicationSendDialog
        key={collectionTask?.id || 'none'}
        task={collectionTask}
        communityLink={commConfig.communityLink}
        onClose={() => setCollectionTask(null)}
        onSent={handleCollectionSent}
      />

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
                  onChange={e => setDueDateForm({
                    date: e.target.value,
                    idempotencyKey: newDueDateOperationKey(),
                  })}
                />
              </div>

              {dueDateModal.asaas_charge_id && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  Esta venda tem cobrança Asaas. O vencimento será confirmado no Asaas antes de atualizar o lançamento interno.
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
    </div>
  );
}
