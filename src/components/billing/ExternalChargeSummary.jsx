import { Calendar, Check, Copy, HandCoins, Link2, MessageCircle, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { externalChargeMethodLabel, normalizeExternalChargeMethod } from '@/lib/external-charge';

export default function ExternalChargeSummary({
  externalLink,
  paymentMethod,
  installments,
  invoiceNumber,
  dueDateLabel,
  messageSentLabel,
  onCopy,
  onMessage,
  onEdit,
  onRemove,
  onRecordPayment,
  removing = false,
  paymentActionLabel = 'Registrar pagamento',
}) {
  if (!externalLink) return null;

  const paymentMethodLabel = externalChargeMethodLabel(
    normalizeExternalChargeMethod(paymentMethod, installments),
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-amber-600 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-amber-800">Cobrança externa registrada</p>
            <p className="text-sm text-amber-700 truncate" title={externalLink}>{externalLink}</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              {paymentMethodLabel}
              {invoiceNumber && <> · Fatura <span className="font-mono font-semibold">{invoiceNumber}</span></>}
            </p>
          </div>
          {onCopy && (
            <Button size="sm" variant="outline" onClick={onCopy} title="Copiar link da cobrança" aria-label="Copiar link da cobrança">
              <Copy className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
          <span className="flex items-center gap-1.5 text-amber-700">
            <Calendar className="w-3.5 h-3.5" />
            Vence em <strong>{dueDateLabel || '—'}</strong>
          </span>
          {messageSentLabel ? (
            <span className="flex items-center gap-1 text-green-700">
              <Check className="w-3.5 h-3.5" /> Mensagem enviada {messageSentLabel}
            </span>
          ) : (
            <span className="text-amber-700 italic">Mensagem pendente</span>
          )}
        </div>
      </div>

      <div className="flex gap-2 justify-center flex-wrap border-t pt-3">
        {onMessage && (
          <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={onMessage}>
            <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> Mensagem
          </Button>
        )}
        {onEdit && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Editar cobrança
          </Button>
        )}
        {onRemove && (
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 border-red-200 hover:bg-red-50"
            onClick={onRemove}
            disabled={removing}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Remover
          </Button>
        )}
        {onRecordPayment && (
          <Button size="sm" variant="outline" className="text-green-700 border-green-300 hover:bg-green-50" onClick={onRecordPayment}>
            <HandCoins className="w-3.5 h-3.5 mr-1.5" /> {paymentActionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
