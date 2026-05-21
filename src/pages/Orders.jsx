import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { PreSaleOrder, PreSaleCampaign } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const PAYMENT_STATUS = {
  awaiting_charge: { label: 'Ag. cobrança',      color: 'bg-gray-100 text-gray-700' },
  message_sent:    { label: 'Mensagem enviada',   color: 'bg-orange-100 text-orange-700' },
  charge_sent:     { label: 'Cobrança enviada',   color: 'bg-blue-100 text-blue-700' },
  paid:            { label: 'Pago',               color: 'bg-green-100 text-green-700' },
  partially_paid:  { label: 'Parcialmente pago',  color: 'bg-amber-100 text-amber-700' },
  cancelled:       { label: 'Cancelado',          color: 'bg-red-100 text-red-700' },
  refunded:        { label: 'Reembolsado',        color: 'bg-purple-100 text-purple-700' },
};

const DELIVERY_STATUS = {
  awaiting_supplier: { label: 'Ag. fornecedor',     color: 'bg-gray-100 text-gray-700' },
  supplier_ordered:  { label: 'Pedido ao forn.',    color: 'bg-blue-100 text-blue-700' },
  received:          { label: 'Produto recebido',   color: 'bg-sky-100 text-sky-700' },
  separated:         { label: 'Separado p/ entrega',color: 'bg-amber-100 text-amber-700' },
  delivered:         { label: 'Entregue',           color: 'bg-green-100 text-green-700' },
  cancelled:         { label: 'Cancelado',          color: 'bg-red-100 text-red-700' },
};

function StatusSelect({ value, options, onChange }) {
  const current = options[value] || { label: value || '—', color: 'bg-gray-100 text-gray-600' };
  return (
    <div className="relative" onClick={e => e.stopPropagation()}>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className={`appearance-none text-xs font-medium px-2.5 py-1.5 rounded-full border-0 cursor-pointer pr-6 ${current.color}`}
        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
      >
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>{v.label}</option>
        ))}
      </select>
    </div>
  );
}

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [search, setSearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [deliveryFilter, setDeliveryFilter] = useState('all');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const navigate = useNavigate();

  const load = () => Promise.all([PreSaleOrder.list(), PreSaleCampaign.list()]).then(([o, c]) => {
    setOrders(o);
    setCampaigns(c);
  }).catch(() => toast.error('Erro ao carregar pedidos'));

  useEffect(() => { load(); }, []);

  const updateStatus = async (orderId, field, value) => {
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, [field]: value } : o));
    try {
      await PreSaleOrder.update(orderId, { [field]: value });
    } catch (e) {
      toast.error(e.message);
      load();
    }
  };

  const filtered = orders.filter(o => {
    const q = search.toLowerCase();
    const matchSearch = !q || [o.order_number, o.checkout_name, o.checkout_whatsapp, o.checkout_email, o.checkout_trainer]
      .some(v => String(v ?? '').toLowerCase().includes(q));
    const matchPayment = paymentFilter === 'all' || o.payment_status === paymentFilter;
    const matchDelivery = deliveryFilter === 'all' || o.delivery_status === deliveryFilter;
    const matchCampaign = campaignFilter === 'all' || o.campaign_id === campaignFilter;
    return matchSearch && matchPayment && matchDelivery && matchCampaign;
  });

  const totalFiltered = filtered.reduce((acc, o) => acc + (o.total_value || 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Pedidos</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} de {orders.length} pedidos · {formatCurrency(totalFiltered)}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Nº pedido, cliente, WhatsApp..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={campaignFilter} onValueChange={setCampaignFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Campanha" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as campanhas</SelectItem>
            {campaigns.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
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
            <ShoppingCart className="w-10 h-10 text-muted-foreground mb-3" />
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Treinador</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Data</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Pagamento</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Entrega</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(o => (
                <tr key={o.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/pedidos/${o.id}`)}>
                  <td className="px-4 py-3 font-mono font-semibold text-blue-700">{o.order_number}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{o.checkout_name}</p>
                    <p className="text-xs text-muted-foreground">{o.checkout_whatsapp}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{o.checkout_trainer || '-'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(o.created_date)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(o.total_value)}</td>
                  <td className="px-4 py-3 text-center">
                    <StatusSelect
                      value={o.payment_status}
                      options={PAYMENT_STATUS}
                      onChange={v => updateStatus(o.id, 'payment_status', v)}
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusSelect
                      value={o.delivery_status}
                      options={DELIVERY_STATUS}
                      onChange={v => updateStatus(o.id, 'delivery_status', v)}
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
