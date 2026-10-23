import { useEffect, useState } from 'react';
import { Loader2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { markOrderShipped } from '@/api/client';
import { parseShippingMoney, shipmentFormError } from '@/lib/order-shipping';
import { formatCurrency } from '@/lib/utils';

function moneyText(value) {
  return value === null || value === undefined || value === '' ? '' : String(value).replace('.', ',');
}

// Marca o pedido com frete como Enviado: rastreio, quanto foi pago e quanto vai
// ser cobrado. Com valor a cobrar, o backend cria a cobrança do frete. Também
// serve para corrigir o envio (rastreio e custo) e para cobrar o frete depois.
export default function ShipOrderDialog({ open, onOpenChange, orderType, order, chargeExists = false, onShipped }) {
  const [trackingCode, setTrackingCode] = useState('');
  const [cost, setCost] = useState('');
  const [price, setPrice] = useState('');
  const [priceTouched, setPriceTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const alreadyShipped = ['shipped', 'delivered'].includes(order?.delivery_status);

  useEffect(() => {
    if (!open) return;
    setTrackingCode(order?.tracking_code || '');
    setCost(moneyText(order?.shipping_cost));
    setPrice(moneyText(order?.shipping_cost));
    setPriceTouched(false);
  }, [open, order?.tracking_code, order?.shipping_cost]);

  const changeCost = value => {
    setCost(value);
    // Até a pessoa mexer no valor a cobrar, ele acompanha o que foi pago.
    if (!priceTouched) setPrice(value);
  };

  const error = shipmentFormError({ trackingCode, cost, price, chargeExists });
  const paid = parseShippingMoney(cost);
  const charged = chargeExists ? null : parseShippingMoney(price);

  const save = async () => {
    if (error) return toast.error(error);
    setSaving(true);
    try {
      const result = await markOrderShipped(orderType, order.id, {
        trackingCode: trackingCode.trim() || null,
        shippingCost: paid,
        shippingPrice: chargeExists ? 0 : charged,
      });
      const charge = result?.shipping_charge;
      toast.success(charge && !chargeExists
        ? `Enviado. Cobrança do frete ${charge.order_number || ''} criada (${formatCurrency(charge.total_value)}).`
        : alreadyShipped ? 'Envio atualizado.' : 'Pedido marcado como enviado.');
      onOpenChange(false);
      onShipped?.(result);
    } catch (e) {
      toast.error(e.message || 'Não foi possível registrar o envio');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="w-4 h-4" /> {alreadyShipped ? (chargeExists ? 'Corrigir envio' : 'Envio e cobrança do frete') : 'Marcar como enviado'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <b className="text-gray-900">{order?.order_number || 'Pedido'}</b>
            {order?.customer_name || order?.customer ? ` · ${order.customer_name || order.customer}` : ''}
          </p>
          <div>
            <Label htmlFor="ship-tracking">Código de rastreio</Label>
            <Input id="ship-tracking" className="mt-1" value={trackingCode} maxLength={80}
              placeholder="Opcional" onChange={event => setTrackingCode(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ship-cost">Quanto paguei</Label>
              <Input id="ship-cost" className="mt-1" inputMode="decimal" value={cost} placeholder="0,00"
                onChange={event => changeCost(event.target.value)} />
            </div>
            {!chargeExists && (
              <div>
                <Label htmlFor="ship-price">Quanto vou cobrar</Label>
                <Input id="ship-price" className="mt-1" inputMode="decimal" value={price} placeholder="0,00"
                  onChange={event => { setPriceTouched(true); setPrice(event.target.value); }} />
              </div>
            )}
          </div>
          {chargeExists ? (
            <p className="text-xs text-muted-foreground">
              A cobrança do frete já existe. Aqui só se corrige o rastreio e quanto foi pago; o valor cobrado muda na própria cobrança.
            </p>
          ) : (
            <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-950">
              {Number.isFinite(charged) && charged > 0
                ? <>Cria a cobrança do frete de <b>{formatCurrency(charged)}</b> para a mesma pessoa. Ela aparece em Cobranças e na Central, como qualquer pedido.</>
                : 'Com zero, o frete fica grátis: só registra o envio, sem cobrança.'}
              {' '}O que você pagou entra como despesa da loja no Financeiro.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={save} disabled={saving || Boolean(error)}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
              {alreadyShipped ? 'Salvar' : 'Marcar como enviado'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
