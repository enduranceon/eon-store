import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ClipboardList, Clock3, PackageCheck, PackagePlus, Search, Truck, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PreSaleCustomer, PreSaleOrder, StockOrder } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const PAYMENT_STATUS = {
  pending: { label: 'Pedido recebido', variant: 'secondary' },
  awaiting_charge: { label: 'Pedido recebido', variant: 'secondary' },
  charge_sent: { label: 'Cobrança enviada', variant: 'info' },
  paid: { label: 'Pago', variant: 'success' },
  partially_paid: { label: 'Parcialmente pago', variant: 'warning' },
  cancelled: { label: 'Cancelado', variant: 'destructive' },
  refunded: { label: 'Reembolsado', variant: 'purple' },
};

const DELIVERY_STATUS = {
  stock: {
    awaiting_delivery: { label: 'Aguardando entrega', hint: 'Pedido pago, aguardando separação.', color: 'bg-violet-100 text-violet-800 ring-violet-200', icon: Clock3 },
    separated: { label: 'Separado', hint: 'Produto separado, pronto para entregar.', color: 'bg-amber-100 text-amber-800 ring-amber-200', icon: PackageCheck },
    delivered: { label: 'Entregue', hint: 'Entrega concluída ao cliente.', color: 'bg-emerald-100 text-emerald-800 ring-emerald-200', icon: CheckCircle2 },
    cancelled: { label: 'Cancelado', hint: 'Pedido não seguirá para entrega.', color: 'bg-red-100 text-red-800 ring-red-200', icon: XCircle },
  },
  presale: {
    awaiting_supplier: { label: 'Aguardando fornecedor', hint: 'Aguardando a produção ou reposição.', color: 'bg-slate-100 text-slate-700 ring-slate-200', icon: Clock3 },
    supplier_ordered: { label: 'Pedido ao fornecedor', hint: 'Produção ou compra já solicitada.', color: 'bg-blue-100 text-blue-800 ring-blue-200', icon: Truck },
    received: { label: 'Produto recebido', hint: 'Item chegou e pode ser separado.', color: 'bg-sky-100 text-sky-800 ring-sky-200', icon: PackageCheck },
    separated: { label: 'Separado para entrega', hint: 'Produto separado, pronto para entregar.', color: 'bg-amber-100 text-amber-800 ring-amber-200', icon: PackageCheck },
    delivered: { label: 'Entregue', hint: 'Entrega concluída ao cliente.', color: 'bg-emerald-100 text-emerald-800 ring-emerald-200', icon: CheckCircle2 },
    cancelled: { label: 'Cancelado', hint: 'Pedido não seguirá para entrega.', color: 'bg-red-100 text-red-800 ring-red-200', icon: XCircle },
  },
};

function paymentStatus(status) {
  return PAYMENT_STATUS[status] || { label: status || 'Sem status', variant: 'secondary' };
}

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

