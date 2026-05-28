import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShoppingCart, Search, AlertTriangle, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PreSaleOrder, PreSaleCampaign } from '@/api/entities';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { toast } from 'sonner';

// Status que exigem confirmação antes de salvar
const SENSITIVE_PAYMENT = new Set(['paid', 'cancelled', 'refunded', 'partially_paid']);

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
  const [pendingChange, setPendingChange] = useState(null); // { orderId, field, oldValue, newValue }
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const load = () => Promise.all([PreSaleOrder.list(), PreSaleCampaign.list()]).then(([o, c]) => {
    setOrders(o);
    setCampaigns(c);
  }).catch(() => toast.error('Erro ao carregar pedidos'));

  useEffect(() => {
    load();
    const p = searchParams.get('pagamento');
    if (p) setPaymentFilter(p);
  }, []);

  const commitUpdate = async (orderId, field, value, extras = {}) => {
    const patch = { [field]: value, ...extras };
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...patch } : o));
    try {
      await PreSaleOrder.update(orderId, patch);
    } catch (e) {
      toast.error(e.message);
      load();
    }
  };

  // Intercepta mudanças sensíveis de pagamento; deixa delivery passar direto
  const handleStatusChange = (orderId, field, oldValue, newValue) => {
    if (field === 'payment_status' && SENSITIVE_PAYMENT.has(newValue) && newValue !== oldValue) {
      setPendingChange({
        orderId, field, oldValue, newValue,
        payment_method: newValue === 'paid' ? 'pix_manual' : null,
        payment_date:   newValue === 'paid' ? todayLocalStr() : null,
      });
    } else {
      commitUpdate(orderId, field, newValue);
    }
  };

  const confirmChange = async () => {
    if (!pendingChange) return;
    setConfirming(true);
    const extras = {};
    if (pendingChange.newValue === 'paid') {
      if (!pendingChange.payment_method) {
        setConfirming(false);
        return toast.error('Selecione a forma de pagamento');
      }
      if (!pendingChange.payment_date) {
        setConfirming(false);
        return toast.error('Informe a data do pagamento');
      }
      extras.payment_method = pendingChange.payment_method;
      extras.payment_date   = pendingChange.payment_date;
    }
    await commitUpdate(pendingChange.orderId, pendingChange.field, pendingChange.newValue, extras);
    setConfirming(false);
    setPendingChange(null);
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
                  <td className="px-4 py-3 text-right font-semibold">
                    {formatCurrency(o.total_value)}
                    {!o.payment_method && o.payment_status !== 'paid' && o.payment_status !== 'cancelled' && (
                      <span className="block text-xs text-orange-500 font-normal flex items-center justify-end gap-1 mt-0.5">
                        <AlertTriangle className="w-3 h-3" /> sem forma de pgto
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusSelect
                      value={o.payment_status}
                      options={PAYMENT_STATUS}
                      onChange={v => handleStatusChange(o.id, 'payment_status', o.payment_status, v)}
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusSelect
                      value={o.delivery_status}
                      options={DELIVERY_STATUS}
                      onChange={v => handleStatusChange(o.id, 'delivery_status', o.delivery_status, v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal de confirmação de mudança de status */}
      <Dialog open={!!pendingChange} onOpenChange={open => { if (!open && !confirming) setPendingChange(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> Confirmar mudança de status
            </DialogTitle>
          </DialogHeader>
          {pendingChange && (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-3 py-2">
                <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${PAYMENT_STATUS[pendingChange.oldValue]?.color || 'bg-gray-100 text-gray-700'}`}>
                  {PAYMENT_STATUS[pendingChange.oldValue]?.label || pendingChange.oldValue}
                </span>
                <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${PAYMENT_STATUS[pendingChange.newValue]?.color || 'bg-gray-100 text-gray-700'}`}>
                  {PAYMENT_STATUS[pendingChange.newValue]?.label || pendingChange.newValue}
                </span>
              </div>

              {/* Forma de pagamento — só aparece quando marcando como PAGO */}
              {pendingChange.newValue === 'paid' && (
                <div>
                  <p className="text-sm font-medium mb-2">Como foi pago? *</p>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mt-1">Manual (sem taxa)</p>
                    {PAYMENT_METHODS.filter(m => m.group === 'manual').map(m => (
                      <button key={m.value} type="button"
                        onClick={() => setPendingChange(p => ({ ...p, payment_method: m.value }))}
                        className={`w-full text-left p-2 rounded-lg border-2 transition-all ${
                          pendingChange.payment_method === m.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-blue-300'
                        }`}>
                        <p className="text-sm font-medium">{m.label}</p>
                        <p className="text-[11px] text-muted-foreground">{m.description}</p>
                      </button>
                    ))}
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mt-2">Via Asaas (com taxa)</p>
                    {PAYMENT_METHODS.filter(m => m.group === 'asaas').map(m => (
                      <button key={m.value} type="button"
                        onClick={() => setPendingChange(p => ({ ...p, payment_method: m.value }))}
                        className={`w-full text-left p-2 rounded-lg border-2 transition-all ${
                          pendingChange.payment_method === m.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-blue-300'
                        }`}>
                        <p className="text-sm font-medium">{m.label}</p>
                        <p className="text-[11px] text-muted-foreground">{m.description}</p>
                      </button>
                    ))}
                  </div>
                  <div className="mt-3">
                    <p className="text-xs font-medium mb-1">Data do pagamento</p>
                    <Input type="date"
                      value={pendingChange.payment_date || todayLocalStr()}
                      onChange={e => setPendingChange(p => ({ ...p, payment_date: e.target.value }))}
                      max={todayLocalStr()} />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Default é hoje, mas você pode ajustar se o pagamento foi em outra data.
                    </p>
                  </div>
                </div>
              )}

              {pendingChange.newValue !== 'paid' && (
                <p className="text-sm text-center text-muted-foreground">
                  Essa ação será salva diretamente no banco de dados.
                </p>
              )}

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setPendingChange(null)} disabled={confirming}>
                  Cancelar
                </Button>
                <Button className="flex-1" onClick={confirmChange}
                  disabled={confirming || (pendingChange.newValue === 'paid' && !pendingChange.payment_method)}>
                  {confirming ? 'Salvando...' : 'Confirmar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
