import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, Package, MessageCircle, Copy, Check, ExternalLink, Zap, QrCode, Link2, FileText, X, RotateCcw, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { StockOrder } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const PAYMENT_STATUS = {
  awaiting_charge: { label: 'Aguardando contato', badge: 'secondary' },
  message_sent:    { label: 'Mensagem enviada',   badge: 'warning' },
  charge_sent:     { label: 'Cobrança enviada',   badge: 'info' },
  paid:            { label: 'Pago',               badge: 'success' },
  partially_paid:  { label: 'Parcialmente pago',  badge: 'warning' },
  cancelled:       { label: 'Cancelado',          badge: 'destructive' },
  refunded:        { label: 'Reembolsado',        badge: 'outline' },
};

const DELIVERY_STATUS = {
  awaiting_delivery: { label: 'Aguardando entrega', badge: 'secondary' },
  separated:         { label: 'Separado',            badge: 'warning' },
  delivered:         { label: 'Entregue',            badge: 'success' },
  cancelled:         { label: 'Cancelado',           badge: 'destructive' },
};

const PAYMENT_METHOD_LABEL = {
  pix_boleto: 'PIX ou Boleto', pix: 'PIX', boleto: 'Boleto',
  card_1x: 'Cartão 1x', card_2x: 'Cartão 2x', card_3x: 'Cartão 3x',
  card_4x: 'Cartão 4x', card_5x: 'Cartão 5x', card_6x: 'Cartão 6x',
};

const CANCEL_REASONS = [
  'Desistência do cliente',
  'Produto indisponível',
  'Duplicidade de pedido',
  'Erro no pedido',
  'Outro',
];

