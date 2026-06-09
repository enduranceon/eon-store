import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3, Search, X, ChevronRight, Copy, Check, ExternalLink,
  CreditCard, Zap, Banknote, Loader2, ShoppingCart,
  Calendar, DollarSign, CheckCircle2, AlertTriangle, Filter,
  Users, TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { supabase } from '@/api/db';
import { PreSaleOrder, PreSaleCampaign } from '@/api/entities';
import { formatCurrency, formatDate, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import { isEffectiveSale, isNonCancelledOrder } from '@/lib/sales';
import { usePageData } from '@/hooks/usePageData';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  paid:             { label: 'Pago',        color: 'bg-green-100 text-green-700' },
  awaiting_charge:  { label: 'Pedido recebido', color: 'bg-gray-100 text-gray-600' },
  charge_sent:      { label: 'Cobrado',     color: 'bg-blue-100 text-blue-700' },
  partially_paid:   { label: 'Parcial',     color: 'bg-amber-100 text-amber-700' },
  overdue:          { label: 'Vencido',     color: 'bg-red-100 text-red-700' },
  cancelled:        { label: 'Cancelado',   color: 'bg-gray-100 text-gray-500 line-through' },
  refunded:         { label: 'Estornado',   color: 'bg-purple-100 text-purple-700' },
};

const ASAAS_STATUS_LABELS = {
  RECEIVED:          { label: 'Recebido',    color: 'bg-green-100 text-green-700' },
  CONFIRMED:         { label: 'Confirmado',  color: 'bg-green-100 text-green-700' },
  RECEIVED_IN_CASH:  { label: 'Recebido',    color: 'bg-green-100 text-green-700' },
  PENDING:           { label: 'Aguardando',  color: 'bg-amber-100 text-amber-700' },
  OVERDUE:           { label: 'Vencida',     color: 'bg-red-100 text-red-700' },
  REFUNDED:          { label: 'Estornada',   color: 'bg-purple-100 text-purple-700' },
  PARTIALLY_REFUNDED:{ label: 'Est. parcial',color: 'bg-purple-100 text-purple-700' },
  AWAITING_RISK_ANALYSIS: { label: 'Em análise', color: 'bg-blue-100 text-blue-700' },
};

