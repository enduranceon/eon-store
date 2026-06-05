import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Search, ArrowRight, Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { StockOrder } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const PAYMENT_STATUS = {
  awaiting_charge: { label: 'Pedido recebido',   color: 'bg-gray-100 text-gray-700' },
  charge_sent:     { label: 'Cobrança enviada',   color: 'bg-blue-100 text-blue-700' },
  paid:            { label: 'Pago',               color: 'bg-green-100 text-green-700' },
  partially_paid:  { label: 'Parcialmente pago',  color: 'bg-amber-100 text-amber-700' },
  cancelled:       { label: 'Cancelado',          color: 'bg-red-100 text-red-700' },
  refunded:        { label: 'Reembolsado',        color: 'bg-purple-100 text-purple-700' },
};

const EFFECTIVE_OPEN_PAYMENT_STATUSES = new Set(['charge_sent', 'partially_paid', 'pending']);

const DELIVERY_STATUS = {
  awaiting_delivery: { label: 'Ag. entrega',        color: 'bg-gray-100 text-gray-700' },
  separated:         { label: 'Separado',            color: 'bg-amber-100 text-amber-700' },
  delivered:         { label: 'Entregue',            color: 'bg-green-100 text-green-700' },
  cancelled:         { label: 'Cancelado',           color: 'bg-red-100 text-red-700' },
};

function StatusSelect({ value, options, onChange, allowedKeys = null }) {
  const current = options[value] || { label: value || '—', color: 'bg-gray-100 text-gray-600' };
  const visibleOptions = allowedKeys
    ? Object.fromEntries(Object.entries(options).filter(([k]) => k === value || allowedKeys.includes(k)))
    : options;
  return (
    <div className="relative" onClick={e => e.stopPropagation()}>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className={`appearance-none text-xs font-medium px-2.5 py-1.5 rounded-full border-0 cursor-pointer pr-6 ${current.color}`}
        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
      >
        {Object.entries(visibleOptions).map(([k, v]) => (
          <option key={k} value={k}>{v.label}</option>
        ))}
      </select>
    </div>
  );
}

function StatusBadge({ value, options }) {
  const current = options[value] || { label: value || '—', color: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center justify-center text-xs font-medium px-2.5 py-1.5 rounded-full ${current.color}`}>
      {current.label}
    </span>
  );
}

function PaymentStatusCell({ order, onOpen }) {
  const isOpen = !['paid', 'cancelled', 'refunded'].includes(order.payment_status);
  const hasEffectiveSale = EFFECTIVE_OPEN_PAYMENT_STATUSES.has(order.payment_status);
  return (
    <div className="flex items-center justify-center gap-2" onClick={e => e.stopPropagation()}>
      <div className="text-center">
        <StatusBadge value={order.payment_status} options={PAYMENT_STATUS} />
        {hasEffectiveSale && order.due_date && (
          <p className="mt-1 text-[11px] text-muted-foreground">vence {formatDate(order.due_date)}</p>
        )}
      </div>
      {isOpen && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpen}>
          Financeiro
          <ArrowRight className="w-3.5 h-3.5 ml-1" />
        </Button>
      )}
    </div>
  );
}

export default function StockOrders() {
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [deliveryFilter, setDeliveryFilter] = useState('all');
  const navigate = useNavigate();

  const load = () => StockOrder.list().then(setOrders).catch(() => toast.error('Erro ao carregar pedidos'));

  useEffect(() => { load(); }, []);

  const commitUpdate = async (orderId, field, value, extras = {}) => {
    const patch = { [field]: value, ...extras };
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...patch } : o));
    try {
      await StockOrder.update(orderId, patch);
    } catch (e) {
      toast.error(e.message);
      load();
    }
  };

  const handleDeliveryStatusChange = (orderId, newValue) => {
    commitUpdate(orderId, 'delivery_status', newValue);
  };

  const filtered = orders.filter(o => {
    const q = search.toLowerCase();
    const matchSearch = !q || [o.order_number, o.customer_name, o.customer_whatsapp, o.customer_email]
      .some(v => String(v ?? '').toLowerCase().includes(q));
    const matchPayment = paymentFilter === 'all' || o.payment_status === paymentFilter;
    const matchDelivery = deliveryFilter === 'all' || o.delivery_status === deliveryFilter;
    return matchSearch && matchPayment && matchDelivery;
  });

  const totalFiltered = filtered.reduce((acc, o) => acc + (o.total_value || 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Pedidos da Loja</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} de {orders.length} pedidos · {formatCurrency(totalFiltered)}</p>
        </div>
        <Button onClick={() => navigate('/estoque/pedidos/novo')}>
          <Plus className="w-4 h-4 mr-1.5" /> Novo pedido
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Nº pedido, cliente, WhatsApp..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={paymentFilter} onValueChange={setPaymentFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Pagamento" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos pagamentos</SelectItem>
            {Object.entries(PAYMENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Entrega" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas entregas</SelectItem>
            {Object.entries(DELIVERY_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <ClipboardList className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum pedido encontrado</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nº Pedido</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Data</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Pagamento</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Entrega</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(o => (
                <tr key={o.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/estoque/pedidos/${o.id}`)}>
                  <td className="px-4 py-3 font-mono font-semibold text-blue-700">{o.order_number}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{o.customer_name}</p>
                    <p className="text-xs text-muted-foreground">{o.customer_whatsapp}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(o.created_date)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(o.total_value)}</td>
                  <td className="px-4 py-3 text-center">
                    <PaymentStatusCell order={o} onOpen={() => navigate(`/estoque/pedidos/${o.id}`)} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusSelect
                      value={o.delivery_status}
                      options={DELIVERY_STATUS}
                      onChange={v => handleDeliveryStatusChange(o.id, v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
