import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock3,
  PackageCheck,
  PackagePlus,
  Search,
  Truck,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PreSaleCampaign, PreSaleCustomer, PreSaleOrder, StockOrder } from '@/api/entities';
import { fulfillmentStatus } from '@/lib/order-fulfillment';
import { formatCurrency, formatDate } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const PAYMENT_STATUS = {
  pending: { label: 'Aguardando cobrança', variant: 'secondary' },
  awaiting_charge: { label: 'Aguardando cobrança', variant: 'secondary' },
  charge_sent: { label: 'Cobrança enviada', variant: 'info' },
  overdue: { label: 'Cobrança vencida', variant: 'warning' },
  paid: { label: 'Pago', variant: 'success' },
  partially_paid: { label: 'Parcialmente pago', variant: 'warning' },
  cancelled: { label: 'Cancelado', variant: 'destructive' },
  refunded: { label: 'Reembolsado', variant: 'purple' },
};

const PAYMENT_FILTERS = [
  { value: 'all', label: 'Todos pagamentos' },
  { value: 'awaiting_charge', label: 'Aguardando cobrança', statuses: ['pending', 'awaiting_charge'] },
  { value: 'charge_sent', label: 'Cobrança enviada', statuses: ['charge_sent'] },
  { value: 'overdue', label: 'Cobrança vencida', statuses: ['overdue'] },
  { value: 'partially_paid', label: 'Parcialmente pago', statuses: ['partially_paid'] },
  { value: 'paid', label: 'Pago', statuses: ['paid'] },
  { value: 'cancelled', label: 'Cancelado', statuses: ['cancelled'] },
  { value: 'refunded', label: 'Reembolsado', statuses: ['refunded'] },
];

// Os nomes e explicações vêm de order-fulfillment. Esta tabela contém apenas
// o aspecto visual específico desta tela, evitando uma segunda fonte de verdade.
const DELIVERY_VISUAL = {
  stock: {
    awaiting_delivery: {
      color: 'bg-violet-100 text-violet-800 ring-violet-200',
      icon: Clock3,
    },
    separated: {
      color: 'bg-amber-100 text-amber-800 ring-amber-200',
      icon: PackageCheck,
    },
    delivered: {
      color: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
      icon: CheckCircle2,
    },
    cancelled: {
      color: 'bg-red-100 text-red-800 ring-red-200',
      icon: XCircle,
    },
  },
  presale: {
    awaiting_supplier: {
      color: 'bg-slate-100 text-slate-700 ring-slate-200',
      icon: Clock3,
    },
    supplier_ordered: {
      color: 'bg-blue-100 text-blue-800 ring-blue-200',
      icon: Truck,
    },
    received: {
      color: 'bg-sky-100 text-sky-800 ring-sky-200',
      icon: PackageCheck,
    },
    separated: {
      color: 'bg-amber-100 text-amber-800 ring-amber-200',
      icon: PackageCheck,
    },
    delivered: {
      color: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
      icon: CheckCircle2,
    },
    cancelled: {
      color: 'bg-red-100 text-red-800 ring-red-200',
      icon: XCircle,
    },
  },
};

const DELIVERY_FILTERS = [
  { value: 'all', label: 'Todas as etapas' },
  { value: 'unknown', label: 'Sem etapa definida' },
  { value: 'awaiting', label: 'Aguardando preparação' },
  { value: 'procurement', label: 'Com fornecedor' },
  { value: 'available', label: 'Produto disponível' },
  { value: 'ready', label: 'Separado para entrega' },
  { value: 'delivered', label: 'Entregue' },
  { value: 'stopped', label: 'Entrega interrompida' },
];

// Forma de entrega escolhida no checkout, diferente da etapa de entrega:
// aqui é COMO o pedido sai (frete ou retirada), não em que ponto do fluxo está.
// 'unset' existe porque pedidos antigos e vendas manuais ficaram sem o campo —
// sem essa opção eles sumiriam da tela ao filtrar e pareceriam perdidos.
const DELIVERY_METHOD_FILTERS = [
  { value: 'all', label: 'Todas as formas' },
  { value: 'shipping', label: 'Frete' },
  { value: 'pickup', label: 'Retirada em treino' },
  { value: 'unset', label: 'Forma não informada' },
];

const ORIGIN_VALUES = new Set(['all', 'stock', 'presale']);
const PAYMENT_FILTER_VALUES = new Set(PAYMENT_FILTERS.map(filter => filter.value));
const DELIVERY_FILTER_VALUES = new Set(DELIVERY_FILTERS.map(filter => filter.value));
const DELIVERY_METHOD_FILTER_VALUES = new Set(DELIVERY_METHOD_FILTERS.map(filter => filter.value));

function matchesDeliveryMethod(order, filter) {
  if (filter === 'all') return true;
  if (filter === 'unset') return !order.delivery_method;
  return order.delivery_method === filter;
}

function paymentStatus(status) {
  return PAYMENT_STATUS[status] || { label: status || 'Sem status financeiro', variant: 'secondary' };
}