export default function StockOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [saving, setSaving] = useState(false);
  const [whatsappModal, setWhatsappModal] = useState(false);
  const [whatsappMsg, setWhatsappMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [deliveryStatus, setDeliveryStatus] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [asaasLoading, setAsaasLoading] = useState(false);
  const [asaasCpf, setAsaasCpf] = useState('');
  const [asaasBilling, setAsaasBilling] = useState('PIX');
  const [asaasInstallments, setAsaasInstallments] = useState(1);
  const [asaasStatus, setAsaasStatus] = useState(null);
  const [asaasDueDate, setAsaasDueDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return d.toISOString().split('T')[0];
  });

  const [cancelModal, setCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelReasonCustom, setCancelReasonCustom] = useState('');
  const [refundModal, setRefundModal] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundReasonCustom, setRefundReasonCustom] = useState('');

  const load = async () => {
    try {
      const o = await StockOrder.get(id);
      setOrder(o);
      setPaymentStatus(o.payment_status || 'awaiting_charge');
      setDeliveryStatus(o.delivery_status || 'awaiting_delivery');
      setInternalNotes(o.internal_notes || '');
      setPaymentDate(o.payment_date || '');
      setDeliveryDate(o.delivery_date || '');
      setPaymentMethod(o.payment_method || '');
      setCancellationReason(o.cancellation_reason || '');
      setAsaasCpf(o.customer_cpf || '');
      if (o.payment_method?.startsWith('card_')) {
        setAsaasBilling('CREDIT_CARD');
        const m = o.payment_method.match(/card_(\d+)x/);
        setAsaasInstallments(m ? parseInt(m[1]) : 1);
      } else if (o.payment_method === 'boleto') {
        setAsaasBilling('BOLETO');
      } else {
        setAsaasBilling('PIX');
      }
    } catch (e) {
      toast.error('Pedido não encontrado');
      navigate('/estoque/pedidos');
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await StockOrder.update(id, {
        payment_status: paymentStatus,
        delivery_status: deliveryStatus,
        internal_notes: internalNotes,
        payment_date: paymentDate || null,
        delivery_date: deliveryDate || null,
        payment_method: paymentMethod || null,
        cancellation_reason: cancellationReason || null,
      });
      toast.success('Pedido atualizado!');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const callAsaas = async (action, extra = {}) => {
    setAsaasLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-asaas-charge', {
        body: { action, order_id: id, order_type: 'stock', ...extra },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    } finally {
      setAsaasLoading(false);
    }
  };

  const createAsaasCharge = async (billingType) => {
    const cpf = asaasCpf.replace(/\D/g, '');
    if (cpf.length < 11) return toast.error('Informe o CPF do cliente (11 dígitos)');
    await StockOrder.update(id, { customer_cpf: asaasCpf });
    try {
      await callAsaas('create', { cpf: asaasCpf, billing_type: billingType, due_date: asaasDueDate, installments: asaasInstallments });
      await supabase.from('stock_orders').update({ due_date: asaasDueDate }).eq('id', id);
      toast.success('Cobrança criada com sucesso!');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao criar cobrança'); }
  };

  const verifyAsaasStatus = async () => {
    try {
      const data = await callAsaas('status');
      setAsaasStatus(data);
      if (data.is_paid) {
        toast.success('Pagamento confirmado! Pedido atualizado para Pago.');
        load();
      } else {
        toast.info(`Status: ${data.label}`);
      }
    } catch (e) { toast.error(e.message || 'Erro ao verificar'); }
  };

  const cancelAsaasCharge = () => {
    setCancelReason('');
    setCancelReasonCustom('');
    setCancelModal(true);
  };

  const confirmCancelAsaasCharge = async () => {
    const reason = cancelReason === 'Outro' ? cancelReasonCustom : cancelReason;
    try {
      await callAsaas('cancel');
      await supabase.from('stock_orders').update({ cancellation_reason: reason || null }).eq('id', id);
      setCancelModal(false);
      setAsaasStatus(null);
      toast.success('Cobrança cancelada.');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao cancelar'); }
  };

  const confirmRefund = async () => {
    const reason = refundReason === 'Outro' ? refundReasonCustom : refundReason;
    try {
      await callAsaas('refund', { reason });
      await supabase.from('stock_orders').update({ cancellation_reason: reason || null }).eq('id', id);
      setRefundModal(false);
      toast.success('Estorno realizado com sucesso!');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao estornar'); }
  };

  const buildMessage = () => {
    if (!order) return '';
    const itemLines = (order.items || []).map(item => {
      const label = item.variation ? `${item.product_name} - ${item.variation}` : item.product_name;
      return `• ${label} x${item.quantity} → ${formatCurrency((item.sale_price || 0) * item.quantity)}`;
    }).join('\n');
    const total = order.total_value || 0;
    const chargeLink = order.asaas_payment_link;
    const pixCopy = order.asaas_pix_copy;
    if (chargeLink || pixCopy) {
      return `Olá, ${order.customer_name}! 👋\n\nSegue o resumo do seu pedido *${order.order_number}*:\n\n📦 *Itens:*\n${itemLines}\n\n💰 *Total: ${formatCurrency(total)}*\n\n${pixCopy ? `📲 *PIX Copia e Cola:*\n\`${pixCopy}\`\n\n` : ''}${chargeLink ? `🔗 *Link de pagamento:*\n${chargeLink}` : ''}`;
    }
    return `Olá, ${order.customer_name}! 👋\n\nSegue o resumo do seu pedido *${order.order_number}*:\n\n📦 *Itens:*\n${itemLines}\n\n💰 *Total: ${formatCurrency(total)}*\n\nComo você prefere pagar?\n• PIX (à vista) — ${formatCurrency(total)}\n• Cartão (em até 6x)`;
  };

  const openWhatsApp = () => { setWhatsappMsg(buildMessage()); setCopied(false); setWhatsappModal(true); };
  const copyMessage = () => { navigator.clipboard.writeText(whatsappMsg).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  const openWhatsAppDirect = () => { window.open(`https://wa.me/55${(order.customer_whatsapp || '').replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMsg)}`, '_blank'); };

  const markMessageSent = async () => {
    try {
      await StockOrder.update(id, { payment_status: 'message_sent' });
      toast.success('Mensagem marcada como enviada!');
      setWhatsappModal(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (!order) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const ps = PAYMENT_STATUS[order.payment_status] || { label: order.payment_status, badge: 'secondary' };
  const ds = DELIVERY_STATUS[order.delivery_status] || { label: order.delivery_status, badge: 'secondary' };
  const items = order.items || [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/estoque/pedidos')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold font-mono">{order.order_number}</h2>
          <p className="text-sm text-muted-foreground">{formatDate(order.created_date)}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={ps.badge}>{ps.label}</Badge>
          <Badge variant={ds.badge}>{ds.label}</Badge>
          {order.customer_whatsapp && (
            <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white gap-1.5" onClick={openWhatsApp}>
              <MessageCircle className="w-4 h-4" /> Cobrar via WhatsApp
            </Button>
          )}
        </div>
      </div>

      {/* Aviso de cancelamento/estorno */}
      {order.cancellation_reason && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-700">Motivo do cancelamento / estorno</p>
            <p className="text-red-600 mt-0.5">{order.cancellation_reason}</p>
          </div>
        </div>
      )}

      {/* Cliente */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><User className="w-4 h-4" /> Cliente</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="font-semibold text-base">{order.customer_name}</p>
          {order.customer_whatsapp && <p className="flex items-center gap-2 text-muted-foreground"><Phone className="w-3.5 h-3.5" />{order.customer_whatsapp}</p>}
          {order.customer_email && <p className="flex items-center gap-2 text-muted-foreground"><Mail className="w-3.5 h-3.5" />{order.customer_email}</p>}
          {order.delivery_method && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Package className="w-3.5 h-3.5" />
              {order.delivery_method === 'pickup' ? `Retirada em treino${order.delivery_city ? ' · ' + order.delivery_city : ''}` : 'Frete'}
            </p>
          )}
          {order.payment_method && (
            <p className="text-xs text-blue-600 font-medium mt-1">
              Preferência: {PAYMENT_METHOD_LABEL[order.payment_method] || order.payment_method}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Itens */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Package className="w-4 h-4" /> Itens do Pedido</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0 ? <p className="text-sm text-muted-foreground">Sem itens</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 font-medium text-muted-foreground">Produto</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Qtd</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Preço unit.</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item, i) => (
                    <tr key={i}>
                      <td className="py-2 font-medium">{item.product_name}{item.variation ? ` — ${item.variation}` : ''}</td>
                      <td className="py-2 text-right">{item.quantity}</td>
                      <td className="py-2 text-right">{formatCurrency(item.sale_price)}</td>
                      <td className="py-2 text-right font-semibold">{formatCurrency((item.sale_price || 0) * item.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t mt-4 pt-4 text-right">
            <span className="text-sm text-muted-foreground mr-3">Total do pedido</span>
            <span className="font-bold text-lg">{formatCurrency(order.total_value)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Modal WhatsApp */}
      <Dialog open={whatsappModal} onOpenChange={setWhatsappModal}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><MessageCircle className="w-5 h-5 text-green-600" /> Mensagem de cobrança</DialogTitle></DialogHeader>
          <div className="bg-gray-50 rounded-xl p-4 text-sm whitespace-pre-wrap font-mono border">{whatsappMsg}</div>
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" variant="outline" onClick={copyMessage}>
              {copied ? <><Check className="w-4 h-4 mr-1.5 text-green-600" />Copiado!</> : <><Copy className="w-4 h-4 mr-1.5" />Copiar mensagem</>}
            </Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsAppDirect}>
              <ExternalLink className="w-4 h-4 mr-1.5" /> Abrir no WhatsApp
            </Button>
          </div>
          {order.payment_status === 'awaiting_charge' && (
            <Button className="w-full bg-orange-500 hover:bg-orange-600 text-white" onClick={markMessageSent}>
              <Check className="w-4 h-4 mr-1.5" /> Mensagem enviada — aguardando resposta
            </Button>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal cancelar cobrança */}
      <Dialog open={cancelModal} onOpenChange={setCancelModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600"><X className="w-5 h-5" /> Cancelar cobrança</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Selecione o motivo do cancelamento:</p>
            <div className="space-y-1.5">
              {CANCEL_REASONS.map(r => (
                <button key={r} type="button" onClick={() => setCancelReason(r)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-all ${cancelReason === r ? 'border-red-400 bg-red-50 text-red-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-700'}`}>
                  {r}
                </button>
              ))}
            </div>
            {cancelReason === 'Outro' && (
              <Textarea placeholder="Descreva o motivo..." value={cancelReasonCustom} onChange={e => setCancelReasonCustom(e.target.value)} rows={2} />
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setCancelModal(false)}>Voltar</Button>
              <Button className="flex-1 bg-red-500 hover:bg-red-600 text-white" onClick={confirmCancelAsaasCharge} disabled={asaasLoading || !cancelReason}>
                {asaasLoading ? 'Cancelando...' : 'Confirmar cancelamento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal estornar */}
      <Dialog open={refundModal} onOpenChange={setRefundModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600"><RotateCcw className="w-5 h-5" /> Estornar pagamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <p className="text-sm font-semibold text-amber-800">Valor a estornar: {formatCurrency(order.total_value)}</p>
              <p className="text-xs text-amber-600 mt-0.5">O estorno será processado no Asaas e é irreversível.</p>
            </div>
            <p className="text-sm text-muted-foreground">Motivo do estorno:</p>
            <div className="space-y-1.5">
              {CANCEL_REASONS.map(r => (
                <button key={r} type="button" onClick={() => setRefundReason(r)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-all ${refundReason === r ? 'border-amber-400 bg-amber-50 text-amber-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-700'}`}>
                  {r}
                </button>
              ))}
            </div>
            {refundReason === 'Outro' && (
              <Textarea placeholder="Descreva o motivo..." value={refundReasonCustom} onChange={e => setRefundReasonCustom(e.target.value)} rows={2} />
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setRefundModal(false)}>Voltar</Button>
              <Button className="flex-1 bg-amber-500 hover:bg-amber-600 text-white" onClick={confirmRefund} disabled={asaasLoading || !refundReason}>
                {asaasLoading ? 'Estornando...' : 'Confirmar estorno'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cobrança Asaas */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Zap className="w-4 h-4 text-blue-600" /> Cobrança Asaas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {order.asaas_charge_id ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${asaasStatus?.color === 'success' ? 'bg-green-100 text-green-700' : asaasStatus?.color === 'danger' ? 'bg-red-100 text-red-700' : asaasStatus?.color === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                    {asaasStatus ? asaasStatus.label : 'Cobrança criada'}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">{order.asaas_charge_id}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button size="sm" variant="outline" onClick={verifyAsaasStatus} disabled={asaasLoading}>
                    <Check className="w-3.5 h-3.5 mr-1" />{asaasLoading ? '...' : 'Verificar'}
                  </Button>
                  {order.asaas_payment_link && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={order.asaas_payment_link} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5 mr-1" /> Ver fatura</a>
                    </Button>
                  )}
                  {order.payment_status === 'paid' && (
                    <Button size="sm" variant="outline" className="text-amber-600 hover:text-amber-800 hover:bg-amber-50" onClick={() => { setRefundReason(''); setRefundReasonCustom(''); setRefundModal(true); }} disabled={asaasLoading}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Estornar
                    </Button>
                  )}
                  {!['paid', 'refunded', 'cancelled'].includes(order.payment_status) && (
                    <Button size="sm" variant="outline" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={cancelAsaasCharge} disabled={asaasLoading}>
                      <X className="w-3.5 h-3.5 mr-1" /> Cancelar
                    </Button>
                  )}
                </div>
              </div>
              {order.asaas_pix_copy && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><QrCode className="w-3.5 h-3.5" /> PIX Copia e Cola</p>
                  <div className="flex gap-2">
                    <input readOnly value={order.asaas_pix_copy} className="flex-1 text-xs font-mono bg-gray-50 border rounded-lg px-3 py-2 truncate" />
                    <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(order.asaas_pix_copy); toast.success('Copiado!'); }}><Copy className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>
              )}
              {order.asaas_payment_link && (
                <div className="flex items-center gap-2">
                  <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm text-blue-600 truncate flex-1">{order.asaas_payment_link}</span>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(order.asaas_payment_link); toast.success('Link copiado!'); }}><Copy className="w-3.5 h-3.5" /></Button>
                </div>
              )}
              <Button className="w-full bg-green-600 hover:bg-green-700 text-white gap-2" onClick={() => { setWhatsappMsg(buildMessage()); setCopied(false); setWhatsappModal(true); }}>
                <MessageCircle className="w-4 h-4" /> Enviar cobrança via WhatsApp
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {order.payment_method && (
                <div className="flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5">
                  <span className="text-blue-600">Cliente solicitou:</span>
                  <span className="font-semibold text-blue-900">{PAYMENT_METHOD_LABEL[order.payment_method] || order.payment_method}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>CPF do cliente</Label>
                  <Input className="mt-1 font-mono" placeholder="000.000.000-00" value={asaasCpf} onChange={e => setAsaasCpf(e.target.value)} />
                </div>
                <div>
                  <Label>Vencimento</Label>
                  <Input type="date" className="mt-1" value={asaasDueDate} onChange={e => setAsaasDueDate(e.target.value)} />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">Forma de cobrança</Label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { key: 'PIX', icon: <QrCode className="w-4 h-4" />, label: 'PIX' },
                    { key: 'BOLETO', icon: <FileText className="w-4 h-4" />, label: 'Boleto' },
                    { key: 'CREDIT_CARD', icon: <Zap className="w-4 h-4" />, label: order.payment_method?.startsWith('card_') ? `Cartão (${order.payment_method.replace('card_', '')})` : 'Cartão' },
                  ].map(opt => (
                    <button key={opt.key} type="button" onClick={() => setAsaasBilling(opt.key)}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${asaasBilling === opt.key ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-200 text-gray-600 hover:border-blue-300 bg-white'}`}>
                      {opt.icon}{opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {asaasBilling === 'CREDIT_CARD' && (
                <div>
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">Parcelas</Label>
                  <div className="grid grid-cols-6 gap-1.5">
                    {[1,2,3,4,5,6].map(n => (
                      <button key={n} type="button" onClick={() => setAsaasInstallments(n)}
                        className={`py-2 rounded-lg border-2 text-sm font-semibold transition-all ${asaasInstallments === n ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-200 text-gray-600 hover:border-blue-300 bg-white'}`}>
                        {n}x
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Button className="w-full gap-2" onClick={() => createAsaasCharge(asaasBilling)} disabled={asaasLoading}>
                <Zap className="w-4 h-4" />
                {asaasLoading ? 'Criando cobrança...' : `Gerar cobrança — ${{ PIX: 'PIX', BOLETO: 'Boleto', CREDIT_CARD: `Cartão ${asaasInstallments}x` }[asaasBilling]}`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Controles */}
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
              <Label>Forma de Pagamento</Label>
              <Select value={paymentMethod || 'none'} onValueChange={v => setPaymentMethod(v === 'none' ? '' : v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Não confirmado</SelectItem>
                  <SelectItem value="pix_boleto">PIX ou Boleto (preferência)</SelectItem>
                  <SelectItem value="pix">PIX</SelectItem>
                  <SelectItem value="boleto">Boleto</SelectItem>
                  <SelectItem value="card_1x">Cartão 1x</SelectItem>
                  <SelectItem value="card_2x">Cartão 2x</SelectItem>
                  <SelectItem value="card_3x">Cartão 3x</SelectItem>
                  <SelectItem value="card_4x">Cartão 4x</SelectItem>
                  <SelectItem value="card_5x">Cartão 5x</SelectItem>
                  <SelectItem value="card_6x">Cartão 6x</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Data de Pagamento</Label>
              <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="mt-1" />
            </div>
          </div>
          {['cancelled', 'refunded'].includes(paymentStatus) && (
            <div>
              <Label>Motivo do cancelamento / estorno</Label>
              <div className="grid grid-cols-2 gap-1.5 mt-1.5 mb-2">
                {CANCEL_REASONS.map(r => (
                  <button key={r} type="button" onClick={() => setCancellationReason(r)}
                    className={`text-left px-3 py-1.5 rounded-lg border text-sm transition-all ${cancellationReason === r ? 'border-red-400 bg-red-50 text-red-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-600'}`}>
                    {r}
                  </button>
                ))}
              </div>
              <Textarea placeholder="Detalhes do motivo (opcional)..." value={cancellationReason} onChange={e => setCancellationReason(e.target.value)} rows={2} className="mt-1" />
            </div>
          )}
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
            <Textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} className="mt-1" rows={3} placeholder="Anotações internas..." />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Salvando...' : 'Salvar alterações'}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
