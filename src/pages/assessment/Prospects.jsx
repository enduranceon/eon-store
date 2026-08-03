import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArchiveX, Calendar, Check, CheckCheck, ChevronRight, CircleDollarSign,
  Clock3, Copy, CreditCard, ExternalLink, Loader2, MessageCircle, Send,
  TrendingUp, UserCheck, UserPlus, UserRoundCheck,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import {
  changeAssessmentContractPlan,
  loseAssessmentProspect,
  markAssessmentProspectMessageSent,
  prepareAssessmentProspectProposal,
} from '@/api/client';
import { supabase } from '@/api/db';
import { createManualInstallments, findPreferredPaymentMethod, loadActivePaymentMethods } from '@/lib/manual-payment';
import { formatCustomerAddress } from '@/lib/br-address';
import { formatCurrency, formatDate, formatDateTime, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { phoneDigitsForWhatsApp } from '@/lib/phone';
import { toast } from 'sonner';

const STAGES = {
  new: { label: 'Novo', badge: 'bg-blue-100 text-blue-700', border: 'border-blue-200' },
  proposal_ready: { label: 'Proposta pronta', badge: 'bg-amber-100 text-amber-800', border: 'border-amber-200' },
  payment_link_sent: { label: 'Link enviado', badge: 'bg-violet-100 text-violet-700', border: 'border-violet-200' },
  contract_active: { label: 'Já virou contrato', badge: 'bg-emerald-100 text-emerald-700', border: 'border-emerald-200' },
  converted: { label: 'Convertido', badge: 'bg-green-100 text-green-700', border: 'border-green-200' },
  lost: { label: 'Não convertido', badge: 'bg-gray-200 text-gray-700', border: 'border-gray-200' },
};

const BOARD_COLUMNS = [
  { key: 'new', title: 'Novos', hint: 'Cadastros que ainda precisam de proposta.' },
  { key: 'proposal_ready', title: 'Proposta pronta', hint: 'Link montado, falta enviar ou registrar envio.' },
  { key: 'payment_link_sent', title: 'Link enviado', hint: 'Aguardando pagamento ou reenvio.' },
  { key: 'contract_active', title: 'Já virou contrato', hint: 'Saiu do funil; seguir pelo contrato/financeiro.' },
  { key: 'converted', title: 'Convertidos', hint: 'Pagamento confirmado.' },
  { key: 'lost', title: 'Não convertidos', hint: 'Arquivados sem conversão.' },
];

const FILTERS = [
  ['all', 'Todos'],
  ['open', 'Em negociação'],
  ['new', 'Novos'],
  ['proposal_ready', 'Proposta pronta'],
  ['payment_link_sent', 'Link enviado'],
  ['contract_active', 'Já virou contrato'],
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

const OPEN_PROSPECT_STAGES = new Set(['new', 'proposal_ready', 'payment_link_sent']);

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

function isOpenProspect(draft) {
  return isDraftProspect(draft) && OPEN_PROSPECT_STAGES.has(draft?.prospect_stage);
}

function needsContractReview(draft) {
  return !isDraftProspect(draft) && OPEN_PROSPECT_STAGES.has(draft?.prospect_stage);
}

function prospectVisualStage(draft) {
  if (needsContractReview(draft)) return 'contract_active';
  return draft?.prospect_stage || 'new';
}

function matchesProspectFilter(item, filter) {
  if (filter === 'all') return true;
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
    message += `Assim que o pagamento for confirmado, ${coach?.name ? `o coach *${coach.name}*` : 'o coach escolhido'} entra em contato para dar início ao atendimento. Qualquer dúvida, me chama por aqui.`;
  } else {
    message += `Para confirmar sua vaga, faça o pagamento pelo link:\n🔗 ${paymentLink}\n\n`;
    message += `Assim que o pagamento for confirmado, ${coach?.name ? `o coach *${coach.name}*` : 'o coach escolhido'} entrará em contato para iniciar seu atendimento. 🏆`;
  }
  return message;
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
            <Link to={`/clientes/${customer.id}`}>Abrir cliente <ChevronRight className="w-3.5 h-3.5 ml-1" /></Link>
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

function ProposalModal({ data, onClose, onDone }) {
  const { draft, customer, coach, modality } = data;
  const [contract, setContract] = useState(draft);
  const [step, setStep] = useState(draft.prospect_stage === 'new' || !paymentLinkFor(draft) ? 'proposal' : 'message');
  const [enrollmentFee, setEnrollmentFee] = useState(Number(draft.enrollment_fee || 0));
  const [manualDiscount, setManualDiscount] = useState(Number(draft.manual_discount || 0));
  const [paymentLink, setPaymentLink] = useState(paymentLinkFor(draft));
  const [dueDate, setDueDate] = useState(draft.due_date || tomorrowLocal());
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const effectiveContract = {
    ...contract,
    enrollment_fee: enrollmentFee,
    manual_discount: manualDiscount,
    external_payment_link: paymentLink,
    due_date: dueDate,
  };
  const total = contractTotal(effectiveContract);
  const message = buildMessage(effectiveContract, customer, coach, modality);
  const isReminder = effectiveContract.prospect_stage === 'payment_link_sent' && Boolean(effectiveContract.prospect_message_sent_at);

  const saveProposal = async () => {
    if (!paymentLink.trim()) return toast.error('Cole o link de pagamento');
    if (!dueDate) return toast.error('Informe o vencimento');
    setSaving(true);
    try {
      const result = await prepareAssessmentProspectProposal(contract.id, {
        enrollmentFee,
        manualDiscount,
        externalPaymentLink: paymentLink.trim(),
        dueDate,
        expectedUpdatedAt: contract.updated_at,
      });
      const updated = result?.contract || effectiveContract;
      setContract(updated);
      setPaymentLink(paymentLinkFor(updated));
      setDueDate(updated.due_date || dueDate);
      setStep('message');
      toast.success('Proposta pronta. O contrato continua aguardando pagamento.');
    } catch (error) {
      toast.error(error.message || 'Não foi possível preparar a proposta');
    } finally {
      setSaving(false);
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
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDollarSign className="w-5 h-5 text-amber-600" /> Preparar proposta
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <CustomerData customer={customer} contract={contract} />
          <div className="bg-gray-50 rounded-xl p-4 text-sm grid grid-cols-2 gap-x-4 gap-y-1.5">
            <span className="text-muted-foreground">Modalidade</span>
            <span className="font-medium">{modality?.name || '—'}</span>
            <span className="text-muted-foreground">Plano</span>
            <span className="font-medium">{draft.plan_snapshot?.name || 'Assessoria'}</span>
            <span className="text-muted-foreground">Coach</span>
            <span className="font-medium">{coach?.name || '—'}</span>
            <span className="text-muted-foreground">Total da proposta</span>
            <span className="font-bold text-green-700">{formatCurrency(total)}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Taxa de matrícula</Label>
              <Input className="mt-1" type="number" min="0" step="0.01" value={enrollmentFee}
                onChange={event => setEnrollmentFee(Math.max(0, Number(event.target.value)))} />
            </div>
            <div>
              <Label>Desconto manual</Label>
              <Input className="mt-1" type="number" min="0" step="0.01" value={manualDiscount}
                onChange={event => setManualDiscount(Math.max(0, Number(event.target.value)))} />
            </div>
          </div>
          <div>
            <Label>Link de pagamento *</Label>
            <Input className="mt-1" type="url" placeholder="https://..." value={paymentLink}
              onChange={event => setPaymentLink(event.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">Cole o link HTTPS gerado no Asaas ou no seu meio de cobrança.</p>
          </div>
          <div>
            <Label>Vencimento *</Label>
            <Input className="mt-1" type="date" min={todayLocalStr()} value={dueDate}
              onChange={event => setDueDate(event.target.value)} />
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
        </div>
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
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm whitespace-pre-wrap text-gray-800 max-h-72 overflow-y-auto">
          {message}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={copyMessage}>
            {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
            {copied ? 'Copiado!' : 'Copiar'}
          </Button>
          <Button variant="outline" size="icon" asChild>
            <a href={paymentLinkFor(effectiveContract)} target="_blank" rel="noreferrer" title="Abrir link de pagamento">
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
      onDone();
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
  const { draft, customer } = data;
  const [reasonCode, setReasonCode] = useState('');
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

function ProspectRow({
  draft,
  customer,
  coach,
  modality,
  onProposal,
  onPayment,
  onLoss,
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
  const contractReview = needsContractReview(draft);
  const hasPaymentLink = Boolean(paymentLinkFor(draft));
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
              {contractReview && draft.prospect_stage && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-600">
                  antigo: {STAGES[draft.prospect_stage]?.label || draft.prospect_stage}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">Recebido em {formatDateTime(draft.created_at)}</span>
            </div>
            <p className="text-base font-semibold text-gray-900 mt-1">{customer?.full_name || '—'}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{modality?.name || '—'} · {planName}</p>
            <div className="flex items-center gap-3 mt-1.5 text-xs">
              {customer?.id && (
                <Link to={`/clientes/${customer.id}`} className="text-blue-600 hover:underline font-medium">
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
            {draft.prospect_stage === 'lost' && (
              <p className="text-xs text-gray-600 mt-2">
                Motivo: <b>{LOSS_REASONS.find(([code]) => code === draft.prospect_loss_reason_code)?.[1] || 'Outro'}</b>
                {draft.prospect_loss_notes ? ` — ${draft.prospect_loss_notes}` : ''}
              </p>
            )}
            {contractReview && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
                <div className="flex items-start gap-2">
                  <CheckCheck className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Este cadastro já foi ativado como contrato.</p>
                    <p className="text-xs mt-1">
                      Ajustes de plano, cobrança ou pagamento agora devem ser feitos pelo contrato para manter financeiro e histórico no mesmo lugar.
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
              {isOpen && (
                <Button size="sm" variant="outline" className="text-gray-700" onClick={() => onLoss(draft, customer)}>
                  <ArchiveX className="w-3.5 h-3.5 mr-1" /> Não convertido
                </Button>
              )}
              <Button size="sm" variant="outline" asChild>
                <Link to={`/assessoria/contratos/${draft.id}`}>
                  {contractReview ? 'Abrir contrato' : 'Ver'} <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Link>
              </Button>
              {isOpen && draft.prospect_stage === 'new' && (
                <Button size="sm" className="bg-amber-600 hover:bg-amber-700" onClick={() => onProposal(draft, customer, coach, modality)}>
                  <CircleDollarSign className="w-3.5 h-3.5 mr-1" /> Preparar proposta
                </Button>
              )}
              {isOpen && draft.prospect_stage === 'proposal_ready' && (
                <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => onProposal(draft, customer, coach, modality)}>
                  <Send className="w-3.5 h-3.5 mr-1" /> Enviar mensagem
                </Button>
              )}
              {isOpen && draft.prospect_stage === 'payment_link_sent' && hasPaymentLink && (
                <>
                  <Button size="sm" variant="outline" className="text-green-700" onClick={() => onProposal(draft, customer, coach, modality)}>
                    <MessageCircle className="w-3.5 h-3.5 mr-1" /> Reenviar
                  </Button>
                  <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => onPayment(draft, customer, coach, modality)}>
                    <CheckCheck className="w-3.5 h-3.5 mr-1" /> Confirmar pagamento
                  </Button>
                </>
              )}
              {isOpen && draft.prospect_stage === 'payment_link_sent' && !hasPaymentLink && (
                <Button size="sm" className="bg-amber-600 hover:bg-amber-700" onClick={() => onProposal(draft, customer, coach, modality)}>
                  <CircleDollarSign className="w-3.5 h-3.5 mr-1" /> Refazer proposta
                </Button>
              )}
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
  const contractReview = needsContractReview(draft);
  const hasPaymentLink = Boolean(paymentLinkFor(draft));
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

        {contractReview && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[11px] text-emerald-950">
            <p className="font-semibold">Seguir pelo contrato</p>
            <p className="mt-0.5">Financeiro e cobrança já estão fora do funil de prospect.</p>
            {draft.prospect_stage && (
              <p className="mt-1 text-emerald-800">Estágio antigo: {STAGES[draft.prospect_stage]?.label || draft.prospect_stage}</p>
            )}
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

        <div className="flex flex-wrap gap-1.5 pt-1">
          {isOpen && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onLoss(draft, customer)}>
              <ArchiveX className="w-3.5 h-3.5 mr-1" /> Perda
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 text-xs" asChild>
            <Link to={`/assessoria/contratos/${draft.id}`}>
              {contractReview ? 'Contrato' : 'Ver'} <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Link>
          </Button>
          {isOpen && draft.prospect_stage === 'new' && (
            <Button size="sm" className="h-8 text-xs bg-amber-600 hover:bg-amber-700" onClick={() => onProposal(draft, customer, coach, modality)}>
              <CircleDollarSign className="w-3.5 h-3.5 mr-1" /> Proposta
            </Button>
          )}
          {isOpen && draft.prospect_stage === 'proposal_ready' && (
            <Button size="sm" className="h-8 text-xs bg-green-600 hover:bg-green-700" onClick={() => onProposal(draft, customer, coach, modality)}>
              <Send className="w-3.5 h-3.5 mr-1" /> Enviar
            </Button>
          )}
          {isOpen && draft.prospect_stage === 'payment_link_sent' && hasPaymentLink && (
            <>
              <Button size="sm" variant="outline" className="h-8 text-xs text-green-700" onClick={() => onProposal(draft, customer, coach, modality)}>
                <MessageCircle className="w-3.5 h-3.5 mr-1" /> Reenviar
              </Button>
              <Button size="sm" className="h-8 text-xs bg-green-600 hover:bg-green-700" onClick={() => onPayment(draft, customer, coach, modality)}>
                <CheckCheck className="w-3.5 h-3.5 mr-1" /> Pago
              </Button>
            </>
          )}
          {isOpen && draft.prospect_stage === 'payment_link_sent' && !hasPaymentLink && (
            <Button size="sm" className="h-8 text-xs bg-amber-600 hover:bg-amber-700" onClick={() => onProposal(draft, customer, coach, modality)}>
              <CircleDollarSign className="w-3.5 h-3.5 mr-1" /> Refazer
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ProspectsKanban({
  groups,
  modalData,
  setProposal,
  setPayment,
  setLoss,
  applyLatestSubmission,
  applyingSubmission,
}) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-[1120px] grid-cols-6 gap-3">
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
                    onProposal={selected => setProposal(modalData(selected))}
                    onPayment={selected => setPayment(modalData(selected))}
                    onLoss={selected => setLoss(modalData(selected))}
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
  const [applyingSubmission, setApplyingSubmission] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const contractsResult = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, installments, enrollment_fee, manual_discount, payment_method, payment_status, due_date, external_payment_link, asaas_payment_link, created_at, updated_at, status, prospect_stage, prospect_proposal_ready_at, prospect_message_sent_at, prospect_converted_at, prospect_lost_at, prospect_loss_reason_code, prospect_loss_notes, prospect_customer_relationship, prospect_previous_contract_id, prospect_reactivated_at')
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
        customerIds.length ? supabase.from('presale_customers').select('id, customer_code, full_name, whatsapp, email, cpf, address_zip, address_street, address_number, address_complement, address_neighborhood, address_city, address_state').in('id', customerIds) : Promise.resolve({ data: [], error: null }),
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
      open: 0,
      new: 0,
      proposal_ready: 0,
      payment_link_sent: 0,
      contract_active: 0,
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
      if (isOpenProspect(item) && hasSubmissionChange(item)) result.needs_review += 1;
      if (item.prospect_customer_relationship === 'former_student') {
        result.returns += 1;
        if (isOpenProspect(item)) result.returns_open += 1;
        if (item.prospect_stage === 'converted' && item.prospect_reactivated_at) result.returns_converted += 1;
      }
    });
    return result;
  }, [prospects]);

  const filtered = useMemo(() => prospects.filter(item => matchesProspectFilter(item, filter)), [prospects, filter]);
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
    setProposal(null); setPayment(null); setLoss(null); load();
  };
  const applyLatestSubmission = async draft => {
    const submission = draft.latest_submission;
    const plan = submission?.plan;
    if (!submission || !plan) return toast.error('Novo plano não encontrado');
    if (!isDraftProspect(draft)) {
      return toast.error('Este cadastro já virou contrato. Faça a alteração pela tela do contrato.');
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
            Do cadastro público à confirmação do pagamento, agora separado entre funil comercial e contratos já ativados.
          </p>
        </div>
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

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-3">
        {[
          ['Em negociação', counts.open, UserPlus, 'text-blue-700', 'bg-blue-50'],
          ['Valor potencial', formatCurrency(potentialValue), CircleDollarSign, 'text-amber-700', 'bg-amber-50'],
          ['Alterações', counts.needs_review, AlertTriangle, 'text-orange-700', 'bg-orange-50'],
          ['Já virou contrato', counts.contract_active, CheckCheck, 'text-emerald-700', 'bg-emerald-50'],
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
            setProposal={setProposal}
            setPayment={setPayment}
            setLoss={setLoss}
            applyLatestSubmission={applyLatestSubmission}
            applyingSubmission={applyingSubmission}
          />
        ) : (
          <div className="space-y-3">
            {filtered.map(draft => (
              <ProspectRow key={draft.id} {...modalData(draft)} draft={draft}
                onProposal={selected => setProposal(modalData(selected))}
                onPayment={selected => setPayment(modalData(selected))}
                onLoss={selected => setLoss(modalData(selected))}
                onApplyLatestSubmission={applyLatestSubmission}
                applyingSubmission={applyingSubmission} />
            ))}
          </div>
        )
      )}

      <Dialog open={Boolean(proposal)} onOpenChange={open => { if (!open) setProposal(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {proposal && <ProposalModal data={proposal} onClose={() => setProposal(null)} onDone={finishModal} />}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(payment)} onOpenChange={open => { if (!open) setPayment(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {payment && <PaymentModal data={payment} onClose={() => setPayment(null)} onDone={finishModal} />}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(loss)} onOpenChange={open => { if (!open) setLoss(null); }}>
        <DialogContent className="max-w-md">{loss && <LossModal data={loss} onClose={() => setLoss(null)} onDone={finishModal} />}</DialogContent>
      </Dialog>
    </div>
  );
}
