import { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, ExternalLink, PackageCheck, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import ConfirmDialog from '@/components/ConfirmDialog';
import { updateOrderFulfillment } from '@/api/client';
import { fulfillmentStatus } from '@/lib/order-fulfillment';
import { nextFulfillmentStep } from '@/lib/order-board';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { toast } from 'sonner';

const TONES = {
  red: 'bg-red-100 text-red-700',
  amber: 'bg-amber-100 text-amber-800',
  blue: 'bg-blue-100 text-blue-700',
  violet: 'bg-violet-100 text-violet-700',
  gray: 'bg-gray-100 text-gray-600',
};

function Tag({ tone = 'gray', children }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${TONES[tone]}`}>{children}</span>;
}

function stageText(days) {
  if (days <= 0) return 'nesta etapa desde hoje';
  if (days === 1) return 'há 1 dia nesta etapa';
  return `há ${days} dias nesta etapa`;
}

function OrderBoardCard({ item, onOpen, onStep }) {
  const { order, signals } = item;
  const step = nextFulfillmentStep(order);
  const StepIcon = step?.status === 'delivered' ? CheckCircle2 : step?.status === 'separated' ? PackageCheck : Truck;
  const waitingPayment = ['awaiting_charge', 'charge_sent'].includes(signals.column);
  return (
    <div className={`rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md ${signals.overdueDays > 0 ? 'border-l-4 border-l-red-500' : ''}`}>
      <button
        type="button"
        onClick={() => onOpen(order)}
        className="w-full text-left p-3 space-y-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[11px] font-semibold text-gray-500">{order.order_number || 'Sem número'}</p>
            <p className="text-sm font-semibold text-gray-950 leading-tight mt-0.5">{order.customer}</p>
            {order.trainer && <p className="text-[11px] text-muted-foreground">Treinador: {order.trainer}</p>}
          </div>
          <span className="text-xs font-bold text-gray-800 shrink-0">{formatCurrency(order.total)}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Tag tone={order.type === 'stock' ? 'blue' : 'violet'}>{order.campaignName || order.typeLabel}</Tag>
          {order.delivery_method === 'shipping' && <Tag>Frete</Tag>}
          {order.delivery_method === 'pickup' && <Tag>Retirada</Tag>}
          {signals.column === 'supplier' && <Tag tone="blue">{fulfillmentStatus('presale', order.delivery_status || 'awaiting_supplier').label}</Tag>}
          {signals.overdueDays > 0 && <Tag tone="red">Vencida há {signals.overdueDays} {signals.overdueDays === 1 ? 'dia' : 'dias'}</Tag>}
          {signals.unpaid && <Tag tone="amber">Falta pagamento</Tag>}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {signals.column === 'delivered' && order.delivery_date
            ? `Entregue em ${formatDate(order.delivery_date)}`
            : stageText(signals.daysInStage)}
          {waitingPayment && order.due_date && !signals.overdueDays && ` · vence ${formatDate(order.due_date)}`}
        </p>
        {!order.customer_id && (
          <p className="flex items-center gap-1 text-[11px] text-amber-800">
            <AlertTriangle className="h-3 w-3" /> Sem cadastro de cliente vinculado
          </p>
        )}
      </button>
      {(step || waitingPayment) && (
        <div className="flex gap-1.5 px-3 pb-3">
          {step ? (
            <>
              <Button size="sm" className="flex-1 min-w-0 h-8 px-2" title={step.label} onClick={() => onStep(order, step)}>
                <StepIcon className="w-3.5 h-3.5 mr-1 shrink-0" /> <span className="truncate">{step.short}</span>
              </Button>
              <Button size="sm" variant="outline" className="h-8 px-2 shrink-0" title="Abrir pedido" onClick={() => onOpen(order)}>
                <ChevronRight className="w-4 h-4" />
                <span className="sr-only">Abrir pedido</span>
              </Button>
            </>
          ) : (
            // A cobrança e o pagamento são feitos dentro do pedido.
            <Button size="sm" variant="outline" className="flex-1 min-w-0 h-8 px-2" onClick={() => onOpen(order)}>
              <ExternalLink className="w-3.5 h-3.5 mr-1 shrink-0" />
              <span className="truncate">{signals.column === 'awaiting_charge' ? 'Enviar cobrança' : 'Registrar pagamento'}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Quadro dos pedidos. As colunas e a ordem vêm de buildOrderBoard; aqui só se
// desenha e se confirma a próxima etapa de entrega.
export default function OrderBoard({ board, hasFilters, onOpen, onChanged }) {
  const [pending, setPending] = useState(null);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [busy, setBusy] = useState(false);

  const askStep = (order, step) => {
    setDeliveryDate(todayLocalStr());
    setPending({ order, step });
  };

  const confirmStep = async () => {
    if (!pending) return;
    const { order, step } = pending;
    if (step.needsDate && !deliveryDate) return toast.error('Informe a data da entrega');
    setBusy(true);
    try {
      await updateOrderFulfillment(order.type, order.id, {
        deliveryStatus: step.status,
        deliveryDate: step.needsDate ? deliveryDate : null,
      });
      toast.success(`${order.order_number || 'Pedido'}: ${fulfillmentStatus(order.type, step.status).label}`);
      setPending(null);
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="relative overflow-x-auto pb-2 -mx-1 px-1">
        <div className="grid gap-3 items-start" style={{ gridTemplateColumns: `repeat(${board.columns.length}, minmax(232px, 1fr))` }}>
          {board.columns.map(column => (
            <section
              key={column.id}
              className="min-w-0 flex flex-col rounded-2xl border bg-slate-50/70 p-3 lg:max-h-[calc(100vh-7rem)]"
              aria-label={column.title}
            >
              <div className="mb-3 flex shrink-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${column.dot}`} aria-hidden="true" />
                    {column.title}
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-snug">{column.hint}</p>
                  {column.items.length > 0 && column.id !== 'cancelled' && (
                    <p className="text-[11px] font-semibold text-gray-700 mt-0.5">{formatCurrency(column.total)}</p>
                  )}
                </div>
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${column.badge}`}>{column.items.length}</span>
              </div>
              {column.items.length === 0 ? (
                <div className="rounded-xl border border-dashed bg-white/70 px-3 py-8 text-center text-xs text-muted-foreground">
                  {hasFilters ? 'Nada com esses filtros.' : 'Nenhum pedido aqui.'}
                </div>
              ) : (
                <div className="space-y-2 lg:min-h-0 lg:overflow-y-auto lg:-m-1 lg:p-1">
                  {column.items.map(item => (
                    <OrderBoardCard key={`${item.order.type}:${item.order.id}`} item={item} onOpen={onOpen} onStep={askStep} />
                  ))}
                </div>
              )}
              {column.id === 'delivered' && board.olderDelivered > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {board.olderDelivered} {board.olderDelivered === 1 ? 'entregue mais antigo está' : 'entregues mais antigos estão'} na lista.
                </p>
              )}
            </section>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={open => { if (!open) setPending(null); }}
        title={pending ? `${pending.step.label}?` : ''}
        icon={ArrowRight}
        iconClassName="text-blue-600"
        confirmLabel={pending?.step.label || 'Confirmar'}
        busy={busy}
        onConfirm={confirmStep}
      >
        {pending && (
          <>
            <p>
              <b>{pending.order.order_number || 'Pedido'}</b> · {pending.order.customer} passa para
              {' '}<b>{fulfillmentStatus(pending.order.type, pending.step.status).label}</b>.
            </p>
            {pending.step.needsDate && (
              <div>
                <Label htmlFor="order-board-delivery-date">Data da entrega</Label>
                <Input id="order-board-delivery-date" type="date" className="mt-1" value={deliveryDate}
                  max={todayLocalStr()} onChange={event => setDeliveryDate(event.target.value)} />
              </div>
            )}
            {pending.order.payment_status !== 'paid' && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Este pedido ainda não está pago. A entrega muda; a cobrança continua em aberto.
              </p>
            )}
            <p className="text-xs text-muted-foreground">A etapa de entrega não volta atrás. Interromper a entrega continua dentro do pedido.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
