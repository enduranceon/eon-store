import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/api/db';
import { registerAssessmentContractRefund } from '@/api/client';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import {
  REFUND_METHODS,
  defaultAlreadyCredited,
  isCardRefundMethod,
  isDifferentFromCalculated,
  refundAllocationStatus,
  refundAllocationsPayload,
} from '@/lib/contract-refund';

const ACTIVE_PAYMENT_STATUSES = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const INSTALLMENT_COLUMNS = 'id, installment_number, total_installments, value, credit_date, status, order_type, order_id';

// Parcelas pagas do contrato e das mudanças de plano dele, na ordem.
async function loadRefundInstallments(contractId) {
  const { data: contractRows, error } = await supabase
    .from('asaas_payments')
    .select(INSTALLMENT_COLUMNS)
    .eq('order_type', 'contract')
    .eq('order_id', contractId)
    .in('status', ACTIVE_PAYMENT_STATUSES)
    .order('installment_number', { ascending: true });
  if (error) throw error;

  const { data: changes, error: changesError } = await supabase
    .from('assessment_contract_plan_changes')
    .select('id')
    .eq('contract_id', contractId);
  if (changesError) throw changesError;

  let upgradeRows = [];
  if (changes?.length) {
    const { data, error: upgradeError } = await supabase
      .from('asaas_payments')
      .select(INSTALLMENT_COLUMNS)
      .eq('order_type', 'plan_change')
      .in('order_id', changes.map(change => change.id))
      .in('status', ACTIVE_PAYMENT_STATUSES)
      .order('installment_number', { ascending: true });
    if (upgradeError) throw upgradeError;
    upgradeRows = data || [];
  }
  return [...(contractRows || []), ...upgradeRows];
}

function installmentLabel(installment) {
  const number = installment.total_installments > 1
    ? `Parcela ${installment.installment_number}/${installment.total_installments}`
    : 'Pagamento';
  return installment.order_type === 'plan_change' ? `Upgrade · ${number}` : number;
}

