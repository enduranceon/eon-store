import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, Package, Calendar, FileText, MessageCircle, Copy, Check, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { PreSaleOrder, PreSaleCampaign, PreSaleCustomer } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const PAYMENT_STATUS = {
  awaiting_charge: { label: 'Aguardando cobrança', badge: 'secondary' },
  charge_sent: { label: 'Cobrança enviada', badge: 'info' },
  paid: { label: 'Pago', badge: 'success' },
  partially_paid: { label: 'Parcialmente pago', badge: 'warning' },
  cancelled: { label: 'Cancelado', badge: 'destructive' },
  refunded: { label: 'Reembolsado', badge: 'outline' },
};

const DELIVERY_STATUS = {
  awaiting_supplier: { label: 'Aguardando fornecedor', badge: 'secondary' },
  supplier_ordered: { label: 'Pedido ao fornecedor', badge: 'info' },
  received: { label: 'Produto recebido', badge: 'info' },
  separated: { label: 'Separado p/ entrega', badge: 'warning' },
  delivered: { label: 'Entregue', badge: 'success' },
  cancelled: { label: 'Cancelado', badge: 'destructive' },
};

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [campaign, setCampaign] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [whatsappModal, setWhatsappModal] = useState(false);
  const [whatsappMsg, setWhatsappMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [deliveryStatus, setDeliveryStatus] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');

  const load = async () => {
    const o = await PreSaleOrder.get(id);
    setOrder(o);
    setPaymentStatus(o.payment_status || 'awaiting_charge');
    setDeliveryStatus(o.delivery_status || 'awaiting_supplier');
    setInternalNotes(o.internal_notes || '');
    setPaymentDate(o.payment_date || '');
    setDeliveryDate(o.delivery_date || '');
    if (o.campaign_id) PreSaleCampaign.get(o.campaign_id).then(setCampaign).catch(() => {});
    if (o.customer_id) PreSaleCustomer.get(o.customer_id).then(setCustomer).catch(() => {});
  };

  useEffect(() => { load(); }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await PreSaleOrder.update(id, {
        payment_status: paymentStatus,
        delivery_status: deliveryStatus,
        internal_notes: internalNotes,
        payment_date: paymentDate || null,
        delivery_date: deliveryDate || null,
      });
      toast.success('Pedido atualizado!');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const buildMessage = () => {
    const itemLines = (order.items || []).map(item => {
      const extras = (item.extras || []).map(e => `   ➕ ${e.name}: ${formatCurrency(e.price)}`).join('\n');
      const itemTotal = ((item.sale_price || 0) + (item.extras_total || 0)) * item.quantity;
      const label = item.variation ? `${item.product_name} - ${item.variation}` : item.product_name;
      return `• ${label} x${item.quantity} → ${formatCurrency(itemTotal)}${extras ? '\n' + extras : ''}`;
    }).join('\n');
    const total = order.total_value || 0;
    return `Olá, ${order.checkout_name}! 👋

Segue o resumo do seu pedido *${order.order_number}*:

📦 *Itens:*
${itemLines}

💰 *Total: ${formatCurrency(total)}*

Como você prefere pagar?
• PIX (à vista) — ${formatCurrency(total)}
• Cartão (em até 4x)`;
  };

  const openWhatsApp = () => {
    const msg = buildMessage();
    setWhatsappMsg(msg);
    setCopied(false);
    setWhatsappModal(true);
  };

  const copyMessage = () => {
    navigator.clipboard.writeText(whatsappMsg).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const openWhatsAppDirect = () => {
    const phone = '55' + (order.checkout_whatsapp || '').replace(/\D/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMsg)}`, '_blank');
  };

  if (!order) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const ps = PAYMENT_STATUS[order.payment_status] || { label: order.payment_status, badge: 'secondary' };
  const ds = DELIVERY_STATUS[order.delivery_status] || { label: order.delivery_status, badge: 'secondary' };
  const items = order.items || [];
  const totalCost = order.total_cost || 0;
  const grossProfit = (order.total_value || 0) - totalCost;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold font-mono">{order.order_number}</h2>
          <p className="text-sm text-muted-foreground">{formatDate(order.created_date)}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={ps.badge}>{ps.label}</Badge>
          <Badge variant={ds.badge}>{ds.label}</Badge>
          {order.checkout_whatsapp && (
            <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white gap-1.5" onClick={openWhatsApp}>
              <MessageCircle className="w-4 h-4" />
              Cobrar via WhatsApp
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Dados do cliente */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><User className="w-4 h-4" /> Cliente</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="font-semibold text-base">{order.checkout_name}</p>
            {order.checkout_whatsapp && <p className="flex items-center gap-2 text-muted-foreground"><Phone className="w-3.5 h-3.5" />{order.checkout_whatsapp}</p>}
            {order.checkout_email && <p className="flex items-center gap-2 text-muted-foreground"><Mail className="w-3.5 h-3.5" />{order.checkout_email}</p>}
            {order.checkout_trainer && <p className="flex items-center gap-2 text-muted-foreground"><User className="w-3.5 h-3.5" />Treinador: {order.checkout_trainer}</p>}
            {order.delivery_method && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Package className="w-3.5 h-3.5" />
                {order.delivery_method === 'pickup'
                  ? `Retirada em treino${order.delivery_city ? ' · ' + order.delivery_city : ''}`
                  : 'Frete'}
              </p>
            )}
            {customer && (
              <Link to={`/clientes/${customer.id}`} className="text-xs text-blue-600 hover:underline block mt-1">
                Ver perfil do cliente →
              </Link>
            )}
          </CardContent>
        </Card>

        {/* Campanha */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Campanha</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {campaign ? (
              <Link to={`/campanhas/${campaign.id}`} className="font-semibold text-blue-700 hover:underline">{campaign.name}</Link>
            ) : <p className="text-muted-foreground">Sem campanha</p>}
          </CardContent>
        </Card>
      </div>

      {/* Itens do pedido */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Package className="w-4 h-4" /> Itens do Pedido</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem itens registrados</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 font-medium text-muted-foreground">Produto</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Variação</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Qtd</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Preço unit.</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Custo unit.</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item, i) => (
                    <>
                      <tr key={i}>
                        <td className="py-2 font-medium">{item.product_name}</td>
                        <td className="py-2 text-muted-foreground">{item.variation || '-'}</td>
                        <td className="py-2 text-right">{item.quantity}</td>
                        <td className="py-2 text-right">{formatCurrency(item.sale_price)}</td>
                        <td className="py-2 text-right text-red-600">{formatCurrency(item.cost_price)}</td>
                        <td className="py-2 text-right font-semibold">{formatCurrency(((item.sale_price || 0) + (item.extras_total || 0)) * (item.quantity || 1))}</td>
                      </tr>
                      {(item.extras || []).map((extra, j) => (
                        <tr key={`${i}-x${j}`} className="bg-blue-50/40 text-xs">
                          <td className="py-1 pl-4 text-blue-700">+ {extra.name}</td>
                          <td className="py-1 text-muted-foreground">—</td>
                          <td className="py-1 text-right text-muted-foreground">{item.quantity}</td>
                          <td className="py-1 text-right text-blue-600">{formatCurrency(extra.price)}</td>
                          <td className="py-1 text-muted-foreground">—</td>
                          <td className="py-1 text-right font-medium text-blue-600">{formatCurrency((extra.price || 0) * (item.quantity || 1))}</td>
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t mt-4 pt-4 grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Total do pedido</p>
              <p className="font-bold text-lg">{formatCurrency(order.total_value)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Custo total</p>
              <p className="font-bold text-lg text-red-600">{formatCurrency(totalCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Lucro bruto est.</p>
              <p className={`font-bold text-lg ${grossProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(grossProfit)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Modal mensagem WhatsApp */}
      <Dialog open={whatsappModal} onOpenChange={setWhatsappModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" />
              Mensagem de cobrança
            </DialogTitle>
          </DialogHeader>
          <div className="bg-gray-50 rounded-xl p-4 text-sm whitespace-pre-wrap font-mono border">
            {whatsappMsg}
          </div>
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" variant="outline" onClick={copyMessage}>
              {copied ? <><Check className="w-4 h-4 mr-1.5 text-green-600" />Copiado!</> : <><Copy className="w-4 h-4 mr-1.5" />Copiar mensagem</>}
            </Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsAppDirect}>
              <ExternalLink className="w-4 h-4 mr-1.5" />
              Abrir no WhatsApp
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Controles de status */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Atualizar Status</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Status de Pagamento</Label>
              <Select value={paymentStatus} onValueChange={setPaymentStatus}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PAYMENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Data de Pagamento</Label>
              <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="mt-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Status de Entrega</Label>
              <Select value={deliveryStatus} onValueChange={setDeliveryStatus}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(DELIVERY_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Data de Entrega</Label>
              <Input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} className="mt-1" />
            </div>
          </div>
          <div>
            <Label>Observações internas</Label>
            <Textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} className="mt-1" rows={3} placeholder="Anotações internas sobre o pedido..." />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Salvando...' : 'Salvar alterações'}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