function StatusBadge({ status }) {
  const s = STATUS_LABELS[status] || { label: status, color: 'bg-gray-100 text-gray-600' };
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${s.color}`}>{s.label}</span>;
}

function TypeBadge({ type }) {
  if (type === 'contract') return (
    <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium whitespace-nowrap">🏃 Assessoria</span>
  );
  if (type === 'stock') return (
    <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium whitespace-nowrap">📦 Estoque</span>
  );
  return (
    <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium whitespace-nowrap">🛒 Pré-venda</span>
  );
}

function PayMethodIcon({ method }) {
  const pm = (method || '').toLowerCase();
  if (pm === 'pix' || pm === 'pix_manual') return <Zap className="w-3.5 h-3.5 text-green-600" />;
  if (pm === 'boleto') return <Banknote className="w-3.5 h-3.5 text-amber-600" />;
  return <CreditCard className="w-3.5 h-3.5 text-blue-500" />;
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  if (!value) return null;
  return (
    <button onClick={handleCopy}
      className="text-muted-foreground hover:text-gray-800 transition-colors p-0.5 rounded">
      {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function getMonthOptions() {
  const opts = [{ value: 'all', label: 'Todos os meses' }];
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = toLocalDateStr(d).slice(0, 7);
    const label = d.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    opts.push({ value: ym, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────
// MODAL DE DETALHE DE VENDA
// ─────────────────────────────────────────────────────────────────

function SaleDetailModal({ sale, onClose }) {
  const [installments, setInstallments] = useState(null);
  const [loadingInst, setLoadingInst] = useState(false);
  const [instError, setInstError] = useState(null);
  const [installmentRetry, setInstallmentRetry] = useState(0);

  const pm = (sale?.payment_method || '').toLowerCase();
  const isAsaasCard = pm === 'credit_card' || (pm.startsWith('card_') && pm !== 'card_machine');
  const isAsaas = isAsaasCard || pm === 'pix' || pm === 'boleto';
  const hasAsaas = sale?.asaas_charge_id && isAsaas;

  useEffect(() => {
    if (!sale || sale.type !== 'contract' || !hasAsaas) return undefined;

    let active = true;
    const timer = setTimeout(async () => {
      setLoadingInst(true);
      setInstError(null);
      try {
        const { data, error } = await supabase.functions.invoke('fetch-contract-installments', {
          body: { contract_id: sale.id },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        if (active) setInstallments(data);
      } catch (error) {
        console.error('[SaleDetail installments]', error);
        if (active) setInstError(error.message || 'Erro ao buscar parcelas');
      } finally {
        if (active) setLoadingInst(false);
      }
    }, 0);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [hasAsaas, installmentRetry, sale]);

  if (!sale) return null;

  const detailLink = sale.type === 'contract' ? `/assessoria/contratos/${sale.id}`
    : sale.type === 'stock' ? `/estoque/pedidos/${sale.id}`
    : `/pedidos/${sale.id}`;

  const pmLabel = PAYMENT_METHOD_LABELS[sale.payment_method] || sale.payment_method || '—';
  const installmentN = sale.installments || (() => {
    const m = pm.match(/^card_(\d+)x$/);
    return m ? parseInt(m[1]) : 1;
  })();

  return (
    <Dialog open={!!sale} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TypeBadge type={sale.type} />
            <span className="font-mono">{sale.order_number}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Info básica */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cliente</span>
              <span className="font-medium">{sale.customer || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <StatusBadge status={sale.payment_status} />
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Forma de pagamento</span>
              <span className="flex items-center gap-1.5">
                <PayMethodIcon method={sale.payment_method} />
                <span>{pmLabel}</span>
                {installmentN > 1 && <span className="text-muted-foreground">({installmentN}x)</span>}
              </span>
            </div>
            {sale.payment_date && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Data de pagamento</span>
                <span>{formatDate(sale.payment_date)}</span>
              </div>
            )}
            {sale.due_date && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Vencimento</span>
                <span>{formatDate(sale.due_date)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-200 pt-2 mt-1">
              <span className="text-muted-foreground">Valor total</span>
              <span className="font-bold text-gray-900 text-base">{formatCurrency(sale.total_value)}</span>
            </div>
          </div>

          {/* Asaas charge ID */}
          {sale.asaas_charge_id && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                ID Asaas
              </p>
              <div className="flex items-center gap-2 bg-slate-50 border rounded-lg px-3 py-2">
                <code className="font-mono text-xs text-slate-700 flex-1 break-all">
                  {sale.asaas_charge_id}
                </code>
                <CopyButton value={sale.asaas_charge_id} />
              </div>
            </div>
          )}

          {/* Parcelas Asaas (contratos parcelados) */}
          {sale.type === 'contract' && hasAsaas && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Parcelas no Asaas
              </p>

              {loadingInst && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Buscando parcelas...
                </div>
              )}

              {instError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Erro ao buscar parcelas</p>
                    <p className="text-xs mt-0.5">{instError}</p>
                    <button onClick={() => setInstallmentRetry(value => value + 1)}
                      className="text-xs text-red-700 underline mt-1 hover:no-underline">
                      Tentar novamente
                    </button>
                  </div>
                </div>
              )}

              {installments && !loadingInst && !instError && (
                <>
                  {installments.asaasError && (
                    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      Não foi possível conectar ao Asaas. Verifique manualmente.
                    </p>
                  )}
                  {installments.noCharge && (
                    <p className="text-sm text-gray-500 bg-gray-50 border rounded-lg p-3">
                      Contrato sem cobrança gerada no Asaas.
                    </p>
                  )}
                  {installments.installments?.length > 0 && (
                    <div className="border rounded-xl overflow-hidden">
                      <div className="bg-gray-50 px-3 py-2 text-xs font-semibold text-muted-foreground border-b flex justify-between">
                        <span>{installments.isSingle ? 'Pagamento único' : `${installments.installments.length} parcelas`}</span>
                        {installments.installmentGroupId && (
                          <span className="font-mono text-[10px] text-gray-400">
                            Grupo: {installments.installmentGroupId.slice(0, 16)}…
                          </span>
                        )}
                      </div>
                      <div className="divide-y">
                        {installments.installments.map(inst => {
                          const st = ASAAS_STATUS_LABELS[inst.status] || { label: inst.status, color: 'bg-gray-100 text-gray-600' };
                          const displayDate = inst.creditDate || inst.paymentDate || inst.dueDate;
                          return (
                            <div key={inst.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                              {/* Número da parcela */}
                              <span className="text-xs font-bold text-muted-foreground shrink-0 w-6 text-center">
                                {installments.isSingle ? '1x' : `${inst.number}/${inst.total}`}
                              </span>
                              {/* Data */}
                              <span className="text-xs text-muted-foreground shrink-0 w-20">
                                {displayDate ? formatDate(displayDate) : '—'}
                              </span>
                              {/* Status */}
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${st.color}`}>
                                {st.label}
                              </span>
                              {/* Valor líquido */}
                              <span className="flex-1 text-right font-semibold">
                                {formatCurrency(inst.netValue || inst.value)}
                              </span>
                              {/* Bruto se diferente */}
                              {inst.netValue && inst.value && inst.netValue !== inst.value && (
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  bruto {formatCurrency(inst.value)}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {/* Resumo das parcelas */}
                      {!installments.isSingle && (
                        <div className="bg-gray-50 border-t px-3 py-2 flex justify-between text-xs font-semibold text-gray-700">
                          <span>
                            <span className="text-green-700">
                              {installments.installments.filter(i => i.isPaid).length} paga{installments.installments.filter(i => i.isPaid).length !== 1 ? 's' : ''}
                            </span>
                            {installments.installments.filter(i => i.isPending).length > 0 && (
                              <span className="text-amber-700 ml-3">
                                {installments.installments.filter(i => i.isPending).length} pendente{installments.installments.filter(i => i.isPending).length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </span>
                          <span>
                            Total líq.: {formatCurrency(
                              installments.installments.reduce((s, i) => s + (i.netValue || i.value || 0), 0)
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Loja: só mostra o charge ID */}
              {installments?.storeOrder && (
                <p className="text-xs text-muted-foreground bg-gray-50 border rounded-lg p-3">
                  Pedido da loja — use o ID Asaas acima para visualizar as cobranças no painel Asaas.
                </p>
              )}
            </div>
          )}

          {/* Itens (pedidos loja) */}
          {sale.items?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Itens
              </p>
              <div className="border rounded-xl divide-y">
                {sale.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">{item.product_name}</span>
                      {item.variation && <span className="text-muted-foreground ml-1.5 text-xs">{item.variation}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      <span className="text-muted-foreground text-xs">x{item.quantity || 1}</span>
                      <span className="font-semibold">{formatCurrency(item.sale_price * (item.quantity || 1))}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Plano assessoria */}
          {sale.plan_name && (
            <div className="flex justify-between text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
              <span className="text-muted-foreground">Plano</span>
              <span className="font-medium text-blue-800">{sale.plan_name}</span>
            </div>
          )}

          {/* Link para detalhe */}
          <Link to={detailLink} onClick={onClose}
            className="flex items-center justify-center gap-2 w-full border rounded-lg py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            <ExternalLink className="w-4 h-4" />
            Abrir detalhe completo
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────
// TAB VENDAS
// ─────────────────────────────────────────────────────────────────

async function loadReportsSales() {
  const [presaleRes, stockRes, contractRes, plansRes, customersRes] = await Promise.all([
    supabase.from('presale_orders')
      .select('id, order_number, checkout_name, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, manual_fee, items, created_date')
      .order('created_date', { ascending: false }),
    supabase.from('stock_orders')
      .select('id, order_number, customer_name, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, manual_fee, items, created_date')
      .order('created_date', { ascending: false }),
    supabase.from('assessment_contracts')
      .select('id, contract_number, customer_id, plan_id, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, manual_fee, enrollment_fee, manual_discount, status, installments, created_at, plan_snapshot')
      .neq('status', 'cancelled').neq('status', 'draft')
      .order('created_at', { ascending: false }),
    supabase.from('assessment_plans').select('id, price_total, name'),
    supabase.from('presale_customers').select('id, full_name'),
  ]);

  const plansMap = Object.fromEntries((plansRes.data || []).map(p => [p.id, p]));
  const customersMap = Object.fromEntries((customersRes.data || []).map(c => [c.id, c]));
  const presale = (presaleRes.data || []).map(o => ({
    ...o,
    type: 'presale',
    customer: o.checkout_name,
    created_at: o.created_date,
  }));
  const stock = (stockRes.data || []).map(o => ({
    ...o,
    type: 'stock',
    customer: o.customer_name,
    created_at: o.created_date,
  }));
  const contracts = (contractRes.data || []).map(c => {
    const plan = plansMap[c.plan_id];
    const snapPrice = c.plan_snapshot?.price_total;
    const base = snapPrice != null ? Number(snapPrice) : (plan ? Number(plan.price_total) : 0);
    const totalValue = Math.max(0, base + (Number(c.enrollment_fee) || 0) - (Number(c.manual_discount) || 0));
    return {
      id: c.id,
      order_number: c.contract_number,
      customer: customersMap[c.customer_id]?.full_name || '—',
      plan_name: c.plan_snapshot?.name || plan?.name || '—',
      total_value: totalValue,
      payment_status: c.payment_status,
      payment_method: c.payment_method,
      payment_date: c.payment_date,
      due_date: c.due_date,
      asaas_charge_id: c.asaas_charge_id,
      manual_fee: c.manual_fee,
      installments: c.installments || 1,
      type: 'contract',
      created_at: c.created_at,
    };
  });

  return [...contracts, ...presale, ...stock].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  );
}

function SalesTab() {
  const { data: sales, loading } = usePageData({
    key: 'reports:sales',
    loader: loadReportsSales,
    initialData: [],
    tags: [
      'presale_orders',
      'stock_orders',
      'assessment_contracts',
      'assessment_plans',
      'presale_customers',
    ],
    onError: error => {
      console.error('[SalesTab]', error);
      toast.error('Erro ao carregar vendas');
    },
  });
  const [search, setSearch]       = useState('');
  const [monthFilter, setMonth]   = useState(toLocalDateStr(new Date()).slice(0, 7)); // mês atual
  const [typeFilter, setType]     = useState('all');
  const [statusFilter, setStatus] = useState('all');
  const [selected, setSelected]   = useState(null);

  const monthOptions = useMemo(() => getMonthOptions(), []);

  const filtered = useMemo(() => {
    return sales.filter(s => {
      if (typeFilter !== 'all' && s.type !== typeFilter) return false;
      if (statusFilter !== 'all' && s.payment_status !== statusFilter) return false;
      if (monthFilter !== 'all') {
        const dateStr = s.payment_date || s.created_at || '';
        if (!dateStr.startsWith(monthFilter)) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!(s.order_number || '').toLowerCase().includes(q) &&
            !(s.customer || '').toLowerCase().includes(q) &&
            !(s.asaas_charge_id || '').toLowerCase().includes(q) &&
            !(s.plan_name || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [sales, typeFilter, statusFilter, monthFilter, search]);

  const effectiveFiltered = filtered.filter(isEffectiveSale);
  const totalValue   = effectiveFiltered.reduce((s, o) => s + (o.total_value || 0), 0);
  const totalPaid    = effectiveFiltered.filter(o => o.payment_status === 'paid').reduce((s, o) => s + (o.total_value || 0), 0);
  const countContracts = effectiveFiltered.filter(o => o.type === 'contract').length;
  const countLoja      = effectiveFiltered.filter(o => o.type !== 'contract').length;

  if (loading) return (
    <div className="flex items-center justify-center py-20 gap-3 text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin" />
      <span className="text-sm">Carregando vendas...</span>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* ── KPI Summary ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Vendas filtradas', value: effectiveFiltered.length, sub: `${countContracts} assessoria · ${countLoja} loja`, icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-50' },
          { label: 'Valor total',      value: formatCurrency(totalValue),  sub: 'soma do período',   icon: DollarSign,   color: 'text-gray-700', bg: 'bg-gray-50' },
          { label: 'Total pago',       value: formatCurrency(totalPaid),   sub: 'pagamentos confirmados', icon: CheckCircle2, color: 'text-green-700', bg: 'bg-green-50' },
          { label: 'Clientes únicos',  value: new Set(filtered.map(o => o.customer)).size, sub: 'no período filtrado', icon: Users, color: 'text-purple-700', bg: 'bg-purple-50' },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`p-2 rounded-full shrink-0 ${k.bg}`}>
                <k.icon className={`w-4 h-4 ${k.color}`} />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className={`text-lg font-bold ${k.color}`}>{k.value}</p>
                <p className="text-[10px] text-muted-foreground">{k.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Filtros ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Busca */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por número, cliente, ID Asaas..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-8 text-sm h-9"
          />
          {search && (
            <button onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-gray-700">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Mês */}
        <Select value={monthFilter} onValueChange={setMonth}>
          <SelectTrigger className="h-9 text-sm w-48">
            <Calendar className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Mês" />
          </SelectTrigger>
          <SelectContent>
            {monthOptions.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Tipo */}
        <Select value={typeFilter} onValueChange={setType}>
          <SelectTrigger className="h-9 text-sm w-40">
            <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tipos</SelectItem>
            <SelectItem value="contract">🏃 Assessoria</SelectItem>
            <SelectItem value="presale">🛒 Pré-venda</SelectItem>
            <SelectItem value="stock">📦 Estoque</SelectItem>
          </SelectContent>
        </Select>

        {/* Status */}
        <Select value={statusFilter} onValueChange={setStatus}>
          <SelectTrigger className="h-9 text-sm w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="paid">Pago</SelectItem>
            <SelectItem value="charge_sent">Cobrado</SelectItem>
            <SelectItem value="awaiting_charge">Pedido recebido</SelectItem>
            <SelectItem value="overdue">Vencido</SelectItem>
            <SelectItem value="cancelled">Cancelado</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Tabela de vendas ─────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Search className="w-8 h-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Nenhuma venda encontrada com os filtros atuais.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            {/* Header */}
            <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 px-4 py-2.5 bg-gray-50 border-b text-xs font-semibold text-muted-foreground">
              <span>Tipo</span>
              <span>Cliente / Número</span>
              <span className="text-right hidden sm:block">Data</span>
              <span className="text-right">Valor</span>
              <span>Status</span>
              <span />
            </div>
            {/* Rows */}
            <div className="divide-y">
              {filtered.map(sale => {
                const pm = (sale.payment_method || '').toLowerCase();
                const installN = sale.installments || (() => {
                  const m = pm.match(/^card_(\d+)x$/);
                  return m ? parseInt(m[1]) : 1;
                })();
                const dateStr = sale.payment_date || sale.due_date || sale.created_at;
                return (
                  <button key={sale.id + sale.type}
                    onClick={() => setSelected(sale)}
                    className="w-full grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left group">
                    <TypeBadge type={sale.type} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm font-semibold text-blue-700">{sale.order_number}</span>
                        <span className="text-muted-foreground text-xs hidden sm:inline">·</span>
                        <span className="text-xs text-muted-foreground truncate hidden sm:block max-w-[150px]">{sale.customer}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="sm:hidden text-xs text-muted-foreground truncate">{sale.customer}</span>
                        {sale.payment_method && (
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <PayMethodIcon method={sale.payment_method} />
                            {installN > 1 ? `${installN}x` : PAYMENT_METHOD_LABELS[sale.payment_method] || sale.payment_method}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground hidden sm:block text-right whitespace-nowrap">
                      {dateStr ? formatDate(dateStr.slice(0, 10)) : '—'}
                    </span>
                    <span className="font-semibold text-sm text-right whitespace-nowrap">
                      {formatCurrency(sale.total_value)}
                    </span>
                    <StatusBadge status={sale.payment_status} />
                    <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                );
              })}
            </div>
          </div>
          {/* Footer count */}
          <div className="px-4 py-2 border-t bg-gray-50 flex items-center justify-between text-xs text-muted-foreground">
            <span>{filtered.length} venda{filtered.length !== 1 ? 's' : ''}</span>
            <span className="font-semibold text-gray-700">{formatCurrency(totalValue)}</span>
          </div>
        </Card>
      )}

      {/* Modal de detalhe */}
      <SaleDetailModal sale={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TAB LOJA (relatórios existentes)
// ─────────────────────────────────────────────────────────────────

function StoreReportsTab() {
  const {
    data: { orders, campaigns },
  } = usePageData({
    key: 'reports:store',
    loader: async () => {
      const [ordersData, campaignsData] = await Promise.all([
        PreSaleOrder.list(),
        PreSaleCampaign.list(),
      ]);
      return { orders: ordersData, campaigns: campaignsData };
    },
    initialData: { orders: [], campaigns: [] },
    tags: ['presale_orders', 'presale_campaigns'],
    onError: error => console.error('[StoreReportsTab]', error),
  });
  const [campaignFilter, setCampaignFilter] = useState('all');

  const filteredOrders = campaignFilter === 'all'
    ? orders
    : orders.filter(o => o.campaign_id === campaignFilter);

  const active = filteredOrders.filter(isNonCancelledOrder);
  const effectiveOrders = active.filter(isEffectiveSale);
  const totalSold      = effectiveOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid      = effectiveOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending   = effectiveOrders.filter(o => o.payment_status !== 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalCancelled = filteredOrders.filter(o => o.payment_status === 'cancelled').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalCost      = effectiveOrders.reduce((acc, o) => acc + (o.total_cost || 0), 0);
  const grossProfit    = totalSold - totalCost;
  const margin         = totalSold > 0 ? (grossProfit / totalSold) * 100 : 0;

  const byCampaign = campaigns.map(c => {
    const co = orders.filter(o => o.campaign_id === c.id && isNonCancelledOrder(o));
    const effectiveCo = co.filter(isEffectiveSale);
    const sold = effectiveCo.reduce((acc, o) => acc + (o.total_value || 0), 0);
    const paid = effectiveCo.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
    const cost = effectiveCo.reduce((acc, o) => acc + (o.total_cost || 0), 0);
    const profit = sold - cost;
    const uniqueCustomers = new Set(co.map(o => o.customer_id || o.checkout_whatsapp)).size;
    return { name: c.name, orders: co.length, sold, paid, cost, profit, uniqueCustomers, margin: sold > 0 ? (profit / sold) * 100 : 0 };
  });

  const supplierReport = {};
  active.forEach(o => {
    (o.items || []).filter(it => !it.cancelled).forEach(item => {
      const key = `${item.product_name}||${item.variation || ''}`;
      if (!supplierReport[key]) {
        supplierReport[key] = {
          product: item.product_name,
          variation: item.variation || '-',
          totalQty: 0,
          paidQty: 0,
          pendingQty: 0,
          orderNumbers: [],
        };
      }
      supplierReport[key].totalQty += item.quantity || 1;
      if (o.order_number && !supplierReport[key].orderNumbers.includes(o.order_number)) {
        supplierReport[key].orderNumbers.push(o.order_number);
      }
      if (o.payment_status === 'paid') supplierReport[key].paidQty += item.quantity || 1;
      else supplierReport[key].pendingQty += item.quantity || 1;
    });
  });

  const deliveryReport  = active.filter(o => o.payment_status === 'paid' && o.delivery_status !== 'delivered');
  const deliveredOrders = active.filter(o => o.delivery_status === 'delivered');

  const chartData = byCampaign.filter(c => c.sold > 0).map(c => ({
    name: c.name.length > 20 ? c.name.slice(0, 20) + '…' : c.name,
    Vendido: c.sold, Pago: c.paid, Lucro: c.profit,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Select value={campaignFilter} onValueChange={setCampaignFilter}>
          <SelectTrigger className="w-52 text-sm h-9"><SelectValue placeholder="Filtrar por campanha" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as campanhas</SelectItem>
            {campaigns.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="financeiro">
        <TabsList className="mb-4">
          <TabsTrigger value="financeiro">Financeiro</TabsTrigger>
          <TabsTrigger value="campanhas">Por Campanha</TabsTrigger>
          <TabsTrigger value="fornecedor">Para Fornecedor</TabsTrigger>
          <TabsTrigger value="entrega">Entregas</TabsTrigger>
        </TabsList>

        {/* FINANCEIRO */}
        <TabsContent value="financeiro" className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total vendido',   value: formatCurrency(totalSold),      color: 'text-gray-900' },
              { label: 'Total pago',      value: formatCurrency(totalPaid),      color: 'text-green-700' },
              { label: 'Total pendente',  value: formatCurrency(totalPending),   color: 'text-yellow-700' },
              { label: 'Total cancelado', value: formatCurrency(totalCancelled), color: 'text-red-700' },
              { label: 'Custo produtos',  value: formatCurrency(totalCost),      color: 'text-red-700' },
              { label: 'Lucro estimado',  value: formatCurrency(grossProfit),    color: grossProfit >= 0 ? 'text-green-700' : 'text-red-700' },
              { label: 'Margem estimada', value: `${margin.toFixed(1)}%`,        color: margin >= 0 ? 'text-green-700' : 'text-red-700' },
              { label: 'Pedidos ativos',  value: active.length,                  color: 'text-gray-900' },
            ].map(k => (
              <Card key={k.label}>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{k.label}</p>
                  <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          {chartData.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Vendas por Campanha</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={chartData} margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={v => `R$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={v => formatCurrency(v)} />
                    <Bar dataKey="Vendido" fill="#3b82f6" />
                    <Bar dataKey="Pago" fill="#22c55e" />
                    <Bar dataKey="Lucro" fill="#a855f7" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* POR CAMPANHA */}
        <TabsContent value="campanhas">
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Campanha</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground">Pedidos</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground">Clientes</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Vendido</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Pago</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Lucro</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Margem</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byCampaign.map(c => (
                  <tr key={c.name} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-center">{c.orders}</td>
                    <td className="px-4 py-3 text-center">{c.uniqueCustomers}</td>
                    <td className="px-4 py-3 text-right">{formatCurrency(c.sold)}</td>
                    <td className="px-4 py-3 text-right text-green-700">{formatCurrency(c.paid)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${c.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{formatCurrency(c.profit)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${c.margin >= 0 ? 'text-green-700' : 'text-red-700'}`}>{c.margin.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* PARA FORNECEDOR */}
        <TabsContent value="fornecedor">
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Variação</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Qtd total</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Paga</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Pendente</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.values(supplierReport).sort((a, b) => b.totalQty - a.totalQty).map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">
                      <span>{r.product}</span>
                      {r.orderNumbers.length > 0 && (
                        <span className="block text-[10px] font-normal text-muted-foreground mt-0.5">
                          {r.orderNumbers.join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.variation}</td>
                    <td className="px-4 py-3 text-right font-semibold">{r.totalQty}</td>
                    <td className="px-4 py-3 text-right text-green-700">{r.paidQty}</td>
                    <td className="px-4 py-3 text-right text-yellow-700">{r.pendingQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ENTREGAS */}
        <TabsContent value="entrega" className="space-y-6">
          <div>
            <h3 className="font-semibold text-base mb-3 text-yellow-700">
              Aguardando entrega ({deliveryReport.length})
            </h3>
            <div className="overflow-x-auto rounded-lg border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nº</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">WhatsApp</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto(s)</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deliveryReport.map(o => (
                    <tr key={o.id}>
                      <td className="px-4 py-3 font-mono font-semibold text-blue-700">{o.order_number}</td>
                      <td className="px-4 py-3 font-medium">{o.checkout_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{o.checkout_whatsapp}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {(o.items || []).filter(i => !i.cancelled).map(i => `${i.product_name}${i.variation ? ' ' + i.variation : ''} x${i.quantity}`).join(', ')}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold">{formatCurrency(o.total_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="font-semibold text-base mb-3 text-green-700">
              Entregues ({deliveredOrders.length})
            </h3>
            <div className="overflow-x-auto rounded-lg border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nº</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">WhatsApp</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto(s)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deliveredOrders.map(o => (
                    <tr key={o.id}>
                      <td className="px-4 py-3 font-mono font-semibold text-blue-700">{o.order_number}</td>
                      <td className="px-4 py-3 font-medium">{o.checkout_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{o.checkout_whatsapp}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {(o.items || []).filter(i => !i.cancelled).map(i => `${i.product_name}${i.variation ? ' ' + i.variation : ''} x${i.quantity}`).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// PÁGINA PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export default function Reports() {
  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div>
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-blue-600" />
          Relatórios
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">Vendas detalhadas · Loja · Assessoria</p>
      </div>

      <Tabs defaultValue="vendas">
        <TabsList>
          <TabsTrigger value="vendas" className="flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" />
            Vendas
          </TabsTrigger>
          <TabsTrigger value="loja" className="flex items-center gap-1.5">
            <ShoppingCart className="w-3.5 h-3.5" />
            Relatórios Loja
          </TabsTrigger>
        </TabsList>

        <TabsContent value="vendas" className="mt-4">
          <SalesTab />
        </TabsContent>

        <TabsContent value="loja" className="mt-4">
          <StoreReportsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
