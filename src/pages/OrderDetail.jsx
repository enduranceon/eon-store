import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, User, Phone, Mail, Package, Calendar, FileText, MessageCircle, Copy, Check, ExternalLink, Zap, QrCode, Link2, X, RotateCcw, AlertTriangle, Tag, ArrowRight, HandCoins, ChevronRight, Pencil, Plus, Minus, Info, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { PreSaleOrder, PreSaleCampaign, PreSaleCustomer, PreSaleProduct } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { loadActivePaymentMethods, createManualInstallments, adjustManualInstallmentsValue } from '@/lib/manual-payment';
import { isSafePaymentUrl, publicTrackingToken } from '@/lib/sales';
import { phoneDigitsForWhatsApp } from '@/lib/phone';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import DiscountInput from '@/components/DiscountInput';
import { defaultAsaasDueDate, defaultPaymentDueDate } from '@/lib/payment-methods';
import { toast } from 'sonner';
import { returnCouponUse } from '@/lib/coupon';

const PAYMENT_STATUS = {
  pending: { label: 'Pedido recebido', badge: 'secondary' },
  awaiting_charge: { label: 'Pedido recebido', badge: 'secondary' },
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

// Motivos para cancelar/trocar uma cobrança já gerada (volta o pedido para "Aguardando cobrança")
const CHARGE_CANCEL_REASONS = [
  'Cliente pediu outra forma de pagamento',
  'Aplicar desconto / ajustar valor',
  'Link ou valor incorreto',
  'Cliente desistiu da compra',
  'Outro',
];

// Rótulo + cor do marcador para cada ação no histórico da venda
function SALE_EVENT_META(ev) {
  const byAction = {
    asaas_charge_created: { label: 'Cobrança Asaas gerada',  dot: 'bg-blue-500' },
    charge_sent:          { label: 'Cobrança enviada',       dot: 'bg-green-500' },
    charge_resent:        { label: 'Cobrança reenviada',     dot: 'bg-green-500' },
    charge_cancelled:     { label: 'Cobrança cancelada',     dot: 'bg-red-500' },
    order_cancelled:      { label: 'Pedido cancelado',       dot: 'bg-red-600' },
    refunded:             { label: 'Pagamento estornado',    dot: 'bg-purple-500' },
  };
  const byStatus = {
    awaiting_charge: { label: 'Aguardando cobrança', dot: 'bg-gray-400' },
    charge_sent:     { label: 'Cobrança enviada',    dot: 'bg-green-500' },
    paid:            { label: 'Pagamento confirmado', dot: 'bg-green-600' },
    cancelled:       { label: 'Pedido cancelado',    dot: 'bg-red-600' },
    refunded:        { label: 'Pagamento estornado', dot: 'bg-purple-500' },
  };
  return byAction[ev.metadata?.action]
      || byStatus[ev.new_status]
      || { label: ev.reason || ev.new_status || 'Atualização', dot: 'bg-gray-400' };
}

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
  // Accordion do card Pagamento: 'asaas' | 'whatsapp' | 'manual' | null
  const [payAction, setPayAction] = useState(null);
  // Modal de "Enviar comprovante após pagamento manual"
  const [postPayWhatsModal, setPostPayWhatsModal] = useState(false);
  // Modal de "Reabrir pagamento" (reverter pagamento manual)
  const [reopenModal, setReopenModal] = useState(false);
  const [reopenLoading, setReopenLoading] = useState(false);
  // Parcelas projetadas (asaas_payments) — mostra detalhamento do pagamento
  const [paymentInstallments, setPaymentInstallments] = useState([]);
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
  const [editPayMethodModal, setEditPayMethodModal] = useState(false);
  const [editPayMethodValue, setEditPayMethodValue] = useState('');
  const [editPayMethodDate, setEditPayMethodDate] = useState('');
  const [editPayMethodSaving, setEditPayMethodSaving] = useState(false);
  // Cancelar pedido inteiro
  const [cancelOrderModal, setCancelOrderModal] = useState(false);
  const [cancelOrderReason, setCancelOrderReason] = useState('');
  const [cancelOrderReasonCustom, setCancelOrderReasonCustom] = useState('');
  const [cancelOrderLoading, setCancelOrderLoading] = useState(false);
  // Cancelar/trocar cobrança (volta para aguardando cobrança)
  const [cancelChargeLoading, setCancelChargeLoading] = useState(false);
  // Vencimento escolhido ao enviar/registrar cobrança externa
  const [whatsappDueDate, setWhatsappDueDate] = useState('');
  // Histórico de ações da venda (sales_status_events)
  const [saleEvents, setSaleEvents] = useState([]);
  // Adicionar peça
  const [campaignProducts, setCampaignProducts] = useState([]);
  const [addItemModal, setAddItemModal] = useState(false);
  const [addItemSearch, setAddItemSearch] = useState('');
  const [addItemProductId, setAddItemProductId] = useState('');
  const [addItemVariation, setAddItemVariation] = useState('');
  const [addItemQuantity, setAddItemQuantity] = useState(1);
  const [addItemExtras, setAddItemExtras] = useState([]);
  const [addItemLoading, setAddItemLoading] = useState(false);

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
    if (o.campaign_id) {
      PreSaleCampaign.get(o.campaign_id).then(setCampaign).catch(() => {});
      // Produtos podem estar vinculados via campaign_id (single) OU campaign_ids (array uuid[])
      supabase
        .from('presale_products')
        .select('*')
        .eq('status', 'active')
        .or(`campaign_id.eq.${o.campaign_id},campaign_ids.cs.{${o.campaign_id}}`)
        .then(({ data }) => setCampaignProducts(data || []))
        .catch(() => setCampaignProducts([]));
    }
    if (o.customer_id) PreSaleCustomer.get(o.customer_id).then(c => {
      setCustomer(c);
      if (c.cpf) setAsaasCpf(c.cpf);
    }).catch(() => {});

    // Carrega parcelas projetadas (asaas_payments) — só "ativas"
    supabase.from('asaas_payments')
      .select('*')
      .eq('order_id', id)
      .eq('order_type', 'presale')
      .order('installment_number', { ascending: true })
      .then(({ data }) => setPaymentInstallments(data || []))
      .catch(() => setPaymentInstallments([]));

    // Histórico de ações da venda (cobranças geradas, canceladas, etc.)
    supabase.from('sales_status_events')
      .select('*')
      .eq('order_type', 'presale')
      .eq('order_id', id)
      .order('created_at', { ascending: false })
      .then(({ data }) => setSaleEvents(data || []))
      .catch(() => setSaleEvents([]));
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
    if (order?.asaas_charge_id) return toast.error('Cancele a cobrança Asaas antes de registrar pagamento por fora');

    setManualPaySaving(true);
    try {
      const totalV = Number(manualPayForm.value);
      const orderTotal = Number(order?.total_value) || 0;
      if (Math.abs(totalV - orderTotal) > 0.009) {
        throw new Error('Pagamento parcial ainda não está habilitado. Informe o valor integral do pedido.');
      }
      const result = await createManualInstallments(
        method, manualPayForm.date,
        { order_id: id, order_type: 'presale', external_reference: order?.order_number },
        totalV,
      );
      toast.success(`Pagamento registrado!${result.installments > 1 ? ` ${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      // Sugere enviar comprovante via WhatsApp (só se tem WhatsApp do cliente)
      if (order?.checkout_whatsapp) {
        setPostPayWhatsModal(true);
      }
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar pagamento');
    } finally {
      setManualPaySaving(false);
    }
  };

  // Atalho do modal de WhatsApp manual → registrar pagamento
  const switchToManualPay = () => {
    setWhatsappModal(false);
    openManualPay();
  };

  // Confirma envio de comprovante após pagamento manual
  const sendPaymentConfirmation = () => {
    setPostPayWhatsModal(false);
    const msg =
      `Olá, ${order.checkout_name}! 👋\n\n` +
      `Confirmamos o recebimento do pagamento do seu pedido *${order.order_number}*!\n\n` +
      `💰 Valor: ${formatCurrency(order.total_value || 0)}\n` +
      `📅 Pago em: ${formatDate(manualPayForm.date || todayLocalStr())}\n\n` +
      `Em breve seu pedido será preparado para entrega. Qualquer dúvida, estamos por aqui!\n\n` +
      `🔍 *Acompanhe seu pedido:*\n${window.location.origin}/p/${publicTrackingToken(order)}`;
    const phone = phoneDigitsForWhatsApp(order.checkout_whatsapp);
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  // Salva apenas campos de entrega e observações.
  // Pagamento (status/método/data) só muda via ações específicas:
  //   - Registrar pagamento manual
  //   - Cancelar Asaas / Estornar
  //   - Reabrir pagamento
  const handleSaveClick = () => handleSave();
  const handleSave = async () => {
    setSaving(true);
    try {
      await PreSaleOrder.update(id, {
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

  const handleSavePaymentMethod = async () => {
    if (!editPayMethodValue) return toast.error('Selecione uma forma de pagamento');
    if (!editPayMethodDate) return toast.error('Informe a data de pagamento');
    setEditPayMethodSaving(true);
    try {
      // Busca a config do método pelo internal_code
      const { data: methods, error: mErr } = await supabase
        .from('payment_methods')
        .select('*')
        .eq('internal_code', editPayMethodValue)
        .eq('active', true)
        .limit(1);
      if (mErr) throw mErr;
      const methodConfig = methods?.[0];
      if (!methodConfig) throw new Error('Método de pagamento não encontrado');

      // Cria parcelas no fluxo de caixa (substitui qualquer registro anterior)
      await createManualInstallments(methodConfig, editPayMethodDate, {
        order_id:   order.id,
        order_type: 'presale',
      }, Number(order.total_value) || 0);

      toast.success('Forma de pagamento salva!');
      setEditPayMethodModal(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setEditPayMethodSaving(false);
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

  // Registra uma ação no histórico da venda (sales_status_events)
  const logSaleEvent = async (newStatus, reason, metadata = {}) => {
    try {
      await supabase.from('sales_status_events').insert({
        order_type:      'presale',
        order_id:        id,
        previous_status: order?.payment_status || null,
        new_status:      newStatus,
        reason,
        metadata,
      });
    } catch (e) {
      console.warn('[sales_status_events] falha ao registrar:', e.message);
    }
  };

  const createAsaasCharge = async (billingType) => {
    const cpf = asaasCpf.replace(/\D/g, '');
    if (cpf.length < 11) return toast.error('Informe o CPF do cliente (11 dígitos)');
    try {
      await callAsaas('create', { cpf: asaasCpf, billing_type: billingType, due_date: asaasDueDate, installments: asaasInstallments });
      await supabase.from('presale_orders').update({ due_date: asaasDueDate }).eq('id', id);
      await logSaleEvent('charge_sent', 'Cobrança Asaas gerada', {
        action:       'asaas_charge_created',
        billing_type: billingType,
        installments: billingType === 'CREDIT_CARD' ? asaasInstallments : 1,
        due_date:     asaasDueDate,
      });
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

  // Abre modal de cancelamento de cobrança
  const openCancelCharge = () => {
    setCancelReason('');
    setCancelReasonCustom('');
    setCancelModal(true);
  };

  // Cancela a cobrança atual (Asaas ou link externo) e volta o pedido para
  // "Aguardando cobrança" — limpando vencimento e link — para gerar/enviar uma nova.
  const confirmCancelCharge = async () => {
    const reason = cancelReason === 'Outro' ? cancelReasonCustom.trim() : cancelReason;
    if (!reason) return toast.error('Selecione o motivo');

    setCancelChargeLoading(true);
    try {
      const hadAsaas    = !!order.asaas_charge_id;
      const hadExternal = !!order.external_payment_link;

      // Se há cobrança nativa no Asaas (não paga), cancela no gateway primeiro
      if (hadAsaas && order.payment_status !== 'paid') {
        try { await callAsaas('cancel'); }
        catch (e) { console.warn('Falha ao cancelar cobrança Asaas:', e.message); }
      }

      await supabase.from('presale_orders').update({
        payment_status:          'awaiting_charge',
        external_payment_link:   null,
        asaas_charge_id:         null,
        asaas_payment_link:      null,
        asaas_pix_qrcode:        null,
        asaas_pix_copy:          null,
        payment_message_sent_at: null,
        due_date:                null,
        cancellation_reason:     reason,
      }).eq('id', id);

      await logSaleEvent('awaiting_charge', reason, {
        action:                'charge_cancelled',
        had_asaas_charge:      hadAsaas,
        had_external_link:     hadExternal,
        previous_due_date:     order.due_date || null,
        previous_external_link: order.external_payment_link || null,
      });

      setCancelModal(false);
      setAsaasStatus(null);
      toast.success('Cobrança cancelada. Pedido voltou para "Aguardando cobrança" — gere ou envie uma nova com novo vencimento.');
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao cancelar cobrança');
    } finally {
      setCancelChargeLoading(false);
    }
  };

  // Confirma estorno com motivo
  const confirmRefund = async () => {
    const reason = refundReason === 'Outro' ? refundReasonCustom : refundReason;
    try {
      await callAsaas('refund', { reason });
      await supabase.from('presale_orders').update({ cancellation_reason: reason || null }).eq('id', id);
      await returnCouponUse(id, 'presale');
      await logSaleEvent('refunded', reason || 'Estorno', { action: 'refunded', value: order.total_value });
      setRefundModal(false);
      toast.success('Estorno realizado com sucesso!');
      load();
    } catch (e) { toast.error(e.message || 'Erro ao estornar'); }
  };

  // Labels legíveis para a preferência de pagamento do cliente
  const PAYMENT_METHOD_LABEL = {
    pix_boleto: 'PIX ou Boleto', pix: 'PIX', pix_manual: 'PIX', boleto: 'Boleto',
    cash: 'Dinheiro', bank_transfer: 'Transferência bancária',
    card_1x: 'Cartão 1x', card_2x: 'Cartão 2x', card_3x: 'Cartão 3x',
    card_4x: 'Cartão 4x', card_5x: 'Cartão 5x', card_6x: 'Cartão 6x',
    card_7x: 'Cartão 7x', card_8x: 'Cartão 8x', card_9x: 'Cartão 9x',
    card_10x: 'Cartão 10x', card_11x: 'Cartão 11x', card_12x: 'Cartão 12x',
  };

  const buildMessage = (manualLink = '', dueDate = order.due_date) => {
    const itemLines = (order.items || []).filter(it => !it.cancelled).map(item => {
      const extras = (item.extras || []).map(e => `   ➕ ${e.name}: ${formatCurrency(e.price)}`).join('\n');
      const itemTotal = ((item.sale_price || 0) + (item.extras_total || 0)) * item.quantity;
      const label = item.variation ? `${item.product_name} - ${item.variation}` : item.product_name;
      return `• ${label} x${item.quantity} → ${formatCurrency(itemTotal)}${extras ? '\n' + extras : ''}`;
    }).join('\n');
    const total = order.total_value || 0;
    const trackingLink = `${window.location.origin}/p/${publicTrackingToken(order)}`;
    const trackingLine = `\n\n🔍 *Acompanhe seu pedido:*\n${trackingLink}`;
    const dueLine = dueDate ? `📅 *Vencimento:* ${formatDate(dueDate)}\n\n` : '';

    // Modo Asaas: tem link ou PIX do gateway
    const chargeLink = order.asaas_payment_link;
    const pixCopy    = order.asaas_pix_copy;
    if (chargeLink || pixCopy) {
      return (
        `Olá, ${order.checkout_name}! 👋\n\n` +
        `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
        `📦 *Itens:*\n${itemLines}\n\n` +
        `💰 *Total: ${formatCurrency(total)}*\n\n` +
        dueLine +
        (pixCopy ? `📲 *PIX Copia e Cola:*\n\`${pixCopy}\`\n\n` : '') +
        (chargeLink ? `🔗 *Link de pagamento:*\n${chargeLink}` : '') +
        trackingLine
      );
    }

    // Modo manual com link externo
    const preferredMethod = order.payment_preference || order.payment_method;
    const payLabel = PAYMENT_METHOD_LABEL[preferredMethod] || preferredMethod || null;
    const linkTrim = manualLink?.trim();
    if (linkTrim) {
      return (
        `Olá, ${order.checkout_name}! 👋\n\n` +
        `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
        `📦 *Itens:*\n${itemLines}\n\n` +
        `💰 *Total: ${formatCurrency(total)}*\n\n` +
        (payLabel ? `💳 *Forma de pagamento:* ${payLabel}\n\n` : '') +
        dueLine +
        `🔗 *Link de pagamento:*\n${linkTrim}` +
        trackingLine
      );
    }

    // Sem link — mensagem informativa
    if (payLabel) {
      return (
        `Olá, ${order.checkout_name}! 👋\n\n` +
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
      `Olá, ${order.checkout_name}! 👋\n\n` +
      `Segue o resumo do seu pedido *${order.order_number}*:\n\n` +
      `📦 *Itens:*\n${itemLines}\n\n` +
      `💰 *Total: ${formatCurrency(total)}*\n\n` +
      `Como você prefere pagar?\n• PIX (à vista) — ${formatCurrency(total)}\n• Cartão (em até 12x)` +
      trackingLine
    );
  };

  const openWhatsApp = () => {
    const savedExternalLink = order.external_payment_link || '';
    const due = order.due_date || defaultPaymentDueDate();
    setWhatsappManualLink(savedExternalLink);
    setWhatsappDueDate(due);
    setWhatsappMsg(buildMessage(savedExternalLink, due));
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
    const phone = phoneDigitsForWhatsApp(order.checkout_whatsapp);
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMsg)}`, '_blank');
  };

  // Atalho: reabre pagamento manual e já abre o accordion Asaas do card Pagamento.
  // Útil quando o usuário registrou manual por engano e quer cobrar pelo gateway.
  const convertToAsaas = async () => {
    await reopenPayment(/* keepModalOpen */ false);
    setPayAction('asaas');
    // Faz scroll suave até o card de Pagamento (Card que vai aparecer agora)
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
  };

  // Reabre pagamento manual: desfaz o registro e volta a awaiting_charge.
  // Só funciona se foi manual_payment (Asaas exige estorno via API).
  const reopenPayment = async () => {
    setReopenLoading(true);
    try {
      // 1. Apaga parcelas manuais em asaas_payments
      await supabase.from('asaas_payments')
        .delete()
        .eq('order_id', id)
        .eq('order_type', 'presale')
        .eq('source', 'manual');

      // 2. Reseta order
      await PreSaleOrder.update(id, {
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

  const markMessageSent = async () => {
    try {
      const externalLink = whatsappManualLink.trim();
      if (externalLink && !isSafePaymentUrl(externalLink)) {
        toast.error('Informe um link válido começando com https://');
        return;
      }
      const hasChargeDetails = Boolean(
        order.asaas_charge_id ||
        order.asaas_payment_link ||
        order.asaas_pix_copy ||
        externalLink
      );
      if (!hasChargeDetails) {
        toast.error('Gere uma cobrança ou informe o link externo antes de efetivar a venda.');
        return;
      }
      // Para cobrança externa, o vencimento é definido/ajustado aqui
      const isExternal = !order.asaas_charge_id;
      const dueDate = isExternal ? (whatsappDueDate || defaultPaymentDueDate()) : order.due_date;
      if (isExternal && !whatsappDueDate) {
        toast.error('Informe a data de vencimento da cobrança');
        return;
      }
      const wasResent = order.payment_status === 'charge_sent';
      const updates = { payment_message_sent_at: new Date().toISOString() };
      if (isExternal) {
        updates.external_payment_link = externalLink || null;
        updates.due_date = dueDate;
      }
      if (['awaiting_charge', 'pending'].includes(order.payment_status)) {
        updates.payment_status = 'charge_sent';
      }
      await PreSaleOrder.update(id, updates);
      await logSaleEvent('charge_sent', wasResent ? 'Cobrança reenviada' : 'Cobrança enviada', {
        action:    wasResent ? 'charge_resent' : 'charge_sent',
        channel:   'whatsapp',
        via:       isExternal ? (externalLink ? 'external_link' : 'message_only') : 'asaas',
        due_date:  dueDate || null,
        link:      isExternal ? (externalLink || null) : (order.asaas_payment_link || null),
      });
      toast.success(wasResent ? 'Reenvio registrado!' : 'Mensagem marcada como enviada!');
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

      // 5b. Se o pagamento foi manual, recalcula parcelas em asaas_payments
      // (Asaas real é tratado via API refund acima; trigger SQL cuida do cancelamento total)
      if (order.manual_payment && !allCancelled) {
        await adjustManualInstallmentsValue(
          { order_id: id, order_type: 'presale' },
          newTotal,
        );
      }

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

  // ── Cancelar pedido inteiro ─────────────────────────────────────
  const openCancelOrder = () => {
    setCancelOrderReason('');
    setCancelOrderReasonCustom('');
    setCancelOrderModal(true);
  };

  const confirmCancelOrder = async () => {
    const reason = cancelOrderReason === 'Outro' ? cancelOrderReasonCustom : cancelOrderReason;
    if (!reason?.trim()) return toast.error('Informe o motivo do cancelamento');

    setCancelOrderLoading(true);
    try {
      // 1) Se tem cobrança Asaas, cancela ela primeiro (só se ainda não foi paga)
      if (order.asaas_charge_id && order.payment_status !== 'paid') {
        try {
          await callAsaas('cancel');
        } catch (e) {
          console.warn('Falha ao cancelar cobrança Asaas:', e.message);
        }
      }

      // 2) Apaga parcelas manuais (se houver)
      await supabase.from('asaas_payments')
        .delete()
        .eq('order_id', id)
        .eq('order_type', 'presale')
        .eq('source', 'manual');

      // 3) Atualiza pedido para cancelled
      await supabase.from('presale_orders').update({
        payment_status: 'cancelled',
        cancellation_reason: reason,
        asaas_charge_id: null,
        asaas_payment_link: null,
        asaas_pix_qrcode: null,
        asaas_pix_copy: null,
        external_payment_link: null,
      }).eq('id', id);

      // 4) Devolve uso de cupom (se houver)
      await returnCouponUse(id, 'presale');

      await logSaleEvent('cancelled', reason, { action: 'order_cancelled' });

      toast.success('Pedido cancelado.');
      setCancelOrderModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao cancelar pedido');
    } finally {
      setCancelOrderLoading(false);
    }
  };

  // ── Adicionar peça ──────────────────────────────────────────────
  const openAddItem = () => {
    setAddItemSearch('');
    setAddItemProductId('');
    setAddItemVariation('');
    setAddItemQuantity(1);
    setAddItemExtras([]);
    setAddItemModal(true);
  };

  const addItemFilteredProducts = campaignProducts.filter(p => {
    if (!addItemSearch.trim()) return true;
    const q = addItemSearch.toLowerCase().trim();
    return (
      (p.name || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.subcategory || '').toLowerCase().includes(q) ||
      (p.supplier || '').toLowerCase().includes(q)
    );
  });

  const addItemSelectedProduct = campaignProducts.find(p => p.id === addItemProductId);
  const addItemSelectedVariation = addItemSelectedProduct?.variations?.find(v => v.name === addItemVariation);

  const confirmAddItem = async () => {
    if (!addItemSelectedProduct) return toast.error('Selecione um produto');
    if (addItemSelectedProduct.variations?.length > 0 && !addItemSelectedVariation) {
      return toast.error('Selecione a variação');
    }
    if (!addItemQuantity || addItemQuantity < 1) return toast.error('Quantidade inválida');

    const sale_price = addItemSelectedVariation?.sale_price ?? addItemSelectedProduct.sale_price ?? 0;
    const cost_price = addItemSelectedVariation?.cost_price ?? addItemSelectedProduct.cost_price ?? 0;
    const extras_total = addItemExtras.reduce((s, e) => s + (e.price || 0), 0);

    const newItem = {
      product_id: addItemSelectedProduct.id,
      product_name: addItemSelectedProduct.name,
      variation: addItemSelectedVariation?.name || null,
      extras: addItemExtras,
      extras_total,
      quantity: addItemQuantity,
      sale_price,
      cost_price,
    };

    const newItems = [...items, newItem];
    const activeItems = newItems.filter(it => !it.cancelled);
    const newSubtotal = activeItems.reduce((s, it) => s + ((it.sale_price || 0) + (it.extras_total || 0)) * it.quantity, 0);
    const newTotalCost = activeItems.reduce((s, it) => s + ((it.cost_price || 0) * it.quantity), 0);
    const newTotal = Math.max(0, newSubtotal - (Number(order.discount_value) || 0) - (Number(order.manual_discount) || 0));

    setAddItemLoading(true);
    try {
      // 1) Se tem cobrança Asaas ativa, cancela primeiro (pra não deixar uma cobrança com valor errado solta)
      if (order.asaas_charge_id) {
        await callAsaas('cancel');
      }

      // 2) Limpa parcelas manuais (se houver) — vai gerar nova cobrança depois
      await supabase.from('asaas_payments')
        .delete()
        .eq('order_id', id)
        .eq('order_type', 'presale')
        .eq('source', 'manual');

      // 3) Atualiza pedido: novos itens + zera tudo de cobrança, volta para "Pedido recebido"
      await supabase.from('presale_orders').update({
        items: newItems,
        total_value: newTotal,
        total_cost: newTotalCost,
        payment_status: 'awaiting_charge',
        payment_method: null,
        payment_date: null,
        due_date: null,
        asaas_charge_id: null,
        asaas_payment_link: null,
        asaas_pix_qrcode: null,
        asaas_pix_copy: null,
        external_payment_link: null,
        payment_message_sent_at: null,
        manual_payment: false,
        manual_fee: null,
      }).eq('id', id);

      toast.success('Peça adicionada! Pedido voltou para "Pedido recebido" — gere a cobrança novamente.');
      setAddItemModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao adicionar peça');
    } finally {
      setAddItemLoading(false);
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
          {!['paid', 'cancelled', 'refunded'].includes(order.payment_status) && (
            <Button variant="outline" size="sm" onClick={openCancelOrder} className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700">
              <X className="w-3.5 h-3.5 mr-1" />
              Cancelar pedido
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

          {/* Adicionar peça — só se pedido NÃO pago e NÃO cancelado/reembolsado */}
          {!['paid', 'refunded', 'cancelled'].includes(order.payment_status) && campaignProducts.length > 0 && (
            <div className="mt-3 flex justify-end">
              <Button variant="outline" size="sm" onClick={openAddItem}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Adicionar peça
              </Button>
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
              <p className="text-xs text-muted-foreground">Lucro estimado</p>
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
          // Recalcula parcelas manuais se já estava pago manualmente
          if (order.manual_payment && order.payment_status === 'paid') {
            await adjustManualInstallmentsValue(
              { order_id: order.id, order_type: 'presale' },
              newTotal,
            );
          }
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

              {/* Dados para cobrança — copie pra criar a cobrança no Asaas */}
              <div className="border rounded-xl p-3 space-y-1.5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Dados para cobrança</p>
                {[
                  { label: 'Nome',     value: order.checkout_name || customer?.full_name },
                  { label: 'WhatsApp', value: order.customer_whatsapp || order.checkout_whatsapp || customer?.whatsapp },
                  { label: 'E-mail',   value: order.checkout_email || customer?.email },
                  { label: 'CPF',      value: customer?.cpf },
                ].map(({ label, value }) => value ? (
                  <div key={label} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground text-xs w-16 shrink-0">{label}</span>
                    <span className="flex-1 font-medium truncate">{value}</span>
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(value); toast.success(`${label} copiado!`); }}
                      className="text-blue-500 hover:text-blue-700 shrink-0 p-1 rounded hover:bg-blue-50"
                      title={`Copiar ${label}`}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : null)}
                {!customer?.cpf && (
                  <div className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>CPF não cadastrado — é obrigatório pra gerar a cobrança no Asaas.</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <Label className="text-xs">Link de cobrança externo (opcional)</Label>
                  <Input
                    className="mt-1 font-mono text-xs"
                    placeholder="https://..."
                    value={whatsappManualLink}
                    onChange={e => {
                      setWhatsappManualLink(e.target.value);
                      setWhatsappMsg(buildMessage(e.target.value, whatsappDueDate));
                      setCopied(false);
                    }}
                  />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">Vencimento da cobrança</Label>
                  <Input
                    type="date"
                    className="mt-1 text-sm"
                    value={whatsappDueDate}
                    onChange={e => {
                      setWhatsappDueDate(e.target.value);
                      setWhatsappMsg(buildMessage(whatsappManualLink, e.target.value));
                      setCopied(false);
                    }}
                  />
                </div>
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
              <ExternalLink className="w-4 h-4 mr-1.5" />
              Abrir no WhatsApp
            </Button>
          </div>
          {['awaiting_charge', 'charge_sent'].includes(order.payment_status) && (
            <Button className="w-full bg-orange-500 hover:bg-orange-600 text-white" onClick={markMessageSent}>
              <Check className="w-4 h-4 mr-1.5" />
              {order.payment_status === 'charge_sent' ? 'Registrar reenvio de cobrança' : 'Efetivar venda externa enviada'}
            </Button>
          )}
          {/* Atalho: se já está cobrando manualmente e o cliente confirmar pagamento */}
          {!order.asaas_charge_id && order.payment_status !== 'paid' && (
            <Button
              variant="outline"
              className="w-full text-amber-700 border-amber-300 hover:bg-amber-50"
              onClick={switchToManualPay}
            >
              <HandCoins className="w-4 h-4 mr-1.5" />
              Cliente já pagou? Registrar pagamento manual
            </Button>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal: oferecer enviar comprovante após registrar pagamento manual */}
      <Dialog open={postPayWhatsModal} onOpenChange={setPostPayWhatsModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="w-5 h-5 text-green-600" /> Pagamento registrado
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Quer enviar uma confirmação por WhatsApp para o cliente?
            </p>
            <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-700 border">
              ✅ Confirmamos o recebimento do pagamento do pedido <strong>{order.order_number}</strong>...
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setPostPayWhatsModal(false)}>
                Agora não
              </Button>
              <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={sendPaymentConfirmation}>
                <MessageCircle className="w-4 h-4 mr-1.5" />
                Enviar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal cancelar/trocar cobrança */}
      <Dialog open={cancelModal} onOpenChange={setCancelModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <X className="w-5 h-5" /> Cancelar cobrança
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800 flex gap-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                A cobrança atual será cancelada {order.asaas_charge_id ? '(inclusive no Asaas) ' : ''}e o pedido volta para
                <strong> Aguardando cobrança</strong>. Depois você gera/envia uma nova com novo vencimento — útil pra trocar a forma de pagamento ou aplicar desconto.
              </span>
            </div>
            <p className="text-sm text-muted-foreground">Selecione o motivo:</p>
            <div className="space-y-1.5">
              {CHARGE_CANCEL_REASONS.map(r => (
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
                onClick={confirmCancelCharge}
                disabled={cancelChargeLoading || !cancelReason || (cancelReason === 'Outro' && !cancelReasonCustom.trim())}
              >
                {cancelChargeLoading ? 'Cancelando...' : 'Confirmar cancelamento'}
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

      {/* Modal cancelar pedido inteiro */}
      <Dialog open={cancelOrderModal} onOpenChange={setCancelOrderModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <X className="w-5 h-5" />
              Cancelar pedido
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Esta ação cancela <strong>todo</strong> o pedido. Se houver cobrança Asaas ativa, ela será cancelada também.
                Esta ação não pode ser desfeita pelo sistema.
              </span>
            </div>

            <div>
              <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Motivo do cancelamento</Label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {['Cliente desistiu', 'Erro no pedido', 'Sem estoque', 'Duplicado', 'Outro'].map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setCancelOrderReason(r)}
                    className={`text-sm px-3 py-2 rounded-lg border transition-all ${
                      cancelOrderReason === r
                        ? 'border-red-400 bg-red-50 text-red-800 font-medium'
                        : 'border-gray-200 hover:border-gray-300 text-gray-700'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {cancelOrderReason === 'Outro' && (
                <Textarea
                  value={cancelOrderReasonCustom}
                  onChange={e => setCancelOrderReasonCustom(e.target.value)}
                  placeholder="Descreva o motivo..."
                  className="mt-2"
                  rows={2}
                />
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCancelOrderModal(false)} disabled={cancelOrderLoading}>Voltar</Button>
              <Button
                variant="destructive"
                onClick={confirmCancelOrder}
                disabled={cancelOrderLoading || !cancelOrderReason}
              >
                {cancelOrderLoading ? 'Cancelando...' : 'Confirmar cancelamento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal adicionar peça */}
      <Dialog open={addItemModal} onOpenChange={setAddItemModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5 text-blue-600" />
              Adicionar peça ao pedido
            </DialogTitle>
          </DialogHeader>

          {(order.asaas_charge_id || order.external_payment_link || order.payment_message_sent_at) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 flex gap-2 shrink-0">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Este pedido já tinha cobrança em andamento. Ao adicionar a peça, a cobrança será cancelada
                e o pedido volta para <strong>"Pedido recebido"</strong>. Você precisa gerar/enviar uma nova cobrança ao cliente.
              </span>
            </div>
          )}

          {/* Conteúdo scrollável */}
          <div className="flex-1 overflow-y-auto space-y-4 -mx-6 px-6">
            {/* Busca */}
            <div className="sticky top-0 bg-white pt-2 pb-2 z-10">
              <div className="relative">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
                <Input
                  placeholder="Buscar produto, SKU, categoria ou fornecedor..."
                  value={addItemSearch}
                  onChange={e => setAddItemSearch(e.target.value)}
                  className="pl-9 h-10"
                  autoFocus
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {addItemFilteredProducts.length} de {campaignProducts.length} produto{campaignProducts.length !== 1 ? 's' : ''}
                {addItemSearch && ' (filtrado)'}
              </p>
            </div>

            {/* Grade de produtos */}
            {addItemFilteredProducts.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                <Package className="w-10 h-10 mx-auto text-gray-300 mb-2" />
                Nenhum produto encontrado.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {addItemFilteredProducts.map(p => {
                  const isSelected = addItemProductId === p.id;
                  const img = p.images?.[0];
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { setAddItemProductId(p.id); setAddItemVariation(''); setAddItemExtras([]); }}
                      className={`text-left rounded-xl border-2 p-3 flex gap-3 transition-all ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50/50 shadow-sm'
                          : 'border-gray-200 hover:border-gray-300 bg-white'
                      }`}
                    >
                      <div className="w-14 h-14 rounded-lg bg-gray-100 shrink-0 overflow-hidden flex items-center justify-center">
                        {img ? (
                          <img src={img} alt={p.name} className="w-full h-full object-cover" />
                        ) : (
                          <Package className="w-6 h-6 text-gray-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`font-semibold text-sm leading-tight ${isSelected ? 'text-blue-900' : 'text-gray-900'}`}>
                          {p.name}
                        </p>
                        {p.variations?.length > 0 && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {p.variations.length} variaç{p.variations.length === 1 ? 'ão' : 'ões'}
                          </p>
                        )}
                        <p className={`text-sm font-bold mt-1 ${isSelected ? 'text-blue-700' : 'text-emerald-700'}`}>
                          {formatCurrency(p.sale_price || 0)}
                        </p>
                      </div>
                      {isSelected && <Check className="w-5 h-5 text-blue-600 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Config (variação, extras, qtd) — só aparece quando seleciona um produto */}
            {addItemSelectedProduct && (
              <div className="border-t pt-4 space-y-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <Check className="w-4 h-4 text-blue-600" />
                  Configurar "{addItemSelectedProduct.name}"
                </div>

                {addItemSelectedProduct.variations?.length > 0 && (
                  <div>
                    <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Variação</Label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1.5">
                      {addItemSelectedProduct.variations.map(v => {
                        const isVarSelected = addItemVariation === v.name;
                        return (
                          <button
                            key={v.name}
                            type="button"
                            onClick={() => setAddItemVariation(v.name)}
                            className={`text-left rounded-lg border px-3 py-2 transition-all ${
                              isVarSelected
                                ? 'border-blue-500 bg-blue-50 text-blue-900'
                                : 'border-gray-200 hover:border-gray-300'
                            }`}
                          >
                            <p className="text-sm font-medium">{v.name}</p>
                            {v.sale_price != null && v.sale_price !== addItemSelectedProduct.sale_price && (
                              <p className="text-xs text-emerald-700 mt-0.5">{formatCurrency(v.sale_price)}</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {addItemSelectedProduct.extras?.length > 0 && (
                  <div>
                    <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Adicionais (opcional)</Label>
                    <div className="space-y-1.5 mt-1.5">
                      {addItemSelectedProduct.extras.map(extra => {
                        const isChecked = addItemExtras.some(e => e.name === extra.name);
                        return (
                          <label key={extra.name} className={`flex items-center gap-2 text-sm cursor-pointer p-2 rounded-lg border transition-all ${
                            isChecked ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 hover:bg-gray-50'
                          }`}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={e => {
                                if (e.target.checked) setAddItemExtras([...addItemExtras, { name: extra.name, price: extra.price }]);
                                else setAddItemExtras(addItemExtras.filter(x => x.name !== extra.name));
                              }}
                              className="rounded"
                            />
                            <span className="flex-1">{extra.name}</span>
                            {extra.price > 0 && <span className="text-blue-600 font-medium">+ {formatCurrency(extra.price)}</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Quantidade</Label>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Button type="button" size="icon" variant="outline" onClick={() => setAddItemQuantity(Math.max(1, addItemQuantity - 1))}>
                      <Minus className="w-3.5 h-3.5" />
                    </Button>
                    <Input
                      type="number"
                      min="1"
                      value={addItemQuantity}
                      onChange={e => setAddItemQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-20 text-center"
                    />
                    <Button type="button" size="icon" variant="outline" onClick={() => setAddItemQuantity(addItemQuantity + 1)}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer fixo com subtotal e ações */}
          <div className="shrink-0 border-t pt-4 -mx-6 px-6 space-y-3">
            {addItemSelectedProduct && (
              <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                <div>
                  <p className="text-xs text-muted-foreground">Subtotal</p>
                  <p className="text-lg font-bold text-emerald-700">
                    {formatCurrency(
                      ((addItemSelectedVariation?.sale_price ?? addItemSelectedProduct.sale_price ?? 0)
                        + addItemExtras.reduce((s, e) => s + (e.price || 0), 0))
                      * addItemQuantity
                    )}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {addItemQuantity}× {formatCurrency(
                    (addItemSelectedVariation?.sale_price ?? addItemSelectedProduct.sale_price ?? 0)
                    + addItemExtras.reduce((s, e) => s + (e.price || 0), 0)
                  )}
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddItemModal(false)} disabled={addItemLoading}>Cancelar</Button>
              <Button onClick={confirmAddItem} disabled={addItemLoading || !addItemSelectedProduct}>
                {addItemLoading ? 'Adicionando...' : (
                  <>
                    <Plus className="w-4 h-4 mr-1" />
                    Adicionar peça
                  </>
                )}
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

      {/* Pagamento — só aparece se ainda há ação a tomar */}
      {!['paid', 'refunded', 'cancelled'].includes(order.payment_status) && (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <HandCoins className="w-4 h-4 text-blue-600" /> Pagamento
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
                    <Button size="sm" variant="outline" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={openCancelCharge} disabled={asaasLoading}>
                      <X className="w-3.5 h-3.5 mr-1" /> Cancelar
                    </Button>
                  )}
                </div>
              </div>
              {/* Vencimento da cobrança */}
              {order.due_date && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5" /> Vence em <span className="font-semibold text-gray-700">{formatDate(order.due_date)}</span>
                </div>
              )}
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
              <Button className="w-full bg-green-600 hover:bg-green-700 text-white gap-2" onClick={() => { setWhatsappManualLink(''); setWhatsappDueDate(order.due_date || ''); setWhatsappMsg(buildMessage()); setCopied(false); setWhatsappModal(true); }}>
                <MessageCircle className="w-4 h-4" /> Enviar cobrança via WhatsApp
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {order.external_payment_link && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Link2 className="w-4 h-4 text-amber-600 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-amber-800">Link externo salvo</p>
                      <p className="text-sm text-amber-700 truncate">{order.external_payment_link}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(order.external_payment_link); toast.success('Link copiado!'); }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  {order.due_date && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-700">
                      <Calendar className="w-3.5 h-3.5" /> Vence em <span className="font-semibold">{formatDate(order.due_date)}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={cancelChargeLoading}
                    onClick={openCancelCharge}
                    className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50"
                  >
                    ✕ Cancelar cobrança (trocar link / aplicar desconto)
                  </button>
                </div>
              )}
              {/* Preferência do cliente */}
              {(order.payment_preference || order.payment_method) && (
                <div className="flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5">
                  <span className="text-blue-600">Cliente solicitou:</span>
                  <span className="font-semibold text-blue-900">{{
                    pix_boleto:'PIX ou Boleto', pix:'PIX', boleto:'Boleto',
                    card_1x:'Cartão 1x', card_2x:'Cartão 2x', card_3x:'Cartão 3x',
                    card_4x:'Cartão 4x', card_5x:'Cartão 5x', card_6x:'Cartão 6x',
                  }[order.payment_preference || order.payment_method] || order.payment_preference || order.payment_method}</span>
                </div>
              )}

              {/* Três ações principais (accordion) */}
              <p className="text-xs text-muted-foreground">Como vai cobrar?</p>

              {/* AÇÃO 1 — Cobrança Asaas */}
              <div className="border rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPayAction(payAction === 'asaas' ? null : 'asaas')}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                    payAction === 'asaas' ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                    <Zap className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">Gerar cobrança no Asaas</p>
                    <p className="text-xs text-muted-foreground">PIX, Boleto ou Cartão — link enviado pelo gateway</p>
                  </div>
                  <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${payAction === 'asaas' ? 'rotate-90' : ''}`} />
                </button>
                {payAction === 'asaas' && (
                  <div className="border-t bg-white px-4 py-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">CPF do cliente</Label>
                        <Input className="mt-1 font-mono text-sm" placeholder="000.000.000-00" value={asaasCpf} onChange={e => setAsaasCpf(e.target.value)} />
                      </div>
                      <div>
                        <Label className="text-xs">Vencimento</Label>
                        <Input type="date" className="mt-1 text-sm" value={asaasDueDate} onChange={e => setAsaasDueDate(e.target.value)} />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">Forma</Label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { key: 'PIX',         icon: <QrCode className="w-4 h-4" />,   label: 'PIX' },
                          { key: 'BOLETO',      icon: <FileText className="w-4 h-4" />, label: 'Boleto' },
                          { key: 'CREDIT_CARD', icon: <Zap className="w-4 h-4" />,      label: 'Cartão' },
                        ].map(opt => (
                          <button key={opt.key} type="button" onClick={() => setAsaasBilling(opt.key)}
                            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border-2 text-sm font-semibold transition-all ${
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
                              className={`py-1.5 rounded-lg border-2 text-sm font-semibold transition-all ${
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
                      {asaasLoading ? 'Criando...' : `Gerar cobrança — ${{ PIX: 'PIX', BOLETO: 'Boleto', CREDIT_CARD: `Cartão ${asaasInstallments}x` }[asaasBilling]}`}
                    </Button>
                  </div>
                )}
              </div>

              {/* AÇÃO 2 — WhatsApp (sem Asaas, com link externo opcional) */}
              {order.checkout_whatsapp && (
                <div className="border rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={openWhatsApp}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                  >
                    <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                      <MessageCircle className="w-4 h-4 text-green-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold">Enviar mensagem por WhatsApp</p>
                      <p className="text-xs text-muted-foreground">Cobrar com link externo (Stone, PagSeguro…) ou só perguntar como pagar</p>
                    </div>
                    <ExternalLink className="w-4 h-4 text-muted-foreground" />
                  </button>
                </div>
              )}

              {/* AÇÃO 3 — Pagamento manual */}
              <div className="border rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={openManualPay}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                    <HandCoins className="w-4 h-4 text-amber-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">Já recebi por fora</p>
                    <p className="text-xs text-muted-foreground">Registrar pagamento manual (dinheiro, PIX direto, maquininha…)</p>
                  </div>
                  <ExternalLink className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
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
                  {/* Resumo */}
                  <div className={`${blockColors.bg} border ${blockColors.border} rounded-xl p-3 space-y-2`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className={`text-xs ${blockColors.text} font-medium uppercase tracking-wide`}>
                          {isRefunded ? 'Estornado' : 'Pago'}
                        </p>
                        <p className={`text-lg font-bold ${blockColors.valueText} mt-0.5`}>
                          {formatCurrency(order.total_value)}
                        </p>
                        <div className={`flex items-center gap-1.5 mt-0.5`}>
                          {order.payment_method ? (
                            <>
                              <span className={`text-xs ${blockColors.text}`}>{PAYMENT_METHOD_LABEL[order.payment_method] || order.payment_method}</span>
                              <button onClick={() => { setEditPayMethodValue(order.payment_method); setEditPayMethodDate(order.payment_date || ''); setEditPayMethodModal(true); }} className={`text-xs ${blockColors.text} hover:opacity-70`}>
                                <Pencil className="w-3 h-3" />
                              </button>
                            </>
                          ) : (
                            <button onClick={() => { setEditPayMethodValue(''); setEditPayMethodDate(order.payment_date || ''); setEditPayMethodModal(true); }} className="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-2 py-0.5 hover:bg-amber-100 flex items-center gap-1">
                              <Pencil className="w-3 h-3" />
                              Definir forma de pagamento
                            </button>
                          )}
                          {order.payment_method && <span className={`text-xs ${blockColors.text}`}> · <span className="font-medium">{order.payment_date ? formatDate(order.payment_date) : '—'}</span></span>}
                        </div>
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

                    {/* Parcelas projetadas */}
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
                                  <p className="font-semibold text-sm">{formatCurrency(p.value || 0)}</p>
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

          {/* Ações em pagamentos manuais ainda pagos (não estornados) */}
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
            <Textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} className="mt-1" rows={3} placeholder="Anotações internas sobre o pedido..." />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSaveClick} disabled={saving}>{saving ? 'Salvando...' : 'Salvar alterações'}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Histórico de ações da cobrança/venda */}
      {saleEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-500" /> Histórico
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative border-l border-gray-200 ml-1.5 space-y-4">
              {saleEvents.map(ev => {
                const meta = SALE_EVENT_META(ev);
                return (
                  <li key={ev.id} className="ml-4">
                    <span className={`absolute -left-1.5 w-3 h-3 rounded-full ${meta.dot}`} />
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-800">{meta.label}</p>
                      <time className="text-xs text-muted-foreground">
                        {new Date(ev.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </time>
                    </div>
                    {ev.reason && ev.reason !== meta.label && (
                      <p className="text-xs text-muted-foreground mt-0.5">{ev.reason}</p>
                    )}
                    {ev.metadata?.due_date && (
                      <p className="text-xs text-muted-foreground mt-0.5">Vencimento: {formatDate(ev.metadata.due_date)}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* Modal editar forma de pagamento */}
      <Dialog open={editPayMethodModal} onOpenChange={setEditPayMethodModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Forma de Pagamento</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-2">Selecione como este pedido foi pago.</p>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Forma de pagamento</Label>
              <Select value={editPayMethodValue} onValueChange={setEditPayMethodValue}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pix_manual">PIX manual</SelectItem>
                  <SelectItem value="pix">PIX (via Asaas)</SelectItem>
                  <SelectItem value="boleto">Boleto</SelectItem>
                  <SelectItem value="cash">Dinheiro</SelectItem>
                  <SelectItem value="bank_transfer">Transferência bancária</SelectItem>
                  <SelectItem value="credit_card">Cartão (à vista)</SelectItem>
                  <SelectItem value="card_2x">Cartão 2x</SelectItem>
                  <SelectItem value="card_3x">Cartão 3x</SelectItem>
                  <SelectItem value="card_4x">Cartão 4x</SelectItem>
                  <SelectItem value="card_5x">Cartão 5x</SelectItem>
                  <SelectItem value="card_6x">Cartão 6x</SelectItem>
                  <SelectItem value="card_7x">Cartão 7x</SelectItem>
                  <SelectItem value="card_8x">Cartão 8x</SelectItem>
                  <SelectItem value="card_9x">Cartão 9x</SelectItem>
                  <SelectItem value="card_10x">Cartão 10x</SelectItem>
                  <SelectItem value="card_11x">Cartão 11x</SelectItem>
                  <SelectItem value="card_12x">Cartão 12x</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Data do pagamento</Label>
              <Input type="date" value={editPayMethodDate} onChange={e => setEditPayMethodDate(e.target.value)} className="mt-1" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setEditPayMethodModal(false)}>Cancelar</Button>
            <Button onClick={handleSavePaymentMethod} disabled={editPayMethodSaving}>
              {editPayMethodSaving ? 'Salvando...' : 'Salvar'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
              <p className="text-amber-800 mt-1">
                Isso vai <strong>desfazer</strong> o registro de pagamento manual:
              </p>
              <ul className="mt-2 ml-4 text-xs text-amber-700 list-disc space-y-0.5">
                <li>Apaga as parcelas projetadas no fluxo de caixa</li>
                <li>Status volta para <strong>Pedido recebido</strong></li>
                <li>Forma e data são removidas</li>
              </ul>
              <p className="text-xs text-amber-700 mt-2">
                Use só se foi um registro errado. Para estornar pagamento real, use o fluxo de cancelamento.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setReopenModal(false)} disabled={reopenLoading}>
                Voltar
              </Button>
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
