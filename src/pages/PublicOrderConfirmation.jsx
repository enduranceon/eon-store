import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CheckCircle2, Package, Phone, Mail, Store } from 'lucide-react';
import { PreSaleOrder, PreSaleCampaign } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';

export default function PublicOrderConfirmation() {
  const { orderId } = useParams();
  const [order, setOrder] = useState(null);
  const [campaign, setCampaign] = useState(null);

  useEffect(() => {
    PreSaleOrder.get(orderId).then(o => {
      setOrder(o);
      if (o.campaign_id) PreSaleCampaign.get(o.campaign_id).then(setCampaign).catch(() => {});
    }).catch(() => {});
  }, [orderId]);

  if (!order) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-blue-600 text-white py-4 px-4">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <Store className="w-4 h-4" />
          <span className="font-semibold">EON Store</span>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-10">
        {/* Sucesso */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-9 h-9 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Pedido confirmado!</h1>
          <p className="text-muted-foreground mt-2">Seu pedido foi registrado com sucesso.</p>
        </div>

        {/* Número do pedido */}
        <div className="bg-blue-600 text-white rounded-xl p-6 text-center mb-6">
          <p className="text-sm opacity-80 mb-1">Número do pedido</p>
          <p className="text-3xl font-bold font-mono tracking-wider">{order.order_number}</p>
        </div>

        {/* Dados do pedido */}
        <div className="bg-white rounded-xl border p-5 space-y-4 mb-4">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Campanha</p>
            <p className="font-semibold">{campaign?.name || 'Pré-venda'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Cliente</p>
            <p className="font-semibold">{order.checkout_name}</p>
            {order.checkout_whatsapp && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                <Phone className="w-3 h-3" />{order.checkout_whatsapp}
              </p>
            )}
            {order.checkout_email && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                <Mail className="w-3 h-3" />{order.checkout_email}
              </p>
            )}
          </div>

          {/* Itens */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">Itens do pedido</p>
            <div className="space-y-2">
              {(order.items || []).map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span>{item.product_name}{item.variation ? ` - ${item.variation}` : ''} <span className="text-muted-foreground">x{item.quantity}</span></span>
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
