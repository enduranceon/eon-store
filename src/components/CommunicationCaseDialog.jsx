import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  actOnCommunicationCase,
  getCommunicationCase,
  listCommunicationCaseEvents,
  prepareCommunicationCase,
} from '@/api/client';
import { formatCurrency, formatDate, formatDateTime, todayLocalStr } from '@/lib/utils';
import { phoneDigitsForWhatsApp } from '@/lib/phone';
import { canCompleteCommunicationReview, communicationBlockReasonLabel } from '@/lib/communication-case';
import { buildTaskMessage } from '@/lib/communication-tasks';

const RESPONSE_OPTIONS = {
  billing: [
    ['will_pay', 'Vai pagar'],
    ['paid_claimed', 'Informou que já pagou'],
    ['dispute', 'Contestou a cobrança'],
    ['needs_agent', 'Precisa de atendimento'],
  ],
  renewal: [
    ['thinking', 'Ainda está pensando'],
    ['will_renew', 'Quer renovar'],
    ['change_plan_or_coach', 'Mudar plano ou treinador'],
    ['needs_agent', 'Falar com atendente'],
  ],
  onboarding: [
    ['needs_agent', 'Precisa de atendimento'],
  ],
};

const PANEL_TABS = [
  ['message', 'Mensagem'],
  ['response', 'Resposta'],
  ['schedule', 'Agendar'],
  ['review', 'Revisar'],
  ['history', 'Histórico'],
];

function purposeForTask(task) {
  if (task?.purpose) return task.purpose;
  if (task?.bucket === 'charges' || String(task?.kind || '').startsWith('charge_')) return 'billing';
  if (task?.bucket === 'renewal' || String(task?.kind || '').startsWith('renewal_')) return 'renewal';
  return 'onboarding';
}

// O primeiro envio da cobrança de um contrato usa o texto de "confirmada"
// (plano, coach, valor, vencimento e link). Lembretes e os demais casos seguem
// a sugestão do servidor.
function initialMessage(task, detail) {
  const suggested = detail?.suggestion?.message || detail?.case?.suggested_message || '';
  if (task?.messageVariant !== 'assessment_contract_confirmation') return suggested;
  if (detail?.suggestion?.action_code !== 'initial_charge') return suggested;
  return buildTaskMessage(task, { externalLink: detail?.case?.payment_link || undefined }) || suggested;
}

function isValidWhatsappNumber(phone) {
  const digits = phoneDigitsForWhatsApp(phone);
  return Boolean(digits && digits !== '55' && digits.length >= 12);
}

function eventLabel(event) {
  const names = {
    message_sent: 'Mensagem registrada manualmente',
    response_recorded: 'Resposta registrada',
    return_scheduled: 'Retorno agendado',
    review_requested: 'Revisão solicitada',
    review_completed: 'Conferência concluída',
    resolve_case: 'Caso resolvido',
  };
  return names[event.action] || names[event.event_type] || event.title || event.event_type || 'Evento';
}

function makeIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `communication-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function CommunicationCaseDialog({
  caseId,
  communicationCase,
  task,
  sourceUi = 'communication_center',
  onClose,
  onChanged,
  onSent,
  onManualPay,
  preventOutsideClose = false,
}) {
  const open = Boolean(caseId || task);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [staleNotice, setStaleNotice] = useState('');
  const [panel, setPanel] = useState('message');
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nextActionAt, setNextActionAt] = useState('');
  const [responseCode, setResponseCode] = useState('');
  const [responseNote, setResponseNote] = useState('');
  const [responseDate, setResponseDate] = useState('');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleNote, setScheduleNote] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [completionNote, setCompletionNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState([]);
  const [eventsCursor, setEventsCursor] = useState(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState('');
  const lastAttempt = useRef(null);

  const activeCase = detail?.case || communicationCase || null;
  const activeId = activeCase?.id || caseId || null;
  const suggestion = detail?.suggestion || null;
  const currentSourceUi = task?.sourceUi || task?.source_ui || sourceUi;

  const loadDetail = useCallback(async ({ stale = false, knownCaseId = null } = {}) => {
    if (!caseId && !task && !knownCaseId) return;
    setLoading(true);
    setLoadError('');
    try {
      const next = (knownCaseId || caseId)
        ? await getCommunicationCase(knownCaseId || caseId)
        : await prepareCommunicationCase({
            source_type: task.sourceType || task.source_type,
            source_id: task.sourceId || task.source_id,
            purpose: purposeForTask(task),
          });
      setDetail(next);
      setMessage(initialMessage(task, next));
      setConfirmed(false);
      setNextActionAt('');
      setResponseCode('');
      setResponseNote('');
      setResponseDate('');
      setScheduleDate('');
      setScheduleNote('');
      setReviewReason('');
      setReviewDate('');
      setCompletionNote('');
      setStaleNotice(stale ? 'Os dados deste acompanhamento mudaram. Revise saldo, contato, link e mensagem antes de continuar.' : '');
      lastAttempt.current = null;
    } catch (cause) {
      setLoadError(cause?.message || 'Não foi possível abrir este acompanhamento.');
    } finally {
      setLoading(false);
    }
  }, [caseId, task]);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      setEvents([]);
      setEventsCursor(null);
      setPanel('message');
      setStaleNotice('');
      return;
    }
    loadDetail();
  }, [open, loadDetail]);

  const loadEvents = useCallback(async ({ cursor = null, append = false } = {}) => {
    if (!activeId) return;
    setEventsLoading(true);
    setEventsError('');
    try {
      const page = await listCommunicationCaseEvents(activeId, { cursor: cursor || undefined, limit: 30 });
      setEvents(current => append ? [...current, ...(page.items || [])] : (page.items || []));
      setEventsCursor(page.next_cursor || null);
    } catch (cause) {
      setEventsError(cause?.message || 'Não foi possível carregar o histórico.');
    } finally {
      setEventsLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    if (open && panel === 'history' && activeId) loadEvents();
  }, [open, panel, activeId, loadEvents]);

  const applyAction = async (action, fields) => {
    if (!activeCase?.id || saving) return;
    const payload = {
      action,
      expected_version: activeCase.version,
      expected_source_fingerprint: activeCase.source_fingerprint,
      source_ui: currentSourceUi,
      ...fields,
    };
    const fingerprint = JSON.stringify([activeCase.id, payload]);
    if (lastAttempt.current?.fingerprint !== fingerprint) {
      lastAttempt.current = { fingerprint, key: makeIdempotencyKey() };
    }
    setSaving(true);
    try {
      await actOnCommunicationCase(activeCase.id, {
        ...payload,
        idempotency_key: lastAttempt.current.key,
      });
      lastAttempt.current = null;
      toast.success(action === 'message_sent' ? 'Envio manual registrado' : 'Acompanhamento atualizado');
      await loadDetail({ knownCaseId: activeCase.id });
      onChanged?.();
      if (action === 'message_sent') onSent?.();
    } catch (cause) {
      if (cause?.status === 409) {
        await loadDetail({ stale: true, knownCaseId: activeCase.id });
        onChanged?.();
        setPanel('message');
      } else {
        toast.error(cause?.message || 'Não foi possível salvar a ação.');
      }
    } finally {
      setSaving(false);
    }
  };

  const phone = activeCase?.contact_phone || '';
  const hasPhone = isValidWhatsappNumber(phone);
  const today = todayLocalStr();
  const eligibleAt = suggestion?.eligible_at || null;
  const contactIsFuture = Boolean((eligibleAt && eligibleAt > today) || (activeCase?.next_action_at && activeCase.next_action_at > today));
  const canSend = hasPhone
    && !activeCase?.blocked_reason
    && !suggestion?.blocked_reason
    && !contactIsFuture
    && Number.isInteger(Number(suggestion?.rule_version))
    && Number(suggestion?.rule_version) > 0
    && (activeCase?.purpose !== 'billing' || activeCase.payment_link || activeCase.can_send_without_link);
  const isResolved = activeCase?.workflow_stage === 'resolved';
  const suggestedReturn = suggestion?.proposed_next_action_at;
  const responseOptions = RESPONSE_OPTIONS[activeCase?.purpose] || RESPONSE_OPTIONS.onboarding;

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast.success('Mensagem copiada');
    } catch {
      toast.error('Não foi possível copiar a mensagem');
    }
  };

  const openWhatsApp = () => {
    if (!hasPhone) return toast.error('Cadastre um WhatsApp válido antes de abrir a conversa');
    if (!message.trim()) return toast.error('Escreva a mensagem antes de abrir o WhatsApp');
    const number = phoneDigitsForWhatsApp(phone);
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };

  const send = () => {
    if (!message.trim()) return toast.error('A mensagem está vazia');
    if (!canSend) return toast.error('Resolva o bloqueio antes de registrar envio');
    if (!confirmed) return toast.error('Confirme que a mensagem foi enviada fora do EON Store');
    applyAction('message_sent', {
      message: message.trim(),
      channel: 'whatsapp',
      confirmed_external_send: true,
      expected_rule_version: suggestion?.rule_version ?? activeCase?.rule_version,
      ...(nextActionAt ? { next_action_at: nextActionAt } : {}),
    });
  };

  const recordResponse = () => {
    if (!responseCode) return toast.error('Selecione a resposta recebida');
    if (['will_pay', 'thinking'].includes(responseCode) && !responseDate) {
      return toast.error('Informe a data combinada para o retorno');
    }
    applyAction('response_recorded', {
      response_code: responseCode,
      note: responseNote.trim(),
      ...(responseDate ? { follow_up_at: responseDate } : {}),
    });
  };

  const schedule = () => {
    if (!scheduleDate) return toast.error('Informe a data do retorno');
    applyAction('return_scheduled', {
      next_action_at: scheduleDate,
      note: scheduleNote.trim(),
    });
  };

  const requestReview = () => {
    if (!reviewReason.trim()) return toast.error('Descreva o motivo da revisão');
    applyAction('review_requested', {
      reason: reviewReason.trim(),
      ...(reviewDate ? { next_action_at: reviewDate } : {}),
    });
  };

  const completeReview = () => {
    if (!canCompleteCommunicationReview(activeCase?.blocked_reason)) return;
    if (!completionNote.trim()) return toast.error('Descreva o que foi conferido');
    applyAction('review_completed', { note: completionNote.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => !nextOpen && !saving && onClose?.()}>
      <DialogContent
        className="!left-auto !right-0 !top-0 !h-[100dvh] !max-h-[100dvh] !w-full !max-w-xl !translate-x-0 !translate-y-0 !rounded-none overflow-y-auto p-0"
        onInteractOutside={preventOutsideClose ? event => event.preventDefault() : undefined}
      >
        <div className="min-h-full">
          <DialogHeader className="border-b px-4 pb-4 pt-6 text-left sm:px-6">
            <DialogTitle>Preparar contato</DialogTitle>
            <DialogDescription>
              {activeCase?.person_name || task?.customerName || 'Carregando pessoa'} · {activeCase?.reference || task?.orderNumber || 'Acompanhamento'}
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div role="status" className="flex items-center justify-center gap-2 px-6 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Revalidando o caso...
            </div>
          )}
          {!loading && loadError && (
            <div role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p>{loadError}</p>
              <Button variant="outline" onClick={() => loadDetail()} className="mt-3 min-h-11">Tentar novamente</Button>
            </div>
          )}

          {!loading && !loadError && activeCase && (
            <div className="space-y-4 px-4 py-5 sm:px-6">
              {staleNotice && (
                <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  {staleNotice}
                </div>
              )}
              <div className="rounded-lg border bg-gray-50 p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-gray-900">{activeCase.person_name || 'Pessoa sem nome'}</p>
                    <p className="text-xs text-muted-foreground">{activeCase.reference || 'Referência indisponível'}</p>
                  </div>
                  {activeCase.source_href && (
                    <Link to={activeCase.source_href} className="text-sm font-medium text-blue-700 hover:underline">
                      Ver origem
                    </Link>
                  )}
                </div>
                {activeCase.purpose === 'billing' && activeCase.balance != null && (
                  <p className="mt-3 font-semibold">Saldo pendente: {formatCurrency(Number(activeCase.balance) || 0)}</p>
                )}
                {activeCase.purpose === 'billing' && !activeCase.payment_link && activeCase.can_send_without_link && (
                  <p className="mt-2 text-xs text-blue-800">Pagamento por PIX Copia e Cola disponível. Confira o código na mensagem antes de registrar o envio.</p>
                )}
                <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <p><span className="text-muted-foreground">Último contato:</span> {activeCase.last_contact_at ? formatDateTime(activeCase.last_contact_at) : 'Não registrado'}</p>
                  <p><span className="text-muted-foreground">Próxima ação:</span> {activeCase.next_action_at ? formatDate(activeCase.next_action_at) : 'Revisão necessária'}</p>
                </div>
              </div>

              {(activeCase.blocked_reason || suggestion?.blocked_reason) && (
                <div role="note" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {suggestion?.blocked_reason === 'not_due_yet' && activeCase.next_action_at
                      ? `Aguardar até ${formatDate(activeCase.next_action_at)} para o próximo contato.`
                      : `${communicationBlockReasonLabel(suggestion?.blocked_reason || activeCase.blocked_reason)}. O caso permanece visível até a revisão ou resolução.`}
                  </span>
                </div>
              )}

              <div aria-label="Ações do acompanhamento" className="flex gap-1 overflow-x-auto border-b pb-2">
                {PANEL_TABS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={panel === value}
                    onClick={() => setPanel(value)}
                    className={`min-h-11 shrink-0 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${panel === value ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {panel === 'message' && (
                <section className="space-y-4" aria-label="Mensagem">
                  <p className="text-sm text-muted-foreground">
                    Sugestão baseada na situação atual. Você pode editar o texto antes de abrir o WhatsApp.
                  </p>
                  {contactIsFuture && suggestion?.blocked_reason !== 'not_due_yet' && (
                    <p role="note" className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                      Contato previsto para {formatDate(activeCase.next_action_at && activeCase.next_action_at > today ? activeCase.next_action_at : eligibleAt)}. O combinado permanece agendado até essa data.
                    </p>
                  )}
                  <div>
                    <Label htmlFor="case-message">Mensagem editável</Label>
                    <Textarea id="case-message" rows={11} value={message} onChange={event => { setMessage(event.target.value); setConfirmed(false); }} className="mt-1 text-sm leading-relaxed" />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button variant="outline" onClick={copyMessage} disabled={!canSend || !message.trim()} className="min-h-11">
                      {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                      {copied ? 'Copiada' : 'Copiar texto'}
                    </Button>
                    <Button variant="outline" onClick={openWhatsApp} disabled={!canSend || !message.trim()} className="min-h-11">
                      <ExternalLink className="mr-2 h-4 w-4" /> Abrir WhatsApp
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Abrir o WhatsApp não comprova envio. O registro abaixo é manual.</p>
                  <div>
                    <Label htmlFor="case-next-action">Próximo retorno após este contato</Label>
                    <Input
                      id="case-next-action"
                      type="date"
                      min={todayLocalStr()}
                      value={nextActionAt}
                      onChange={event => setNextActionAt(event.target.value)}
                      className="mt-1 min-h-11"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {suggestedReturn
                        ? `Se não escolher outra data, a regra sugere ${formatDate(suggestedReturn)}.`
                        : 'Se não escolher outra data, o servidor definirá a próxima revisão.'}
                    </p>
                  </div>
                  <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={event => setConfirmed(event.target.checked)}
                      className="mt-1 h-4 w-4 accent-blue-600"
                    />
                    Confirmo que enviei esta mensagem fora do EON Store.
                  </label>
                  <Button onClick={send} disabled={saving || isResolved || !canSend || !confirmed} className="min-h-11 w-full">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Registrar envio manual
                  </Button>
                  {onManualPay && activeCase.purpose === 'billing' && !isResolved && (
                    <Button type="button" variant="outline" onClick={onManualPay} className="min-h-11 w-full">
                      Cliente já pagou? Registrar pagamento manual
                    </Button>
                  )}
                  {activeCase.purpose === 'renewal' && (
                    <p className="text-xs text-muted-foreground">
                      Para “não renovar”, use a resolução segura no <Link to="/assessoria/renovacoes" className="text-blue-700 underline">quadro de Renovações</Link>.
                    </p>
                  )}
                </section>
              )}

              {panel === 'response' && (
                <section className="space-y-4" aria-label="Registrar resposta">
                  <div>
                    <Label htmlFor="case-response">O que a pessoa informou?</Label>
                    <select
                      id="case-response"
                      value={responseCode}
                      onChange={event => setResponseCode(event.target.value)}
                      className="mt-1 min-h-11 w-full rounded-md border bg-white px-3 text-sm"
                    >
                      <option value="">Selecione uma resposta</option>
                      {responseOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="case-response-date">Data combinada para retorno</Label>
                    <Input id="case-response-date" type="date" min={todayLocalStr()} value={responseDate} onChange={event => setResponseDate(event.target.value)} className="mt-1 min-h-11" />
                  </div>
                  <div>
                    <Label htmlFor="case-response-note">Observação</Label>
                    <Textarea id="case-response-note" rows={4} value={responseNote} onChange={event => setResponseNote(event.target.value)} className="mt-1" />
                  </div>
                  {responseCode === 'paid_claimed' && (
                    <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                      O pagamento informado será encaminhado para conferência. Ele não será marcado como pago aqui.
                    </p>
                  )}
                  <Button onClick={recordResponse} disabled={saving || isResolved} className="min-h-11 w-full">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Registrar resposta
                  </Button>
                  {activeCase.purpose === 'renewal' && (
                    <p className="text-xs text-muted-foreground">
                      A decisão “não renovar” deve ser registrada pelo <Link to="/assessoria/renovacoes" className="text-blue-700 underline">quadro de Renovações</Link>.
                    </p>
                  )}
                </section>
              )}

              {panel === 'schedule' && (
                <section className="space-y-4" aria-label="Agendar retorno">
                  <p className="text-sm text-muted-foreground">A data vale para todo o caso. Nenhuma outra etapa deve antecipar o combinado.</p>
                  <div>
                    <Label htmlFor="case-schedule-date">Retomar em</Label>
                    <Input id="case-schedule-date" type="date" min={todayLocalStr()} value={scheduleDate} onChange={event => setScheduleDate(event.target.value)} className="mt-1 min-h-11" />
                  </div>
                  <div>
                    <Label htmlFor="case-schedule-note">Motivo ou combinado</Label>
                    <Textarea id="case-schedule-note" rows={4} value={scheduleNote} onChange={event => setScheduleNote(event.target.value)} className="mt-1" />
                  </div>
                  <Button onClick={schedule} disabled={saving || isResolved} className="min-h-11 w-full">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Agendar retorno
                  </Button>
                </section>
              )}

              {panel === 'review' && (
                <section className="space-y-4" aria-label="Solicitar revisão">
                  <p className="text-sm text-muted-foreground">Use para conferir pagamento informado, contestação, contato ou cobrança. O saldo permanece no Financeiro.</p>
                  {activeCase.blocked_reason && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p className="font-medium">Revisão pendente: {communicationBlockReasonLabel(activeCase.blocked_reason)}</p>
                      <p className="mt-1">Próxima conferência: {activeCase.next_action_at ? formatDate(activeCase.next_action_at) : 'sem data definida'}.</p>
                      {activeCase.blocked_reason === 'payment_review' && (
                        <p className="mt-1">Se o pagamento foi confirmado, registre-o no Financeiro antes de encerrar a conferência.</p>
                      )}
                    </div>
                  )}
                  {canCompleteCommunicationReview(activeCase.blocked_reason) && !isResolved && (
                    <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3">
                      <Label htmlFor="case-completion-note">O que foi conferido?</Label>
                      <Textarea id="case-completion-note" rows={3} value={completionNote} onChange={event => setCompletionNote(event.target.value)} className="bg-white" />
                      <Button type="button" variant="outline" onClick={completeReview} disabled={saving || !completionNote.trim()} className="min-h-11 w-full">
                        Conferência feita · retomar acompanhamento
                      </Button>
                    </div>
                  )}
                  <div>
                    <Label htmlFor="case-review-reason">O que precisa ser revisto?</Label>
                    <Textarea id="case-review-reason" rows={4} value={reviewReason} onChange={event => setReviewReason(event.target.value)} className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="case-review-date">Revisar em</Label>
                    <Input id="case-review-date" type="date" min={todayLocalStr()} value={reviewDate} onChange={event => setReviewDate(event.target.value)} className="mt-1 min-h-11" />
                  </div>
                  <Button onClick={requestReview} disabled={saving || isResolved} className="min-h-11 w-full">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Solicitar revisão
                  </Button>
                </section>
              )}

              {panel === 'history' && (
                <section className="space-y-3" aria-label="Histórico do acompanhamento">
                  {eventsError && (
                    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      {eventsError}
                      <Button variant="outline" onClick={() => loadEvents()} className="mt-2 min-h-11 w-full">Tentar novamente</Button>
                    </div>
                  )}
                  {!eventsLoading && !eventsError && events.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há eventos neste acompanhamento.</p>}
                  {events.map(event => (
                    <div key={event.id} className="rounded-md border p-3 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <p className="font-semibold">{eventLabel(event)}</p>
                        <time className="text-xs text-muted-foreground">{event.created_at ? formatDateTime(event.created_at) : ''}</time>
                      </div>
                      {(event.note || event.reason) && <p className="mt-1 whitespace-pre-wrap text-gray-700">{event.note || event.reason}</p>}
                      {event.message && <p className="mt-2 whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-700">{event.message}</p>}
                    </div>
                  ))}
                  {eventsLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando histórico...</p>}
                  {eventsCursor && (
                    <Button variant="outline" disabled={eventsLoading} onClick={() => loadEvents({ cursor: eventsCursor, append: true })} className="min-h-11 w-full">Carregar eventos anteriores</Button>
                  )}
                </section>
              )}

              <Button variant="ghost" onClick={() => loadDetail()} disabled={loading || saving} className="min-h-11 w-full text-muted-foreground">
                <RefreshCw className="mr-2 h-4 w-4" /> Revalidar dados do caso
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
