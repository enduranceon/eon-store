import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, Package, Calendar, FileText, MessageCircle, Copy, Check, ExternalLink, Zap, QrCode, Link2, X, RotateCcw, AlertTriangle, Tag, ArrowRight, HandCoins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { PreSaleOrder, PreSaleCampaign, PreSaleCustomer } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { loadActivePaymentMethods, calcFee, projectInstallments, createManualInstallments } from '@/lib/manual-payment';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import DiscountInput from '@/components/DiscountInput';
import { toast } from 'sonner';
import { returnCouponUse } from '@/lib/coupon';

const PAYMENT_STATUS = {
  awaiting_charge: { label: 'Aguardando contato', badge: 'secondary' },
  message_sent: { label: 'Mensagem enviada', badge: 'warning' },
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

const CANCEL_REASONS = [
  'Desistência do cliente',
  'Produto indisponível',
  'Duplicidade de pedido',
  'Erro no pedido',
  'Outro',
];

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [campaign, setCampaign] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveConfirmModal, setSaveConfirmModal] = useState(false);
  const [manualPayModal, setManualPayModal] = useState(false);
  const [manualPayForm, setManualPayForm] = useState({ method_id: '', date: '', value: '' });
  const [methodGroups, setMethodGroups] = useState([]);  // [[group_name, [methods...]], ...]
  const [manualPaySaving, setManualPaySaving] = useState(false);
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
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });

  // Estados dos modais de cancelamento e estorno
  const [cancelModal, setCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelReasonCustom, setCancelReasonCustom] = useState('');
  const [refundModal, setRefundModal] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundReasonCustom, setRefundReasonCustom] = useState('');
  const [cancelItemModal, setCancelItemModal] = useState(false);
  const [cancelItemIndex, setCancelItemIndex] = useState(null);
  const [cancelItemDelivered, setCancelItemDelivered] = useState(false);
  const [cancelItemReason, setCancelItemReason] = useState('');
  const [cancelItemLoading, setCancelItemLoading] = useState(false);

  const load = async () => {
    const o = await PreSaleOrder.get(id);
    setOrder(o);
    setPaymentStatus(o.payment_status || 'awaiting_charge');
    setDeliveryStatus(o.delivery_status || 'awaiting_supplier');
    setInternalNotes(o.internal_notes || '');
    setPaymentDate(o.payment_date || '');
    setDeliveryDate(o.delivery_date || '');
    setPaymentMethod(o.payment_method || '');
    setCancellationReason(o.cancellation_reason || '');
    if (o.payment_method?.startsWith('card_')) {
      setAsaasBilling('CREDIT_CARD');
      const m = o.payment_method.match(/card_(\d+)x/);
      setAsaasInstallments(m ? parseInt(m[1]) : 1);
    } else if (o.payment_method === 'boleto') {
      setAsaasBilling('BOLETO');
    } else {
      setAsaasBilling('PIX');
    }
    if (o.campaign_id) PreSaleCampaign.get(o.campaign_id).then(setCampaign).catch(() => {});
    if (o.customer_id) PreSaleCustomer.get(o.customer_id).then(c => {
      setCustomer(c);
      if (c.cpf) setAsaasCpf(c.cpf);
    }).catch(() => {});
  };

  useEffect(() => { load(); }, [id]);

  const openManualPay = async () => {
    const total = order?.total_value ? Number(order.total_value).toFixed(2) : '';
    try {
      const groups = await loadActivePaymentMethods();
      setMethodGroups(groups);
      // Default: PIX manual se existir
      const allMethods = groups.flatMap(([, list]) => list);
      const defaultMethod = allMethods.find(m => m.internal_code === 'pix_manual') || allMethods[0];
      setManualPayForm({
        method_id: defaultMethod?.id || '',
        date:      todayLocalStr(),
        value:     total,
      });
      setManualPayModal(true);
    } catch (e) {
      toast.error('Erro ao carregar métodos: ' + e.message);
    }
  };

  const recordManualPayment = async () => {
    if (!manualPayForm.method_id) return toast.error('Selecione um método');
    if (!manualPayForm.date)      return toast.error('Informe a data do pagamento');
    if (!manualPayForm.value || isNaN(Number(manualPayForm.value))) return toast.error('Informe o valor recebido');
    const method = methodGroups.flatMap(([, list]) => list).find(m => m.id === manualPayForm.method_id);
    if (!method) return toast.error('Método inválido');

    setManualPaySaving(true);
    try {
      const totalV = Number(manualPayForm.value);
      const fee    = calcFee(method, totalV);
      // 1. Atualiza order
      await PreSaleOrder.update(id, {
        payment_status: 'paid',
        payment_method: method.internal_code || method.kind,
        payment_date:   manualPayForm.date,
        manual_payment: true,
        manual_fee:     fee > 0 ? Math.round(fee * 100) / 100 : null,
      });
      // 2. Cria parcelas projetadas em asaas_payments
      const result = await createManualInstallments(
        method, manualPayForm.date,
        { order_id: id, order_type: 'presale', external_reference: order?.order_number },
        totalV,
      );
      toast.success(`Pagamento registrado! ${result.installments > 1 ? `${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      load();
    } catch (e) { toast.error(e.message); }
    finally { setManualPaySaving(false); }
  };

  const SENSITIVE_PAYMENT = new Set(['paid', 'cancelled', 'refunded', 'partially_paid']);

  const handleSaveClick = () => {
    if (order && SENSITIVE_PAYMENT.has(paymentStatus) && paymentStatus !== order.payment_status) {
      setSaveConfirmModal(true);
    } else {
      handleSave();
    }
  };

  const handleSave = async () => {
    setSaveConfirmModal(false);
    setSaving(true);
    try {
      const wasActive = !['cancelled', 'refunded'].includes(order.payment_status);
      const willBeCancelled = ['cancelled', 'refunded'].includes(paymentStatus);

      await PreSaleOrder.update(id, {
        payment_status: paymentStatus,
        delivery_status: deliveryStatus,
        internal_notes: internalNotes,
        payment_date: paymentDate || null,
        delivery_date: deliveryDate || null,
        payment_method: paymentMethod || null,
        cancellation_reason: cancellationReason || null,
      });

      // Devolve uso de cupom se mudou para cancelado/estornado manualmente
      if (wasActive && willBeCancelled && order.coupon_code) {
        await returnCouponUse(id, 'presale');
      }

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
        body: { action, order_id: id, order_type: 'presale', ...extra },
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
    try {
      await callAsaas('create', { cpf: asaasCpf, billing_type: billingType, due_date: asaasDueDate, installments: asaasInstallments });
      await supabase.from('presale_orders').update({ due_date: asaasDueDate }).eq('id', id);
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

  // Abre modal de cancelamento
  const cancelAsaasCharge = () => {
    setCancelReason('');
    setCancelReasonCustom('');
    setCancelModal(true);
  };

  // Confirma cancelamento com motivo
  const confirmCancelAsaasCharge = async () => {
    const reason = cancelReason === 'Outro' ? cancelReasonCustom : cancelReason;
    try {
      await callAsaas('cancel');
      await supabase.from('presale_orders').update({ cancellation_reason: reason || null }).eq('id', id);
      await returnCouponUse(id, 'presale');
      setCancelModal(false);
      setAsaasStatus(null);
      toast.success('Cobrança cancelada.');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao cancelar'); }
  };

  // Confirma estorno com motivo
  const confirmRefund = async () => {
    const reason = refundReason === 'Outro' ? refundReasonCustom : refundReason;
    try {
      await callAsaas('refund', { reason });
      await supabase.from('presale_orders').update({ cancellation_reason: reason || null }).eq('id', id);
      await returnCouponUse(id, 'presale');
      setRefundModal(false);
      toast.success('Estorno realizado com sucesso!');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao estornar'); }
  };

  const buildMessage = () => {
    const itemLines = (order.items || []).filter(it => !it.cancelled).map(item => {
      const extras = (item.extras || []).map(e => `   ➕ ${e.name}: ${formatCurrency(e.price)}`).join('\n');
      const itemTotal = ((item.sale_price || 0) + (item.extras_total || 0)) * item.quantity;
      const label = item.variation ? `${item.product_name} - ${item.variation}` : item.product_name;
      return `• ${label} x${item.quantity} → ${formatCurrency(itemTotal)}${extras ? '\n' + extras : ''}`;
    }).join('\n');
    const total = order.total_value || 0;
    const chargeLink = order.asaas_payment_link;
    const pixCopy = order.asaas_pix_copy;
    const trackingLink = `${window.location.origin}/p/${order.id}`;
    const trackingLine = `\n\n🔍 *Acompanhe seu pedido:*\n${trackingLink}`;
    if (chargeLink || pixCopy) {
      return `Olá, ${order.checkout_name}! 👋\n\nSegue o resumo do seu pedido *${order.order_number}*:\n\n📦 *Itens:*\n${itemLines}\n\n💰 *Total: ${formatCurrency(total)}*\n\n${pixCopy ? `📲 *PIX Copia e Cola:*\n\`${pixCopy}\`\n\n` : ''}${chargeLink ? `🔗 *Link de pagamento:*\n${chargeLink}` : ''}${trackingLine}`;
    }
    return `Olá, ${order.checkout_name}! 👋\n\nSegue o resumo do seu pedido *${order.order_number}*:\n\n📦 *Itens:*\n${itemLines}\n\n💰 *Total: ${formatCurrency(total)}*\n\nComo você prefere pagar?\n• PIX (à vista) — ${formatCurrency(total)}\n• Cartão (em até 4x)${trackingLine}`;
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

  const markMessageSent = async () => {
    try {
      await PreSaleOrder.update(id, { payment_status: 'message_sent' });
      toast.success('Mensagem marcada como enviada!');
      setWhatsappModal(false);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!order) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const ps = PAYMENT_STATUS[order.payment_status] || { label: order.payment_status, badge: 'secondary' };
  const ds = DELIVERY_STATUS[order.delivery_status] || { label: order.delivery_status, badge: 'secondary' };
  const items = order.items || [];
  const totalCost = order.total_cost || 0;
  const grossProfit = (order.total_value || 0) - totalCost;

  const openCancelItem = (index) => {
    setCancelItemIndex(index);
    setCancelItemDelivered(order.delivery_status === 'delivered');
    setCancelItemReason('');
    setCancelItemModal(true);
  };

  const confirmCancelItem = async () => {
    const item = items[cancelItemIndex];
    const itemPrice = ((item.sale_price || 0) + (item.extras_total || 0)) * item.quantity;

    // 1. Calcula novo subtotal (sem o item cancelado)
    const newItems = items.map((it, i) =>
      i === cancelItemIndex ? { ...it, cancelled: true, cancelled_at: new Date().toISOString() } : it
    );
    const activeItems = newItems.filter(it => !it.cancelled);
    const newSubtotal = activeItems.reduce((sum, it) => sum + ((it.sale_price || 0) + (it.extras_total || 0)) * it.quantity, 0);
    const newTotalCost = activeItems.reduce((sum, it) => sum + ((it.cost_price || 0) * it.quantity), 0);

    // 2. Recalcula desconto de cupom proporcionalmente (mantém razão original)
    const oldDiscount = Number(order.discount_value) || 0;
    const oldSubtotal = (order.total_value || 0) + oldDiscount;
    let newDiscount = 0;
    if (oldDiscount > 0 && oldSubtotal > 0) {
      // Mantém a mesma proporção (funciona pra % e aproxima fixo)
      newDiscount = Math.round((newSubtotal * (oldDiscount / oldSubtotal)) * 100) / 100;
      newDiscount = Math.min(newDiscount, newSubtotal); // cap
    }
    const newTotal = Math.max(0, newSubtotal - newDiscount);

    // 3. Refund Asaas = diferença real (old_total - new_total)
    const refundValue = Math.max(0, (order.total_value || 0) - newTotal);
    const allCancelled = activeItems.length === 0;
    const newPaymentStatus = allCancelled
      ? (order.payment_status === 'paid' ? 'refunded' : 'cancelled')
      : order.payment_status;

    setCancelItemLoading(true);
    try {
      // 4. Asaas PRIMEIRO — se falhar, nada é alterado no DB
      if (order.payment_status === 'paid' && order.asaas_charge_id && refundValue > 0) {
        await callAsaas('refund', { value: refundValue, reason: cancelItemReason || 'Cancelamento de peça' });
      }

      // 5. Atualiza pedido (items, totais, desconto recalculado, status se for o último)
      await supabase.from('presale_orders').update({
        items: newItems,
        total_value: newTotal,
        total_cost: newTotalCost,
        discount_value: newDiscount,
        ...(allCancelled ? { payment_status: newPaymentStatus } : {}),
      }).eq('id', id);

      // 4. Registra devolução
      await supabase.from('order_returns').insert({
        order_id: id,
        order_type: 'presale',
        order_number: order.order_number,
        customer_name: order.checkout_name,
        item_index: cancelItemIndex,
        product_name: item.product_name,
        variation: item.variation || null,
        quantity: item.quantity,
        unit_price: item.sale_price || 0,
        refund_value: refundValue,
        was_delivered: cancelItemDelivered,
        status: cancelItemDelivered ? 'pending_return' : 'completed',
        notes: cancelItemReason || null,
      });

      // 5. Se todas as peças foram canceladas, devolve uso de cupom
      if (allCancelled) await returnCouponUse(id, 'presale');

      setCancelItemModal(false);
      toast.success(cancelItemDelivered ? 'Peça cancelada — aguardando devolução física.' : 'Peça cancelada com sucesso.');
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao cancelar peça');
    } finally {
      setCancelItemLoading(false);
    }
  };

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

      {/* Aviso de cancelamento */}
      {order.cancellation_reason && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-700">Motivo do cancelamento / estorno</p>
            <p className="text-red-600 mt-0.5">{order.cancellation_reason}</p>
          </div>
        </div>
      )}

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
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item, i) => (
                    <>
                      <tr key={i} className={item.cancelled ? 'opacity-50' : ''}>
                        <td className="py-2 font-medium">
                          <span className={item.cancelled ? 'line-through text-muted-foreground' : ''}>{item.product_name}</span>
                          {item.cancelled && <span className="ml-2 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium">Cancelado</span>}
                        </td>
                        <td className="py-2 text-muted-foreground">{item.variation || '-'}</td>
                        <td className="py-2 text-right">{item.quantity}</td>
                        <td className="py-2 text-right">{formatCurrency(item.sale_price)}</td>
                        <td className="py-2 text-right text-red-600">{formatCurrency(item.cost_price)}</td>
                        <td className="py-2 text-right font-semibold">{formatCurrency(((item.sale_price || 0) + (item.extras_total || 0)) * (item.quantity || 1))}</td>
                        <td className="py-2 text-right">
                          {!item.cancelled && !['cancelled', 'refunded'].includes(order.payment_status) && (
                            <button onClick={() => openCancelItem(i)} className="text-xs text-red-500 hover:text-red-700 hover:underline whitespace-nowrap">
                              Cancelar peça
                            </button>
                          )}
                        </td>
                      </tr>
                      {(item.extras || []).map((extra, j) => (
                        <tr key={`${i}-x${j}`} className={`bg-blue-50/40 text-xs${item.cancelled ? ' opacity-50' : ''}`}>
                          <td className="py-1 pl-4 text-blue-700">+ {extra.name}</td>
                          <td className="py-1 text-muted-foreground">—</td>
                          <td className="py-1 text-right text-muted-foreground">{item.quantity}</td>
                          <td className="py-1 text-right text-blue-600">{formatCurrency(extra.price)}</td>
                          <td className="py-1 text-muted-foreground">—</td>
                          <td className="py-1 text-right font-medium text-blue-600">{formatCurrency((extra.price || 0) * (item.quantity || 1))}</td>
                          <td></td>
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {order.coupon_code && (
            <div className="border-t mt-4 pt-3 flex items-center justify-between text-sm bg-amber-50 -mx-6 px-6 py-2">
              <span className="flex items-center gap-2 text-amber-800">
                <Tag className="w-3.5 h-3.5" />
                Cupom aplicado: <span className="font-mono font-bold">{order.coupon_code}</span>
              </span>
              <span className="font-semibold text-amber-800">-{formatCurrency(order.discount_value || 0)}</span>
            </div>
          )}
          <div className={`${order.coupon_code ? '' : 'border-t mt-4 pt-4'} grid grid-cols-3 gap-4 text-center ${order.coupon_code ? 'pt-4' : ''}`}>
            <div>
              <p className="text-xs text-muted-foreground">Total do pedido</p>
              <p className="font-bold text-lg">{formatCurrency(order.total_value)}</p>
              {order.coupon_code && (
                <p className="text-[10px] text-muted-foreground">já com desconto</p>
              )}
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

      {/* Desconto manual */}
      <DiscountInput
        subtotal={(order.items || []).filter(it => !it.cancelled).reduce((s, it) => s + (it.sale_price || 0) * it.quantity, 0) - (Number(order.discount_value) || 0)}
        currentDiscount={Number(order.manual_discount) || 0}
        currentReason={order.discount_reason || ''}
        lockedReason={order.asaas_charge_id
          ? 'Já existe uma cobrança gerada no Asaas. Cancele a cobrança atual antes de aplicar desconto.'
          : null}
        entityType="presale_order"
        entityId={order.id}
        onSave={async (newValue, reason) => {
          const activeItems = (order.items || []).filter(it => !it.cancelled);
          const subItens = activeItems.reduce((s, it) => s + (it.sale_price || 0) * it.quantity, 0);
          const cupom = Number(order.discount_value) || 0;
          const newTotal = Math.max(0, subItens - cupom - newValue);
          await PreSaleOrder.update(order.id, {
            manual_discount: newValue,
            discount_reason: reason || null,
            total_value:     newTotal,
          });
          await load();
        }}
      />

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
          {order.payment_status === 'awaiting_charge' && (
            <Button className="w-full bg-orange-500 hover:bg-orange-600 text-white" onClick={markMessageSent}>
              <Check className="w-4 h-4 mr-1.5" />
              Mensagem enviada — aguardando resposta
            </Button>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal cancelar cobrança */}
      <Dialog open={cancelModal} onOpenChange={setCancelModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <X className="w-5 h-5" /> Cancelar cobrança
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Selecione o motivo do cancelamento:</p>
            <div className="space-y-1.5">
              {CANCEL_REASONS.map(r => (
                <button key={r} type="button" onClick={() => setCancelReason(r)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-all ${
                    cancelReason === r ? 'border-red-400 bg-red-50 text-red-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}>
                  {r}
                </button>
              ))}
            </div>
            {cancelReason === 'Outro' && (
              <Textarea
                placeholder="Descreva o motivo..."
                value={cancelReasonCustom}
                onChange={e => setCancelReasonCustom(e.target.value)}
                rows={2}
                className="mt-1"
              />
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setCancelModal(false)}>Voltar</Button>
              <Button
                className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                onClick={confirmCancelAsaasCharge}
                disabled={asaasLoading || !cancelReason}
              >
                {asaasLoading ? 'Cancelando...' : 'Confirmar cancelamento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal estornar pagamento */}
      <Dialog open={refundModal} onOpenChange={setRefundModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <RotateCcw className="w-5 h-5" /> Estornar pagamento
            </DialogTitle>
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
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-all ${
                    refundReason === r ? 'border-amber-400 bg-amber-50 text-amber-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}>
                  {r}
                </button>
              ))}
            </div>
            {refundReason === 'Outro' && (
              <Textarea
                placeholder="Descreva o motivo..."
                value={refundReasonCustom}
                onChange={e => setRefundReasonCustom(e.target.value)}
                rows={2}
                className="mt-1"
              />
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setRefundModal(false)}>Voltar</Button>
              <Button
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                onClick={confirmRefund}
                disabled={asaasLoading || !refundReason}
              >
                {asaasLoading ? 'Estornando...' : 'Confirmar estorno'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal cancelar peça individual */}
      <Dialog open={cancelItemModal} onOpenChange={setCancelItemModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <X className="w-5 h-5" /> Cancelar peça
            </DialogTitle>
          </DialogHeader>
          {cancelItemIndex !== null && items[cancelItemIndex] && (
            <div className="space-y-4">
              <div className="bg-gray-50 border rounded-xl px-4 py-3 text-sm">
                <p className="font-semibold">{items[cancelItemIndex].product_name}</p>
                {items[cancelItemIndex].variation && <p className="text-muted-foreground">{items[cancelItemIndex].variation}</p>}
                <p className="text-muted-foreground mt-1">
                  Qtd: {items[cancelItemIndex].quantity} × {formatCurrency(items[cancelItemIndex].sale_price)}
                  {' = '}<span className="font-semibold text-gray-800">{formatCurrency(((items[cancelItemIndex].sale_price || 0) + (items[cancelItemIndex].extras_total || 0)) * items[cancelItemIndex].quantity)}</span>
                </p>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Esta peça já foi entregue ao cliente?</p>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setCancelItemDelivered(false)}
                    className={`py-2 rounded-lg border-2 text-sm font-medium transition-all ${!cancelItemDelivered ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                    Não entregue
                  </button>
                  <button onClick={() => setCancelItemDelivered(true)}
                    className={`py-2 rounded-lg border-2 text-sm font-medium transition-all ${cancelItemDelivered ? 'border-orange-400 bg-orange-50 text-orange-800' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                    Já entregue
                  </button>
                </div>
                {cancelItemDelivered && (
                  <p className="text-xs text-orange-600 mt-1.5">⚠ Item ficará pendente na Central de Devoluções até retornar fisicamente.</p>
                )}
              </div>

              <div>
                <p className="text-sm font-medium mb-1.5">Motivo (opcional)</p>
                <div className="space-y-1.5">
                  {CANCEL_REASONS.filter(r => r !== 'Outro').map(r => (
                    <button key={r} type="button" onClick={() => setCancelItemReason(cancelItemReason === r ? '' : r)}
                      className={`w-full text-left px-3 py-1.5 rounded-lg border text-sm transition-all ${cancelItemReason === r ? 'border-red-400 bg-red-50 text-red-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-700'}`}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {order.payment_status === 'paid' && order.asaas_charge_id && (() => {
                const itemPrice = ((items[cancelItemIndex].sale_price || 0) + (items[cancelItemIndex].extras_total || 0)) * items[cancelItemIndex].quantity;
                const oldDiscount = Number(order.discount_value) || 0;
                const oldSubtotal = (order.total_value || 0) + oldDiscount;
                const newSubtotal = oldSubtotal - itemPrice;
                const newDiscount = oldDiscount > 0 && oldSubtotal > 0
                  ? Math.min(Math.round((newSubtotal * (oldDiscount / oldSubtotal)) * 100) / 100, newSubtotal)
                  : 0;
                const refund = Math.max(0, (order.total_value || 0) - (newSubtotal - newDiscount));
                return (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700">
                    Estorno de {formatCurrency(refund)} será processado no Asaas.
                    {order.coupon_code && (
                      <p className="text-[11px] text-amber-600 mt-0.5">
                        (valor proporcional após desconto do cupom {order.coupon_code})
                      </p>
                    )}
                  </div>
                );
              })()}
              {order.payment_status !== 'paid' && order.asaas_charge_id && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-700">
                  ⚠ A cobrança Asaas ainda está com o valor original. Se o cliente ainda não pagou, cancele e gere nova cobrança após o ajuste.
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setCancelItemModal(false)}>Voltar</Button>
                <Button
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                  onClick={confirmCancelItem}
                  disabled={cancelItemLoading}
                >
                  {cancelItemLoading ? 'Cancelando...' : 'Confirmar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Cobrança Asaas */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-blue-600" /> Cobrança Asaas
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {order.asaas_charge_id ? (
            <div className="space-y-3">
              {/* Status + ações */}
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                    asaasStatus?.color === 'success' ? 'bg-green-100 text-green-700' :
                    asaasStatus?.color === 'danger'  ? 'bg-red-100 text-red-700' :
                    asaasStatus?.color === 'warning' ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
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
                      <a href={order.asaas_payment_link} target="_blank" rel="noreferrer">
                        <ExternalLink className="w-3.5 h-3.5 mr-1" /> Ver fatura
                      </a>
                    </Button>
                  )}
                  {/* Botão estornar — só aparece quando pago */}
                  {order.payment_status === 'paid' && (
                    <Button size="sm" variant="outline" className="text-amber-600 hover:text-amber-800 hover:bg-amber-50" onClick={() => { setRefundReason(''); setRefundReasonCustom(''); setRefundModal(true); }} disabled={asaasLoading}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Estornar
                    </Button>
                  )}
                  {/* Botão cancelar — só aparece quando não pago/estornado */}
                  {!['paid', 'refunded', 'cancelled'].includes(order.payment_status) && (
                    <Button size="sm" variant="outline" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={cancelAsaasCharge} disabled={asaasLoading}>
                      <X className="w-3.5 h-3.5 mr-1" /> Cancelar
                    </Button>
                  )}
                </div>
              </div>
              {/* PIX copia e cola */}
              {order.asaas_pix_copy && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><QrCode className="w-3.5 h-3.5" /> PIX Copia e Cola</p>
                  <div className="flex gap-2">
                    <input readOnly value={order.asaas_pix_copy} className="flex-1 text-xs font-mono bg-gray-50 border rounded-lg px-3 py-2 truncate" />
                    <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(order.asaas_pix_copy); toast.success('Copiado!'); }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}
              {/* Link fatura */}
              {order.asaas_payment_link && (
                <div className="flex items-center gap-2">
                  <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm text-blue-600 truncate flex-1">{order.asaas_payment_link}</span>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(order.asaas_payment_link); toast.success('Link copiado!'); }}>
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
              {/* Enviar WhatsApp */}
              <Button className="w-full bg-green-600 hover:bg-green-700 text-white gap-2" onClick={() => { setWhatsappMsg(buildMessage()); setCopied(false); setWhatsappModal(true); }}>
                <MessageCircle className="w-4 h-4" /> Enviar cobrança via WhatsApp
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Preferência do cliente */}
              {order.payment_method && (
                <div className="flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5">
                  <span className="text-blue-600">Cliente solicitou:</span>
                  <span className="font-semibold text-blue-900">{{
                    pix_boleto:'PIX ou Boleto', pix:'PIX', boleto:'Boleto',
                    card_1x:'Cartão 1x', card_2x:'Cartão 2x', card_3x:'Cartão 3x',
                    card_4x:'Cartão 4x', card_5x:'Cartão 5x', card_6x:'Cartão 6x',
                  }[order.payment_method] || order.payment_method}</span>
                </div>
              )}
              {/* CPF + Vencimento */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>CPF do cliente <span className="text-xs text-muted-foreground font-normal">(do perfil)</span></Label>
                  <Input className="mt-1 font-mono" placeholder="000.000.000-00" value={asaasCpf} onChange={e => setAsaasCpf(e.target.value)} />
                </div>
                <div>
                  <Label>Vencimento</Label>
                  <Input type="date" className="mt-1" value={asaasDueDate} onChange={e => setAsaasDueDate(e.target.value)} />
                </div>
              </div>
              {/* Seletor de método */}
              <div>
                <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">Forma de cobrança</Label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { key: 'PIX',         icon: <QrCode className="w-4 h-4" />,   label: 'PIX' },
                    { key: 'BOLETO',      icon: <FileText className="w-4 h-4" />, label: 'Boleto' },
                    { key: 'CREDIT_CARD', icon: <Zap className="w-4 h-4" />,      label: order.payment_method?.startsWith('card_') ? `Cartão (${order.payment_method.replace('card_', '')})` : 'Cartão' },
                  ].map(opt => (
                    <button key={opt.key} type="button" onClick={() => setAsaasBilling(opt.key)}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                        asaasBilling === opt.key
                          ? 'border-blue-500 bg-blue-500 text-white'
                          : 'border-gray-200 text-gray-600 hover:border-blue-300 bg-white'
                      }`}>
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
                        className={`py-2 rounded-lg border-2 text-sm font-semibold transition-all ${
                          asaasInstallments === n
                            ? 'border-blue-500 bg-blue-500 text-white'
                            : 'border-gray-200 text-gray-600 hover:border-blue-300 bg-white'
                        }`}>
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
              <div className="border-t pt-3">
                <Button
                  variant="outline"
                  className="w-full gap-2 text-green-700 border-green-300 hover:bg-green-50"
                  onClick={openManualPay}
                >
                  <HandCoins className="w-4 h-4" /> Registrar pagamento manual (sem Asaas)
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
              <Label>Forma de Pagamento</Label>
              <Select value={paymentMethod || 'none'} onValueChange={v => setPaymentMethod(v === 'none' ? '' : v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Não confirmado</SelectItem>
                  <SelectItem value="pix_boleto">PIX ou Boleto (preferência do cliente)</SelectItem>
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
          {/* Motivo do cancelamento — aparece quando status for cancelado ou reembolsado */}
          {['cancelled', 'refunded'].includes(paymentStatus) && (
            <div>
              <Label>Motivo do cancelamento / estorno</Label>
              <div className="grid grid-cols-2 gap-1.5 mt-1.5 mb-2">
                {CANCEL_REASONS.map(r => (
                  <button key={r} type="button" onClick={() => setCancellationReason(r)}
                    className={`text-left px-3 py-1.5 rounded-lg border text-sm transition-all ${
                      cancellationReason === r ? 'border-red-400 bg-red-50 text-red-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-600'
                    }`}>
                    {r}
                  </button>
                ))}
              </div>
              <Textarea
                placeholder="Detalhes do motivo (opcional)..."
                value={cancellationReason}
                onChange={e => setCancellationReason(e.target.value)}
                rows={2}
                className="mt-1"
              />
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
            <Textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} className="mt-1" rows={3} placeholder="Anotações internas sobre o pedido..." />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSaveClick} disabled={saving}>{saving ? 'Salvando...' : 'Salvar alterações'}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Modal de pagamento manual */}
      <Dialog open={manualPayModal} onOpenChange={setManualPayModal}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="w-4 h-4 text-green-600" /> Registrar pagamento manual
            </DialogTitle>
          </DialogHeader>
          <ManualPaymentForm
            form={manualPayForm}
            setForm={setManualPayForm}
            methodGroups={methodGroups}
            saving={manualPaySaving}
            onSave={recordManualPayment}
            onCancel={() => setManualPayModal(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Modal de confirmação de status sensível */}
      <Dialog open={saveConfirmModal} onOpenChange={setSaveConfirmModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> Confirmar mudança de status
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-3 py-2">
              <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${order?.payment_status === 'paid' ? 'bg-green-100 text-green-700' : order?.payment_status === 'cancelled' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>
                {PAYMENT_STATUS[order?.payment_status]?.label || order?.payment_status}
              </span>
              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${paymentStatus === 'paid' ? 'bg-green-100 text-green-700' : paymentStatus === 'cancelled' ? 'bg-red-100 text-red-700' : paymentStatus === 'refunded' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>
                {PAYMENT_STATUS[paymentStatus]?.label || paymentStatus}
              </span>
            </div>
            <p className="text-sm text-center text-muted-foreground">Tem certeza? Todas as alterações do formulário serão salvas.</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setSaveConfirmModal(false)} disabled={saving}>Cancelar</Button>
              <Button className="flex-1" onClick={handleSave} disabled={saving}>{saving ? 'Salvando...' : 'Confirmar e salvar'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