// Registra o estorno feito de um contrato. No cartão, o estorno é por
// parcela, igual ao que o Asaas mostra em "Estorno" de cada cobrança.
export default function RegisterRefundDialog({ refund, onClose, onSaved }) {
  const calculated = Number(refund.calculated_amount ?? refund.amount) || 0;
  const [method, setMethod] = useState('pix');
  // Em branco de propósito: a data define quais parcelas já tinham caído.
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState(calculated.toFixed(2));
  const [notes, setNotes] = useState('');
  const [installments, setInstallments] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [values, setValues] = useState({});
  const [creditedOverrides, setCreditedOverrides] = useState({});
  const [saving, setSaving] = useState(false);

  const isCard = isCardRefundMethod(method);
  const different = isDifferentFromCalculated(amount, calculated);
  const split = refundAllocationStatus(installments || [], values, amount);
  const creditedFor = installment => (
    installment.id in creditedOverrides
      ? creditedOverrides[installment.id]
      : defaultAlreadyCredited(installment.credit_date, date)
  );

  useEffect(() => {
    if (!isCard || installments !== null) return undefined;
    let ignore = false;
    loadRefundInstallments(refund.source_id)
      .then(rows => { if (!ignore) setInstallments(rows); })
      .catch(error => { if (!ignore) setLoadError(error.message || 'Não foi possível carregar as parcelas'); });
    return () => { ignore = true; };
  }, [installments, isCard, refund.source_id]);

  const close = () => {
    if (!saving) onClose();
  };

  const canSave = Boolean(date) && Number(String(amount).replace(',', '.')) > 0
    && (!different || notes.trim())
    && (!isCard || split.complete);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const credited = Object.fromEntries((installments || []).map(item => [item.id, creditedFor(item)]));
      await registerAssessmentContractRefund(refund.source_id, {
        refundDate: date,
        method,
        amount: Math.round(Number(String(amount).replace(',', '.')) * 100) / 100,
        allocations: isCard ? refundAllocationsPayload(installments, values, credited) : null,
        notes: notes.trim() || null,
        expectedUpdatedAt: refund.updated_at,
      });
      toast.success('Estorno registrado.');
      onSaved();
    } catch (error) {
      toast.error(error.message || 'Erro ao registrar o estorno');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={nextOpen => !nextOpen && close()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-green-700">
            <CheckCircle2 className="w-5 h-5" /> Registrar estorno
          </DialogTitle>
          <DialogDescription>
            Registre como o dinheiro voltou para o aluno. O pagamento do contrato continua registrado; o estorno entra à parte.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-gray-50 border rounded-xl p-3 text-sm space-y-1">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Contrato</span>
              <span className="font-mono font-semibold">{refund.reference}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Cliente</span>
              <span className="font-medium text-right">{refund.customer_name || '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Estorno calculado</span>
              <span className="font-bold text-green-700">{formatCurrency(calculated)}</span>
            </div>
          </div>

          <div>
            <Label>Forma do estorno *</Label>
            <select
              className="w-full mt-1 h-10 border rounded-lg px-3 text-sm bg-white"
              value={method}
              onChange={event => setMethod(event.target.value)}
              disabled={saving}
            >
              {REFUND_METHODS.map(item => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Data do estorno *</Label>
              <Input
                type="date"
                className="mt-1"
                max={todayLocalStr()}
                value={date}
                onChange={event => {
                  setDate(event.target.value);
                  // A marcação de "já tinha caído" volta a seguir a nova data.
                  setCreditedOverrides({});
                }}
                disabled={saving}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                O dia em que o dinheiro voltou para o aluno (no Asaas, a data em “Estorno”).
              </p>
            </div>
            <div>
              <Label>Valor devolvido (R$) *</Label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                className="mt-1"
                value={amount}
                onChange={event => setAmount(event.target.value)}
                disabled={saving}
              />
            </div>
          </div>

          {different && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Diferente do calculado ({formatCurrency(calculated)}). Explique o motivo na observação.
            </p>
          )}

          {isCard && (
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-blue-50 border-b border-blue-200 px-3 py-2">
                <p className="text-xs font-semibold text-blue-900">Quanto saiu de cada parcela</p>
                <p className="text-[11px] text-blue-800 mt-0.5">
                  Copie o que o Asaas mostra em “Estorno” de cada parcela. “Já tinha caído” vem marcado pela data de crédito de cada parcela; mude só se ela caiu em outro dia.
                </p>
              </div>
              {!date ? (
                <p className="px-3 py-3 text-sm text-amber-800 bg-amber-50">
                  Escolha a data do estorno primeiro: ela mostra quais parcelas já tinham caído na conta.
                </p>
              ) : loadError ? (
                <p className="px-3 py-3 text-sm text-red-700 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4" /> {loadError}
                </p>
              ) : installments === null ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">Carregando parcelas…</p>
              ) : installments.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  Este contrato não tem parcelas de pagamento registradas. Use outra forma de estorno.
                </p>
              ) : (
                <div className="divide-y">
                  {installments.map(installment => (
                    <div key={installment.id} className="px-3 py-2 grid grid-cols-1 sm:grid-cols-[1fr_7rem] gap-2 items-center">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {installmentLabel(installment)} · {formatCurrency(installment.value)}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          Crédito previsto {formatDate(installment.credit_date)}
                        </p>
                        <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-gray-700">
                          <input
                            type="checkbox"
                            checked={creditedFor(installment)}
                            onChange={event => setCreditedOverrides(current => ({
                              ...current,
                              [installment.id]: event.target.checked,
                            }))}
                            disabled={saving}
                          />
                          já tinha caído na conta
                        </label>
                      </div>
                      <div>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0,00"
                          aria-label={`Estornado na ${installmentLabel(installment)}`}
                          value={values[installment.id] ?? ''}
                          onChange={event => setValues(current => ({
                            ...current,
                            [installment.id]: event.target.value,
                          }))}
                          disabled={saving}
                          className="h-9 text-sm"
                        />
                        {split.errors[installment.id] && (
                          <p className="text-[11px] text-red-600 mt-0.5">{split.errors[installment.id]}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {date && installments?.length > 0 && (
                <div className={`px-3 py-2 text-xs flex items-center justify-between border-t ${
                  split.complete ? 'bg-green-50 text-green-800' : 'bg-gray-50 text-gray-700'
                }`}>
                  <span>Distribuído {formatCurrency(split.allocated)}</span>
                  <span className="font-semibold">
                    {split.complete
                      ? 'Fechou com o valor devolvido'
                      : split.remaining > 0
                        ? `Falta ${formatCurrency(split.remaining)}`
                        : `Passou ${formatCurrency(-split.remaining)}`}
                  </span>
                </div>
              )}
            </div>
          )}

          {method === 'card_asaas' && (
            <p className="text-[11px] text-muted-foreground">
              No estorno parcial o Asaas não devolve a taxa da transação; no estorno total, devolve.
            </p>
          )}

          <div>
            <Label>{different ? 'Observação *' : 'Observação'}</Label>
            <Textarea
              rows={2}
              className="mt-1"
              maxLength={1000}
              placeholder={isCard ? 'Ex.: estornado no painel do Asaas' : 'Ex.: PIX devolvido, comprovante anexado'}
              value={notes}
              onChange={event => setNotes(event.target.value)}
              disabled={saving}
            />
          </div>

          {(refund.receipts || []).length === 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Este estorno ainda não tem comprovante anexado. Dá para registrar assim mesmo e anexar depois.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={close} disabled={saving}>
              Voltar
            </Button>
            <Button
              className="flex-1 bg-green-600 hover:bg-green-700 text-white"
              onClick={save}
              disabled={saving || !canSave}
            >
              {saving ? 'Salvando…' : 'Registrar estorno'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
