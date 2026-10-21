import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/api/db';
import ShipOrderDialog from '@/components/orders/ShipOrderDialog';
import {
  currentShippingCharge,
  isOpenShippingCharge,
  isShippingCharge,
  shipsByCarrier,
} from '@/lib/order-shipping';
import { formatCurrency, formatDate } from '@/lib/utils';

const CHARGE_STATUS = {
  pending: { label: 'Aguardando cobrança', badge: 'secondary' },
  awaiting_charge: { label: 'Aguardando cobrança', badge: 'secondary' },
  charge_sent: { label: 'Cobrança enviada', badge: 'info' },
  overdue: { label: 'Cobrança vencida', badge: 'warning' },
  partially_paid: { label: 'Parcialmente pago', badge: 'warning' },
  paid: { label: 'Pago', badge: 'success' },
  cancelled: { label: 'Cancelada', badge: 'destructive' },
  refunded: { label: 'Reembolsada', badge: 'outline' },
};

function orderPath(type, id) {
  return type === 'presale' ? `/pedidos/${id}` : `/estoque/pedidos/${id}`;
}

// Na cobrança do frete: de qual pedido ela é.
function ShippingChargeOrigin({ order }) {
  const navigate = useNavigate();
  const [parent, setParent] = useState(null);

  useEffect(() => {
    let alive = true;
    const table = order.shipping_parent_type === 'presale' ? 'presale_orders' : 'stock_orders';
    supabase.from(table)
      .select('id, order_number, tracking_code, shipped_at')
      .eq('id', order.shipping_parent_id)
      .maybeSingle()
      .then(({ data }) => { if (alive) setParent(data || null); });
    return () => { alive = false; };
  }, [order.shipping_parent_id, order.shipping_parent_type]);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
      <Truck className="w-4 h-4 shrink-0 text-sky-700" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Cobrança do frete do pedido {parent?.order_number || ''}</p>
        <p className="text-xs text-sky-900/80">
          {parent?.shipped_at ? `Enviado em ${formatDate(parent.shipped_at)}` : 'Criada no envio do pedido'}
          {parent?.tracking_code ? ` · rastreio ${parent.tracking_code}` : ''}
          {' '}· sem etapa de entrega; cobre e receba como um pedido normal.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => navigate(orderPath(order.shipping_parent_type, order.shipping_parent_id))}>
        <ExternalLink className="w-3.5 h-3.5" /> Abrir pedido
      </Button>
    </div>
  );
}

// Envio e frete do pedido com entrega por frete: marcar como enviado, ver o
// rastreio, o que foi pago e a cobrança do frete (ou cobrar depois).
function ShippingCard({ orderType, order, onChanged }) {
  const navigate = useNavigate();
  const [charges, setCharges] = useState(null);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.from('stock_orders')
      .select('id, order_number, total_value, payment_status, created_date')
      .eq('shipping_parent_type', orderType)
      .eq('shipping_parent_id', order.id)
      .then(({ data }) => { if (alive) setCharges(data || []); });
    return () => { alive = false; };
  }, [orderType, order.id, order.updated_date, order.shipped_at, order.delivery_status]);

  const charge = currentShippingCharge(charges || []);
  const chargeOpen = isOpenShippingCharge(charge);
  const status = order.delivery_status;
  const shipped = ['shipped', 'delivered'].includes(status);
  const canShip = status === 'separated';
  const chargeStatus = charge ? CHARGE_STATUS[charge.payment_status] || { label: charge.payment_status, badge: 'secondary' } : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2"><Truck className="w-4 h-4" /> Envio e frete</CardTitle>
          {canShip && <Button size="sm" onClick={() => setDialog(true)}><Truck className="w-3.5 h-3.5" /> Marcar como enviado</Button>}
          {shipped && (
            <Button size="sm" variant="outline" onClick={() => setDialog(true)}>
              {chargeOpen ? 'Corrigir envio' : 'Cobrar frete'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!shipped && !canShip && status !== 'cancelled' && (
          <p className="text-muted-foreground">Depois de separar o pedido, marque como enviado aqui com o rastreio e o valor do frete. A cobrança do frete sai nessa hora.</p>
        )}
        {status === 'cancelled' && !order.shipped_at && <p className="text-muted-foreground">Entrega interrompida; o pedido não foi enviado.</p>}
        {canShip && (
          <p className="text-muted-foreground">Pedido separado. Ao enviar, informe quanto pagou e quanto vai cobrar: o frete é cobrado à parte, numa cobrança ligada a este pedido.</p>
        )}
        {(shipped || order.shipped_at) && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">Enviado em</dt><dd className="font-medium">{order.shipped_at ? formatDate(order.shipped_at) : '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Rastreio</dt><dd className="font-medium font-mono break-all">{order.tracking_code || '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Quanto paguei</dt><dd className="font-medium">{order.shipping_cost === null || order.shipping_cost === undefined ? '—' : formatCurrency(order.shipping_cost)}</dd></div>
          </dl>
        )}
        {charge ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <span className="font-medium">Cobrança do frete</span>
            <span className="font-mono text-xs text-muted-foreground">{charge.order_number}</span>
            <span className="font-semibold">{formatCurrency(charge.total_value)}</span>
            <Badge variant={chargeStatus.badge}>{chargeStatus.label}</Badge>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigate(orderPath('stock', charge.id))}>
              <ExternalLink className="w-3.5 h-3.5" /> Abrir cobrança
            </Button>
          </div>
        ) : shipped && charges !== null && (
          <p className="text-xs text-muted-foreground">Sem cobrança de frete (frete grátis). Use “Cobrar frete” se for cobrar.</p>
        )}
        {charge && !chargeOpen && shipped && (
          <p className="text-xs text-muted-foreground">A cobrança anterior foi {charge.payment_status === 'refunded' ? 'reembolsada' : 'cancelada'}. “Cobrar frete” cria outra.</p>
        )}
      </CardContent>
      <ShipOrderDialog
        open={dialog}
        onOpenChange={setDialog}
        orderType={orderType}
        order={order}
        chargeExists={chargeOpen}
        onShipped={() => onChanged?.()}
      />
    </Card>
  );
}

export default function OrderShipping({ orderType, order, onChanged }) {
  if (isShippingCharge(order)) return <ShippingChargeOrigin order={order} />;
  if (!shipsByCarrier(order)) return null;
  return <ShippingCard orderType={orderType} order={order} onChanged={onChanged} />;
}
