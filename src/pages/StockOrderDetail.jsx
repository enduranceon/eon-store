import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, Package, MessageCircle, Copy, Check, ExternalLink, Zap, QrCode, Link2, FileText, X, RotateCcw, AlertTriangle, Tag, HandCoins, Calendar } from 'lucide-react';
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
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { loadActivePaymentMethods, calcFee, createManualInstallments, adjustManualInstallmentsValue } from '@/lib/manual-payment';
import { defaultAsaasDueDate, defaultPaymentDueDate } from '@/lib/payment-methods';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import DiscountInput from '@/components/DiscountInput';
import { toast } from 'sonner';
import { returnCouponUse } from '@/lib/coupon';

const PAYMENT_STATUS = {
  awaiting_charge: { label: 'Pedido recebido', badge: 'secondary' },
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
  const [whatsappManualLink, setWhatsappManualLink] = useState('');
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
  const [asaasDueDate, setAsaasDueDate] = useState(defaultAsaasDueDate);

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

  // Pagamento manual
  const [manualPayModal, setManualPayModal] = useState(false);
  const [manualPaySaving, setManualPaySaving] = useState(false);
  const [manualPayForm, setManualPayForm] = useState({ method_id: '', date: '', value: '' });
  const [methodGroups, setMethodGroups]   = useState([]);
  // Reabrir pagamento
  const [reopenModal, setReopenModal] = useState(false);
  const [reopenLoading, setReopenLoading] = useState(false);
  // Parcelas projetadas
  const [paymentInstallments, setPaymentInstallments] = useState([]);

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

      // Carrega parcelas projetadas
      supabase.from('asaas_payments')
        .select('*')
        .eq('order_id', id)
        .eq('order_type', 'stock')
        .order('installment_number', { ascending: true })
        .then(({ data }) => setPaymentInstallments(data || []))
        .catch(() => setPaymentInstallments([]));
    } catch (e) {
      toast.error('Pedido não encontrado');
      navigate('/estoque/pedidos');
    }
  };

  useEffect(() => { load(); }, [id]);

  // Salva apenas campos de entrega e observações. Pagamento muda só via ações.
  const handleSave = async () => {
    setSaving(true);
    try {
      await StockOrder.update(id, {
        delivery_status: deliveryStatus,
        delivery_date:   deliveryDate || null,
        internal_notes:  internalNotes,
      });
      toast.success('Atualizações salvas!');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const openManualPay = async () => {
    const total = order?.total_value ? Number(order.total_value).toFixed(2) : '';
    try {
      const groups = await loadActivePaymentMethods();
      setMethodGroups(groups);
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
      // 1. Marca como pago com os dados do método
      await StockOrder.update(id, {
        payment_status: 'paid',
        payment_method: method.internal_code || method.kind,
        payment_date:   manualPayForm.date,
        manual_payment: true,
        manual_fee:     fee > 0 ? Math.round(fee * 100) / 100 : null,
      });
      // 2. Cria parcelas projetadas no fluxo de caixa
      const result = await createManualInstallments(
        method, manualPayForm.date,
        { order_id: id, order_type: 'stock', external_reference: order?.order_number },
        totalV,
      );
      toast.success(`Pagamento registrado!${result.installments > 1 ? ` ${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar pagamento');
    } finally {
      setManualPaySaving(false);
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
      await returnCouponUse(id, 'stock');
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
      await returnCouponUse(id, 'stock');
      setRefundModal(false);
      toast.success('Estorno realizado com sucesso!');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao estornar'); }
  };

  const PAYMENT_METHOD_LABEL = {
    pix_boleto: 'PIX ou Boleto', pix: 'PIX', pix_manual: 'PIX', boleto: 'Boleto',
    cash: 'Dinheiro', bank_transfer: 'Transferência bancária',
    card_1x: 'Cartão 1x', card_2x: 'Cartão 2x', card_3x: 'Cartão 3x',
    card_4x: 'Cartão 4x', card_5x: 'Cartão 5x', card_6x: 'Cartão 6x',
    card_7x: 'Cartão 7x', card_8x: 'Cartão 8x', card_9x: 'Cartão 9x',
    card_10x: 'Cartão 10x', card_11x: 'Cartão 11x', card_12x: 'Cartão 12x',
  };

  const buildMessage = (manualLink = '') => {
    if (!order) return '';
    const itemLines = (order.items || []).filter(it => !it.cancelled).map(item => {
      const label = item.variation ? `${item.product_name} - ${item.variation}` : item.product_name;
      return `• ${label} x${item.quantity} → ${formatCurrency((item.sale_price || 0) * item.quantity)}`;
    }).join('\n');
    const total = order.total_value || 0;
    const trackingLink = `${window.location.origin}/p/${order.id}`;
    const trackingLine = `\n\n🔍 *Acompanhe seu pedido:*\n${trackingLink}`;

    // Modo Asaas: tem link ou PIX do gateway
    const chargeLink = order.asaas_payment_link;
    const pixCopy    = order.asaas_pix_copy;
    if (chargeLink || pixCopy) {
      return (
        `Olá, ${order.customer_name}! 👋\n\n` +
        `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
        `📦 *Itens:*\n${itemLines}\n\n` +
        `💰 *Total: ${formatCurrency(total)}*\n\n` +
        (pixCopy ? `📲 *PIX Copia e Cola:*\n\`${pixCopy}\`\n\n` : '') +
        (chargeLink ? `🔗 *Link de pagamento:*\n${chargeLink}` : '') +
        trackingLine
      );
    }

    // Modo manual com link externo
    const payLabel = PAYMENT_METHOD_LABEL[order.payment_method] || order.payment_method || null;
    const linkTrim = manualLink?.trim();
    if (linkTrim) {
      return (
        `Olá, ${order.customer_name}! 👋\n\n` +
        `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
        `📦 *Itens:*\n${itemLines}\n\n` +
        `💰 *Total: ${formatCurrency(total)}*\n\n` +
        (payLabel ? `💳 *Forma de pagamento:* ${payLabel}\n\n` : '') +
        `🔗 *Link de pagamento:*\n${linkTrim}` +
        trackingLine
      );
    }

    // Sem link — mensagem informativa
    if (payLabel) {
      return (
        `Olá, ${order.customer_name}! 👋\n\n` +
        `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
        `📦 *Itens:*\n${itemLines}\n\n` +
        `💰 *Total: ${formatCurrency(total)}*\n\n` +
        `💳 *Forma de pagamento:* ${payLabel}\n\n` +
        `Em breve envio o link/QR para você finalizar o pagamento. 👍` +
        trackingLine
      );
    }

    // Fallback: sem preferência de pagamento registrada
    return (
      `Olá, ${order.customer_name}! 👋\n\n` +
      `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
      `📦 *Itens:*\n${itemLines}\n\n` +
      `💰 *Total: ${formatCurrency(total)}*\n\n` +
      `Como você prefere pagar?\n• PIX (à vista) — ${formatCurrency(total)}\n• Cartão (em até 12x)` +
      trackingLine
    );
  };

  const openWhatsApp = () => {
    const savedExternalLink = order.external_payment_link || '';
    setWhatsappManualLink(savedExternalLink);
    setWhatsappMsg(buildMessage(savedExternalLink));
    setCopied(false);
    setWhatsappModal(true);
  };
  const copyMessage = () => { navigator.clipboard.writeText(whatsappMsg).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  const openWhatsAppDirect = () => { window.open(`https://wa.me/55${(order.customer_whatsapp || '').replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMsg)}`, '_blank'); };

  const markMessageSent = async () => {
    try {
      const updates = { payment_message_sent_at: new Date().toISOString() };
      if (!order.asaas_charge_id) {
        updates.external_payment_link = whatsappManualLink.trim() || null;
        if (!order.due_date) {
          updates.due_date = defaultPaymentDueDate();
        }
        if (['awaiting_charge', 'pending'].includes(order.payment_status)) {
          updates.payment_status = 'message_sent';
        }
      }
      await StockOrder.update(id, updates);
      toast.success('Mensagem marcada como enviada!');
      setWhatsappModal(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  // Atalho: reabre pagamento manual e prepara fluxo de cobrança Asaas.
  const convertToAsaas = async () => {
    await reopenPayment();
    setAsaasBilling('PIX');
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
  };

  // Reabre pagamento manual: desfaz o registro e volta a awaiting_charge.
  const reopenPayment = async () => {
    setReopenLoading(true);
    try {
      await supabase.from('asaas_payments')
        .delete()
        .eq('order_id', id)
        .eq('order_type', 'stock')
        .eq('source', 'manual');
      await StockOrder.update(id, {
        payment_status: 'awaiting_charge',
        payment_date:   null,
        payment_method: null,
        manual_payment: false,
        manual_fee:     null,
      });
      toast.success('Pagamento revertido. Pedido voltou para "Pedido recebido".');
      setReopenModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao reabrir pagamento');
    } finally {
      setReopenLoading(false);
    }
  };

  if (!order) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const ps = PAYMENT_STATUS[order.payment_status] || { label: order.payment_status, badge: 'secondary' };
  const ds = DELIVERY_STATUS[order.delivery_status] || { label: order.delivery_status, badge: 'secondary' };
  const items = order.items || [];

  const openCancelItem = (index) => {
    setCancelItemIndex(index);
    setCancelItemDelivered(order.delivery_status === 'delivered');
    setCancelItemReason('');
    setCancelItemModal(true);
  };

  const confirmCancelItem = async () => {
    const item = items[cancelItemIndex];
    const itemPrice = (item.sale_price || 0) * item.quantity;

    // Calcula novo estado dos itens
    const newItems = items.map((it, i) =>
      i === cancelItemIndex ? { ...it, cancelled: true, cancelled_at: new Date().toISOString() } : it
    );
    const activeItems = newItems.filter(it => !it.cancelled);
    const newSubtotal = activeItems.reduce((sum, it) => sum + (it.sale_price || 0) * it.quantity, 0);

    // Recalcula desconto de cupom proporcionalmente
    const oldDiscount = Number(order.discount_value) || 0;
    const oldSubtotal = (order.total_value || 0) + oldDiscount;
    let newDiscount = 0;
    if (oldDiscount > 0 && oldSubtotal > 0) {
      newDiscount = Math.round((newSubtotal * (oldDiscount / oldSubtotal)) * 100) / 100;
      newDiscount = Math.min(newDiscount, newSubtotal);
    }
    const newTotal = Math.max(0, newSubtotal - newDiscount);
    const refundValue = Math.max(0, (order.total_value || 0) - newTotal);
    const allCancelled = activeItems.length === 0;
    const newPaymentStatus = allCancelled
      ? (order.payment_status === 'paid' ? 'refunded' : 'cancelled')
      : order.payment_status;

    setCancelItemLoading(true);
    try {
      // 1. Asaas PRIMEIRO — se falhar, nada é alterado no DB
      if (order.payment_status === 'paid' && order.asaas_charge_id && refundValue > 0) {
        await callAsaas('refund', { value: refundValue, reason: cancelItemReason || 'Cancelamento de peça' });
      }

      // 3. Atualiza pedido
      await supabase.from('stock_orders').update({
        items: newItems,
        total_value: newTotal,
        discount_value: newDiscount,
        ...(allCancelled ? { payment_status: newPaymentStatus } : {}),
      }).eq('id', id);

      // 3b. Se o pagamento foi manual, recalcula parcelas em asaas_payments
      if (order.manual_payment && !allCancelled) {
        await adjustManualInstallmentsValue(
          { order_id: id, order_type: 'stock' },
          newTotal,
        );
      }

      // 4. Reposição automática de estoque se não foi entregue
      if (!cancelItemDelivered && item.product_id) {
        const { data: prod } = await supabase
          .from('stock_products').select('quantity').eq('id', item.product_id).single();
        if (prod) {
          await supabase.from('stock_products')
            .update({ quantity: (prod.quantity || 0) + item.quantity })
            .eq('id', item.product_id);
        }
      }

      // 5. Registra devolução
      await supabase.from('order_returns').insert({
        order_id: id,
        order_type: 'stock',
        order_number: order.order_number,
        customer_name: order.customer_name,
        item_index: cancelItemIndex,
        product_id: item.product_id || null,
        product_name: item.product_name,
        variation: item.variation || null,
        quantity: item.quantity,
        unit_price: item.sale_price || 0,
        refund_value: refundValue,
        was_delivered: cancelItemDelivered,
        status: cancelItemDelivered ? 'pending_return' : 'completed',
        notes: cancelItemReason || null,
      });

      // 6. Se todas as peças foram canceladas, devolve uso de cupom
      if (allCancelled) await returnCouponUse(id, 'stock');

      setCancelItemModal(false);
      const stockMsg = !cancelItemDelivered && item.product_id ? ' Estoque reposto automaticamente.' : '';
      toast.success(cancelItemDelivered ? 'Peça cancelada — aguardando devolução física.' : `Peça cancelada.${stockMsg}`);
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
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item, i) => (
                    <tr key={i} className={item.cancelled ? 'opacity-50' : ''}>
                      <td className="py-2 font-medium">
                        <span className={item.cancelled ? 'line-through text-muted-foreground' : ''}>
                          {item.product_name}{item.variation ? ` — ${item.variation}` : ''}
                        </span>
                        {item.cancelled && <span className="ml-2 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium">Cancelado</span>}
                      </td>
                      <td className="py-2 text-right">{item.quantity}</td>
                      <td className="py-2 text-right">{formatCurrency(item.sale_price)}</td>
                      <td className="py-2 text-right font-semibold">{formatCurrency((item.sale_price || 0) * item.quantity)}</td>
                      <td className="py-2 text-right">
                        {!item.cancelled && !['cancelled', 'refunded'].includes(order.payment_status) && (
                          <button onClick={() => openCancelItem(i)} className="text-xs text-red-500 hover:text-red-700 hover:underline whitespace-nowrap">
                            Cancelar peça
                          </button>
                        )}
                      </td>
                    </tr>
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
          <div className={`${order.coupon_code ? 'pt-3' : 'border-t mt-4 pt-4'} text-right`}>
            <span className="text-sm text-muted-foreground mr-3">Total do pedido</span>
            <span className="font-bold text-lg">{formatCurrency(order.total_value)}</span>
            {order.coupon_code && (
              <p className="text-[10px] text-muted-foreground mt-0.5">já com desconto aplicado</p>
            )}
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
        entityType="stock_order"
        entityId={order.id}
        onSave={async (newValue, reason) => {
          // Recalcula total_value: subtotal_items - cupom - manual
          const activeItems = (order.items || []).filter(it => !it.cancelled);
          const subItens = activeItems.reduce((s, it) => s + (it.sale_price || 0) * it.quantity, 0);
          const cupom = Number(order.discount_value) || 0;
          const newTotal = Math.max(0, subItens - cupom - newValue);
          await StockOrder.update(order.id, {
            manual_discount: newValue,
            discount_reason: reason || null,
            total_value:     newTotal,
          });
          // Recalcula parcelas manuais se já estava pago manualmente
          if (order.manual_payment && order.payment_status === 'paid') {
            await adjustManualInstallmentsValue(
              { order_id: order.id, order_type: 'stock' },
              newTotal,
            );
          }
          await load();
        }}
      />

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

      {/* Modal WhatsApp */}
      <Dialog open={whatsappModal} onOpenChange={setWhatsappModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-600" /> Mensagem de cobrança
            </DialogTitle>
          </DialogHeader>

          {/* Badge indicando o modo */}
          {order.asaas_charge_id ? (
            <div className="flex items-center gap-2 text-xs bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              <Zap className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span className="text-blue-800"><strong>Cobrança Asaas</strong> — link/PIX incluído automaticamente na mensagem</span>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <Link2 className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="text-amber-800">Sem cobrança Asaas — você pode inserir um link externo abaixo (Stone, PagSeguro, etc.)</span>
              </div>
              <div>
                <Label className="text-xs">Link de cobrança externo (opcional)</Label>
                <Input
                  className="mt-1 font-mono text-xs"
                  placeholder="https://..."
                  value={whatsappManualLink}
                  onChange={e => {
                    setWhatsappManualLink(e.target.value);
                    setWhatsappMsg(buildMessage(e.target.value));
                    setCopied(false);
                  }}
                />
              </div>
            </div>
          )}

          {/* Preview da mensagem */}
          <div className="bg-gray-50 rounded-xl p-4 text-sm whitespace-pre-wrap font-mono border max-h-64 overflow-y-auto">
            {whatsappMsg}
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={copyMessage}>
              {copied ? <><Check className="w-4 h-4 mr-1.5 text-green-600" />Copiado!</> : <><Copy className="w-4 h-4 mr-1.5" />Copiar</>}
            </Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsAppDirect}>
              <ExternalLink className="w-4 h-4 mr-1.5" /> Abrir no WhatsApp
            </Button>
          </div>
          {order.payment_status === 'awaiting_charge' && (
            <Button className="w-full bg-orange-500 hover:bg-orange-600 text-white" onClick={markMessageSent}>
              <Check className="w-4 h-4 mr-1.5" /> Efetivar venda externa enviada
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

      {/* Modal cancelar peça individual */}
      <Dialog open={cancelItemModal} onOpenChange={setCancelItemModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600"><X className="w-5 h-5" /> Cancelar peça</DialogTitle>
          </DialogHeader>
          {cancelItemIndex !== null && items[cancelItemIndex] && (
            <div className="space-y-4">
              <div className="bg-gray-50 border rounded-xl px-4 py-3 text-sm">
                <p className="font-semibold">{items[cancelItemIndex].product_name}</p>
                {items[cancelItemIndex].variation && <p className="text-muted-foreground">{items[cancelItemIndex].variation}</p>}
                <p className="text-muted-foreground mt-1">
                  Qtd: {items[cancelItemIndex].quantity} × {formatCurrency(items[cancelItemIndex].sale_price)}
                  {' = '}<span className="font-semibold text-gray-800">{formatCurrency((items[cancelItemIndex].sale_price || 0) * items[cancelItemIndex].quantity)}</span>
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
                {!cancelItemDelivered && items[cancelItemIndex]?.product_id && (
                  <p className="text-xs text-blue-600 mt-1.5">✓ Estoque será reposto automaticamente.</p>
                )}
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
                const itemPrice = (items[cancelItemIndex].sale_price || 0) * items[cancelItemIndex].quantity;
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

      {/* Cobrança Asaas — só aparece se ainda há ação a tomar */}
      {!['paid', 'refunded', 'cancelled'].includes(order.payment_status) && (
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
              {order.external_payment_link && (
                <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <Link2 className="w-4 h-4 text-amber-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-amber-800">Link externo salvo</p>
                    <p className="text-sm text-amber-700 truncate">{order.external_payment_link}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(order.external_payment_link); toast.success('Link copiado!'); }}>
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
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
              <div className="relative flex items-center gap-3 py-1">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">ou</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
              <Button variant="outline" className="w-full gap-2 border-green-300 text-green-700 hover:bg-green-50" onClick={openManualPay}>
                <HandCoins className="w-4 h-4" /> Registrar pagamento manual (sem Asaas)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Aviso simples para pedidos cancelados */}
      {order.payment_status === 'cancelled' && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3 px-4 flex items-center gap-2 text-sm">
            <X className="w-4 h-4 text-red-600 shrink-0" />
            <span className="text-red-800">
              <strong>Pedido cancelado.</strong>
              {order.cancellation_reason && ` Motivo: ${order.cancellation_reason}`}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Status do pagamento (read-only + detalhamento) */}
      {['paid', 'refunded'].includes(order.payment_status) && (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            Status do pagamento
            <Badge variant={ps.badge}>{ps.label}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(() => {
              const activeInstallments = paymentInstallments.filter(p => !['CANCELLED','REFUNDED'].includes(p.status));
              const totalGross = activeInstallments.reduce((s,p) => s + (Number(p.value) || 0), 0);
              const totalNet   = activeInstallments.reduce((s,p) => s + (Number(p.net_value) || 0), 0);
              const totalFee   = totalGross - totalNet;
              const registeredAt = activeInstallments[0]?.last_synced_at || activeInstallments[0]?.created_at
                                || paymentInstallments[0]?.last_synced_at || paymentInstallments[0]?.created_at;
              const sourceLabel  = order.manual_payment ? 'Registro manual' : 'Cobrança Asaas';
              const sourceBadgeColor = order.manual_payment ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700';
              const isRefunded = order.payment_status === 'refunded';
              const blockColors = isRefunded
                ? { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', valueText: 'text-purple-800' }
                : { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700',  valueText: 'text-green-800' };
              return (
                <>
                  <div className={`${blockColors.bg} border ${blockColors.border} rounded-xl p-3 space-y-2`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className={`text-xs ${blockColors.text} font-medium uppercase tracking-wide`}>
                          {isRefunded ? 'Estornado' : 'Pago'}
                        </p>
                        <p className={`text-lg font-bold ${blockColors.valueText} mt-0.5`}>
                          {formatCurrency(order.total_value)}
                        </p>
                        <p className={`text-xs ${blockColors.text} mt-0.5`}>
                          {PAYMENT_METHOD_LABEL[order.payment_method] || order.payment_method}
                          {' · '}
                          <span className="font-medium">{order.payment_date ? formatDate(order.payment_date) : '—'}</span>
                        </p>
                      </div>
                      <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full ${sourceBadgeColor}`}>
                        {sourceLabel}
                      </span>
                    </div>
                    {registeredAt && (
                      <p className={`text-[11px] ${blockColors.text} flex items-center gap-1`}>
                        <Calendar className="w-3 h-3" />
                        Registrado em {new Date(registeredAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                      </p>
                    )}
                    {isRefunded && order.cancellation_reason && (
                      <p className={`text-[11px] ${blockColors.text}`}>
                        <strong>Motivo:</strong> {order.cancellation_reason}
                      </p>
                    )}
                  </div>

                    {(totalFee > 0 || totalGross > 0) && (
                      <div className="grid grid-cols-3 gap-2 text-center text-sm">
                        <div className="bg-gray-50 border rounded-lg py-2">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Bruto</p>
                          <p className="font-semibold mt-0.5">{formatCurrency(totalGross)}</p>
                        </div>
                        <div className="bg-gray-50 border rounded-lg py-2">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Taxa</p>
                          <p className="font-semibold mt-0.5 text-red-600">−{formatCurrency(totalFee)}</p>
                        </div>
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg py-2">
                          <p className="text-[10px] text-emerald-700 uppercase tracking-wide">Líquido</p>
                          <p className="font-bold mt-0.5 text-emerald-700">{formatCurrency(totalNet)}</p>
                        </div>
                      </div>
                    )}

                    {activeInstallments.length > 0 && (
                      <div className="border rounded-xl overflow-hidden">
                        <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" />
                          {activeInstallments.length === 1
                            ? 'Recebimento no fluxo de caixa'
                            : `${activeInstallments.length} parcelas no fluxo de caixa`}
                        </div>
                        <div className="divide-y">
                          {activeInstallments.map(p => {
                            const isPaid = ['RECEIVED','CONFIRMED','RECEIVED_IN_CASH'].includes(p.status);
                            const isPast = p.credit_date && new Date(p.credit_date) <= new Date();
                            return (
                              <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                                <span className="text-xs font-bold text-muted-foreground w-12 shrink-0">
                                  {activeInstallments.length === 1 ? '1x' : `${p.installment_number}/${p.total_installments || activeInstallments.length}`}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-gray-700">
                                    {p.credit_date ? formatDate(p.credit_date) : '—'}
                                    {isPast && isPaid && <span className="ml-1.5 text-[10px] text-emerald-600 font-medium">✓ creditado</span>}
                                    {!isPast && <span className="ml-1.5 text-[10px] text-blue-600">a receber</span>}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p className="font-semibold text-sm">{formatCurrency(p.net_value || p.value || 0)}</p>
                                  {Number(p.value) !== Number(p.net_value) && (
                                    <p className="text-[10px] text-muted-foreground">bruto {formatCurrency(p.value)}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

          {order.payment_status === 'paid' && order.manual_payment && (
            <div className="pt-3 border-t space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-blue-700 border-blue-300 hover:bg-blue-50"
                  onClick={convertToAsaas}
                  disabled={reopenLoading}
                >
                  <Zap className="w-3.5 h-3.5 mr-1.5" /> Converter pra cobrança Asaas
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-amber-700 border-amber-300 hover:bg-amber-50"
                  onClick={() => setReopenModal(true)}
                  disabled={reopenLoading}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reabrir pagamento
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                <strong>Converter:</strong> desfaz o registro manual e prepara o card pra gerar cobrança Asaas. ·{' '}
                <strong>Reabrir:</strong> só desfaz (use se foi erro de registro).
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Entrega + observações */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Entrega e observações</CardTitle></CardHeader>
        <CardContent className="space-y-4">
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

      {/* Modal de reabrir pagamento */}
      <Dialog open={reopenModal} onOpenChange={open => !open && !reopenLoading && setReopenModal(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <RotateCcw className="w-5 h-5" /> Reabrir pagamento
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <p className="font-semibold text-amber-900">Atenção</p>
              <p className="text-amber-800 mt-1">Isso vai <strong>desfazer</strong> o registro de pagamento manual:</p>
              <ul className="mt-2 ml-4 text-xs text-amber-700 list-disc space-y-0.5">
                <li>Apaga as parcelas projetadas no fluxo de caixa</li>
                <li>Status volta para <strong>Pedido recebido</strong></li>
                <li>Forma, data e taxa são removidos</li>
              </ul>
              <p className="text-xs text-amber-700 mt-2">
                Use só se foi um registro errado.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setReopenModal(false)} disabled={reopenLoading}>Voltar</Button>
              <Button className="flex-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={reopenPayment} disabled={reopenLoading}>
                {reopenLoading ? 'Revertendo...' : 'Confirmar reabertura'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