function deliveryBucket(status) {
  if (!status) return 'unknown';
  if (status === 'awaiting_delivery' || status === 'awaiting_supplier') return 'awaiting';
  if (status === 'supplier_ordered') return 'procurement';
  if (status === 'received') return 'available';
  if (status === 'separated') return 'ready';
  if (status === 'delivered') return 'delivered';
  if (status === 'cancelled') return 'stopped';
  return 'unknown';
}

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

function normalizeOrder(order, type, customersById, campaignsById) {
  const customer = order.customer_id ? customersById[order.customer_id] : null;
  const deliveryVisual = DELIVERY_VISUAL[type][order.delivery_status] || {
    color: 'bg-gray-100 text-gray-700 ring-gray-200',
    icon: Clock3,
  };
  const delivery = {
    ...fulfillmentStatus(type, order.delivery_status),
    ...deliveryVisual,
  };

  return {
    ...order,
    type,
    typeLabel: type === 'stock' ? 'Loja' : 'Pré-venda',
    customer: firstText(
      order.customer_name,
      order.checkout_name,
      customer?.full_name,
    ) || 'Cliente não informado',
    contact: firstText(
      order.customer_whatsapp,
      order.checkout_whatsapp,
      order.customer_email,
      order.checkout_email,
      customer?.whatsapp,
      customer?.email,
    ),
    trainer: firstText(order.checkout_trainer),
    campaignName: type === 'presale' ? campaignsById[order.campaign_id]?.name || '' : '',
    createdAt: order.created_date,
    total: Number(order.total_value || 0),
    delivery,
    deliveryBucket: deliveryBucket(order.delivery_status),
  };
}

