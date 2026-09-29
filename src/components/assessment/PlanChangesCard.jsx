import { useMemo, useState } from 'react';
import {
  ArrowRight, Banknote, ExternalLink, Link2, PenLine, RotateCcw, TrendingUp, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import ExternalChargeDialog from '@/components/billing/ExternalChargeDialog';
import PlanChangeDialog from '@/components/assessment/PlanChangeDialog';
import { cancelAssessmentPlanChange, saveAssessmentPlanChangeExternalCharge } from '@/api/client';
import {
  createManualInstallments,
  getPaymentMethodLabel,
  loadActivePaymentMethods,
  reopenManualPayment,
} from '@/lib/manual-payment';
import { externalChargeMethodLabel } from '@/lib/external-charge';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import {
  PLAN_CHANGE_PAYMENT_STATUS,
  PLAN_CHANGE_STATUS,
  PLAN_CHANGE_TYPE_LABEL,
  allowedPlanChangeMethodGroups,
  isOpenPlanChangeCharge,
  planChangeChargeMethods,
  planHistorySegments,
} from '@/lib/assessment-plan-change';

const CHANGEABLE_CONTRACT_STATUSES = ['active', 'on_leave', 'scheduled'];
const HTTPS_LINK = /^https:\/\/\S+$/;

function monthLabel(dateStr) {
  const [year, month] = String(dateStr).split('-');
  return `${month}/${year}`;
}

function StatusPill({ meta }) {
  if (!meta) return null;
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${meta.className}`}>
      {meta.label}
    </span>
  );
}

// Mudanças de plano no meio do ciclo: trechos do plano, cada pedido com a
// cobrança própria da diferença e as correções (editar, cobrança, pagamento,
// cancelar). As regras ficam no banco; aqui só chamamos a API.
export default function PlanChangesCard({
  contract,
  changes,
  history,
  plans,
  transitions,
  coaches,
  onChanged,
}) {
  const [dialog, setDialog] = useState(null);
  const [chargeFor, setChargeFor] = useState(null);
  const [chargeForm, setChargeForm] = useState({ link: '', due_date: '', payment_method: 'pix', invoice_number: '' });
  const [chargeSaving, setChargeSaving] = useState(false);
  const [payFor, setPayFor] = useState(null);
  const [payForm, setPayForm] = useState({ method_id: '', date: '', value: '' });
  const [methodGroups, setMethodGroups] = useState([]);
  const [paySaving, setPaySaving] = useState(false);
  const [cancelFor, setCancelFor] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSaving, setCancelSaving] = useState(false);
  const [undoingId, setUndoingId] = useState(null);

  const plansById = useMemo(() => new Map(plans.map(plan => [plan.id, plan])), [plans]);
  const coachesById = useMemo(() => new Map(coaches.map(coach => [coach.id, coach])), [coaches]);
  const segments = useMemo(
    () => planHistorySegments(history, contract.end_date),
    [contract.end_date, history],
  );
  const sortedChanges = useMemo(
    () => [...changes].sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date))
      || String(b.created_at).localeCompare(String(a.created_at))),
    [changes],
  );

  const latestPlanId = segments.at(-1)?.row.plan_id || contract.plan_id;
  const pendingCharge = changes.find(change => change.status !== 'cancelled' && isOpenPlanChangeCharge(change));
  const eligible = CHANGEABLE_CONTRACT_STATUSES.includes(contract.status);
  let blockReason = '';
  if (contract.payment_status !== 'paid') {
    blockReason = 'Liberado depois do pagamento do contrato. Antes disso, use “Ajustar plano”.';
  } else if (contract.scheduled_cancellation_date) {
    blockReason = 'O contrato tem cancelamento agendado.';
  } else if (pendingCharge) {
    blockReason = 'Registre o pagamento ou cancele a mudança com cobrança em aberto antes de fazer outra.';
  }

  const planName = (planId, snapshot) => snapshot?.name || plansById.get(planId)?.name || '—';
  const coachName = coachId => coachesById.get(coachId)?.name || '—';

  const finish = () => {
    setDialog(null);
    onChanged();
  };

  const startCharge = change => {
    setChargeForm({
      link: change.external_payment_link || '',
      due_date: change.due_date || defaultPaymentDueDate(),
      payment_method: change.charge_payment_method || 'pix',
      invoice_number: change.external_invoice_number || '',
    });
    setChargeFor(change);
  };

  const saveCharge = async () => {
    const link = chargeForm.link.trim();
    if (!HTTPS_LINK.test(link)) {
      toast.error('Informe o link de pagamento (https://…)');
      return;
    }
    if (!chargeForm.due_date) {
      toast.error('Informe o vencimento');
      return;
    }
    setChargeSaving(true);
    try {
      await saveAssessmentPlanChangeExternalCharge(chargeFor.id, {
        externalLink: link,
        dueDate: chargeForm.due_date,
        paymentMethod: chargeForm.payment_method,
        invoiceNumber: chargeForm.invoice_number.trim() || null,
        expectedUpdatedAt: chargeFor.updated_at,
      });
      toast.success(chargeFor.external_payment_link
        ? 'Cobrança da diferença atualizada.'
        : 'Cobrança da diferença registrada. Envie o link para o aluno.');
      setChargeFor(null);
      onChanged();
    } catch (error) {
      toast.error(error.message || 'Erro ao salvar a cobrança');
    } finally {
      setChargeSaving(false);
    }
  };

  const openPayment = async change => {
    try {
      const groups = allowedPlanChangeMethodGroups(await loadActivePaymentMethods(), change.max_installments);
      const methods = groups.flatMap(([, list]) => list);
      const defaultMethod = methods.find(method => method.internal_code === 'pix_manual') || methods[0];
      setMethodGroups(groups);
      setPayForm({
        method_id: defaultMethod?.id || '',
        date: todayLocalStr(),
        value: Number(change.amount).toFixed(2),
      });
      setPayFor(change);
    } catch (error) {
      toast.error('Erro ao carregar formas de pagamento: ' + (error.message || 'desconhecido'));
    }
  };

  const savePayment = async () => {
    const method = methodGroups.flatMap(([, list]) => list).find(item => item.id === payForm.method_id);
    if (!method) {
      toast.error('Selecione a forma de pagamento');
      return;
    }
    if (!payForm.date) {
      toast.error('Informe a data do pagamento');
      return;
    }
    setPaySaving(true);
    try {
      await createManualInstallments(
        method,
        payForm.date,
        { order_id: payFor.id, order_type: 'plan-change' },
        Number(payFor.amount),
        payForm.installments,
      );
      toast.success('Pagamento da diferença registrado. O repasse pendente sai no próximo fechamento.');
      setPayFor(null);
      onChanged();
    } catch (error) {
      toast.error(error.message || 'Erro ao registrar o pagamento');
    } finally {
      setPaySaving(false);
    }
  };

  const undoPayment = async change => {
    if (!window.confirm(
      `Desfazer o pagamento de ${formatCurrency(change.amount)}?\n\n`
      + 'A cobrança volta a ficar em aberto e as parcelas saem do fluxo de caixa.',
    )) return;
    setUndoingId(change.id);
    try {
      const result = await reopenManualPayment({ order_id: change.id, order_type: 'plan-change' });
      toast.success('Pagamento desfeito. A cobrança da diferença voltou a ficar em aberto.');
      if (result?.closing_to_regenerate) {
        toast.info(`Gere de novo o fechamento de repasse de ${monthLabel(result.closing_to_regenerate)}, que aguarda aprovação.`);
      }
      onChanged();
    } catch (error) {
      toast.error(error.message || 'Erro ao desfazer o pagamento');
    } finally {
      setUndoingId(null);
    }
  };

  const saveCancellation = async () => {
    const reason = cancelReason.trim();
    if (!reason) {
      toast.error('Informe o motivo do cancelamento');
      return;
    }
    setCancelSaving(true);
    try {
      await cancelAssessmentPlanChange(cancelFor.id, { reason, expectedUpdatedAt: cancelFor.updated_at });
      toast.success(cancelFor.status === 'applied'
        ? `Mudança cancelada. O plano anterior voltou desde ${formatDate(cancelFor.effective_date)}.`
        : 'Mudança cancelada.');
      setCancelFor(null);
      setCancelReason('');
      onChanged();
    } catch (error) {
      toast.error(error.message || 'Erro ao cancelar a mudança');
    } finally {
      setCancelSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-indigo-600" /> Mudanças de plano
          </CardTitle>
          {eligible && (
            <Button size="sm" variant="outline" onClick={() => setDialog({ change: null })} disabled={Boolean(blockReason)}>
              <TrendingUp className="w-3.5 h-3.5 mr-1.5" /> Mudar plano
            </Button>
          )}
        </div>
        {eligible && blockReason && (
          <p className="text-xs text-muted-foreground">{blockReason}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {segments.length > 1 && (
          <div className="rounded-lg border bg-gray-50 px-3 py-2">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Trechos do plano neste contrato</p>
            <div className="space-y-1">
              {segments.map(segment => (
                <div key={segment.row.id || segment.from} className="flex items-center justify-between gap-2 text-sm flex-wrap">
                  <span className="font-medium">{planName(segment.row.plan_id, segment.row.plan_snapshot)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(segment.from)} → {segment.to ? formatDate(segment.to) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sortedChanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma mudança de plano. Use “Mudar plano” para upgrade ou troca lateral no meio do ciclo.
          </p>
        ) : (
          <div className="space-y-2">
            {sortedChanges.map(change => {
              const active = change.status !== 'cancelled';
              const amount = Number(change.amount) || 0;
              const openChargeRow = active && isOpenPlanChangeCharge(change);
              return (
                <div key={change.id} className={`border rounded-xl p-3 space-y-1.5 ${active ? '' : 'opacity-70'}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">
                      {planName(change.from_plan_id)}
                      <ArrowRight className="inline w-3.5 h-3.5 mx-1 -mt-0.5 text-muted-foreground" />
                      {planName(change.to_plan_id, change.to_plan_snapshot)}
                    </span>
                    <Badge variant={change.change_type === 'upgrade' ? 'purple' : 'info'}>
                      {PLAN_CHANGE_TYPE_LABEL[change.change_type] || change.change_type}
                    </Badge>
                    <StatusPill meta={PLAN_CHANGE_STATUS[change.status]} />
                    {change.payment_status !== 'cancelled' && (
                      <StatusPill meta={PLAN_CHANGE_PAYMENT_STATUS[change.payment_status]} />
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    A partir de {formatDate(change.effective_date)}
                    {' · '}
                    {amount > 0
                      ? <>diferença <strong className="text-gray-800">{formatCurrency(amount)}</strong> ({change.remaining_days} de {change.cycle_days} dias) · até {change.max_installments}x</>
                      : 'sem cobrança'}
                  </p>

                  {change.to_coach_id !== change.from_coach_id && (
                    <p className="text-xs text-muted-foreground">
                      Treinador: {coachName(change.from_coach_id)} → {coachName(change.to_coach_id)}
                    </p>
                  )}

                  {openChargeRow && change.external_payment_link && (
                    <p className="text-xs text-amber-800">
                      <Link2 className="inline w-3 h-3 mr-1 -mt-0.5" />
                      Cobrança: {externalChargeMethodLabel(change.charge_payment_method)}
                      {change.due_date && ` · vence ${formatDate(change.due_date)}`}
                      {change.external_invoice_number && ` · fatura ${change.external_invoice_number}`}
                      {' · '}
                      <a
                        href={change.external_payment_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline whitespace-nowrap"
                      >
                        abrir link <ExternalLink className="inline w-3 h-3 -mt-0.5" />
                      </a>
                    </p>
                  )}

                  {change.payment_status === 'paid' && (
                    <p className="text-xs text-green-700">
                      Pago em {formatDate(change.payment_date)} · {getPaymentMethodLabel(change.paid_payment_method)}
                    </p>
                  )}

                  {!active && (
                    <p className="text-xs text-muted-foreground">
                      Cancelada em {formatDate(change.cancelled_at)}
                      {change.cancellation_reason && `: ${change.cancellation_reason}`}
                    </p>
                  )}

                  {change.notes && (
                    <p className="text-xs text-gray-700 italic">“{change.notes}”</p>
                  )}

                  {active && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {openChargeRow && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => startCharge(change)}>
                            <Link2 className="w-3.5 h-3.5 mr-1.5" />
                            {change.external_payment_link ? 'Editar cobrança' : 'Cadastrar cobrança'}
                          </Button>
                          <Button size="sm" variant="outline" className="text-green-700 border-green-300 hover:bg-green-50"
                            onClick={() => openPayment(change)}>
                            <Banknote className="w-3.5 h-3.5 mr-1.5" /> Registrar pagamento
                          </Button>
                        </>
                      )}
                      {change.payment_status === 'paid' && change.manual_payment && (
                        <Button size="sm" variant="outline" className="text-amber-700 border-amber-300 hover:bg-amber-50"
                          onClick={() => undoPayment(change)} disabled={undoingId === change.id}>
                          <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                          {undoingId === change.id ? 'Desfazendo…' : 'Desfazer pagamento'}
                        </Button>
                      )}
                      {change.payment_status !== 'paid' && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ change })}>
                            <PenLine className="w-3.5 h-3.5 mr-1.5" /> Corrigir
                          </Button>
                          <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50"
                            onClick={() => { setCancelReason(''); setCancelFor(change); }}>
                            <XCircle className="w-3.5 h-3.5 mr-1.5" /> Cancelar mudança
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {dialog && (
        <PlanChangeDialog
          contract={contract}
          change={dialog.change}
          fromPlanId={dialog.change ? dialog.change.from_plan_id : latestPlanId}
          plans={plans}
          transitions={transitions}
          coaches={coaches}
          onClose={() => setDialog(null)}
          onSaved={finish}
        />
      )}

      {chargeFor && (
        <ExternalChargeDialog
          open
          onCancel={() => setChargeFor(null)}
          hasCharge={Boolean(chargeFor.external_payment_link)}
          form={chargeForm}
          setForm={setChargeForm}
          saving={chargeSaving}
          onSave={saveCharge}
          methods={planChangeChargeMethods(chargeFor.max_installments)}
          summary={(
            <p className="text-sm bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 text-indigo-900">
              Diferença da mudança de plano: <strong>{formatCurrency(chargeFor.amount)}</strong>, em até {chargeFor.max_installments}x.
            </p>
          )}
        />
      )}

      {payFor && (
        <Dialog open onOpenChange={nextOpen => !nextOpen && !paySaving && setPayFor(null)}>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Banknote className="w-5 h-5 text-green-600" /> Pagamento da diferença
              </DialogTitle>
              <DialogDescription>
                {formatCurrency(payFor.amount)}, valor integral, em até {payFor.max_installments}x.
              </DialogDescription>
            </DialogHeader>
            <ManualPaymentForm
              form={payForm}
              setForm={setPayForm}
              methodGroups={methodGroups}
              saving={paySaving}
              onSave={savePayment}
              onCancel={() => setPayFor(null)}
              lockedValue
            />
          </DialogContent>
        </Dialog>
      )}

      {cancelFor && (
        <Dialog open onOpenChange={nextOpen => !nextOpen && !cancelSaving && setCancelFor(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <XCircle className="w-5 h-5 text-red-600" /> Cancelar mudança de plano
              </DialogTitle>
              <DialogDescription>
                {cancelFor.status === 'applied'
                  ? `O aluno volta ao plano anterior desde ${formatDate(cancelFor.effective_date)}, e a pendência de repasse da diferença é descartada.`
                  : 'A mudança agendada deixa de valer, e a pendência de repasse da diferença é descartada.'}
                {cancelFor.to_coach_id !== cancelFor.from_coach_id
                  && ' O treinador anterior volta; dias de fechamentos já aprovados continuam com quem foi pago neles.'}
              </DialogDescription>
            </DialogHeader>
            <div>
              <Label>Motivo *</Label>
              <Textarea
                className="mt-1"
                rows={2}
                maxLength={500}
                value={cancelReason}
                onChange={event => setCancelReason(event.target.value)}
                placeholder="Ex.: aluno desistiu do upgrade"
                disabled={cancelSaving}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setCancelFor(null)} disabled={cancelSaving}>
                Voltar
              </Button>
              <Button variant="destructive" className="flex-1" onClick={saveCancellation}
                disabled={cancelSaving || !cancelReason.trim()}>
                {cancelSaving ? 'Cancelando…' : 'Cancelar mudança'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
