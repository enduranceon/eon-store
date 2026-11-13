import { useEffect, useState } from 'react';
import { Loader2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExternalChargeFields } from '@/components/billing/ExternalChargeForm';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { supabase } from '@/api/db';
import { markOrderShipped, saveOrderExternalCharge } from '@/api/client';
import { parseShippingMoney, shipmentFormError, shippingChargeFormError } from '@/lib/order-shipping';
import { formatCurrency } from '@/lib/utils';

function moneyText(value) {
  return value === null || value === undefined || value === '' ? '' : String(value).replace('.', ',');
}

function emptyChargeForm() {
  return { link: '', due_date: '', payment_method: 'pix', invoice_number: '' };
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
  const [chargeNow, setChargeNow] = useState(true);
  const [chargeForm, setChargeForm] = useState(emptyChargeForm);
  const [messageTask, setMessageTask] = useState(null);
  const alreadyShipped = ['shipped', 'delivered'].includes(order?.delivery_status);

  useEffect(() => {
    if (!open) return;
    setTrackingCode(order?.tracking_code || '');
    setCost(moneyText(order?.shipping_cost));
    setPrice(moneyText(order?.shipping_cost));
    setPriceTouched(false);
    setChargeNow(true);
    setChargeForm(emptyChargeForm());
  }, [open, order?.tracking_code, order?.shipping_cost]);

  const changeCost = value => {
    setCost(value);
    // Até a pessoa mexer no valor a cobrar, ele acompanha o que foi pago.
    if (!priceTouched) setPrice(value);
  };

  const error = shipmentFormError({ trackingCode, cost, price, chargeExists });
  const paid = parseShippingMoney(cost);
  const charged = chargeExists ? null : parseShippingMoney(price);
  const willCharge = !chargeExists && Number.isFinite(charged) && charged > 0;
  const collectNow = willCharge && chargeNow;
  const chargeError = collectNow ? shippingChargeFormError(chargeForm) : null;

  const save = async () => {
    if (error) return toast.error(error);
    if (chargeError) return toast.error(chargeError);
    setSaving(true);
    try {
      const result = await markOrderShipped(orderType, order.id, {
        trackingCode: trackingCode.trim() || null,
        shippingCost: paid,
        shippingPrice: chargeExists ? 0 : charged,
      });
      const charge = result?.shipping_charge;
      const created = Boolean(charge && !chargeExists);
      toast.success(created
        ? `Enviado. Cobrança do frete ${charge.order_number || ''} criada (${formatCurrency(charge.total_value)}).`
        : alreadyShipped ? 'Envio atualizado.' : 'Pedido marcado como enviado.');

      // O envio já foi gravado. Se o link falhar, a cobrança do frete existe e
      // pode ser completada na própria cobrança; nada se perde.
      let linked = false;
      if (created && collectNow) {
        try {
          // Versão atual da cobrança recém-criada (evita conflito de edição).
          const { data: fresh } = await supabase.from('stock_orders')
            .select('updated_date, created_date').eq('id', charge.id).maybeSingle();
          await saveOrderExternalCharge('stock', charge.id, {
            externalLink: chargeForm.link.trim(),
            dueDate: chargeForm.due_date,
            paymentMethod: chargeForm.payment_method,
            invoiceNumber: chargeForm.invoice_number.trim() || null,
            expectedUpdatedAt: fresh?.updated_date || fresh?.created_date || charge.updated_date || charge.created_date,
          });
          linked = true;
          toast.success('Link da cobrança do frete salvo.');
        } catch (linkError) {
          toast.error(`${linkError.message || 'Não foi possível salvar o link'}. O envio foi registrado; complete o link na cobrança do frete.`);
        }
      }
      onOpenChange(false);
      onShipped?.(result);
      if (linked) {
        setMessageTask({ sourceType: 'stock', sourceId: charge.id, kind: 'charge_send', sourceUi: 'ship_dialog' });
      }
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
          {willCharge && (
            <div className="space-y-3 rounded-lg border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={chargeNow} disabled={saving}
                  onChange={event => setChargeNow(event.target.checked)} />
                Já cobrar agora
              </label>
              {chargeNow ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Gere a cobrança no Asaas e cole o link aqui. Ao salvar, abre a mensagem de cobrança para enviar à pessoa.
                  </p>
                  <ExternalChargeFields form={chargeForm} setForm={setChargeForm} saving={saving} />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A cobrança fica aguardando o link em Cobranças, como hoje.
                </p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={save} disabled={saving || Boolean(error) || Boolean(chargeError)}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
              {alreadyShipped ? 'Salvar' : 'Marcar como enviado'}
            </Button>
          </div>
        </div>
      </DialogContent>
      <CommunicationSendDialog
        task={messageTask}
        onClose={() => setMessageTask(null)}
        onChanged={() => onShipped?.()}
        onSent={() => setMessageTask(null)}
      />
    </Dialog>
  );
}
