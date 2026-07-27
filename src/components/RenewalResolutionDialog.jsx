import { useState } from 'react';
import { Ban, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { resolveAssessmentRenewal } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDate, todayLocalStr } from '@/lib/utils';
import { isSafePaymentUrl } from '@/lib/sales';
import { canResolveAssessmentRenewal } from '@/lib/assessment-renewal-resolution';

const REASON_BY_CHOICE = {
  customer_declined: 'Atleta decidiu não renovar',
  duplicate: 'Renovação criada em duplicidade',
  created_in_error: 'Renovação criada por engano',
};

export default function RenewalResolutionDialog({
  target,
  onClose,
  onResolved,
  onRefresh,
}) {
  const { contract, parent, customerName, initialChoice = '' } = target;
  const [choice, setChoice] = useState(initialChoice);
  const [externalConfirmed, setExternalConfirmed] = useState(false);
  const [externalNote, setExternalNote] = useState('');
  const [noServiceStartedConfirmed, setNoServiceStartedConfirmed] = useState(false);
  const [resolving, setResolving] = useState(false);

  const isNonRenewal = choice === 'customer_declined';
  const hasExternalReference = !!(
    contract.external_payment_link || contract.external_invoice_number
  );
  const hasMixedCharge = !!contract.asaas_charge_id && hasExternalReference;
  const needsExternalConfirmation = hasExternalReference && !contract.asaas_charge_id;
  const mayHaveStarted = ['active', 'overdue', 'on_leave'].includes(contract.status)
    || (!!contract.start_date && contract.start_date <= todayLocalStr());
  const safeExternalLink = isSafePaymentUrl(contract.external_payment_link)
    ? contract.external_payment_link
    : null;

  const submit = async () => {
    const reason = REASON_BY_CHOICE[choice];
    if (!reason) return toast.error('Escolha o que aconteceu com a renovação');
    if (!canResolveAssessmentRenewal(contract)) {
      return toast.error('Esta renovação mudou ou possui movimentação financeira; atualize a lista');
    }
    if (hasMixedCharge) {
      return toast.error('A venda possui cobranças Asaas e externa ao mesmo tempo e precisa de conferência');
    }
    if (needsExternalConfirmation && !externalConfirmed) {
      return toast.error('Confirme que a cobrança externa foi cancelada no provedor');
    }
    if (needsExternalConfirmation && externalNote.trim().length < 3) {
      return toast.error('Informe onde ou como a cobrança externa foi cancelada');
    }
    if (mayHaveStarted && !noServiceStartedConfirmed) {
      return toast.error('Confirme que a nova vigência não chegou a começar na prática');
    }

    setResolving(true);
    try {
      const result = await resolveAssessmentRenewal(contract.id, {
        resolution: isNonRenewal ? 'non_renewal' : 'discard',
        reasonCode: choice,
        reason,
        expectedUpdatedAt: contract.updated_at,
        expectedPaymentStatus: contract.payment_status,
        expectedChargeId: contract.asaas_charge_id || null,
        externalCancellationConfirmed: needsExternalConfirmation ? externalConfirmed : false,
        externalConfirmationNote: needsExternalConfirmation ? externalNote.trim() : null,
        serviceStarted: false,
      });

      toast.success(isNonRenewal
        ? 'Renovação encerrada e “Não renovou” registrado no contrato anterior.'
        : 'Venda de renovação descartada sem registrar saída da atleta.');
      onClose();
      await onResolved?.(result);
    } catch (error) {
      const protocol = error.details?.operation_id
        ? ` Protocolo: ${error.details.operation_id}.`
        : '';
      if (error.code === 'reconciliation_required') {
        toast.error(`A operação precisa de conferência. Não repita nem gere outra cobrança.${protocol}`);
      } else if (error.code === 'operation_in_progress') {
        toast.info(`O encerramento já está sendo processado. Aguarde antes de tentar novamente.${protocol}`);
      } else {
        toast.error(`${error.message || 'Erro ao encerrar renovação'}${protocol}`);
      }

      if (['reconciliation_required', 'invalid_transition', 'not_found'].includes(error.code)) {
        onClose();
        await onRefresh?.();
      }
    } finally {
      setResolving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && !resolving && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-700">
            <Ban className="w-5 h-5" /> Encerrar renovação
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          <div className="rounded-lg border bg-gray-50 p-3 text-sm">
            <p className="font-mono font-semibold text-blue-700">{contract.contract_number}</p>
            <p className="font-semibold text-gray-900">{customerName || 'Aluno'}</p>
            {parent && (
              <p className="text-xs text-muted-foreground mt-1">
                Renovação de {parent.contract_number}, com fim em {formatDate(parent.end_date)}
              </p>
            )}
          </div>

          <div>
            <Label>O que aconteceu?</Label>
            <Select value={choice} onValueChange={setChoice} disabled={resolving}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Selecione uma opção" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="customer_declined">Atleta não vai continuar</SelectItem>
                <SelectItem value="duplicate">Venda criada em duplicidade</SelectItem>
                <SelectItem value="created_in_error">Venda criada por engano</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground mt-1">
              Para mudar plano ou valor, use “Trocar plano”; isso não é uma saída da atleta.
            </p>
          </div>

          {hasMixedCharge && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 space-y-1">
              <p>Esta venda possui referências de cobrança Asaas e externa ao mesmo tempo. Faça a conferência antes de encerrá-la.</p>
              {contract.external_invoice_number && (
                <p className="text-xs">Fatura externa: <b className="font-mono">{contract.external_invoice_number}</b></p>
              )}
              {safeExternalLink && (
                <a className="block text-xs text-blue-700 underline break-all" href={safeExternalLink} target="_blank" rel="noreferrer">
                  Abrir a cobrança externa
                </a>
              )}
            </div>
          )}

          {contract.asaas_charge_id && !hasMixedCharge && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              A cobrança criada pela API do Asaas será cancelada antes de a venda ser descartada.
            </div>
          )}

          {needsExternalConfirmation && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3">
              <p className="text-sm text-amber-900">
                Esta cobrança foi cadastrada externamente. O EON não consegue cancelá-la no provedor.
              </p>
              {contract.external_invoice_number && (
                <p className="text-xs text-amber-900">Fatura: <b className="font-mono">{contract.external_invoice_number}</b></p>
              )}
              {safeExternalLink && (
                <a className="text-xs text-blue-700 underline break-all" href={safeExternalLink} target="_blank" rel="noreferrer">
                  Abrir a cobrança externa
                </a>
              )}
              <label className="flex items-start gap-2 text-sm text-amber-900 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={externalConfirmed}
                  onChange={event => setExternalConfirmed(event.target.checked)}
                  disabled={resolving}
                />
                <span>Confirmo que cancelei essa cobrança no sistema externo.</span>
              </label>
              <div>
                <Label>Onde ou como foi cancelada?</Label>
                <Input
                  className="mt-1"
                  placeholder="Ex.: cancelada no painel do provedor"
                  maxLength={500}
                  value={externalNote}
                  onChange={event => setExternalNote(event.target.value)}
                  disabled={resolving}
                />
              </div>
            </div>
          )}

          {mayHaveStarted && (
            <label className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={noServiceStartedConfirmed}
                onChange={event => setNoServiceStartedConfirmed(event.target.checked)}
                disabled={resolving}
              />
              <span>
                Confirmo que a nova vigência não começou na prática. Se houve atendimento, devo usar cancelamento de contrato efetivo.
              </span>
            </label>
          )}

          <div className={`rounded-lg border p-3 text-sm ${isNonRenewal ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50 text-gray-800'}`}>
            {!choice ? (
              <>Escolha acima se houve uma saída real da atleta ou apenas um erro na venda.</>
            ) : isNonRenewal ? (
              <>A venda ficará <b>descartada</b> e o contrato anterior receberá <b>“Não renovou”</b>, sem multa ou estorno.</>
            ) : (
              <>Apenas a venda ficará <b>descartada</b>, sem registrar saída. Uma renovação correta poderá ser criada depois.</>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" disabled={resolving} onClick={onClose}>
              Voltar
            </Button>
            <Button
              type="button"
              className="bg-amber-600 hover:bg-amber-700 text-white"
              disabled={
                resolving
                || !choice
                || hasMixedCharge
                || (needsExternalConfirmation && (
                  !externalConfirmed || externalNote.trim().length < 3
                ))
                || (mayHaveStarted && !noServiceStartedConfirmed)
              }
              onClick={submit}
            >
              {resolving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              {resolving ? 'Processando...' : 'Confirmar encerramento'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
