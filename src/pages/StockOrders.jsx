import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Search, AlertTriangle, ArrowRight, Plus, HandCoins } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StockOrder } from '@/api/entities';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { loadActivePaymentMethods, calcFee, createManualInstallments } from '@/lib/manual-payment';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import { toast } from 'sonner';

const SENSITIVE_PAYMENT = new Set(['cancelled', 'refunded', 'partially_paid']);

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
  awaiting_delivery: { label: 'Ag. entrega',        color: 'bg-gray-100 text-gray-700' },
  separated:         { label: 'Separado',            color: 'bg-amber-100 text-amber-700' },
  delivered:         { label: 'Entregue',            color: 'bg-green-100 text-green-700' },
  cancelled:         { label: 'Cancelado',           color: 'bg-red-100 text-red-700' },
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

export default function StockOrders() {
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [deliveryFilter, setDeliveryFilter] = useState('all');
  const [pendingChange, setPendingChange] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Estados para o modal de pagamento manual
  const [manualPayModal, setManualPayModal] = useState(false);
  const [manualPayOrder, setManualPayOrder] = useState(null);
  const [manualPayForm, setManualPayForm] = useState({ method_id: '', date: '', value: '' });
  const [methodGroups, setMethodGroups] = useState([]);
  const [manualPaySaving, setManualPaySaving] = useState(false);
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

  const handleStatusChange = async (orderId, field, oldValue, newValue) => {
    if (field === 'payment_status' && newValue === 'paid' && newValue !== oldValue) {
      // Abre modal de pagamento manual completo
      const order = orders.find(o => o.id === orderId);
      try {
        const groups = await loadActivePaymentMethods();
        setMethodGroups(groups);
        const allMethods = groups.flatMap(([, list]) => list);
        const defaultMethod = allMethods.find(m => m.internal_code === 'pix_manual') || allMethods[0];
        setManualPayForm({
          method_id: defaultMethod?.id || '',
          date:      todayLocalStr(),
          value:     order?.total_value ? Number(order.total_value).toFixed(2) : '',
        });
        setManualPayOrder(order);
        setManualPayModal(true);
      } catch (e) {
        toast.error('Erro ao carregar métodos: ' + e.message);
      }
    } else if (field === 'payment_status' && SENSITIVE_PAYMENT.has(newValue) && newValue !== oldValue) {
      setPendingChange({ orderId, field, oldValue, newValue });
    } else {
      commitUpdate(orderId, field, newValue);
    }
  };

  const confirmManualPayment = async () => {
    if (!manualPayOrder) return;
    if (!manualPayForm.method_id) return toast.error('Selecione um método');
    if (!manualPayForm.date)      return toast.error('Informe a data do pagamento');
    if (!manualPayForm.value || isNaN(Number(manualPayForm.value))) return toast.error('Informe o valor recebido');
    const method = methodGroups.flatMap(([, list]) => list).find(m => m.id === manualPayForm.method_id);
    if (!method) return toast.error('Método inválido');

    setManualPaySaving(true);
    try {
      const totalV = Number(manualPayForm.value);
      const fee    = calcFee(method, totalV);
      // 1. Marca como pago
      await StockOrder.update(manualPayOrder.id, {
        payment_status: 'paid',
        payment_method: method.internal_code || method.kind,
        payment_date:   manualPayForm.date,
        manual_payment: true,
        manual_fee:     fee > 0 ? Math.round(fee * 100) / 100 : null,
      });
      // 2. Cria parcelas projetadas no fluxo de caixa
      const result = await createManualInstallments(
        method, manualPayForm.date,
        { order_id: manualPayOrder.id, order_type: 'stock', external_reference: manualPayOrder.order_number },
        totalV,
      );
      toast.success(`Pagamento registrado!${result.installments > 1 ? ` ${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      setManualPayOrder(null);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar pagamento');
    } finally {
      setManualPaySaving(false);
    }
  };

  const confirmChange = async () => {
    if (!pendingChange) return;
    setConfirming(true);
    await commitUpdate(pendingChange.orderId, pendingChange.field, pendingChange.newValue);
    setConfirming(false);
    setPendingChange(null);
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

      {/* Modal de pagamento manual — abre ao marcar como Pago */}
      <Dialog open={manualPayModal} onOpenChange={open => { if (!open && !manualPaySaving) { setManualPayModal(false); setManualPayOrder(null); } }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="w-4 h-4 text-green-600" />
              Registrar pagamento
              {manualPayOrder && <span className="font-mono text-sm font-normal text-muted-foreground">— {manualPayOrder.order_number}</span>}
            </DialogTitle>
          </DialogHeader>
          <ManualPaymentForm
            form={manualPayForm}
            setForm={setManualPayForm}
            methodGroups={methodGroups}
            saving={manualPaySaving}
            onSave={confirmManualPayment}
            onCancel={() => { setManualPayModal(false); setManualPayOrder(null); }}
          />
        </DialogContent>
      </Dialog>

      {/* Modal de confirmação para outros status sensíveis (cancelado, reembolsado) */}
      <Dialog open={!!pendingChange} onOpenChange={open => { if (!open && !confirming) setPendingChange(null); }}>
        <DialogContent className="max-w-sm">
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
              <p className="text-sm text-center text-muted-foreground">
                Essa ação será salva diretamente no banco de dados.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setPendingChange(null)} disabled={confirming}>
                  Cancelar
                </Button>
                <Button className="flex-1" onClick={confirmChange} disabled={confirming}>
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