function normalizeOrder(order, type, customersById) {
  const customer = order.customer_id ? customersById[order.customer_id] : null;
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
    createdAt: order.created_date,
    total: Number(order.total_value || 0),
    delivery: DELIVERY_STATUS[type][order.delivery_status] || {
      label: 'Sem entrega definida', hint: 'Status de entrega não informado.', color: 'bg-gray-100 text-gray-700 ring-gray-200', icon: Clock3,
    },
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

async function loadOrderCenter() {
  const [stockOrders, presaleOrders, customers] = await Promise.all([
    StockOrder.list(),
    PreSaleOrder.list(),
    PreSaleCustomer.list('full_name'),
  ]);
  const customersById = Object.fromEntries(customers.map(customer => [customer.id, customer]));
  return [
    ...stockOrders.map(order => normalizeOrder(order, 'stock', customersById)),
    ...presaleOrders.map(order => normalizeOrder(order, 'presale', customersById)),
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export default function OrderCenter() {
  const navigate = useNavigate();
  const { data: orders } = usePageData({
    key: 'orders:center:v2',
    loader: loadOrderCenter,
    initialData: [],
    tags: ['stock_orders', 'presale_orders', 'presale_customers'],
    onError: () => toast.error('Erro ao carregar pedidos'),
  });
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [deliveryFilter, setDeliveryFilter] = useState('all');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter(order => {
      const matchesSearch = !term || [
        order.order_number,
        order.customer,
        order.contact,
      ].some(value => String(value || '').toLowerCase().includes(term));
      return matchesSearch
        && (typeFilter === 'all' || order.type === typeFilter)
        && (paymentFilter === 'all' || order.payment_status === paymentFilter)
        && (deliveryFilter === 'all' || order.delivery_status === deliveryFilter);
    });
  }, [deliveryFilter, orders, paymentFilter, search, typeFilter]);

  const openOrders = orders.filter(order =>
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
          <p className="text-sm text-muted-foreground">Todos os pedidos da loja e da pré-venda em uma única fila.</p>
        </div>
        <Button onClick={() => navigate('/estoque/pedidos/novo')}>
          <PackagePlus className="w-4 h-4" /> Nova venda
        </Button>
      </div>

      <div className="grid border rounded-lg bg-white sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x">
        <div className="px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Todos os pedidos</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{orders.length}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Aguardando financeiro</p>
          <p className="mt-1 text-2xl font-semibold text-amber-700">{openOrders}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Loja / pré-venda</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{stockOrders} <span className="text-base font-normal text-muted-foreground">/ {presaleOrders}</span></p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="pl-9"
            placeholder="Pedido, cliente, WhatsApp ou e-mail..."
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Origem" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas origens</SelectItem>
            <SelectItem value="stock">Loja</SelectItem>
            <SelectItem value="presale">Pré-venda</SelectItem>
          </SelectContent>
        </Select>
        <Select value={paymentFilter} onValueChange={setPaymentFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Pagamento" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos pagamentos</SelectItem>
            {Object.entries(PAYMENT_STATUS).map(([value, status]) => (
              <SelectItem key={value} value={value}>{status.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Entrega" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as etapas</SelectItem>
            <SelectItem value="awaiting_supplier">Aguardando fornecedor</SelectItem>
            <SelectItem value="supplier_ordered">Pedido ao fornecedor</SelectItem>
            <SelectItem value="received">Produto recebido</SelectItem>
            <SelectItem value="awaiting_delivery">Aguardando entrega</SelectItem>
            <SelectItem value="separated">Separado para entrega</SelectItem>
            <SelectItem value="delivered">Entregue</SelectItem>
            <SelectItem value="cancelled">Cancelado</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="border-gray-200 bg-gradient-to-br from-white to-gray-50">
        <CardContent className="p-4">
          <p className="mb-3 text-sm font-semibold text-gray-900">Etapas da entrega</p>
          <div className="flex flex-wrap gap-2">
            {[
              { label: 'Aguardando', hint: 'Ainda depende de fornecedor, produto ou preparação.', color: 'bg-slate-100 text-slate-700 ring-slate-200', icon: Clock3 },
              { label: 'Separado', hint: 'Produto pronto para entregar ao cliente.', color: 'bg-amber-100 text-amber-800 ring-amber-200', icon: PackageCheck },
              { label: 'Entregue', hint: 'Entrega concluída.', color: 'bg-emerald-100 text-emerald-800 ring-emerald-200', icon: CheckCircle2 },
              { label: 'Cancelado', hint: 'Pedido não seguirá para entrega.', color: 'bg-red-100 text-red-800 ring-red-200', icon: XCircle },
            ].map(delivery => <DeliveryBadge key={delivery.label} delivery={delivery} />)}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Passe o mouse sobre a etiqueta para ver a explicação. Verde significa entrega concluída.</p>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <ClipboardList className="mb-3 w-10 h-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nenhum pedido encontrado</p>
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
                      <Badge variant={order.type === 'stock' ? 'info' : 'purple'} className="mt-1 w-fit">{order.typeLabel}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{order.customer}</p>
                      {order.contact && <p className="text-xs text-muted-foreground">{order.contact}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{order.createdAt ? formatDate(order.createdAt) : '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(order.total)}</td>
                    <td className="px-4 py-3 text-center"><Badge variant={status.variant}>{status.label}</Badge></td>
                    <td className="px-4 py-3"><DeliveryBadge delivery={order.delivery} /></td>
                    <td className="px-4 py-3 text-right">
                      <Button size="icon" variant="ghost" title="Abrir pedido" onClick={event => { event.stopPropagation(); openOrder(order); }}>
                        <ArrowRight className="w-4 h-4" />
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
