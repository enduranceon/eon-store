import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Check, CheckCircle2, Clock, Copy, ExternalLink, Link2, Loader2, Send, UserRoundCheck, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TASK_BUCKET, TASK_KIND, buildTaskMessage } from '@/lib/communication-tasks';
import { hasNativePaymentInfo, registerCommunicationIgnore, registerCommunicationSend, registerCommunicationSnooze } from '@/lib/communication-send';
import { DEFAULT_COMMUNITY_LINK } from '@/lib/communication-config';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { isSafePaymentUrl } from '@/lib/sales';
import { formatPhoneDisplay, phoneDigitsForWhatsApp } from '@/lib/phone';
import { todayLocalStr, toLocalDateStr } from '@/lib/utils';

function hasAnyPaymentLink(task, externalLink) {
  return Boolean(task?.asaasPaymentLink || task?.asaasPixCopy || String(externalLink || '').trim());
}

function datePlusDays(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

// O componente é remontado por `key={task.id}` no pai, então o estado é
// inicializado de forma lazy a partir da task — sem efeito de sincronização.
export default function CommunicationSendDialog({ task, communityLink: initialCommunityLink = '', onClose, onSent }) {
  const initialLink = task?.externalPaymentLink || '';
  const initialDue = task?.dueDate || defaultPaymentDueDate();
  const initialCommunity = initialCommunityLink || DEFAULT_COMMUNITY_LINK;

  const [externalLink, setExternalLink] = useState(initialLink);
  const [dueDate, setDueDate] = useState(initialDue);
  const [communityLink, setCommunityLink] = useState(initialCommunity);
  const [messageText, setMessageText] = useState(() => (
    task ? buildTaskMessage(task, { externalLink: initialLink, dueDate: initialDue, communityLink: initialCommunity }) : ''
  ));
  const [actionReason, setActionReason] = useState('');
  const [snoozeUntil, setSnoozeUntil] = useState(() => datePlusDays(1));
  const [copied, setCopied] = useState(false);
  const [savingAction, setSavingAction] = useState(null);
  const saving = Boolean(savingAction);

  const rebuildMessage = (patch = {}) => {
    if (!task) return;
    setMessageText(buildTaskMessage(task, {
      externalLink: patch.externalLink ?? externalLink,
      dueDate: patch.dueDate ?? dueDate,
      communityLink: patch.communityLink ?? communityLink,
    }));
  };

  const updateExternalLink = (value) => { setExternalLink(value); rebuildMessage({ externalLink: value }); };
  const updateDueDate = (value) => { setDueDate(value); rebuildMessage({ dueDate: value }); };
  const updateCommunityLink = (value) => { setCommunityLink(value); rebuildMessage({ communityLink: value }); };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast.success('Mensagem copiada');
    } catch {
      toast.error('Não foi possível copiar');
    }
  };

  const openWhatsApp = () => {
    if (!task) return;
    const phone = phoneDigitsForWhatsApp(task.customerWhatsapp);
    if (!phone || phone === '55') return toast.error('Cliente sem WhatsApp cadastrado');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(messageText)}`, '_blank');
  };

  const markAsSent = async () => {
    if (!task) return;
    const message = messageText.trim();
    if (!message) return toast.error('Mensagem vazia');

    const trimmedLink = externalLink.trim();
    const isChargeTask = task.bucket === TASK_BUCKET.CHARGES;
    const nativePaymentInfo = hasNativePaymentInfo(task);

    if (isChargeTask && !nativePaymentInfo && !trimmedLink) {
      return toast.error('Informe o link externo antes de registrar o envio');
    }
    if (trimmedLink && !isSafePaymentUrl(trimmedLink)) {
      return toast.error('Informe um link válido começando com http:// ou https://');
    }

    setSavingAction('sent');
    try {
      await registerCommunicationSend(task, { message, externalLink: trimmedLink, dueDate, communityLink });
      toast.success('Envio registrado');
      onSent?.();
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar envio');
    } finally {
      setSavingAction(null);
    }
  };

  const ignoreTask = async () => {
    if (!task) return;
    const reason = actionReason.trim();
    if (!reason) return toast.error('Informe o motivo para ignorar esta etapa');
    setSavingAction('ignored');
    try {
      await registerCommunicationIgnore(task, { reason });
      toast.success('Etapa ignorada');
      onSent?.();
    } catch (e) {
      toast.error(e.message || 'Erro ao ignorar mensagem');
    } finally {
      setSavingAction(null);
    }
  };

  const snoozeTask = async () => {
    if (!task) return;
    if (!snoozeUntil) return toast.error('Informe a data para adiar');
    if (snoozeUntil < todayLocalStr()) return toast.error('Escolha hoje ou uma data futura');

    setSavingAction('snoozed');
    try {
      await registerCommunicationSnooze(task, { reason: actionReason.trim(), snoozeUntil });
      toast.success('Etapa adiada');
      onSent?.();
    } catch (e) {
      toast.error(e.message || 'Erro ao adiar mensagem');
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <Dialog open={!!task} onOpenChange={open => !open && onClose?.()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {task && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Send className="w-5 h-5 text-blue-600" />
                {task.title}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3 text-sm grid gap-2 md:grid-cols-2">
                <div>
                  <span className="text-muted-foreground block text-xs">Cliente</span>
                  <span className="font-semibold">{task.customerName}</span>
                  {task.customerWhatsapp && (
                    <span className="text-muted-foreground block text-xs mt-0.5">{formatPhoneDisplay(task.customerWhatsapp)}</span>
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">{task.sourceLabel}</span>
                  <Link to={task.href} className="font-mono font-semibold text-blue-700 hover:underline">
                    {task.orderNumber}
                  </Link>
                </div>
              </div>

              {task.bucket === TASK_BUCKET.CHARGES && (
                <div className="grid gap-3 md:grid-cols-2">
                  {!hasNativePaymentInfo(task) && (
                    <div>
                      <Label className="text-xs">Link externo</Label>
                      <div className="relative mt-1">
                        <Link2 className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                        <Input
                          className="pl-9 font-mono text-xs"
                          placeholder="https://..."
                          value={externalLink}
                          onChange={e => updateExternalLink(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                  {!hasNativePaymentInfo(task) && (
                    <div>
                      <Label className="text-xs">Vencimento</Label>
                      <Input
                        type="date"
                        className="mt-1"
                        value={dueDate}
                        onChange={e => updateDueDate(e.target.value)}
                      />
                    </div>
                  )}
                  {hasNativePaymentInfo(task) && (
                    <div className="md:col-span-2 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                      <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Cobrança Asaas ou link salvo encontrado. A mensagem usa esses dados automaticamente.</span>
                    </div>
                  )}
                  {!hasAnyPaymentLink(task, externalLink) && (
                    <div className="md:col-span-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Para registrar envio de cobrança, informe um link externo ou gere a cobrança Asaas na tela de origem.</span>
                    </div>
                  )}
                </div>
              )}

              {task.kind === TASK_KIND.ONBOARDING_WELCOME && (
                <div>
                  <Label className="text-xs">Link da comunidade</Label>
                  <Input
                    className="mt-1 font-mono text-xs"
                    placeholder="https://chat.whatsapp.com/..."
                    value={communityLink}
                    onChange={e => updateCommunityLink(e.target.value)}
                  />
                </div>
              )}

              <div>
                <Label className="text-xs">Mensagem</Label>
                <Textarea
                  rows={12}
                  className="mt-1 font-mono text-xs leading-relaxed"
                  value={messageText}
                  onChange={e => {
                    setMessageText(e.target.value);
                    setCopied(false);
                  }}
                />
              </div>

              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" className="flex-1 min-w-36" onClick={copyMessage}>
                  {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
                  {copied ? 'Copiado' : 'Copiar'}
                </Button>
                <Button className="flex-1 min-w-36 bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsApp}>
                  <ExternalLink className="w-4 h-4 mr-1.5" />
                  WhatsApp
                </Button>
              </div>

              <div className="rounded-lg border bg-gray-50 p-3 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Organizar fila</p>
                </div>
                <div className="grid gap-3 md:grid-cols-[1fr_180px]">
                  <div>
                    <Label className="text-xs">Motivo / observação</Label>
                    <Textarea
                      rows={3}
                      className="mt-1 text-xs leading-relaxed"
                      placeholder="Cliente pediu retorno amanhã, falei por outro canal, cobrança incorreta..."
                      value={actionReason}
                      onChange={e => setActionReason(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Relembrar em</Label>
                    <Input
                      type="date"
                      className="mt-1"
                      value={snoozeUntil}
                      min={todayLocalStr()}
                      onChange={e => setSnoozeUntil(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <Button variant="outline" onClick={snoozeTask} disabled={saving} className="border-blue-200 text-blue-700 hover:bg-blue-50">
                    {savingAction === 'snoozed' ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Clock className="w-4 h-4 mr-1.5" />}
                    {savingAction === 'snoozed' ? 'Adiando...' : 'Adiar etapa'}
                  </Button>
                  <Button variant="outline" onClick={ignoreTask} disabled={saving} className="border-gray-300">
                    {savingAction === 'ignored' ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <XCircle className="w-4 h-4 mr-1.5" />}
                    {savingAction === 'ignored' ? 'Ignorando...' : 'Ignorar etapa'}
                  </Button>
                </div>
              </div>

              <div>
                <Button onClick={markAsSent} disabled={saving} className="w-full">
                  {savingAction === 'sent' ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <UserRoundCheck className="w-4 h-4 mr-1.5" />}
                  {savingAction === 'sent' ? 'Registrando...' : 'Marcar como enviada'}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
