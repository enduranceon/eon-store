import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Clock, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  createAssessmentPlanChange,
  previewAssessmentPlanChange,
  updateAssessmentPlanChange,
} from '@/api/client';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { PLAN_CHANGE_TYPE_LABEL, planChangeTargets } from '@/lib/assessment-plan-change';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function lastContractDay(endDate) {
  if (!endDate) return undefined;
  const date = new Date(`${endDate}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return toLocalDateStr(date);
}

function monthLabel(dateStr) {
  const [year, month] = String(dateStr).split('-');
  return `${month}/${year}`;
}

// Registra ou corrige uma mudança de plano no meio do ciclo. O valor e todas
// as travas vêm da prévia do banco; a tela só monta o pedido.
export default function PlanChangeDialog({
  contract,
  change = null,
  fromPlanId,
  plans,
  transitions,
  coaches,
  onClose,
  onSaved,
}) {
  const editing = Boolean(change);
  const [toPlanId, setToPlanId] = useState(change?.to_plan_id || '');
  const [effectiveDate, setEffectiveDate] = useState(change?.effective_date || todayLocalStr());
  // Vazio = manter o treinador que atende o aluno na data efetiva.
  const [toCoachId, setToCoachId] = useState(
    change && change.to_coach_id !== change.from_coach_id ? change.to_coach_id : '',
  );
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);

  const plansById = useMemo(() => new Map(plans.map(plan => [plan.id, plan])), [plans]);
  const coachesById = useMemo(() => new Map(coaches.map(coach => [coach.id, coach])), [coaches]);
  const targets = useMemo(() => {
    const list = planChangeTargets(plans, transitions, fromPlanId);
    // Na correção, o destino atual continua na lista mesmo se a matriz mudou;
    // a prévia diz se ele ainda vale.
    if (editing && !list.some(target => target.plan.id === change.to_plan_id)) {
      const current = plansById.get(change.to_plan_id)
        || { id: change.to_plan_id, name: change.to_plan_snapshot?.name, price_total: change.to_price };
      return [{ plan: current, type: change.change_type }, ...list];
    }
    return list;
  }, [change, editing, fromPlanId, plans, plansById, transitions]);

  const fromPlan = plansById.get(fromPlanId);
  const toPlan = plansById.get(toPlanId);
  const keepCoachId = preview?.from_coach_id || (editing ? change.from_coach_id : contract.coach_id);
  const keepCoach = coachesById.get(keepCoachId);
  const coachOptions = coaches.filter(coach => coach.active === true
    && coach.id !== keepCoachId
    && (!toPlan || (coach.modality_ids || []).includes(toPlan.modality_id)));
  const requestCoachId = toCoachId || (editing ? change.from_coach_id : null);
  const validDate = DATE_PATTERN.test(effectiveDate);

  useEffect(() => {
    if (!toPlanId || !validDate) {
      setPreview(null);
      setPreviewError('');
      setPreviewing(false);
      return undefined;
    }
    let ignore = false;
    setPreviewing(true);
    const timer = setTimeout(async () => {
      try {
        const result = await previewAssessmentPlanChange(contract.id, {
          toPlanId,
          effectiveDate,
          toCoachId: requestCoachId,
          planChangeId: change?.id || null,
        });
        if (ignore) return;
        setPreview(result);
        setPreviewError('');
      } catch (error) {
        if (ignore) return;
        setPreview(null);
        setPreviewError(error.message || 'Não foi possível calcular a mudança');
      } finally {
        if (!ignore) setPreviewing(false);
      }
    }, 300);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [change?.id, contract.id, effectiveDate, requestCoachId, toPlanId, validDate]);

  const close = () => {
    if (!saving) onClose();
  };

  const save = async () => {
    if (!preview || previewing) return;
    const trimmed = text.trim();
    if (editing && !trimmed) {
      toast.error('Informe o motivo da correção');
      return;
    }
    setSaving(true);
    try {
      const payload = { toPlanId, effectiveDate, toCoachId: requestCoachId };
      const result = editing
        ? await updateAssessmentPlanChange(change.id, {
          ...payload,
          reason: trimmed,
          expectedUpdatedAt: change.updated_at,
        })
        : await createAssessmentPlanChange(contract.id, {
          ...payload,
          notes: trimmed || null,
          expectedUpdatedAt: contract.updated_at,
        });
      const saved = result?.plan_change;
      if (editing) {
        toast.success('Mudança de plano corrigida.');
      } else if (saved?.status === 'applied') {
        toast.success(Number(saved.amount) > 0
          ? 'Novo plano em vigor. Agora cadastre a cobrança da diferença.'
          : 'Novo plano em vigor.');
      } else {
        toast.success(`Mudança agendada para ${formatDate(effectiveDate)}.`);
      }
      if (result?.closing_to_regenerate) {
        toast.info(`Gere de novo o fechamento de repasse de ${monthLabel(result.closing_to_regenerate)}, que aguarda aprovação.`);
      }
      onSaved();
    } catch (error) {
      toast.error(error.message || 'Erro ao salvar a mudança de plano');
    } finally {
      setSaving(false);
    }
  };

  const amount = Number(preview?.amount) || 0;
  const toCoachName = coachesById.get(preview?.to_coach_id)?.name || '—';

  return (
    <Dialog open onOpenChange={nextOpen => !nextOpen && close()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-indigo-600" />
            {editing ? 'Corrigir mudança de plano' : 'Mudar plano'}
          </DialogTitle>
          <DialogDescription>
            Mesmo ciclo e mesma data final. O aluno paga só a diferença dos dias que faltam, pelos preços de tabela de hoje.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-gray-50 px-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">{editing ? 'Plano de origem' : 'Plano atual'}</p>
            <p className="font-semibold">
              {fromPlan?.name || '—'}
              {fromPlan && <span className="font-normal text-muted-foreground"> · {formatCurrency(fromPlan.price_total)}</span>}
            </p>
          </div>

          <div>
            <Label>Novo plano *</Label>
            {targets.length === 0 ? (
              <p className="mt-1 text-sm text-amber-700">
                A matriz não permite upgrade nem troca lateral a partir deste plano. Ajuste em Configurações da Assessoria → Trocas de plano no meio do ciclo.
              </p>
            ) : (
              <select
                className="w-full mt-1 h-10 border rounded-lg px-3 text-sm bg-white"
                value={toPlanId}
                onChange={event => setToPlanId(event.target.value)}
                disabled={saving}
              >
                <option value="">Selecione…</option>
                {targets.map(({ plan, type }) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name || 'Plano'} · {formatCurrency(plan.price_total)} · {PLAN_CHANGE_TYPE_LABEL[type] || type}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Vale a partir de *</Label>
              <Input
                type="date"
                className="mt-1"
                value={effectiveDate}
                min={contract.start_date}
                max={lastContractDay(contract.end_date)}
                onChange={event => setEffectiveDate(event.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <Label>Treinador</Label>
              <select
                className="w-full mt-1 h-10 border rounded-lg px-3 text-sm bg-white"
                value={toCoachId}
                onChange={event => setToCoachId(event.target.value)}
                disabled={saving}
              >
                <option value="">Manter {keepCoach?.name || 'o atual'}</option>
                {coachOptions.map(coach => (
                  <option key={coach.id} value={coach.id}>{coach.name}</option>
                ))}
              </select>
            </div>
          </div>

          {previewing && (
            <p className="text-sm text-muted-foreground">Calculando…</p>
          )}

          {!previewing && previewError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{previewError}</span>
            </div>
          )}

          {!previewing && preview && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-indigo-900">{preview.from_plan?.name}</span>
                <ArrowRight className="w-3.5 h-3.5 text-indigo-700" />
                <span className="font-semibold text-indigo-900">{preview.to_plan?.name}</span>
                <Badge variant={preview.change_type === 'upgrade' ? 'purple' : 'info'}>
                  {PLAN_CHANGE_TYPE_LABEL[preview.change_type] || preview.change_type}
                </Badge>
              </div>

              {amount > 0 ? (
                <div>
                  <p className="text-indigo-900">
                    Diferença: <strong className="text-base">{formatCurrency(amount)}</strong>
                    {' '}· em até {preview.max_installments}x
                  </p>
                  <p className="text-xs text-indigo-800 mt-0.5">
                    ({formatCurrency(preview.to_price)} − {formatCurrency(preview.from_price)}) × {preview.remaining_days} dias restantes ÷ {preview.cycle_days} dias do ciclo
                  </p>
                  {preview.max_installments === 1 && (
                    <p className="text-xs text-indigo-800 mt-0.5">Abaixo de R$ 100,00 a diferença é paga à vista.</p>
                  )}
                </div>
              ) : (
                <p className="text-indigo-900">Troca lateral: sem cobrança.</p>
              )}

              <p className="text-xs text-indigo-800 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {preview.applies_now
                  ? `Vale desde ${formatDate(preview.effective_date)}: o contrato passa para o novo plano ao confirmar.`
                  : `Fica agendada: o contrato passa para o novo plano em ${formatDate(preview.effective_date)}.`}
              </p>

              {preview.coach_changes && (
                <p className="text-xs text-indigo-800">
                  Treinador: {coachesById.get(preview.from_coach_id)?.name || '—'} → {toCoachName} a partir de {formatDate(preview.effective_date)}.
                </p>
              )}

              {amount > 0 && (
                <p className="text-xs text-indigo-800">
                  Até a diferença ser paga, o treinador recebe pelo plano anterior; o restante fica pendente e é liberado no fechamento depois do pagamento.
                </p>
              )}

              {preview.closing_to_regenerate && (
                <p className="text-xs text-amber-800">
                  O fechamento de repasse de {monthLabel(preview.closing_to_regenerate)} aguarda aprovação: gere de novo depois de confirmar.
                </p>
              )}
            </div>
          )}

          <div>
            <Label>{editing ? 'Motivo da correção *' : 'Observação'}</Label>
            <Textarea
              className="mt-1"
              rows={2}
              maxLength={editing ? 500 : 1000}
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder={editing ? 'Ex.: aluno pediu para começar na semana que vem' : 'Opcional'}
              disabled={saving}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={close} disabled={saving}>
              Voltar
            </Button>
            <Button
              className="flex-1"
              onClick={save}
              disabled={saving || previewing || !preview || (editing && !text.trim())}
            >
              <Check className="w-4 h-4 mr-1.5" />
              {saving ? 'Salvando…' : editing ? 'Salvar correção' : 'Confirmar mudança'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
