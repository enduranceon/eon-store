import { useParams, useLocation } from 'react-router-dom';
import { CheckCircle2, Phone, Mail, Store } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

export default function PublicStoreConfirmation() {
  const { orderId } = useParams();
  const location = useLocation();
  const order = location.state?.order;

  if (!order) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-9 h-9 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Pedido confirmado!</h1>
          <p className="text-gray-500 text-sm">Seu pedido foi registrado. Em breve você receberá a cobrança via WhatsApp.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-[#1a1a2e] text-white py-4 px-4">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <Store className="w-4 h-4" />
          <span className="font-semibold">EON Store — Loja</span>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-10">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-9 h-9 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Pedido confirmado!</h1>
          <p className="text-muted-foreground mt-2">Seu pedido foi registrado com sucesso.</p>
        </div>

        <div className="bg-blue-600 text-white rounded-xl p-6 text-center mb-6">
          <p className="text-sm opacity-80 mb-1">Número do pedido</p>
          <p className="text-3xl font-bold font-mono tracking-wider">{order.order_number}</p>
        </div>

        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-4 mb-4 flex items-start gap-3">
          <span className="text-2xl">📲</span>
          <div>
            <p className="font-semibold text-green-900 text-sm">Em breve entraremos em contato!</p>
            <p className="text-sm text-green-800 mt-0.5">Você receberá a cobrança via <strong>WhatsApp</strong>. Fique de olho no número {order.customer_whatsapp}.</p>
          </div>
        </div>

        <div className="bg-white rounded-xl border p-5 space-y-4">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Cliente</p>
            <p className="font-semibold">{order.customer_name}</p>
            {order.customer_whatsapp && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                <Phone className="w-3 h-3" />{order.customer_whatsapp}
              </p>
            )}
            {order.customer_email && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                <Mail className="w-3 h-3" />{order.customer_email}
              </p>
            )}
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Itens do pedido</p>
            <div className="space-y-2">
              {(order.items || []).map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span>{item.product_name} <span className="text-muted-foreground">x{item.quantity}</span></span>
                  <span className="font-semibold">{formatCurrency(item.sale_price * item.quantity)}</span>
                </div>
              ))}
              <div className="border-t pt-2 flex items-center justify-between font-bold">
                <span>Total</span>
                <span className="text-blue-700">{formatCurrency(order.total_value)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
