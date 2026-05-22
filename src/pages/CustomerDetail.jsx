import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, ShoppingCart, Edit2, Save, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PreSaleCustomer, PreSaleOrder } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const PAYMENT_BADGE = { paid: 'success', partially_paid: 'warning', awaiting_charge: 'secondary', charge_sent: 'info', cancelled: 'destructive', refunded: 'outline' };
const PAYMENT_LABEL = { awaiting_charge: 'Ag. cobrança', charge_sent: 'Cobrança enviada', paid: 'Pago', partially_paid: 'Parcialmente pago', cancelled: 'Cancelado', refunded: 'Reembolsado' };

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [orders, setOrders] = useState([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [c, allOrders] = await Promise.all([PreSaleCustomer.get(id), PreSaleOrder.list()]);
    setCustomer(c);
    setForm({ full_name: c.full_name, whatsapp: c.whatsapp, email: c.email, trainer: c.trainer, cpf: c.cpf || '', internal_notes: c.internal_notes || '' });
    setOrders(allOrders.filter(o => o.customer_id === id));
  };

  useEffect(() => { load(); }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await PreSaleCustomer.update(id, form);
      toast.success('Cliente atualizado!');
      setEditing(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!customer) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const activeOrders = orders.filter(o => o.payment_status !== 'cancelled');
  const totalValue = activeOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid = activeOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending = totalValue - totalPaid;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="w-4 h-4" /></Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{customer.full_name}</h2>
          <p className="text-sm text-muted-foreground">Cliente desde {formatDate(customer.created_date)}</p>
        </div>
        {!editing ? (
          <Button variant="outline" onClick={() => setEditing(true)}><Edit2 className="w-4 h-4" /> Editar</Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(false)}><X className="w-4 h-4" /></Button>
            <Button onClick={handleSave} disabled={saving}><Save className="w-4 h-4" /> {saving ? 'Salvando...' : 'Salvar'}</Button>
          </div>
        )}
      </div>

      {/* Resumo financeiro */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Total comprado</p>
            <p className="text-xl font-bold mt-1">{formatCurrency(totalValue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Total pago</p>
            <p className="text-xl font-bold text-green-600 mt-1">{formatCurrency(totalPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Pendente</p>
            <p className="text-xl font-bold text-yellow-600 mt-1">{formatCurrency(totalPending)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Dados pessoais */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><User className="w-4 h-4" /> Dados do Cliente</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>Nome completo</Label><Input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} className="mt-1" /></div>
                <div><Label>WhatsApp</Label><Input value={form.whatsapp || ''} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} className="mt-1" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>E-mail</Label><Input value={form.email || ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="mt-1" /></div>
                <div><Label>Treinador</Label><Input value={form.trainer || ''} onChange={e => setForm(f => ({ ...f, trainer: e.target.value }))} className="mt-1" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>CPF <span className="text-xs text-muted-foreground font-normal">(necessário para cobrança Asaas)</span></Label>
                  <Input value={form.cpf || ''} onChange={e => setForm(f => ({ ...f, cpf: e.target.value }))} className="mt-1" placeholder="000.000.000-00" />
                </div>
              </div>
              <div><Label>Observações internas</Label><Textarea value={form.internal_notes} onChange={e => setForm(f => ({ ...f, internal_notes: e.target.value }))} className="mt-1" rows={3} /></div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /><span>{customer.whatsapp || '-'}</span></div>
              <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground" /><span>{customer.email || '-'}</span></div>
              <div className="flex items-center gap-2"><User className="w-4 h-4 text-muted-foreground" /><span>Treinador: {customer.trainer || '-'}</span></div>
              <div className="flex items-center gap-2"><span className="text-muted-foreground text-xs">CPF:</span><span className="font-mono text-sm">{customer.cpf || <span className="text-gray-400 italic">não cadastrado</span>}</span></div>
              {customer.internal_notes && <div className="col-span-2 bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">{customer.internal_notes}</div>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Histórico de pedidos */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Pedidos ({orders.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">Nenhum pedido ainda</p>
          ) : (
            <div className="space-y-2">
              {orders.map(o => (
                <Link key={o.id} to={`/pedidos/${o.id}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-colors">
                  <div>
                    <p className="text-sm font-mono font-semibold text-blue-700">{o.order_number}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(o.created_date)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={PAYMENT_BADGE[o.payment_status] || 'secondary'}>{PAYMENT_LABEL[o.payment_status] || o.payment_status}</Badge>
                    <span className="text-sm font-semibold">{formatCurrency(o.total_value)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
