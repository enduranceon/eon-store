import { useMemo, useState } from 'react';
import { Copy, ExternalLink, MessageCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  recordContractParcelPayment,
  removeContractParcels,
  reopenContractParcelPayment,
  syncContractParcels,
} from '@/api/client';
import {
  carneProgressLabel,
  formatBrl,
  parcelMessage,
  parcelState,
  parcelsSummary,
} from '@/lib/contract-parcels';
import { formatDate, todayLocalStr } from '@/lib/utils';

const TONE_VARIANT = {
  success: 'success',
  info: 'info',
  danger: 'destructive',
  warning: 'warning',
  muted: 'secondary',
};

const CONFIRM_COPY = {
  record: {
    title: 'Registrar pagamento da parcela',
    action: 'Registrar pagamento',
    busy: 'Registrando…',
  },
  reopen: {
    title: 'Desfazer o registro da parcela',
    action: 'Desfazer registro',
    busy: 'Desfazendo…',
  },
  remove: {
    title: 'Remover o carnê do contrato',
    action: 'Remover carnê',
    busy: 'Removendo…',
  },
};

// Parcelas de boleto/PIX parcelado (carnê) do contrato. O Asaas só é lido: cada
// parcela traz o seu link, e o pagamento é registrado parcela a parcela.
export default function ContractParcelsCard({ contract, parcels, studentName, onChanged }) {
  const today = todayLocalStr();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type, parcel? }

  const summary = useMemo(() => parcelsSummary(parcels, today), [parcels, today]);
  const sorted = useMemo(
    () => [...parcels].sort((a, b) => a.installment_number - b.installment_number),
    [parcels],
  );
  const firstName = String(studentName || '').trim().split(/\s+/)[0] || '';

  async function run(task, successMessage) {
    setBusy(true);
    try {
      await task();
      toast.success(successMessage);
      setConfirm(null);
      onChanged?.();
    } catch (e) {
      toast.error(e.message || 'Não foi possível concluir');
    } finally {
      setBusy(false);
    }
  }

  const syncParcels = () => run(
    () => syncContractParcels(contract.id),
    'Parcelas atualizadas com o Asaas',
  );

  function confirmAction() {
    if (!confirm) return;
    if (confirm.type === 'record') {
      run(
        () => recordContractParcelPayment(contract.id, confirm.parcel.id, contract.updated_at),
        `Parcela ${confirm.parcel.installment_number}/${confirm.parcel.total_installments} registrada como paga`,
      );
    } else if (confirm.type === 'reopen') {
      run(
        () => reopenContractParcelPayment(contract.id, confirm.parcel.id, contract.updated_at),
        'Registro da parcela desfeito',
      );
    } else {
      run(() => removeContractParcels(contract.id, contract.updated_at), 'Carnê removido do contrato');
    }
  }

  const copy = (text, message) => {
    navigator.clipboard.writeText(text);
    toast.success(message);
  };

  const confirmParcel = confirm?.parcel;
  const copyText = confirm ? CONFIRM_COPY[confirm.type] : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">Parcelas do Asaas (carnê)</CardTitle>
          <Button size="sm" variant="outline" onClick={syncParcels} disabled={busy}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${busy ? 'animate-spin' : ''}`} /> Atualizar parcelas
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{carneProgressLabel(summary)}</p>
        {summary.pendingRecord > 0 && (
          <p className="text-xs text-blue-700">
            {summary.pendingRecord === 1
              ? '1 parcela já está paga no Asaas e falta registrar aqui.'
              : `${summary.pendingRecord} parcelas já estão pagas no Asaas e faltam registrar aqui.`}
          </p>
        )}
        {summary.overdue > 0 && (
          <p className="text-xs text-red-700">
            {summary.overdue === 1 ? '1 parcela vencida.' : `${summary.overdue} parcelas vencidas.`}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="border rounded-xl divide-y overflow-hidden">
          {sorted.map(parcel => {
            const state = parcelState(parcel, today);
            return (
              <div key={parcel.id} className="flex items-center gap-2 px-3 py-2 text-sm flex-wrap">
                <span className="text-xs font-bold text-muted-foreground w-10 shrink-0">
                  {parcel.installment_number}/{parcel.total_installments}
                </span>
                <div className="flex-1 min-w-[8rem]">
                  <p className="font-semibold text-sm">{formatBrl(parcel.value)}</p>
                  <p className="text-xs text-muted-foreground">vence {formatDate(parcel.due_date)}</p>
                </div>
                <Badge variant={TONE_VARIANT[state.tone]}>{state.label}</Badge>
                <div className="flex items-center gap-1 ml-auto">
                  {parcel.invoice_url && (
                    <>
                      <Button
                        size="sm" variant="ghost" title="Copiar link da parcela" aria-label="Copiar link da parcela"
                        onClick={() => copy(parcel.invoice_url, 'Link da parcela copiado')}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" asChild title="Abrir no Asaas">
                        <a href={parcel.invoice_url} target="_blank" rel="noreferrer" aria-label="Abrir parcela no Asaas">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </Button>
                      {state.key !== 'recorded' && (
                        <Button
                          size="sm" variant="ghost" title="Copiar mensagem com o link desta parcela"
                          aria-label="Copiar mensagem com o link desta parcela"
                          onClick={() => copy(parcelMessage({ firstName, parcel }), 'Mensagem copiada')}
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </>
                  )}
                  {state.key === 'paid_unrecorded' && (
                    <Button size="sm" disabled={busy} onClick={() => setConfirm({ type: 'record', parcel })}>
                      Registrar pagamento
                    </Button>
                  )}
                  {state.key === 'recorded' && (
                    <Button
                      size="sm" variant="ghost" disabled={busy} title="Desfazer o registro desta parcela"
                      aria-label="Desfazer o registro desta parcela"
                      onClick={() => setConfirm({ type: 'reopen', parcel })}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] text-muted-foreground">
          O sistema só lê o Asaas: as parcelas são criadas e cobradas lá. O pagamento de cada parcela só é registrado
          depois de conferir no Asaas e com o CPF da pessoa. A renovação conta como renovada desde a primeira parcela registrada.
        </p>

        {summary.recorded === 0 && (
          <button
            type="button"
            onClick={() => setConfirm({ type: 'remove' })}
            className="text-xs text-red-600 hover:underline flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remover o carnê do contrato (para registrar a cobrança de outro jeito)
          </button>
        )}
      </CardContent>

      <Dialog open={Boolean(confirm)} onOpenChange={next => { if (!next && !busy) setConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{copyText?.title}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {confirm?.type === 'record' && confirmParcel && (
                  <>
                    <p>
                      Parcela <strong>{confirmParcel.installment_number}/{confirmParcel.total_installments}</strong>
                      {' '}de <strong>{formatBrl(confirmParcel.value)}</strong>
                      {confirmParcel.paid_date && <>, paga em {formatDate(confirmParcel.paid_date)}</>}
                      {confirmParcel.credit_date && <> (crédito em {formatDate(confirmParcel.credit_date)})</>}.
                    </p>
                    <p>O sistema confere o Asaas e o CPF da pessoa de novo antes de gravar. As taxas não são registradas.</p>
                  </>
                )}
                {confirm?.type === 'reopen' && confirmParcel && (
                  <p>
                    O pagamento da parcela {confirmParcel.installment_number}/{confirmParcel.total_installments} volta a ficar em
                    aberto aqui (no Asaas nada muda). Use se o registro foi um erro.
                  </p>
                )}
                {confirm?.type === 'remove' && (
                  <p>As parcelas importadas saem do contrato e a forma de pagamento volta ao que era antes. Nada muda no Asaas.</p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={() => setConfirm(null)}>Cancelar</Button>
            <Button className="flex-1" disabled={busy} onClick={confirmAction}>
              {busy ? copyText?.busy : copyText?.action}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
