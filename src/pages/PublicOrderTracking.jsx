import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckCircle2, Clock, Package, Truck, Sparkles, AlertCircle,
  Copy, QrCode, ExternalLink, Tag, Store, MapPin,
} from 'lucide-react';
import { supabase } from '@/api/db';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

const PAYMENT_METHOD_LABEL = {
  pix_boleto: 'PIX ou Boleto', pix: 'PIX', boleto: 'Boleto',
  card_1x: 'Cartão 1x', card_2x: 'Cartão 2x', card_3x: 'Cartão 3x',
  card_4x: 'Cartão 4x', card_5x: 'Cartão 5x', card_6x: 'Cartão 6x',
};

// Mapeia status interno → estágio da timeline (0..3)
function getStage(order) {
  if (['cancelled', 'refunded'].includes(order.payment_status)) return -1;
  if (order.delivery_status === 'delivered') return 3;
  if (['separated', 'received', 'supplier_ordered'].includes(order.delivery_status) && order.payment_status === 'paid') return 2;
  if (order.payment_status === 'paid') return 2;
  return 0; // aguardando pagamento
}

function TimelineStep({ icon: Icon, label, sub, state }) {
  const colors = {
    done:    { bg: 'bg-green-500', text: 'text-green-700', line: 'bg-green-300' },
    current: { bg: 'bg-blue-500',  text: 'text-blue-700',  line: 'bg-gray-200' },
    pending: { bg: 'bg-gray-200',  text: 'text-gray-400',  line: 'bg-gray-200' },
    failed:  { bg: 'bg-red-500',   text: 'text-red-700',   line: 'bg-red-200' },
  }[state];
  return (
    <div className="flex gap-3 relative">
      <div className="flex flex-col items-center">
        <div className={`w-8 h-8 rounded-full ${colors.bg} flex items-center justify-center shrink-0 ${state === 'current' ? 'ring-4 ring-blue-100 animate-pulse' : ''}`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
        <div className={`flex-1 w-0.5 ${colors.line} my-1`} style={{ minHeight: 16 }} />
      </div>
      <div className="pb-6 pt-1 flex-1">
        <p className={`text-sm font-semibold ${colors.text}`}>{label}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function CancelledBanner({ order }) {
  const isRefund = order.payment_status === 'refunded';
  return (
    <div className="bg-red-50 border border-red-200 rounded-2xl p-5 text-center">
      <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-2" />
      <h3 className="font-bold text-red-700 text-lg">
        {isRefund ? 'Pedido estornado' : 'Pedido cancelado'}
      </h3>
      <p className="text-sm text-red-600 mt-1">
        {isRefund
          ? 'O valor pago já foi devolvido ou está em processamento (até 7 dias úteis).'
          : 'Este pedido foi cancelado e não será processado.'}
      </p>
    </div>
  );
}

export default function PublicOrderTracking() {
  const { orderId } = useParams();
  const [order, setOrder]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error: err } = await supabase.functions.invoke('get-public-order', {
          body: { order_id: orderId },
        });
        if (err || data?.error) { setError(true); return; }
        setOrder(data);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [orderId]);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error || !order) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center">
        <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-gray-800">Pedido não encontrado</h2>
        <p className="text-sm text-muted-foreground mt-1">Verifique o link enviado.</p>
      </div>
    </div>
  );

  const stage = getStage(order);
  const isCancelled = stage === -1;
  const isPaid = order.payment_status === 'paid';
  const hasPaymentInfo = order.asaas_pix_copy || order.asaas_payment_link || order.asaas_pix_qrcode;
  const subtotal = (order.total_value || 0) + (order.discount_value || 0);

  const copy = (text, label) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copiado!`);
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-md mx-auto px-5 py-4 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
            <Store className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">EON Store</span>
        </div>
      </header>

      <div className="max-w-md mx-auto px-4 py-5 space-y-4">
        {/* Saudação */}
        <div>
          <p className="text-sm text-muted-foreground">Olá, {order.customer_name?.split(' ')[0]}! 👋</p>
          <h2 className="text-xl font-bold text-gray-900 mt-0.5">Acompanhe seu pedido</h2>
          <p className="font-mono text-sm text-blue-700 font-semibold mt-1">{order.order_number}</p>
        </div>

        {/* Cancelado */}
        {isCancelled && <CancelledBanner order={order} />}

        {/* Pagamento pendente — mostra PIX/link em destaque */}
        {!isCancelled && !isPaid && hasPaymentInfo && (
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-blue-800">
              <Clock className="w-5 h-5" />
              <h3 className="font-bold">Aguardando seu pagamento</h3>
            </div>
            <p className="text-2xl font-bold text-blue-900">{formatCurrency(order.total_value)}</p>

            {order.asaas_pix_qrcode && (
              <div className="bg-white rounded-xl p-3 border border-blue-100">
                <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <QrCode className="w-3.5 h-3.5" /> Aponte a câmera do seu app PIX
                </p>
                <img
                  src={`data:image/png;base64,${order.asaas_pix_qrcode}`}
                  alt="QR Code PIX"
                  className="w-full max-w-[200px] mx-auto"
                />
              </div>
            )}

            {order.asaas_pix_copy && (
              <button
                onClick={() => copy(order.asaas_pix_copy, 'PIX')}
                className="w-full bg-white border border-blue-200 rounded-xl px-4 py-3 text-left hover:bg-blue-50 transition-colors"
              >
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Copy className="w-3 h-3" /> PIX Copia e Cola — toque para copiar
                </p>
                <p className="text-xs font-mono text-gray-700 truncate">{order.asaas_pix_copy}</p>
              </button>
            )}

            {order.asaas_payment_link && (
              <a
                href={order.asaas_payment_link}
                target="_blank"
                rel="noreferrer"
                className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-4 py-3 flex items-center justify-center gap-2 font-semibold text-sm transition-colors"
              >
                <ExternalLink className="w-4 h-4" /> Abrir página de pagamento
              </a>
            )}
          </div>
        )}

        {/* Pagamento confirmado — destaque */}
        {!isCancelled && isPaid && stage < 3 && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-5 flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
            <div>
              <p className="font-bold text-green-800">Pagamento confirmado!</p>
              <p className="text-sm text-green-700 mt-0.5">Estamos preparando seu pedido.</p>
            </div>
          </div>
        )}

        {/* Entregue */}
        {!isCancelled && stage === 3 && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-5 flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-green-600 shrink-0" />
            <div>
              <p className="font-bold text-green-800">Pedido entregue!</p>
              <p className="text-sm text-green-700 mt-0.5">Aproveite suas peças 🎉</p>
            </div>
          </div>
        )}

        {/* Timeline */}
        {!isCancelled && (
          <div className="bg-white rounded-2xl border p-5">
            <h3 className="font-bold text-sm text-gray-900 mb-4">Linha do tempo</h3>
            <div>
              <TimelineStep
                icon={CheckCircle2}
                label="Pedido recebido"
                sub={order.created_date ? new Date(order.created_date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null}
                state="done"
              />
              <TimelineStep
                icon={CheckCircle2}
                label="Pagamento confirmado"
                sub={order.payment_date ? new Date(order.payment_date + 'T00:00:00').toLocaleDateString('pt-BR') : null}
                state={stage >= 2 ? 'done' : stage >= 0 ? 'current' : 'pending'}
              />
              <TimelineStep
                icon={Package}
                label="Em preparação"
                state={stage >= 3 ? 'done' : stage === 2 ? 'current' : 'pending'}
              />
              <TimelineStep
                icon={Truck}
                label="Entregue"
                sub={order.delivery_date ? new Date(order.delivery_date + 'T00:00:00').toLocaleDateString('pt-BR') : null}
                state={stage === 3 ? 'done' : 'pending'}
              />
            </div>
          </div>
        )}

        {/* Itens */}
        <div className="bg-white rounded-2xl border p-5">
          <h3 className="font-bold text-sm text-gray-900 mb-3">Seus itens</h3>
          <div className="space-y-2 divide-y">
            {(order.items || []).map((item, i) => {
              const itemTotal = ((item.sale_price || 0) + (item.extras_total || 0)) * (item.quantity || 1);
              return (
                <div key={i} className={`flex items-start justify-between gap-3 ${i > 0 ? 'pt-2' : ''} ${item.cancelled ? 'opacity-50' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${item.cancelled ? 'line-through' : ''}`}>
                      {item.product_name}
                    </p>
                    {item.variation && <p className="text-xs text-muted-foreground">{item.variation}</p>}
                    {(item.extras || []).map((e, j) => (
                      <p key={j} className="text-xs text-blue-600">+ {e.name}</p>
                    ))}
                    <p className="text-xs text-muted-foreground mt-0.5">Qtd: {item.quantity}</p>
                    {item.cancelled && (
                      <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">Cancelado</span>
                    )}
                  </div>
                  <span className="text-sm font-semibold whitespace-nowrap">{formatCurrency(itemTotal)}</span>
                </div>
              );
            })}
          </div>

          <div className="border-t mt-3 pt-3 space-y-1.5 text-sm">
            {order.coupon_code && (
              <>
                <div className="flex items-center justify-between text-gray-600">
                  <span>Subtotal</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-amber-700">
                  <span className="flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5" /> Cupom {order.coupon_code}
                  </span>
                  <span className="font-semibold">-{formatCurrency(order.discount_value || 0)}</span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between font-bold pt-1">
              <span>Total</span>
              <span className="text-lg text-blue-700">{formatCurrency(order.total_value)}</span>
            </div>
          </div>
        </div>

        {/* Entrega + Pagamento info */}
        {(order.delivery_method || order.payment_method) && (
          <div className="bg-white rounded-2xl border p-5 space-y-2 text-sm">
            {order.delivery_method && (
              <div className="flex items-center gap-2 text-gray-700">
                <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
                <span>
                  {order.delivery_method === 'pickup'
                    ? `Retirada em treino${order.delivery_city ? ' · ' + order.delivery_city : ''}`
                    : 'Frete'}
                </span>
              </div>
            )}
            {order.payment_method && (
              <div className="flex items-center gap-2 text-gray-700">
                <Tag className="w-4 h-4 text-muted-foreground shrink-0" />
                <span>{PAYMENT_METHOD_LABEL[order.payment_method] || order.payment_method}</span>
              </div>
            )}
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground pt-2">
          Esta página atualiza automaticamente conforme o pedido avança.
        </p>
      </div>
    </div>
  );
}