function DeliveryBadge({ delivery }) {
  const Icon = delivery.icon || Clock3;
  return (
    <span title={delivery.hint} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold ring-1 ring-inset ${delivery.color}`}>
      <Icon className="h-3.5 w-3.5" />
      {delivery.label}
    </span>
  );
}

function validFilter(value, allowedValues) {
  return allowedValues.has(value) ? value : 'all';
}

function matchesPayment(order, filter) {
  if (filter === 'all') return true;
  return PAYMENT_FILTERS.find(item => item.value === filter)?.statuses?.includes(order.payment_status) || false;
}

async function loadOrderCenter() {
  const [stockOrders, presaleOrders, customers, campaigns] = await Promise.all([
    StockOrder.list(),
    PreSaleOrder.list(),
    PreSaleCustomer.list('full_name'),
    PreSaleCampaign.list(),
  ]);
  const customersById = Object.fromEntries(customers.map(customer => [customer.id, customer]));
  const campaignsById = Object.fromEntries(campaigns.map(campaign => [campaign.id, campaign]));

  return {
    campaigns,
    orders: [
      ...stockOrders.map(order => normalizeOrder(order, 'stock', customersById, campaignsById)),
      ...presaleOrders.map(order => normalizeOrder(order, 'presale', customersById, campaignsById)),
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
  };
}

export default function OrderCenter() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: { orders, campaigns },
  } = usePageData({
    key: 'orders:center:v3',
    loader: loadOrderCenter,
    initialData: { orders: [], campaigns: [] },
    tags: ['stock_orders', 'presale_orders', 'presale_customers', 'presale_campaigns'],
    onError: () => toast.error('Erro ao carregar pedidos'),
  });
  const [search, setSearch] = useState('');

  const typeFilter = validFilter(searchParams.get('origem'), ORIGIN_VALUES);
  const paymentFilter = validFilter(searchParams.get('pagamento'), PAYMENT_FILTER_VALUES);
  const deliveryFilter = validFilter(searchParams.get('entrega'), DELIVERY_FILTER_VALUES);
  const deliveryMethodFilter = validFilter(searchParams.get('forma'), DELIVERY_METHOD_FILTER_VALUES);
  const campaignFilter = searchParams.get('campanha') || 'all';

  const updateFilters = changes => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      Object.entries(changes).forEach(([key, value]) => {
        if (!value || value === 'all') next.delete(key);
        else next.set(key, value);
      });
      return next;
    }, { replace: true });
  };

  const changeOrigin = value => {
    updateFilters({
      origem: value,
      ...(value === 'stock' ? { campanha: 'all' } : {}),
    });
  };

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter(order => {
      const matchesSearch = !term || [
        order.order_number,
        order.customer,
        order.contact,
        order.trainer,
        order.campaignName,
      ].some(value => String(value || '').toLowerCase().includes(term));
      const matchesCampaign = campaignFilter === 'all'
        || (order.type === 'presale' && order.campaign_id === campaignFilter);

      return matchesSearch
        && (typeFilter === 'all' || order.type === typeFilter)
        && matchesPayment(order, paymentFilter)
        && (deliveryFilter === 'all' || order.deliveryBucket === deliveryFilter)
        && matchesDeliveryMethod(order, deliveryMethodFilter)
        && matchesCampaign;
    });
  }, [campaignFilter, deliveryFilter, deliveryMethodFilter, orders, paymentFilter, search, typeFilter]);

  const openPaymentOrders = orders.filter(order =>
    !['paid', 'cancelled', 'refunded'].includes(order.payment_status)
  ).length;
  const stockOrders = orders.filter(order => order.type === 'stock').length;
  const presaleOrders = orders.length - stockOrders;
  const filteredTotal = filtered.reduce((total, order) => total + order.total, 0);
  const openOrder = order => {
    navigate(order.type === 'stock'
      ? `/estoque/pedidos/${order.id}`
      : `/pedidos/${order.id}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Pedidos</h2>
          <p className="text-sm text-muted-foreground">Loja e pré-venda na mesma fila, com a origem visível em cada pedido.</p>
        </div>
        <Button onClick={() => navigate('/estoque/pedidos/novo')}>
          <PackagePlus className="w-4 h-4" /> Nova venda
        </Button>
      </div>

      <div className="grid divide-y rounded-lg border bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Todos os pedidos</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{orders.length}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Pagamento em aberto</p>
          <p className="mt-1 text-2xl font-semibold text-amber-700">{openPaymentOrders}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Loja / pré-venda</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{stockOrders} <span className="text-base font-normal text-muted-foreground">/ {presaleOrders}</span></p>
        </div>
      </div>

      <Card className="border-blue-100 bg-blue-50/40">
        <CardContent className="p-4 text-sm text-blue-950">
          <p className="font-semibold">Pagamento e entrega são acompanhados separadamente.</p>
          <p className="mt-1 text-blue-900/80">A lista só organiza e filtra; qualquer alteração é feita dentro do pedido, sem misturar uma cobrança cancelada com a etapa física da entrega.</p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="pl-9"
            placeholder="Pedido, cliente, campanha, treinador..."
          />
        </div>
        <Select value={typeFilter} onValueChange={changeOrigin}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Origem" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas origens</SelectItem>
            <SelectItem value="stock">Loja</SelectItem>
            <SelectItem value="presale">Pré-venda</SelectItem>
          </SelectContent>
        </Select>
        {typeFilter !== 'stock' && campaigns.length > 0 && (
          <Select value={campaignFilter} onValueChange={value => updateFilters({ campanha: value })}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Campanha" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas campanhas</SelectItem>
              {campaigns.map(campaign => <SelectItem key={campaign.id} value={campaign.id}>{campaign.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={paymentFilter} onValueChange={value => updateFilters({ pagamento: value })}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Pagamento" /></SelectTrigger>
          <SelectContent>
            {PAYMENT_FILTERS.map(filter => <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={deliveryFilter} onValueChange={value => updateFilters({ entrega: value })}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Entrega" /></SelectTrigger>
          <SelectContent>
            {DELIVERY_FILTERS.map(filter => <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={deliveryMethodFilter} onValueChange={value => updateFilters({ forma: value })}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Forma de entrega" /></SelectTrigger>
          <SelectContent>
            {DELIVERY_METHOD_FILTERS.map(filter => <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <ClipboardList className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nenhum pedido encontrado para esses filtros</p>
            {(search || typeFilter !== 'all' || paymentFilter !== 'all' || deliveryFilter !== 'all' || deliveryMethodFilter !== 'all' || campaignFilter !== 'all') && (
              <Button className="mt-4" variant="outline" onClick={() => { setSearch(''); updateFilters({ origem: 'all', pagamento: 'all', entrega: 'all', forma: 'all', campanha: 'all' }); }}>
                Limpar filtros
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Pedido</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Cliente</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Data</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Total</th>
                <th className="px-4 py-3 text-center font-medium text-muted-foreground">Pagamento</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Entrega</th>
                <th className="px-4 py-3"><span className="sr-only">Abrir</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(order => {
                const status = paymentStatus(order.payment_status);
                return (
                  <tr key={`${order.type}:${order.id}`} className="cursor-pointer hover:bg-gray-50" onClick={() => openOrder(order)}>
                    <td className="px-4 py-3">
                      <p className="font-mono font-semibold text-blue-700">{order.order_number || 'Sem número'}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Badge variant={order.type === 'stock' ? 'info' : 'purple'}>{order.typeLabel}</Badge>
                        {order.campaignName && <Badge variant="secondary">{order.campaignName}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{order.customer}</p>
                      {order.contact && <p className="text-xs text-muted-foreground">{order.contact}</p>}
                      {order.trainer && <p className="mt-0.5 text-xs text-muted-foreground">Treinador: {order.trainer}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{order.createdAt ? formatDate(order.createdAt) : '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(order.total)}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {order.due_date && !['paid', 'cancelled', 'refunded'].includes(order.payment_status) && (
                        <p className="mt-1 text-[11px] text-muted-foreground">vence {formatDate(order.due_date)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3"><DeliveryBadge delivery={order.delivery} /></td>
                    <td className="px-4 py-3 text-right">
                      <Button size="icon" variant="ghost" title="Abrir pedido" onClick={event => { event.stopPropagation(); openOrder(order); }}>
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            {filtered.length} pedidos exibidos · <span className="font-medium text-gray-900">{formatCurrency(filteredTotal)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
