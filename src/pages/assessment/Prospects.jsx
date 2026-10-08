import { studentProfilePath } from '@/lib/customer-profile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArchiveX, BellRing, Calendar, Check, CheckCheck, ChevronRight, CircleDollarSign,
  Clock3, Copy, CreditCard, ExternalLink, HelpCircle, Loader2, MessageCircle, Plus, SearchCheck, Send,
  ThumbsUp, TrendingUp, UserCheck, UserPlus, UserRoundCheck,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import AsaasPaidNotice from '@/components/AsaasPaidNotice';
import AsaasPaymentCheckDialog from '@/components/AsaasPaymentCheckDialog';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { PhoneInput } from '@/components/PhoneInput';
import {
  changeAssessmentContractCoach,
  changeAssessmentContractPlan,
  createManualAssessmentProspect,
  loseAssessmentProspect,
  markAssessmentProspectMessageSent,
  prepareAssessmentProspectProposal,
  registerAssessmentProspectContact,
} from '@/api/client';
import { AssessmentCoach, AssessmentModality, AssessmentPlan } from '@/api/entities';
import { supabase } from '@/api/db';
import { createManualInstallments, findPreferredPaymentMethod, loadActivePaymentMethods } from '@/lib/manual-payment';
import { formatCustomerAddress } from '@/lib/br-address';
import { formatCurrency, formatDate, formatDateTime, maskCpf, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { phoneDigitsForWhatsApp } from '@/lib/phone';
import { prepareManualProspect, PROSPECT_GENDERS } from '@/lib/assessment-prospect-form';
import {
  coachServesModality,
  contractPlanSnapshot,
  describeProspectProposal,
  planProspectProposalSave,
  proposalFormFrom,
} from '@/lib/assessment-prospect-proposal';
import {
  LINK_DEADLINE_DAYS,
  PROSPECT_STEP_LABELS,
  addDays,
  formatDeadline,
  hoursSince,
  isStepDue,
  needsActionToday,
  prospectClosingMessage,
  prospectFirstContactMessage,
  prospectFollowUpMessage,
  prospectNextStep,
  prospectPaymentClosingMessage,
} from '@/lib/assessment-prospect-flow';
import { asaasCheckCandidates } from '@/lib/asaas-payment-check';
import { toast } from 'sonner';

const STAGES = {
  new: { label: 'Novo', badge: 'bg-blue-100 text-blue-700', border: 'border-blue-200' },
  awaiting_reply: { label: 'Aguardando resposta', badge: 'bg-sky-100 text-sky-800', border: 'border-sky-200' },
  clarifying: { label: 'Tirando dúvidas', badge: 'bg-orange-100 text-orange-800', border: 'border-orange-200' },
  proposal_ready: { label: 'Proposta pronta', badge: 'bg-amber-100 text-amber-800', border: 'border-amber-200' },
  payment_link_sent: { label: 'Link enviado', badge: 'bg-violet-100 text-violet-700', border: 'border-violet-200' },
  converted: { label: 'Convertido', badge: 'bg-green-100 text-green-700', border: 'border-green-200' },
  lost: { label: 'Não convertido', badge: 'bg-gray-200 text-gray-700', border: 'border-gray-200' },
};

const BOARD_COLUMNS = [
  { key: 'new', title: 'Novos', hint: 'Primeiro contato, sem link.' },
  { key: 'awaiting_reply', title: 'Aguardando resposta', hint: 'Lembrete no dia 2 e encerramento no dia 5.' },
  { key: 'clarifying', title: 'Tirando dúvidas', hint: 'Mesmo relógio, contado da última conversa.' },
  { key: 'proposal_ready', title: 'Proposta pronta', hint: 'Link montado, falta enviar ou registrar envio.' },
  { key: 'payment_link_sent', title: 'Link enviado', hint: 'Lembrete no dia seguinte ao vencimento; encerramento 5 dias depois.' },
  { key: 'converted', title: 'Convertidos', hint: 'Pagamento confirmado.' },
  { key: 'lost', title: 'Não convertidos', hint: 'Arquivados sem conversão.' },
];

const FILTERS = [
  ['all', 'Todos'],
  ['today', 'Para hoje'],
  ['open', 'Em negociação'],
  ['new', 'Novos'],
  ['awaiting_reply', 'Aguardando resposta'],
  ['clarifying', 'Tirando dúvidas'],
  ['proposal_ready', 'Proposta pronta'],
  ['payment_link_sent', 'Link enviado'],
  ['needs_review', 'Alterações'],
  ['returns', 'Retornos'],
  ['converted', 'Convertidos'],
  ['lost', 'Não convertidos'],
];

const LOSS_REASONS = [
  ['price', 'Preço'],
  ['no_response', 'Não respondeu'],
  ['changed_mind', 'Desistiu'],
  ['chose_competitor', 'Escolheu outra assessoria'],
  ['coach_availability', 'Indisponibilidade de coach'],
  ['invalid_contact', 'Contato inválido (número não funciona)'],
  ['other_service', 'Queria outro serviço'],
  ['other', 'Outro motivo'],
];

const RELATIONSHIPS = {
  new_customer: {
    label: 'Cliente novo',
    badge: 'bg-sky-100 text-sky-700',
    description: 'Sem contrato anterior de assessoria',
  },
  former_student: {
    label: 'Ex-aluno retornando',
    badge: 'bg-orange-100 text-orange-800',
    description: 'Possui contrato anterior de assessoria e está inativo',
  },
  active_student: {
    label: 'Aluno atual',
    badge: 'bg-indigo-100 text-indigo-700',
    description: 'Já possui outro contrato ativo; revisar como novo serviço ou troca',
  },
};

const PROSPECT_CONTRACT_COLUMNS = 'id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, installments, enrollment_fee, manual_discount, discount_reason, payment_method, payment_status, payment_date, payment_message_sent_at, due_date, external_payment_link, asaas_charge_id, asaas_payment_link, created_at, updated_at, status, prospect_stage, prospect_proposal_ready_at, prospect_message_sent_at, prospect_converted_at, prospect_lost_at, prospect_loss_reason_code, prospect_loss_notes, prospect_customer_relationship, prospect_previous_contract_id, prospect_reactivated_at, prospect_first_contact_at, prospect_last_contact_at, prospect_followup_sent_at, prospect_payment_reminder_sent_at, prospect_closing_sent_at, prospect_close_deadline';

const OPEN_PROSPECT_STAGES = new Set(['new', 'awaiting_reply', 'clarifying', 'proposal_ready', 'payment_link_sent']);
const OPEN_PAYMENT_STATUSES = new Set(['pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid']);

function contractTotal(contract) {
  const base = Number(contract.plan_snapshot?.price_total ?? 0);
  const enrollment = Number(contract.enrollment_fee || 0);
  const discount = Number(contract.manual_discount || 0);
  return Math.max(0, base + enrollment - discount);
}

function tomorrowLocal() {
  const date = new Date(`${todayLocalStr()}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return toLocalDateStr(date);
}

function getPlanMonths(plan) {
  return Number(plan?.period_months)
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
}

function hasSubmissionChange(draft) {
  const submission = draft?.latest_submission;
  if (!submission) return false;
  return (submission.plan_id && submission.plan_id !== draft.plan_id)
    || (submission.coach_id && submission.coach_id !== draft.coach_id);
}

function isDraftProspect(draft) {
  return draft?.status === 'draft';
}

function hasOpenPayment(draft) {
  return OPEN_PAYMENT_STATUSES.has(draft?.payment_status || 'pending') && !draft?.payment_date;
}

function isOpenProspect(draft) {
  if (['cancelled', 'voided'].includes(draft?.status)) return false;
  return OPEN_PROSPECT_STAGES.has(draft?.prospect_stage) && hasOpenPayment(draft);
}

function prospectVisualStage(draft) {
  if (draft?.prospect_stage === 'lost') return 'lost';
  if (draft?.prospect_stage === 'converted' || draft?.payment_status === 'paid' || draft?.prospect_converted_at) return 'converted';
  if (
    isOpenProspect(draft)
    && draft?.prospect_stage === 'new'
    && (paymentLinkFor(draft) || draft?.payment_message_sent_at || draft?.prospect_message_sent_at || ['charge_sent', 'overdue'].includes(draft?.payment_status))
  ) {
    return 'payment_link_sent';
  }
  return draft?.prospect_stage || 'new';
}

function matchesProspectFilter(item, filter, today) {
  if (filter === 'all') return true;
  if (filter === 'today') return isOpenProspect(item) && needsActionToday(item, today);
  if (filter === 'returns') return item.prospect_customer_relationship === 'former_student';
  if (filter === 'needs_review') return isOpenProspect(item) && hasSubmissionChange(item);
  if (filter === 'open') return isOpenProspect(item);
  return prospectVisualStage(item) === filter;
}

function paymentLinkFor(contract) {
  return contract.external_payment_link || contract.asaas_payment_link || '';
}

function buildMessage(contract, customer, coach, modality) {
  const total = contractTotal(contract);
  const installments = Number(contract.installments) || 1;
  const months = Number(contract.plan_snapshot?.period_months) || 1;
  const planName = contract.plan_snapshot?.name
    || (modality ? `${modality.name} · ${months}m` : 'Assessoria');
  const firstName = customer?.full_name?.trim().split(' ')[0] || 'atleta';
  const paymentLink = paymentLinkFor(contract);
  const isReminder = contract.prospect_stage === 'payment_link_sent' && Boolean(contract.prospect_message_sent_at);

  let message = `Olá, ${firstName}! 👋\n\n`;
  if (isReminder) {
    message += 'Passando só para lembrar que sua proposta para treinar com a *Endurance On* ficou reservada e o pagamento ainda está em aberto.\n\n';
  } else if (contract.prospect_first_contact_at || contract.prospect_last_contact_at) {
    // Depois do primeiro contato, a proposta responde ao "quer seguir".
    message += 'Que bom que você quer seguir! Sua proposta está pronta:\n\n';
  } else {
    message += contract.prospect_customer_relationship === 'former_student'
      ? 'Que bom ter você de volta à *Endurance On*! Sua nova proposta está pronta:\n\n'
      : 'Recebemos seu cadastro para treinar com a *Endurance On*. Sua proposta está pronta:\n\n';
  }
  if (modality) message += `🏃 Modalidade: *${modality.name}*\n`;
  message += `📅 Plano: *${planName}* (${months} ${months === 1 ? 'mês' : 'meses'})\n`;
  if (coach) message += `👤 Coach: *${coach.name}*\n`;
  message += `💰 Total: *${formatCurrency(total)}*`;
  if (installments > 1) {
    message += ` em *${installments}x de ${formatCurrency(total / installments)}*`;
  }
  message += '\n';
  if (Number(contract.enrollment_fee) > 0) {
    message += `📌 Matrícula: ${formatCurrency(contract.enrollment_fee)}\n`;
  }
  message += `⏰ Vencimento: *${formatDate(contract.due_date)}*\n\n`;
  if (isReminder) {
    message += `Para confirmar sua vaga, é só finalizar pelo link abaixo:\n🔗 ${paymentLink}\n\n`;
    message += `Assim que o pagamento for confirmado, ${coach?.name ? `o coach *${coach.name}*` : 'o coach escolhido'} entra em contato para dar início ao atendimento. Se você já fez o pagamento, pode desconsiderar esta mensagem. Qualquer dúvida, me chama por aqui.`;
  } else {
    message += `Para confirmar sua vaga, faça o pagamento pelo link:\n🔗 ${paymentLink}\n\n`;
    message += `Assim que o pagamento for confirmado, ${coach?.name ? `o coach *${coach.name}*` : 'o coach escolhido'} entrará em contato para iniciar seu atendimento. 🏆`;
  }
  return message;
}

// Formato que a conferência do Asaas usa (o mesmo da tela de Cobranças).
function asaasOrderFor(draft, customer) {
  return {
    type: 'contract',
    id: draft.id,
    order_number: draft.contract_number,
    customer: customer?.full_name || '—',
    is_prospect: true,
    total_value: contractTotal(draft),
    payment_status: draft.payment_status,
    payment_method: draft.payment_method,
    due_date: draft.due_date,
    asaas_charge_id: draft.asaas_charge_id,
    external_payment_link: draft.external_payment_link,
    installments: Number(draft.installments) || 1,
    updated_at: draft.updated_at,
    status: draft.status,
  };
}

const CONTACT_TITLES = {
  first_contact: 'Primeiro contato',
  follow_up: 'Lembrete',
  closing: 'Encerramento',
  payment_closing: 'Encerramento com prazo final',
};

// Mensagens da conversa antes e depois do link. Envio manual: copiar (ou abrir
// o WhatsApp) e registrar. Sem travas de data: dá para enviar antes do previsto.
function ContactModal({ data, onClose, onDone, onRegisterPaid }) {
  const { draft, customer, coach, modality, kind } = data;
  const today = todayLocalStr();
  const deadline = addDays(today, LINK_DEADLINE_DAYS);
  const step = prospectNextStep(draft);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [externalCancelled, setExternalCancelled] = useState(false);
  const fullName = customer?.full_name;
  const message = kind === 'first_contact'
    ? prospectFirstContactMessage({
      fullName,
      modality: modality?.name,
      plan: draft.plan_snapshot?.name,
      coach: coach?.name,
      returning: draft.prospect_customer_relationship === 'former_student',
    })
    : kind === 'follow_up'
      ? prospectFollowUpMessage({ fullName, coach: coach?.name })
      : kind === 'closing'
        ? prospectClosingMessage({ fullName })
        : prospectPaymentClosingMessage({ fullName, deadline, paymentLink: paymentLinkFor(draft) });
  const archives = kind === 'closing';
  const needsLinkConfirmation = archives && Boolean(draft.external_payment_link);
  const early = step?.kind === kind && step.dueDate > today;
  const lastContact = kind === 'payment_closing'
    ? draft.prospect_payment_reminder_sent_at || draft.prospect_message_sent_at
    : draft.prospect_last_contact_at;

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Mensagem copiada!');
    window.setTimeout(() => setCopied(false), 2000);
  };

  const openWhatsApp = () => {
    const phone = phoneDigitsForWhatsApp(customer?.whatsapp);
    if (!phone || phone === '55') return toast.error('WhatsApp do prospect não cadastrado');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };

  const register = async () => {
    if (needsLinkConfirmation && !externalCancelled) return toast.error('Confirme o cancelamento do link externo');
    setSaving(true);
    try {
      await registerAssessmentProspectContact(draft.id, {
        action: kind === 'payment_closing' ? 'closing' : kind,
        externalCancellationConfirmed: externalCancelled,
        expectedUpdatedAt: draft.updated_at,
      });
      toast.success({
        first_contact: 'Primeiro contato registrado. O card foi para “Aguardando resposta”.',
        follow_up: 'Lembrete registrado.',
        closing: 'Encerramento registrado. A proposta foi arquivada como “Não respondeu”.',
        payment_closing: `Encerramento registrado. O link fica ativo até ${formatDeadline(deadline)}.`,
      }[kind]);
      onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível registrar o envio');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-green-600" /> {CONTACT_TITLES[kind]}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4 mt-2">
        {kind === 'payment_closing' && (
          <AsaasPaidNotice order={asaasOrderFor(draft, customer)} onRegister={onRegisterPaid} />
        )}
        {kind !== 'first_contact' && lastContact && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {kind === 'payment_closing'
              ? `Último envio do link em ${formatDateTime(lastContact)}. Confira a conversa no WhatsApp antes de enviar.`
              : `Último contato registrado em ${formatDateTime(lastContact)}. Confira a conversa no WhatsApp antes de enviar: se a pessoa respondeu, marque a resposta no card.`}
          </p>
        )}
        {early && (
          <p className="text-xs text-muted-foreground">
            Previsto para {formatDate(step.dueDate)}. Se quiser, pode enviar antes.
          </p>
        )}
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm whitespace-pre-wrap text-gray-800 max-h-72 overflow-y-auto">
          {message}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={copyMessage}>
            {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
            {copied ? 'Copiado!' : 'Copiar'}
          </Button>
          <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={openWhatsApp} disabled={!customer?.whatsapp}>
            <MessageCircle className="w-4 h-4 mr-1.5" /> Abrir WhatsApp
          </Button>
        </div>
        {kind === 'payment_closing' && (
          <p className="text-xs text-muted-foreground">
            O link continua valendo até {formatDeadline(deadline)}. Nesse dia, o card pede para arquivar: aí você cancela o link no Asaas.
          </p>
        )}
        {needsLinkConfirmation && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={externalCancelled}
              onChange={event => setExternalCancelled(event.target.checked)} />
            <span>Confirmo que o link de pagamento externo foi cancelado e não poderá mais ser pago.</span>
          </label>
        )}
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Voltar</Button>
          <Button className="bg-violet-600 hover:bg-violet-700" onClick={register} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Send className="w-4 h-4 mr-1.5" />}
            {archives ? 'Registrar que enviei e arquivar' : 'Registrar que enviei'}
          </Button>
        </div>
      </div>
    </>
  );
}

function elapsedLabel(hours) {
  if (hours === null) return '';
  if (hours < 1) return 'menos de 1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'dia' : 'dias'}`;
}

// O próximo passo do card e quando ele vence ("Lembrete hoje", "Encerramento
// em 13/10"). No primeiro contato, mostra há quanto tempo o cadastro chegou.
function NextStepLine({ draft }) {
  const step = isOpenProspect(draft) ? prospectNextStep(draft) : null;
  if (!step) return null;
  const today = todayLocalStr();
  const due = isStepDue(step, today);
  let text;
  let urgent = due;
  if (step.kind === 'first_contact') {
    const hours = hoursSince(draft.created_at);
    text = `Chegou há ${elapsedLabel(hours)}: primeiro contato`;
    urgent = hours !== null && hours >= 2;
  } else {
    const when = step.dueDate === today ? 'hoje' : due ? `desde ${formatDate(step.dueDate)}` : `em ${formatDate(step.dueDate)}`;
    text = `${PROSPECT_STEP_LABELS[step.kind]} ${when}`;
    if (step.kind === 'archive' && !due) text += ' (link ativo até lá)';
  }
  return (
    <p className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
      urgent ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50 text-gray-600'
    }`}>
      <Clock3 className="h-3.5 w-3.5 shrink-0" /> {text}
    </p>
  );
}

// Botões do card (quadro e lista), conforme a etapa e o próximo passo.
function ProspectActionButtons({
  draft, customer, coach, modality, compact = false,
  onProposal, onPayment, onLoss, onContact, onQuickContact, quickBusy,
}) {
  const isOpen = isOpenProspect(draft);
  const canAct = isOpen && isDraftProspect(draft);
  const managedInContract = isOpen && !canAct;
  const hasPaymentLink = Boolean(paymentLinkFor(draft));
  const stage = draft.prospect_stage;
  const step = canAct ? prospectNextStep(draft) : null;
  const due = isStepDue(step, todayLocalStr());
  const size = compact ? 'h-8 text-xs' : '';
  const text = (full, short) => (compact ? short : full);
  const args = [draft, customer, coach, modality];
  const busy = quickBusy === draft.id;
  const icon = 'w-3.5 h-3.5 mr-1';
  const primary = (color = 'bg-green-600 hover:bg-green-700') => `${size} ${color}`;
  const outline = `${size}`;

  return (
    <>
      {canAct && stage === 'new' && step?.kind === 'first_contact' && (
        <Button size="sm" className={primary('bg-sky-600 hover:bg-sky-700')} onClick={() => onContact(...args, 'first_contact')}>
          <MessageCircle className={icon} /> {text('Primeiro contato', '1º contato')}
        </Button>
      )}
      {canAct && stage === 'new' && (
        <Button size="sm" variant={step?.kind === 'first_contact' ? 'outline' : 'default'}
          className={step?.kind === 'first_contact' ? outline : primary('bg-amber-600 hover:bg-amber-700')}
          onClick={() => onProposal(...args)}>
          <CircleDollarSign className={icon} /> {text('Preparar proposta', 'Proposta')}
        </Button>
      )}
      {canAct && ['awaiting_reply', 'clarifying'].includes(stage) && (
        <Button size="sm" className={primary('bg-amber-600 hover:bg-amber-700')} onClick={() => onProposal(...args)}>
          <ThumbsUp className={icon} /> Quer seguir
        </Button>
      )}
      {canAct && ['new', 'awaiting_reply'].includes(stage) && (
        <Button size="sm" variant="outline" className={outline} disabled={busy}
          onClick={() => onQuickContact(draft, 'has_questions')}>
          <HelpCircle className={icon} /> {text('Tem dúvidas', 'Dúvidas')}
        </Button>
      )}
      {canAct && stage === 'clarifying' && (
        <Button size="sm" variant="outline" className={outline} disabled={busy}
          onClick={() => onQuickContact(draft, 'conversation')}>
          <MessageCircle className={icon} /> {text('Conversamos hoje', 'Conversamos')}
        </Button>
      )}
      {canAct && ['awaiting_reply', 'clarifying'].includes(stage) && step && (
        <Button size="sm" variant={due ? 'default' : 'outline'}
          className={due ? primary('bg-violet-600 hover:bg-violet-700') : outline}
          onClick={() => onContact(...args, step.kind)}>
          {step.kind === 'closing'
            ? <><ArchiveX className={icon} /> Encerrar</>
            : <><BellRing className={icon} /> Lembrete</>}
        </Button>
      )}
      {canAct && stage === 'proposal_ready' && (
        <Button size="sm" className={primary()} onClick={() => onProposal(...args)}>
          <Send className={icon} /> {text('Enviar mensagem', 'Enviar')}
        </Button>
      )}
      {canAct && stage === 'payment_link_sent' && hasPaymentLink && (
        <>
          <Button size="sm" variant={step?.kind === 'payment_reminder' && due ? 'default' : 'outline'}
            className={step?.kind === 'payment_reminder' && due ? primary('bg-violet-600 hover:bg-violet-700') : `${outline} text-green-700`}
            onClick={() => onProposal(...args)}>
            {step?.kind === 'payment_reminder'
              ? <><BellRing className={icon} /> Lembrete</>
              : <><MessageCircle className={icon} /> Reenviar</>}
          </Button>
          {step?.kind === 'payment_closing' && (
            <Button size="sm" variant={due ? 'default' : 'outline'}
              className={due ? primary('bg-violet-600 hover:bg-violet-700') : outline}
              onClick={() => onContact(...args, 'payment_closing')}>
              <ArchiveX className={icon} /> Encerrar
            </Button>
          )}
          {step?.kind === 'archive' && (
            <Button size="sm" variant={due ? 'default' : 'outline'}
              className={due ? primary('bg-gray-700 hover:bg-gray-800') : outline}
              onClick={() => onLoss(draft, customer, 'no_response')}>
              <ArchiveX className={icon} /> Arquivar
            </Button>
          )}
          <Button size="sm" className={primary()} onClick={() => onPayment(...args)}>
            <CheckCheck className={icon} /> {text('Confirmar pagamento', 'Pago')}
          </Button>
        </>
      )}
      {canAct && stage === 'payment_link_sent' && !hasPaymentLink && (
        <Button size="sm" className={primary('bg-amber-600 hover:bg-amber-700')} onClick={() => onProposal(...args)}>
          <CircleDollarSign className={icon} /> {text('Refazer proposta', 'Refazer')}
        </Button>
      )}
      {canAct && (
        <Button size="sm" variant="outline" className={`${outline} text-gray-700`} onClick={() => onLoss(draft, customer)}>
          <ArchiveX className={icon} /> {text('Não convertido', 'Perda')}
        </Button>
      )}
      <Button size="sm" variant="outline" className={outline} asChild>
        <Link to={`/assessoria/contratos/${draft.id}`}>
          {managedInContract ? text('Abrir contrato', 'Contrato') : 'Ver'} <ChevronRight className="w-3.5 h-3.5 ml-1" />
        </Link>
      </Button>
    </>
  );
}

function CustomerData({ customer, contract }) {
  const relationship = RELATIONSHIPS[contract?.prospect_customer_relationship];
  const address = formatCustomerAddress(customer);
  return (
    <div className="border rounded-xl p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cliente vinculado</p>
        {customer?.id && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-blue-600" asChild>
            <Link to={studentProfilePath(customer.id, 'registration')}>Abrir cliente <ChevronRight className="w-3.5 h-3.5 ml-1" /></Link>
          </Button>
        )}
      </div>
      {relationship && (
        <div className="rounded-lg bg-gray-50 border p-2.5 mb-2">
          <span className={`inline-flex text-[11px] px-2 py-0.5 rounded-full font-semibold ${relationship.badge}`}>
            {relationship.label}
          </span>
          <p className="text-xs text-muted-foreground mt-1">{relationship.description}</p>
          {contract?.prospect_previous_contract_id && (
            <Link className="text-xs text-blue-600 hover:underline mt-1 inline-block"
              to={`/assessoria/contratos/${contract.prospect_previous_contract_id}`}>
              Ver contrato de referência →
            </Link>
          )}
        </div>
      )}
      {[
        ['Código', customer?.customer_code],
        ['Nome', customer?.full_name],
        ['Gênero', PROSPECT_GENDERS[customer?.gender] || customer?.gender],
        ['Nascimento', customer?.birth_date ? formatDate(customer.birth_date) : null],
        ['WhatsApp', customer?.whatsapp],
        ['E-mail', customer?.email],
        ['CPF', customer?.cpf],
        ['Endereço', address],
      ].map(([label, value]) => value ? (
        <div key={label} className="flex items-start justify-between gap-2 text-sm">
          <span className="text-muted-foreground text-xs w-20 shrink-0">{label}</span>
          <span className={`flex-1 font-medium ${label === 'Endereço' ? 'break-words leading-snug' : 'truncate'}`}>{value}</span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(value).then(() => toast.success(`${label} copiado!`))}
            className="text-blue-500 hover:text-blue-700 shrink-0 p-1 rounded hover:bg-blue-50"
            title={`Copiar ${label}`}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : null)}
    </div>
  );
}

async function loadProspectContract(id) {
  const { data, error } = await supabase
    .from('assessment_contracts')
    .select(PROSPECT_CONTRACT_COLUMNS)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

function PlanSelectItems({ plans }) {
  return plans.map(plan => (
    <SelectItem key={plan.id} value={plan.id} className="[&>span:last-child]:min-w-0">
      <span className="block whitespace-normal break-words">{plan.name || `Plano ${plan.period || ''}`}</span>
      <span className="block whitespace-normal text-xs text-muted-foreground">
        {formatCurrency(plan.price_total)} total · {getPlanMonths(plan)} {getPlanMonths(plan) === 1 ? 'mês' : 'meses'}
      </span>
    </SelectItem>
  ));
}

function ProposalModal({ data, onClose, onDone, onSaved, onRegisterPaid }) {
  const { draft, customer } = data;
  const [contract, setContract] = useState(draft);
  const [step, setStep] = useState(
    ['proposal_ready', 'payment_link_sent'].includes(draft.prospect_stage) && paymentLinkFor(draft) ? 'message' : 'proposal',
  );
  const [form, setForm] = useState(() => proposalFormFrom(draft, {
    paymentLink: paymentLinkFor(draft),
    defaultDueDate: tomorrowLocal(),
  }));
  const [options, setOptions] = useState({ plans: [], coaches: [], modalities: [] });
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const planOperation = useRef(null);

  useEffect(() => {
    let active = true;
    setLoadingOptions(true);
    setOptionsError(false);
    Promise.all([
      AssessmentPlan.filter({ active: true }),
      AssessmentCoach.filter({ active: true }, 'name'),
      AssessmentModality.list(),
    ]).then(([plans, coaches, modalities]) => {
      if (active) setOptions({ plans, coaches, modalities });
    }).catch(() => {
      if (active) setOptionsError(true);
    }).finally(() => { if (active) setLoadingOptions(false); });
    return () => { active = false; };
  }, [optionsAttempt]);

  const coachById = new Map(options.coaches.map(item => [item.id, item]));
  const modalityById = new Map(options.modalities.map(item => [item.id, item]));
  const proposal = describeProspectProposal({ contract, form, plans: options.plans });
  const savedCoach = coachById.get(contract.coach_id) || (contract.coach_id === draft.coach_id ? data.coach : null);
  const savedModality = modalityById.get(contract.plan_snapshot?.modality_id) || data.modality;
  const message = buildMessage(contract, customer, savedCoach, savedModality);
  const isReminder = contract.prospect_stage === 'payment_link_sent' && Boolean(contract.prospect_message_sent_at);

  // Plano desativado continua na lista enquanto for o plano do prospect.
  const optionsReady = !loadingOptions && !optionsError;
  const planChoices = contract.plan_id && !options.plans.some(plan => plan.id === contract.plan_id)
    ? [{
      ...contractPlanSnapshot(contract),
      id: contract.plan_id,
      name: `${contract.plan_snapshot?.name || 'Plano atual'}${optionsReady ? ' (desativado)' : ''}`,
    }, ...options.plans]
    : options.plans;
  const coachChoices = options.coaches.filter(coach => coachServesModality(coach, proposal.modalityId));
  if (contract.coach_id && form.coach_id === contract.coach_id && !proposal.planChanged
    && !coachChoices.some(coach => coach.id === contract.coach_id)) {
    coachChoices.unshift({ id: contract.coach_id, name: savedCoach?.name || 'Coach atual' });
  }
  const coachValue = coachChoices.some(coach => coach.id === form.coach_id) ? form.coach_id : '';
  const installmentChoices = Array.from(
    { length: Math.max(proposal.maxInstallments, Number(form.installments) || 1) },
    (_, index) => index + 1,
  );
  const savedLink = paymentLinkFor(contract);
  const linkMayBeStale = Boolean(savedLink) && form.payment_link.trim() === savedLink
    && (Math.abs(proposal.total - contractTotal(contract)) > 0.009
      || proposal.installments !== (Number(contract.installments) || 1));
  const modalityName = modalityById.get(proposal.modalityId)?.name;

  const choosePlan = planId => {
    if (planId === contract.plan_id) {
      const originalModalityId = options.plans.find(plan => plan.id === planId)?.modality_id
        || contract.plan_snapshot?.modality_id;
      setForm(current => ({
        ...current,
        plan_id: planId,
        installments: Number(contract.installments) || 1,
        enrollment_fee: String(Number(contract.enrollment_fee || 0)),
        coach_id: coachServesModality(coachById.get(current.coach_id), originalModalityId) ? current.coach_id : contract.coach_id,
      }));
      return;
    }
    const nextPlan = options.plans.find(plan => plan.id === planId);
    setForm(current => ({
      ...current,
      plan_id: planId,
      installments: Math.min(Math.max(1, Number(current.installments) || 1), Math.max(1, Number(nextPlan?.max_installments) || 1)),
      enrollment_fee: String(Number(nextPlan?.enrollment_fee || 0)),
      coach_id: coachServesModality(coachById.get(current.coach_id), nextPlan?.modality_id) ? current.coach_id : '',
    }));
  };

  const saveProposal = async () => {
    if (saving) return;
    const plan = planProspectProposalSave({
      contract,
      form,
      plans: options.plans,
      coaches: options.coaches,
      today: todayLocalStr(),
    });
    if (plan.error) return toast.error(plan.error);
    const { steps, values } = plan;
    let current = contract;
    let savedSomething = false;
    setSaving(true);
    try {
      for (const action of steps) {
        if (action === 'plan') {
          const fingerprint = JSON.stringify([current.id, current.updated_at, values.planId, values.startDate,
            values.installments, values.enrollmentFee, values.manualDiscount]);
          if (planOperation.current?.fingerprint !== fingerprint) {
            planOperation.current = { fingerprint, key: crypto.randomUUID() };
          }
          await changeAssessmentContractPlan(current.id, {
            planId: values.planId,
            startDate: values.startDate,
            installments: values.installments,
            enrollmentFee: values.enrollmentFee,
            manualDiscount: values.manualDiscount,
            discountReason: current.discount_reason || null,
          }, { idempotencyKey: planOperation.current.key });
          savedSomething = true;
          current = { ...current, ...(await loadProspectContract(current.id)) };
        } else if (action === 'coach') {
          // Prospect ainda não começou: o coach novo vale desde o início do contrato.
          const result = await changeAssessmentContractCoach(current.id, {
            coachId: values.coachId,
            effectiveDate: current.start_date,
            expectedUpdatedAt: current.updated_at,
          });
          savedSomething = true;
          current = { ...current, ...(result?.contract || await loadProspectContract(current.id)) };
        } else {
          const result = await prepareAssessmentProspectProposal(current.id, {
            enrollmentFee: values.enrollmentFee,
            manualDiscount: values.manualDiscount,
            externalPaymentLink: values.paymentLink,
            dueDate: values.dueDate,
            expectedUpdatedAt: current.updated_at,
          });
          savedSomething = true;
          current = { ...current, ...(result?.contract || await loadProspectContract(current.id)) };
        }
        setContract(current);
      }
      setForm(proposalFormFrom(current, { paymentLink: paymentLinkFor(current), defaultDueDate: values.dueDate }));
      setStep('message');
      toast.success('Proposta pronta. O contrato continua aguardando pagamento.');
    } catch (error) {
      const reason = error.message || 'Não foi possível preparar a proposta';
      toast.error(savedSomething ? `${reason}. O que já foi salvo continua valendo; confira e salve de novo.` : reason);
    } finally {
      setSaving(false);
      if (savedSomething) onSaved?.();
    }
  };

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Mensagem copiada!');
    window.setTimeout(() => setCopied(false), 2000);
  };

  const openWhatsApp = () => {
    const phone = phoneDigitsForWhatsApp(customer?.whatsapp);
    if (!phone || phone === '55') return toast.error('WhatsApp do prospect não cadastrado');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };

  const markSent = async () => {
    setSaving(true);
    try {
      await markAssessmentProspectMessageSent(contract.id, contract.updated_at);
      toast.success('Envio registrado. O prospect ficou em “Link enviado”.');
      onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível registrar o envio');
    } finally {
      setSaving(false);
    }
  };

  if (step === 'proposal') {
    const enrollmentFeeValue = Number(form.enrollment_fee) || 0;
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDollarSign className="w-5 h-5 text-amber-600" /> Preparar proposta
          </DialogTitle>
        </DialogHeader>
        <fieldset className="space-y-4 mt-2 min-w-0" disabled={saving}>
          <CustomerData customer={customer} contract={contract} />
          {optionsError && (
            <div role="alert" className="text-sm text-red-700">
              Não foi possível carregar os planos e coaches. Dá para salvar matrícula, desconto e link, mas não trocar plano, coach, parcelas ou início.
              <Button variant="link" onClick={() => setOptionsAttempt(value => value + 1)}>Tentar novamente</Button>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2 min-w-0">
              <Label htmlFor="proposal-plan">Plano *</Label>
              <Select value={form.plan_id} onValueChange={choosePlan} disabled={!optionsReady}>
                <SelectTrigger id="proposal-plan" className="mt-1 h-auto min-h-9 gap-2 text-left [&>span]:min-w-0 [&>svg]:shrink-0">
                  <SelectValue placeholder={loadingOptions ? 'Carregando planos...' : 'Selecione...'} />
                </SelectTrigger>
                <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                  <PlanSelectItems plans={planChoices} />
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <Label htmlFor="proposal-coach">Coach *</Label>
              <Select value={coachValue} onValueChange={value => setForm(current => ({ ...current, coach_id: value }))}
                disabled={!optionsReady}>
                <SelectTrigger id="proposal-coach" className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {coachChoices.map(coach => <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {!coachValue && optionsReady && (
                <p className="text-xs text-amber-700 mt-1">
                  Escolha um coach que atenda {modalityName || 'a modalidade do plano'}.
                </p>
              )}
            </div>
            <div className="min-w-0">
              <Label htmlFor="proposal-installments">Parcelas</Label>
              <Select value={String(form.installments)} disabled={!optionsReady}
                onValueChange={value => setForm(current => ({ ...current, installments: Number(value) }))}>
                <SelectTrigger id="proposal-installments" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {installmentChoices.map(count => (
                    <SelectItem key={count} value={String(count)}>
                      {count}x de {formatCurrency(proposal.total / count)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <Label htmlFor="proposal-start">Início</Label>
              <Input id="proposal-start" className="mt-1 min-w-0" type="date" value={form.start_date} disabled={!optionsReady}
                onChange={event => setForm(current => ({ ...current, start_date: event.target.value }))} />
            </div>
            <div className="min-w-0">
              <Label>Término</Label>
              <p className="mt-1 h-9 flex items-center text-sm text-gray-700">
                {proposal.endDate ? formatDate(proposal.endDate) : '—'}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  ({proposal.months} {proposal.months === 1 ? 'mês' : 'meses'})
                </span>
              </p>
            </div>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="proposal-enrollment-fee">Matrícula</Label>
                {enrollmentFeeValue > 0 ? (
                  <button type="button" className="whitespace-nowrap text-xs font-medium text-red-600 hover:underline"
                    onClick={() => setForm(current => ({ ...current, enrollment_fee: '0' }))}>
                    Remover
                  </button>
                ) : proposal.planEnrollmentFee > 0 ? (
                  <button type="button" className="whitespace-nowrap text-xs font-medium text-blue-600 hover:underline"
                    onClick={() => setForm(current => ({ ...current, enrollment_fee: String(proposal.planEnrollmentFee) }))}>
                    Cobrar {formatCurrency(proposal.planEnrollmentFee)}
                  </button>
                ) : null}
              </div>
              <Input id="proposal-enrollment-fee" className="mt-1" type="number" min="0" step="0.01" inputMode="decimal"
                value={form.enrollment_fee}
                onChange={event => setForm(current => ({ ...current, enrollment_fee: event.target.value }))} />
            </div>
            <div className="min-w-0">
              <Label htmlFor="proposal-discount">Desconto</Label>
              <Input id="proposal-discount" className="mt-1" type="number" min="0" step="0.01" inputMode="decimal"
                value={form.manual_discount}
                onChange={event => setForm(current => ({ ...current, manual_discount: event.target.value }))} />
            </div>
          </div>
          <dl className="bg-gray-50 rounded-xl p-4 text-sm space-y-1.5" aria-label="Resumo da proposta">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Plano</dt>
              <dd>{formatCurrency(proposal.base)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Matrícula</dt>
              <dd>{enrollmentFeeValue > 0 ? formatCurrency(enrollmentFeeValue) : 'Sem matrícula'}</dd>
            </div>
            {Number(form.manual_discount) > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Desconto</dt>
                <dd>− {formatCurrency(Number(form.manual_discount))}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3 border-t pt-2">
              <dt className="font-semibold">Total da proposta</dt>
              <dd className="text-right">
                <span className="font-bold text-green-700">{formatCurrency(proposal.total)}</span>
                {proposal.installments > 1 && (
                  <span className="block text-xs text-muted-foreground">
                    {proposal.installments}x de {formatCurrency(proposal.perInstallment)}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          <div>
            <Label htmlFor="proposal-link">Link de pagamento *</Label>
            <Input id="proposal-link" className="mt-1" type="url" placeholder="https://..." value={form.payment_link}
              onChange={event => setForm(current => ({ ...current, payment_link: event.target.value }))} />
            <p className="text-xs text-muted-foreground mt-1">Gere o link com o total acima no Asaas ou no seu meio de cobrança e cole aqui.</p>
            {linkMayBeStale && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                O valor mudou desde que este link foi salvo ({formatCurrency(contractTotal(contract))} em {Number(contract.installments) || 1}x).
                Se o link foi gerado com o valor antigo, gere um novo e cole aqui.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="proposal-due-date">Vencimento *</Label>
            <Input id="proposal-due-date" className="mt-1" type="date" min={todayLocalStr()} value={form.due_date}
              onChange={event => setForm(current => ({ ...current, due_date: event.target.value }))} />
          </div>
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
            Salvar a proposta não ativa o contrato. A conversão acontecerá apenas quando o pagamento for confirmado.
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button className="flex-1 bg-amber-600 hover:bg-amber-700" onClick={saveProposal} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <ChevronRight className="w-4 h-4 mr-1.5" />}
              Salvar e montar mensagem
            </Button>
          </div>
        </fieldset>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-green-600" />
          {isReminder ? 'Lembrete de pagamento' : 'Mensagem e link de pagamento'}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4 mt-2">
        {isReminder && <AsaasPaidNotice order={asaasOrderFor(contract, customer)} onRegister={onRegisterPaid} />}
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm whitespace-pre-wrap text-gray-800 max-h-72 overflow-y-auto">
          {message}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={copyMessage}>
            {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
            {copied ? 'Copiado!' : 'Copiar'}
          </Button>
          <Button variant="outline" size="icon" asChild>
            <a href={paymentLinkFor(contract)} target="_blank" rel="noreferrer" title="Abrir link de pagamento">
              <ExternalLink className="w-4 h-4" />
            </a>
          </Button>
          <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={openWhatsApp} disabled={!customer?.whatsapp}>
            <MessageCircle className="w-4 h-4 mr-1.5" /> Abrir WhatsApp
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Depois de realmente enviar a mensagem no WhatsApp, registre o envio para manter o funil correto.
        </p>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <Button variant="ghost" onClick={() => setStep('proposal')} disabled={saving}>Editar proposta</Button>
          <Button className="bg-violet-600 hover:bg-violet-700" onClick={markSent} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Send className="w-4 h-4 mr-1.5" />}
            {contract.prospect_stage === 'payment_link_sent' ? 'Registrar reenvio' : 'Confirmar que enviei'}
          </Button>
        </div>
      </div>
    </>
  );
}

function PaymentModal({ data, onClose, onDone }) {
  const { draft, customer } = data;
  const total = contractTotal(draft);
  const [methodGroups, setMethodGroups] = useState([]);
  const [form, setForm] = useState({ method_id: '', date: todayLocalStr(), value: total.toFixed(2) });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    loadActivePaymentMethods()
      .then(groups => {
        if (!active) return;
        setMethodGroups(groups);
        const defaultMethod = findPreferredPaymentMethod(groups, draft.payment_method);
        setForm(current => ({ ...current, method_id: defaultMethod?.id || current.method_id }));
      })
      .catch(error => toast.error(error.message || 'Erro ao carregar formas de pagamento'))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [draft.payment_method]);

  const save = async () => {
    const method = methodGroups.flatMap(([, methods]) => methods).find(item => item.id === form.method_id);
    if (!method) return toast.error('Selecione a forma de pagamento');
    if (Math.abs(Number(form.value) - total) > 0.009) {
      return toast.error(`O valor recebido deve ser ${formatCurrency(total)}. Ajuste a proposta antes, se necessário.`);
    }
    setSaving(true);
    try {
      await createManualInstallments(method, form.date, {
        order_id: draft.id,
        order_type: 'contract',
        external_reference: draft.contract_number,
      }, total);
      toast.success(`Pagamento confirmado. ${customer?.full_name || 'O prospect'} foi convertido.`);
      onDone(draft.id);
    } catch (error) {
      toast.error(error.message || 'Não foi possível confirmar o pagamento');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCheck className="w-5 h-5 text-green-600" /> Confirmar pagamento e converter
        </DialogTitle>
      </DialogHeader>
      <div className="mt-2">
        {loading ? (
          <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : (
          <ManualPaymentForm
            form={form}
            setForm={setForm}
            methodGroups={methodGroups}
            saving={saving}
            onSave={save}
            onCancel={onClose}
          />
        )}
      </div>
    </>
  );
}

function LossModal({ data, onClose, onDone }) {
  const { draft, customer, presetReason } = data;
  const [reasonCode, setReasonCode] = useState(presetReason || '');
  const [reasonNotes, setReasonNotes] = useState('');
  const [externalCancelled, setExternalCancelled] = useState(false);
  const [saving, setSaving] = useState(false);
  const hasExternalLink = Boolean(draft.external_payment_link);

  const save = async () => {
    if (!reasonCode) return toast.error('Selecione o motivo');
    if (hasExternalLink && !externalCancelled) return toast.error('Confirme o cancelamento do link externo');
    setSaving(true);
    try {
      await loseAssessmentProspect(draft.id, {
        reasonCode,
        reasonNotes: reasonNotes.trim() || null,
        externalCancellationConfirmed: externalCancelled,
        expectedUpdatedAt: draft.updated_at,
      });
      toast.success('Prospect arquivado como não convertido. O histórico foi preservado.');
      onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível encerrar o prospect');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-gray-800">
          <ArchiveX className="w-5 h-5" /> Marcar como não convertido
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4 mt-2">
        <p className="text-sm text-muted-foreground">
          {customer?.full_name || draft.contract_number} continuará salvo para histórico e métricas. Isso não será contado como churn.
        </p>
        {draft.prospect_close_deadline && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            O prazo final do link era {formatDate(draft.prospect_close_deadline)}. Cancele o link no Asaas antes de arquivar.
          </p>
        )}
        <div>
          <Label>Motivo *</Label>
          <select className="w-full mt-1 h-10 border rounded-lg px-3 text-sm bg-white" value={reasonCode}
            onChange={event => setReasonCode(event.target.value)}>
            <option value="">Selecione...</option>
            {LOSS_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <Label>Detalhes (opcional)</Label>
          <Textarea className="mt-1" rows={3} maxLength={500} value={reasonNotes}
            onChange={event => setReasonNotes(event.target.value)} placeholder="Ex.: tentou contato duas vezes, achou o valor alto..." />
        </div>
        {hasExternalLink && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={externalCancelled}
              onChange={event => setExternalCancelled(event.target.checked)} />
            <span>Confirmo que o link de pagamento externo foi cancelado e não poderá mais ser pago.</span>
          </label>
        )}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>Voltar</Button>
          <Button className="flex-1 bg-gray-700 hover:bg-gray-800" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <ArchiveX className="w-4 h-4 mr-1.5" />}
            Arquivar prospect
          </Button>
        </div>
      </div>
    </>
  );
}

function CreateProspectModal({ onClose, onDone }) {
  const [plans, setPlans] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [form, setForm] = useState({
    full_name: '', whatsapp: '', email: '', cpf: '', gender: '', birth_date: '',
    plan_id: '', coach_id: '', installments: 1, notes: '',
  });
  const [saving, setSaving] = useState(false);

  const operation = useRef(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoadingOptions(true);
    setOptionsError(false);
    Promise.all([
      AssessmentPlan.filter({ active: true }),
      AssessmentCoach.filter({ active: true }, 'name'),
    ]).then(([planList, coachList]) => {
      if (!active) return;
      setPlans(planList);
      setCoaches(coachList);
    }).catch(() => {
      if (active) setOptionsError(true);
    }).finally(() => { if (active) setLoadingOptions(false); });
    return () => { active = false; };
  }, [optionsAttempt]);

  const selectedPlan = plans.find(plan => plan.id === form.plan_id);
  const maxInstallments = Math.max(1, Number(selectedPlan?.max_installments) || 1);
  const coachChoices = selectedPlan
    ? coaches.filter(coach => coachServesModality(coach, selectedPlan.modality_id))
    : coaches;

  const choosePlan = planId => setForm(current => {
    const nextPlan = plans.find(plan => plan.id === planId);
    const coach = coaches.find(item => item.id === current.coach_id);
    return {
      ...current,
      plan_id: planId,
      installments: 1,
      coach_id: !current.coach_id || coachServesModality(coach, nextPlan?.modality_id) ? current.coach_id : '',
    };
  });

  const save = async () => {
    if (savingRef.current || loadingOptions || optionsError) return;
    const { error, payload } = prepareManualProspect(form, maxInstallments, todayLocalStr());
    if (error) return toast.error(error);
    const fingerprint = JSON.stringify(payload);
    if (operation.current?.fingerprint !== fingerprint) {
      operation.current = { fingerprint, key: crypto.randomUUID() };
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await createManualAssessmentProspect(payload, { idempotencyKey: operation.current.key });
      toast.success('Prospect criado! Ele já aparece na coluna "Novos".');
      onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível criar o prospect');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <UserPlus className="w-5 h-5 text-green-600" /> Novo prospect
        </DialogTitle>
      </DialogHeader>
      <fieldset className="space-y-4 mt-2 min-w-0" disabled={saving}>
        {optionsError && <div role="alert" className="text-sm text-red-700">
          Não foi possível carregar os planos e coaches.
          <Button variant="link" onClick={() => setOptionsAttempt(value => value + 1)}>Tentar novamente</Button>
        </div>}
        <div>
          <Label htmlFor="prospect-name">Nome completo *</Label>
          <Input id="prospect-name" className="mt-1" maxLength={200} value={form.full_name}
            onChange={event => setForm(f => ({ ...f, full_name: event.target.value }))} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="prospect-phone">WhatsApp *</Label>
            <PhoneInput id="prospect-phone" className="mt-1" value={form.whatsapp}
              onChange={value => setForm(f => ({ ...f, whatsapp: value }))} />
          </div>
          <div>
            <Label htmlFor="prospect-email">E-mail</Label>
            <Input id="prospect-email" className="mt-1" type="email" maxLength={320} value={form.email}
              onChange={event => setForm(f => ({ ...f, email: event.target.value }))} />
          </div>
        </div>
        <div>
          <Label htmlFor="prospect-cpf">CPF</Label>
          <Input id="prospect-cpf" className="mt-1" inputMode="numeric" value={form.cpf}
            onChange={event => setForm(f => ({ ...f, cpf: maskCpf(event.target.value) }))} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="prospect-gender">Gênero</Label>
            <Select value={form.gender || 'unspecified'} onValueChange={value => setForm(f => ({ ...f, gender: value === 'unspecified' ? '' : value }))}>
              <SelectTrigger id="prospect-gender" className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unspecified">Não informado</SelectItem>
                {Object.entries(PROSPECT_GENDERS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="prospect-birth-date">Data de nascimento</Label>
            <Input id="prospect-birth-date" className="mt-1 min-w-0" type="date" min="1900-01-01" max={todayLocalStr()} value={form.birth_date}
              onChange={event => setForm(f => ({ ...f, birth_date: event.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="min-w-0">
            <Label htmlFor="prospect-plan">Plano *</Label>
            <Select value={form.plan_id} onValueChange={choosePlan}>
              <SelectTrigger id="prospect-plan" className="mt-1 h-auto min-h-9 gap-2 text-left [&>span]:min-w-0 [&>svg]:shrink-0"><SelectValue placeholder="Selecione..." /></SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                <PlanSelectItems plans={plans} />
              </SelectContent>
            </Select>
            {Number(selectedPlan?.enrollment_fee) > 0 && (
              <dl className="mt-2 space-y-1 text-xs" aria-label="Valores do plano">
                <div className="flex flex-wrap justify-between gap-x-2">
                  <dt className="text-muted-foreground">Matrícula</dt>
                  <dd>{formatCurrency(selectedPlan.enrollment_fee)}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-x-2 font-medium">
                  <dt>Total com matrícula</dt>
                  <dd>{formatCurrency(Number(selectedPlan.price_total || 0) + Number(selectedPlan.enrollment_fee))}</dd>
                </div>
              </dl>
            )}
          </div>
          <div>
            <Label htmlFor="prospect-coach">Coach *</Label>
            <Select value={form.coach_id} onValueChange={value => setForm(f => ({ ...f, coach_id: value }))}>
              <SelectTrigger id="prospect-coach" className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
              <SelectContent>
                {coachChoices.map(coach => <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="prospect-installments">Parcelas</Label>
          <Input id="prospect-installments" className="mt-1" type="number" min="1" max={maxInstallments} step="1" value={form.installments}
            onChange={event => setForm(f => ({ ...f, installments: event.target.value }))} />
          {selectedPlan && (
            <p className="text-xs text-muted-foreground mt-1">Este plano permite até {maxInstallments}x.</p>
          )}
        </div>
        <div>
          <Label htmlFor="prospect-notes">Observações</Label>
          <Textarea id="prospect-notes" className="mt-1" rows={3} maxLength={2000} value={form.notes}
            onChange={event => setForm(f => ({ ...f, notes: event.target.value }))}
            placeholder="Ex.: veio por indicação, contato prévio por WhatsApp..." />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={save} disabled={saving || loadingOptions || optionsError}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <UserPlus className="w-4 h-4 mr-1.5" />}
            Criar prospect
          </Button>
        </div>
      </fieldset>
    </>
  );
}

function ProspectRow({
  draft,
  customer,
  coach,
  modality,
  onProposal,
  onPayment,
  onLoss,
  onContact,
  onQuickContact,
  quickBusy,
  onApplyLatestSubmission,
  applyingSubmission,
}) {
  const visualStage = prospectVisualStage(draft);
  const stage = STAGES[visualStage] || STAGES.new;
  const relationship = RELATIONSHIPS[draft.prospect_customer_relationship] || RELATIONSHIPS.new_customer;
  const total = contractTotal(draft);
  const installments = Number(draft.installments) || 1;
  const planName = draft.plan_snapshot?.name || 'Plano de assessoria';
  const isOpen = isOpenProspect(draft);
  const canUseProspectActions = isDraftProspect(draft);
  const managedInContract = isOpen && !canUseProspectActions;
  const latestSubmission = draft.latest_submission;
  const submissionChanged = isOpen && hasSubmissionChange(draft);
  const submittedPlanName = latestSubmission?.plan?.name || 'plano informado';
  const submittedCoachName = latestSubmission?.coach?.name;
  const planChanged = latestSubmission?.plan_id && latestSubmission.plan_id !== draft.plan_id;
  const coachChanged = latestSubmission?.coach_id && latestSubmission.coach_id !== draft.coach_id;

  return (
    <Card className={`${stage.border} transition-colors`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-gray-700">{draft.contract_number}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${stage.badge}`}>{stage.label}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${relationship.badge}`}>{relationship.label}</span>
              {managedInContract && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                  cobrança em aberto
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">Recebido em {formatDateTime(draft.created_at)}</span>
            </div>
            <p className="text-base font-semibold text-gray-900 mt-1">{customer?.full_name || '—'}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{modality?.name || '—'} · {planName}</p>
            <div className="flex items-center gap-3 mt-1.5 text-xs">
              {customer?.id && (
                <Link to={studentProfilePath(customer.id, 'registration')} className="text-blue-600 hover:underline font-medium">
                  Abrir cliente{customer.customer_code ? ` · ${customer.customer_code}` : ''} →
                </Link>
              )}
              {draft.prospect_previous_contract_id && (
                <Link to={`/assessoria/contratos/${draft.prospect_previous_contract_id}`} className="text-orange-700 hover:underline">
                  Contrato anterior →
                </Link>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{formatDate(draft.start_date)} → {formatDate(draft.end_date)}</span>
              {coach && <span>Coach: <b className="text-gray-700">{coach.name}</b></span>}
              <span className="flex items-center gap-1"><CreditCard className="w-3 h-3" />{installments}x de <b className="text-gray-700 ml-1">{formatCurrency(total / installments)}</b></span>
              {draft.prospect_message_sent_at && <span>Último envio: {formatDateTime(draft.prospect_message_sent_at)}</span>}
              {draft.prospect_converted_at && <span>Convertido: {formatDateTime(draft.prospect_converted_at)}</span>}
              {draft.prospect_lost_at && <span>Encerrado: {formatDateTime(draft.prospect_lost_at)}</span>}
            </div>
            <div className="mt-2 max-w-sm"><NextStepLine draft={draft} /></div>
            {draft.prospect_stage === 'lost' && (
              <p className="text-xs text-gray-600 mt-2">
                Motivo: <b>{LOSS_REASONS.find(([code]) => code === draft.prospect_loss_reason_code)?.[1] || 'Outro'}</b>
                {draft.prospect_loss_notes ? ` — ${draft.prospect_loss_notes}` : ''}
              </p>
            )}
            {managedInContract && (
              <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950">
                <div className="flex items-start gap-2">
                  <MessageCircle className="w-4 h-4 text-violet-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Link/cobrança enviada. Ainda está em negociação.</p>
                    <p className="text-xs mt-1">
                      Só conte como convertido quando o pagamento for confirmado. Para reenviar, cancelar ou ajustar cobrança, abra o contrato.
                    </p>
                  </div>
                </div>
              </div>
            )}
            {isOpen && submissionChanged && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">Alteração solicitada em {formatDateTime(latestSubmission.submitted_at)}</p>
                    <p className="text-xs mt-1">
                      {planChanged && <>Plano solicitado: <b>{submittedPlanName}</b>. Proposta atual: <b>{planName}</b>.</>}
                      {planChanged && coachChanged ? ' ' : ''}
                      {coachChanged && <>Coach solicitado: <b>{submittedCoachName || '—'}</b>. Coach atual: <b>{coach?.name || '—'}</b>.</>}
                    </p>
                    {(draft.external_payment_link || draft.asaas_payment_link) && (
                      <p className="text-xs mt-1 text-amber-800">
                        Ao atualizar o plano, o link/cobrança atual será limpo para você enviar a proposta correta.
                      </p>
                    )}
                  </div>
                  {planChanged && latestSubmission.plan?.active !== false && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="bg-white text-amber-900 border-amber-300 hover:bg-amber-100 shrink-0"
                      onClick={() => onApplyLatestSubmission(draft)}
                      disabled={applyingSubmission === draft.id}
                    >
                      {applyingSubmission === draft.id
                        ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                        : <Check className="w-3.5 h-3.5 mr-1" />}
                      Usar novo plano
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-bold text-green-700 text-base">{formatCurrency(total)}</span>
            <div className="flex gap-1.5 flex-wrap justify-end">
              <ProspectActionButtons
                draft={draft} customer={customer} coach={coach} modality={modality}
                onProposal={onProposal} onPayment={onPayment} onLoss={onLoss}
                onContact={onContact} onQuickContact={onQuickContact} quickBusy={quickBusy}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProspectKanbanCard({
  draft,
  customer,
  coach,
  modality,
  onProposal,
  onPayment,
  onLoss,
  onContact,
  onQuickContact,
  quickBusy,
  onApplyLatestSubmission,
  applyingSubmission,
}) {
  const visualStage = prospectVisualStage(draft);
  const stage = STAGES[visualStage] || STAGES.new;
  const relationship = RELATIONSHIPS[draft.prospect_customer_relationship] || RELATIONSHIPS.new_customer;
  const total = contractTotal(draft);
  const installments = Number(draft.installments) || 1;
  const planName = draft.plan_snapshot?.name || 'Plano de assessoria';
  const isOpen = isOpenProspect(draft);
  const canUseProspectActions = isDraftProspect(draft);
  const managedInContract = isOpen && !canUseProspectActions;
  const latestSubmission = draft.latest_submission;
  const submissionChanged = isOpen && hasSubmissionChange(draft);
  const planChanged = latestSubmission?.plan_id && latestSubmission.plan_id !== draft.plan_id;

  return (
    <Card className={`${stage.border} bg-white shadow-sm hover:shadow-md transition-shadow`}>
      <CardContent className="p-3 space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold text-gray-600">{draft.contract_number}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${relationship.badge}`}>{relationship.label}</span>
          </div>
          <p className="text-sm font-semibold text-gray-950 leading-tight">{customer?.full_name || '—'}</p>
          <p className="text-[11px] text-muted-foreground line-clamp-2">
            {modality?.name || '—'} · {planName}
          </p>
        </div>

        <div className="rounded-lg bg-gray-50 border px-2.5 py-2 text-[11px] text-gray-700 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span>Total</span>
            <b className="text-green-700">{formatCurrency(total)}</b>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>Pagamento</span>
            <span>{installments}x de {formatCurrency(total / installments)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>Início</span>
            <span>{formatDate(draft.start_date)}</span>
          </div>
        </div>

        {managedInContract && (
          <div className="rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-2 text-[11px] text-violet-950">
            <p className="font-semibold">Link/cobrança enviada</p>
            <p className="mt-0.5">Ainda em negociação. Só vira convertido quando pagar.</p>
          </div>
        )}

        {submissionChanged && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-950">
            <p className="font-semibold">Alteração solicitada</p>
            <p className="mt-0.5">Novo formulário recebido em {formatDateTime(latestSubmission.submitted_at)}.</p>
            {planChanged && latestSubmission.plan?.active !== false && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 bg-white text-amber-900 border-amber-300 hover:bg-amber-100"
                onClick={() => onApplyLatestSubmission(draft)}
                disabled={applyingSubmission === draft.id}
              >
                {applyingSubmission === draft.id
                  ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  : <Check className="w-3.5 h-3.5 mr-1" />}
                Usar novo plano
              </Button>
            )}
          </div>
        )}

        <NextStepLine draft={draft} />

        <div className="flex flex-wrap gap-1.5 pt-1">
          <ProspectActionButtons
            compact
            draft={draft} customer={customer} coach={coach} modality={modality}
            onProposal={onProposal} onPayment={onPayment} onLoss={onLoss}
            onContact={onContact} onQuickContact={onQuickContact} quickBusy={quickBusy}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ProspectsKanban({
  groups,
  modalData,
  handlers,
  onCheckAsaas,
  applyLatestSubmission,
  applyingSubmission,
}) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-[1540px] grid-cols-7 gap-3">
        {groups.map(column => (
          <div key={column.key} className="rounded-2xl border bg-slate-50/70 p-3">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-gray-900">{column.title}</p>
                <p className="text-[11px] text-muted-foreground leading-snug">{column.hint}</p>
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${STAGES[column.key]?.badge || 'bg-gray-100 text-gray-700'}`}>
                {column.items.length}
              </span>
            </div>
            {column.key === 'payment_link_sent' && column.items.length > 0 && (
              <Button size="sm" variant="outline" className="mb-3 h-8 w-full bg-white text-xs" onClick={() => onCheckAsaas(column.items)}>
                <SearchCheck className="w-3.5 h-3.5 mr-1" /> Conferir no Asaas
              </Button>
            )}
            {column.items.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-white/70 px-3 py-8 text-center text-xs text-muted-foreground">
                Sem cards aqui.
              </div>
            ) : (
              <div className="space-y-2">
                {column.items.map(draft => (
                  <ProspectKanbanCard
                    key={draft.id}
                    {...modalData(draft)}
                    draft={draft}
                    {...handlers}
                    onApplyLatestSubmission={applyLatestSubmission}
                    applyingSubmission={applyingSubmission}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Prospects() {
  const [prospects, setProspects] = useState([]);
  const [customers, setCustomers] = useState({});
  const [coaches, setCoaches] = useState({});
  const [modalities, setModalities] = useState({});
  const [filter, setFilter] = useState('all');
  const [viewMode, setViewMode] = useState('kanban');
  const [loading, setLoading] = useState(true);
  const [proposal, setProposal] = useState(null);
  const [payment, setPayment] = useState(null);
  const [loss, setLoss] = useState(null);
  const [creatingProspect, setCreatingProspect] = useState(false);
  const [applyingSubmission, setApplyingSubmission] = useState(null);
  const [contact, setContact] = useState(null);
  const [quickBusy, setQuickBusy] = useState(null);
  const [asaasOrders, setAsaasOrders] = useState(null);
  const [welcomeContractId, setWelcomeContractId] = useState(null);
  const today = todayLocalStr();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const contractsResult = await supabase
        .from('assessment_contracts')
        .select(PROSPECT_CONTRACT_COLUMNS)
        .not('prospect_stage', 'is', null)
        .is('parent_contract_id', null)
        .order('created_at', { ascending: false });
      if (contractsResult.error) throw contractsResult.error;
      let list = contractsResult.data || [];

      const contractIds = list.map(item => item.id);
      const customerIds = [...new Set(list.map(item => item.customer_id).filter(Boolean))];
      const modalityIds = [...new Set(list.map(item => item.plan_snapshot?.modality_id).filter(Boolean))];
      const submissionsResult = contractIds.length
        ? await supabase
          .from('assessment_prospect_submissions')
          .select('id, contract_id, plan_id, coach_id, submitted_full_name, submitted_whatsapp, submitted_email, submitted_cpf, region, submitted_at, landing_page')
          .in('contract_id', contractIds)
          .order('submitted_at', { ascending: false })
        : { data: [], error: null };
      if (submissionsResult.error) throw submissionsResult.error;

      const latestByContract = {};
      (submissionsResult.data || []).forEach(submission => {
        if (!latestByContract[submission.contract_id]) {
          latestByContract[submission.contract_id] = submission;
        }
      });

      const submittedPlanIds = [...new Set((submissionsResult.data || []).map(item => item.plan_id).filter(Boolean))];
      const submittedCoachIds = [...new Set((submissionsResult.data || []).map(item => item.coach_id).filter(Boolean))];
      const coachIds = [...new Set([...list.map(item => item.coach_id).filter(Boolean), ...submittedCoachIds])];
      const [customerResult, coachResult, modalityResult, submittedPlanResult] = await Promise.all([
        customerIds.length ? supabase.from('presale_customers').select('id, customer_code, full_name, gender, birth_date, whatsapp, email, cpf, address_zip, address_street, address_number, address_complement, address_neighborhood, address_city, address_state').in('id', customerIds) : Promise.resolve({ data: [], error: null }),
        coachIds.length ? supabase.from('assessment_coaches').select('id, name').in('id', coachIds) : Promise.resolve({ data: [], error: null }),
        modalityIds.length ? supabase.from('assessment_modalities').select('id, name').in('id', modalityIds) : Promise.resolve({ data: [], error: null }),
        submittedPlanIds.length ? supabase.from('assessment_plans').select('id, name, period, period_months, modality_id, price_total, price_monthly, enrollment_fee, max_installments, active').in('id', submittedPlanIds) : Promise.resolve({ data: [], error: null }),
      ]);
      if (customerResult.error) throw customerResult.error;
      if (coachResult.error) throw coachResult.error;
      if (modalityResult.error) throw modalityResult.error;
      if (submittedPlanResult.error) throw submittedPlanResult.error;
      const coachMap = Object.fromEntries((coachResult.data || []).map(item => [item.id, item]));
      const submittedPlanMap = Object.fromEntries((submittedPlanResult.data || []).map(item => [item.id, item]));
      list = list.map(item => {
        const latest = latestByContract[item.id];
        return {
          ...item,
          latest_submission: latest ? {
            ...latest,
            plan: submittedPlanMap[latest.plan_id] || null,
            coach: coachMap[latest.coach_id] || null,
          } : null,
        };
      });
      setProspects(list);
      setCustomers(Object.fromEntries((customerResult.data || []).map(item => [item.id, item])));
      setCoaches(coachMap);
      setModalities(Object.fromEntries((modalityResult.data || []).map(item => [item.id, item])));
    } catch (error) {
      console.error(error);
      toast.error(`Erro ao carregar prospects: ${error.message || ''}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(() => {
    const result = {
      all: prospects.length,
      today: 0,
      open: 0,
      new: 0,
      awaiting_reply: 0,
      clarifying: 0,
      proposal_ready: 0,
      payment_link_sent: 0,
      converted: 0,
      lost: 0,
      needs_review: 0,
      returns: 0,
      returns_open: 0,
      returns_converted: 0,
    };
    prospects.forEach(item => {
      const visualStage = prospectVisualStage(item);
      if (result[visualStage] !== undefined) result[visualStage] += 1;
      if (isOpenProspect(item)) result.open += 1;
      if (isOpenProspect(item) && needsActionToday(item, today)) result.today += 1;
      if (isOpenProspect(item) && hasSubmissionChange(item)) result.needs_review += 1;
      if (item.prospect_customer_relationship === 'former_student') {
        result.returns += 1;
        if (isOpenProspect(item)) result.returns_open += 1;
        if (prospectVisualStage(item) === 'converted' && item.prospect_reactivated_at) result.returns_converted += 1;
      }
    });
    return result;
  }, [prospects, today]);

  const filtered = useMemo(
    () => prospects.filter(item => matchesProspectFilter(item, filter, today)),
    [prospects, filter, today],
  );
  const boardGroups = useMemo(() => BOARD_COLUMNS.map(column => ({
    ...column,
    items: filtered.filter(item => prospectVisualStage(item) === column.key),
  })), [filtered]);
  const potentialValue = prospects
    .filter(item => isOpenProspect(item))
    .reduce((sum, item) => sum + contractTotal(item), 0);
  const closed = counts.converted + counts.lost;
  const conversionRate = closed ? Math.round((counts.converted / closed) * 100) : 0;
  const modalData = draft => ({
    draft,
    customer: customers[draft.customer_id],
    coach: coaches[draft.coach_id],
    modality: modalities[draft.plan_snapshot?.modality_id],
  });
  const finishModal = () => {
    setProposal(null); setPayment(null); setLoss(null); setContact(null); setCreatingProspect(false); load();
  };
  // Pagamento registrado: o prospect vira aluno e a boas-vindas abre na hora.
  const finishPayment = contractId => {
    finishModal();
    if (contractId) setWelcomeContractId(contractId);
  };
  const welcomeTask = useMemo(() => (welcomeContractId
    ? { sourceType: 'contract', sourceId: welcomeContractId, purpose: 'onboarding' }
    : null), [welcomeContractId]);
  const registerQuickContact = async (draft, action) => {
    setQuickBusy(draft.id);
    try {
      await registerAssessmentProspectContact(draft.id, { action, expectedUpdatedAt: draft.updated_at });
      toast.success(action === 'has_questions'
        ? 'O card foi para “Tirando dúvidas”. O lembrete conta a partir da última conversa.'
        : 'Conversa registrada. O lembrete volta a contar a partir de hoje.');
      load();
    } catch (error) {
      toast.error(error.message || 'Não foi possível registrar');
    } finally {
      setQuickBusy(null);
    }
  };
  const openAsaasCheck = orders => {
    setProposal(null); setContact(null);
    setAsaasOrders(orders);
  };
  const handlers = {
    onProposal: selected => setProposal(modalData(selected)),
    onPayment: selected => setPayment(modalData(selected)),
    onLoss: (selected, _customer, presetReason) => setLoss({ ...modalData(selected), presetReason }),
    onContact: (selected, _customer, _coach, _modality, kind) => setContact({ ...modalData(selected), kind }),
    onQuickContact: registerQuickContact,
    quickBusy,
  };
  const checkColumnInAsaas = items => {
    const orders = asaasCheckCandidates(items.map(item => asaasOrderFor(item, customers[item.customer_id])));
    if (!orders.length) return toast.info('Nenhum link desta coluna é fatura do Asaas.');
    openAsaasCheck(orders);
  };
  const applyLatestSubmission = async draft => {
    const submission = draft.latest_submission;
    const plan = submission?.plan;
    if (!submission || !plan) return toast.error('Novo plano não encontrado');
    if (!isDraftProspect(draft)) {
      return toast.error('Esta cobrança já saiu do rascunho. Faça a alteração pela tela do contrato.');
    }
    if (!isOpenProspect(draft)) {
      return toast.error('Este prospect já não está mais em negociação');
    }
    if (draft.payment_status && !['pending', 'awaiting_charge', 'charge_sent', 'overdue'].includes(draft.payment_status)) {
      return toast.error('Só é possível trocar o plano antes do pagamento');
    }
    if ((draft.external_payment_link || draft.asaas_payment_link) && !window.confirm('Atualizar para o novo plano vai limpar o link/cobrança atual. Depois você precisa gerar e enviar uma nova proposta. Continuar?')) {
      return;
    }
    const months = getPlanMonths(plan);
    const installments = Math.max(1, Math.min(Number(plan.max_installments) || 1, months));
    setApplyingSubmission(draft.id);
    try {
      await changeAssessmentContractPlan(draft.id, {
        planId: plan.id,
        startDate: draft.start_date || todayLocalStr(),
        installments,
        enrollmentFee: Number(plan.enrollment_fee || 0),
        manualDiscount: 0,
        discountReason: null,
      });
      toast.success(`Prospect atualizado para ${plan.name}. Monte e envie o novo link de pagamento.`);
      load();
    } catch (error) {
      toast.error(error.message || 'Não foi possível atualizar o prospect');
    } finally {
      setApplyingSubmission(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-green-600" /> Central de Prospects
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Do cadastro público à confirmação do pagamento. Link enviado continua em negociação até o pagamento cair.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => setCreatingProspect(true)}>
            <Plus className="w-4 h-4 mr-1.5" /> Novo prospect
          </Button>
          <div className="flex rounded-xl border bg-white p-1 shadow-sm">
            {[
              ['kanban', 'Kanban'],
              ['list', 'Lista'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setViewMode(value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  viewMode === value ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ['Para hoje', counts.today, BellRing, 'text-violet-700', 'bg-violet-50'],
          ['Em negociação', counts.open, UserPlus, 'text-blue-700', 'bg-blue-50'],
          ['Valor potencial', formatCurrency(potentialValue), CircleDollarSign, 'text-amber-700', 'bg-amber-50'],
          ['Alterações', counts.needs_review, AlertTriangle, 'text-orange-700', 'bg-orange-50'],
          ['Convertidos', counts.converted, CheckCheck, 'text-green-700', 'bg-green-50'],
          ['Conversão dos encerrados', `${conversionRate}%`, TrendingUp, 'text-violet-700', 'bg-violet-50'],
          ['Retornos em negociação', counts.returns_open, UserRoundCheck, 'text-orange-700', 'bg-orange-50'],
          ['Retornos confirmados', counts.returns_converted, UserCheck, 'text-emerald-700', 'bg-emerald-50'],
        ].map(([label, value, Icon, color, background]) => (
          <Card key={label}><CardContent className="p-4 flex items-center gap-3">
            <div className={`p-2 rounded-full shrink-0 ${background}`}><Icon className={`w-5 h-5 ${color}`} /></div>
            <div><p className="text-xs text-muted-foreground">{label}</p><p className={`text-xl font-bold ${color}`}>{value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap">
        {FILTERS.map(([value, label]) => (
          <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>
            {label} <span className="ml-1.5 opacity-70">{counts[value]}</span>
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Carregando...</span></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <Clock3 className="w-10 h-10 text-gray-400 mb-3" />
          <p className="text-base font-semibold text-gray-700">Nenhum prospect nesta etapa</p>
          <p className="text-sm text-muted-foreground mt-1">Os novos cadastros do site aparecerão automaticamente aqui.</p>
        </CardContent></Card>
      ) : (
        viewMode === 'kanban' ? (
          <ProspectsKanban
            groups={boardGroups}
            modalData={modalData}
            handlers={handlers}
            onCheckAsaas={checkColumnInAsaas}
            applyLatestSubmission={applyLatestSubmission}
            applyingSubmission={applyingSubmission}
          />
        ) : (
          <div className="space-y-3">
            {filtered.map(draft => (
              <ProspectRow key={draft.id} {...modalData(draft)} draft={draft}
                {...handlers}
                onApplyLatestSubmission={applyLatestSubmission}
                applyingSubmission={applyingSubmission} />
            ))}
          </div>
        )
      )}

      <Dialog open={Boolean(proposal)} onOpenChange={open => { if (!open) setProposal(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {proposal && (
            <ProposalModal data={proposal} onClose={() => setProposal(null)} onDone={finishModal} onSaved={load}
              onRegisterPaid={order => openAsaasCheck([order])} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(payment)} onOpenChange={open => { if (!open) setPayment(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {payment && <PaymentModal data={payment} onClose={() => setPayment(null)} onDone={finishPayment} />}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(loss)} onOpenChange={open => { if (!open) setLoss(null); }}>
        <DialogContent className="max-w-md">{loss && <LossModal data={loss} onClose={() => setLoss(null)} onDone={finishModal} />}</DialogContent>
      </Dialog>
      <Dialog open={Boolean(contact)} onOpenChange={open => { if (!open) setContact(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {contact && (
            <ContactModal data={contact} onClose={() => setContact(null)} onDone={finishModal}
              onRegisterPaid={order => openAsaasCheck([order])} />
          )}
        </DialogContent>
      </Dialog>
      {asaasOrders && (
        <AsaasPaymentCheckDialog
          orders={asaasOrders}
          onClose={({ registered }) => {
            const single = asaasOrders.length === 1 ? asaasOrders[0].id : null;
            setAsaasOrders(null);
            if (!registered) return;
            load();
            if (single) setWelcomeContractId(single);
            else toast.success('As boas-vindas de quem pagou estão na Central de Comunicação.');
          }}
        />
      )}
      {welcomeTask && (
        <CommunicationSendDialog
          task={welcomeTask}
          sourceUi="prospects_board"
          onClose={() => setWelcomeContractId(null)}
          onChanged={() => load()}
          onSent={() => { setWelcomeContractId(null); load(); }}
        />
      )}
      <Dialog open={creatingProspect} onOpenChange={open => { if (!open) setCreatingProspect(false); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {creatingProspect && <CreateProspectModal onClose={() => setCreatingProspect(false)} onDone={finishModal} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
