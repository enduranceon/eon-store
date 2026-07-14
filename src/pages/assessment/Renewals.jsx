import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCcw, RotateCcw, ChevronRight, Check, Trash2,
  Calendar, Loader2, CheckCheck, Activity, Ban, Clock, Zap, MessageCircle, PenLine, Link2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AssessmentContract, AssessmentContractEvent } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';
import { getActivationStatusForContract } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { defaultAsaasDueDate } from '@/lib/payment-methods';
import { suggestedAssessmentChargeDueDate } from '@/lib/assessment-renewal-billing';
import { isSafePaymentUrl } from '@/lib/sales';
import { EXTERNAL_CHARGE_METHODS, externalChargeMethodLabel, normalizeExternalChargeMethod } from '@/lib/external-charge';
import { TASK_BUCKET, TASK_KIND } from '@/lib/communication-tasks';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function snapPrice(contract) {
  return Number(
    contract.plan_snapshot?.price_total
    ?? contract.plan?.price_total
    ?? 0
  );
}

function contractTotal(contract) {
  const base       = snapPrice(contract);
  const enrollment = Number(contract.enrollment_fee || 0);
  const discount   = Number(contract.manual_discount || 0);
  return Math.max(0, base + enrollment - discount);
}

function hasChargeInfo(contract) {
  return Boolean(
    contract?.asaas_charge_id ||
    contract?.asaas_payment_link ||
    contract?.asaas_pix_copy ||
    contract?.external_payment_link
  );
}

const PAY_STATUS = {
  pending:         { label: 'Aguardando cobrança', cls: 'bg-gray-100 text-gray-600' },
  awaiting_charge: { label: 'A cobrar',            cls: 'bg-amber-100 text-amber-700' },
  charge_sent:     { label: 'Cobrança enviada',    cls: 'bg-blue-100 text-blue-700' },
  overdue:         { label: 'Vencido',             cls: 'bg-red-100 text-red-700' },
  partially_paid:  { label: 'Pago parcial',        cls: 'bg-amber-100 text-amber-700' },
  paid:            { label: 'Pago',                cls: 'bg-green-100 text-green-700' },
  cancelled:       { label: 'Cancelado',           cls: 'bg-gray-100 text-gray-600' },
  refunded:        { label: 'Reembolsado',         cls: 'bg-gray-100 text-gray-600' },
};

const TERMINAL_PAYMENT_STATUSES = new Set(['paid', 'cancelled', 'refunded']);
const DAY_MS = 86400000;

function localDate(dateStr) {
  if (!dateStr) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))
    ? new Date(`${dateStr}T00:00:00`)
    : new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(dateStr, days) {
  const d = localDate(dateStr);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

function daysBetween(dateStr, todayStr = todayLocalStr()) {
  const target = localDate(dateStr);
  const today = localDate(todayStr);
  if (!target || !today) return null;
  return Math.round((target - today) / DAY_MS);
}

function renewalDate(draft, parent) {
  return parent?.end_date || draft.start_date || draft.end_date || '';
}

function renewalDaysLeft(draft, parent, todayStr = todayLocalStr()) {
  return daysBetween(renewalDate(draft, parent), todayStr);
}

function renewalTimingLabel(daysLeft) {
  if (daysLeft === null) return 'Sem data';
  if (daysLeft < -1) return `Venceu há ${Math.abs(daysLeft)} dias`;
  if (daysLeft === -1) return 'Venceu ontem';
  if (daysLeft === 0) return 'Vence hoje';
  if (daysLeft === 1) return 'Vence amanhã';
  return `Vence em ${daysLeft} dias`;
}

function renewalTimingClass(daysLeft) {
  if (daysLeft === null) return 'bg-gray-100 text-gray-600';
  if (daysLeft <= 0) return 'bg-red-100 text-red-700';
  if (daysLeft <= 3) return 'bg-amber-100 text-amber-700';
  if (daysLeft <= RENEWAL_ATTENTION_WINDOW_DAYS) return 'bg-blue-100 text-blue-700';
  return 'bg-gray-100 text-gray-600';
}

function compareRenewalDrafts(a, b, parents = {}) {
  const parentA = parents[a.parent_contract_id];
  const parentB = parents[b.parent_contract_id];
  const dateA = renewalDate(a, parentA) || '9999-12-31';
  const dateB = renewalDate(b, parentB) || '9999-12-31';
  const byRenewalDate = dateA.localeCompare(dateB);
  if (byRenewalDate !== 0) return byRenewalDate;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

function normalizeScanDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return RENEWAL_ATTENTION_WINDOW_DAYS;
  return Math.max(1, Math.min(90, Math.round(n)));
}

function chargeTaskForRenewal(contract, { customer, coach, modality } = {}) {
  const total = contractTotal(contract);
  const planName = contract.plan_snapshot?.name || 'Renovação';
  const itemLabel = [planName, modality?.name].filter(Boolean).join(' - ');
  const items = [{ label: itemLabel || 'Renovação', quantity: 1, unitPrice: total, total }];

  return {
    id: `renewal-charge:${contract.id}:${contract.payment_message_sent_at || contract.updated_at || contract.created_at || ''}`,
    kind: TASK_KIND.CHARGE_SEND,
    bucket: TASK_BUCKET.CHARGES,
    sourceType: 'contract',
    tableName: 'assessment_contracts',
    sourceId: contract.id,
    sourceLabel: 'Contrato',
    orderNumber: contract.contract_number,
    customerName: customer?.full_name || 'Aluno',
    customerWhatsapp: customer?.whatsapp || '',
    totalValue: total,
    paymentStatus: contract.payment_status || 'pending',
    dueDate: suggestedAssessmentChargeDueDate(contract),
    startDate: contract.start_date || '',
    endDate: contract.end_date || '',
    parentContractId: contract.parent_contract_id || null,
    installments: contract.installments || 1,
    enrollmentFee: Number(contract.enrollment_fee) || 0,
    manualDiscount: Number(contract.manual_discount) || 0,
    creditBalance: Number(contract.credit_balance) || 0,
    asaasChargeId: contract.asaas_charge_id,
    asaasPaymentLink: contract.asaas_payment_link,
    asaasPixCopy: contract.asaas_pix_copy,
    externalPaymentLink: contract.external_payment_link,
    paymentMessageSentAt: contract.payment_message_sent_at,
    items,
    itemSummary: itemLabel || 'Renovação',
    href: `/assessoria/contratos/${contract.id}`,
    title: 'Enviar cobrança da renovação',
    statusLabel: contract.due_date ? `vence em ${formatDate(contract.due_date)}` : 'definir vencimento',
    planLabel: planName,
    planPeriod: contract.plan_snapshot?.period || '',
    periodMonths: contract.plan_snapshot?.period_months || null,
    modalityName: modality?.name || contract.plan_snapshot?.modality_name || '',
    coachName: coach?.name || '',
    messageVariant: 'assessment_contract_confirmation',
  };
}

// ─────────────────────────────────────────────────────────────────
// LINHA DE RENOVAÇÃO (gerada automaticamente, tem contrato pai)
// ─────────────────────────────────────────────────────────────────

function RenewalRow({ draft, parent, customer, coach, modality, onActivate, onDecline, onDiscard, busy }) {
  const total        = contractTotal(draft);
  const planName     = draft.plan_snapshot?.name
    || (modality ? `${modality.name} · ${draft.plan_snapshot?.period_months || ''}m` : 'Plano');
  const installments = draft.installments || 1;
  const valuePerInst = installments > 0 ? total / installments : total;
  const daysLeft     = renewalDaysLeft(draft, parent);
  const timingLabel  = renewalTimingLabel(daysLeft);
  const renewAt      = renewalDate(draft, parent);
  const activationStatus = getActivationStatusForContract(draft);
  const isScheduledActivation = activationStatus === 'scheduled';

  return (
    <Card className="border-blue-200">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-blue-700">{draft.contract_number}</span>
              <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Rascunho</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${renewalTimingClass(daysLeft)}`}>
                {timingLabel}
              </span>
              {parent && (
                <span className="text-[11px] text-muted-foreground">
                  renova <Link to={`/assessoria/contratos/${parent.id}`} className="text-blue-600 hover:underline font-mono">{parent.contract_number}</Link>
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-gray-900 mt-1">{customer?.full_name || '—'}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {modality?.name || '—'} · {planName}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Renovar em {formatDate(renewAt)} · nova vigência {formatDate(draft.start_date)} → {formatDate(draft.end_date)}
              </span>
              {coach && <span>Coach: <b className="text-gray-700">{coach.name}</b></span>}
              <span>
                {installments}x de <b className="text-gray-700">{formatCurrency(valuePerInst)}</b>
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-bold text-blue-700 text-base">{formatCurrency(total)}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={busy}
                className="border-amber-200 text-amber-700 hover:bg-amber-50"
                onClick={() => onDecline(draft, parent)}>
                <Ban className="w-3.5 h-3.5 mr-1" /> Não renovar
              </Button>
              <Button size="sm" variant="outline" disabled={busy}
                className="border-gray-200 text-gray-600 hover:bg-gray-50"
                title="Remove este rascunho e deixa o contrato apto a gerar uma nova renovação."
                onClick={() => onDiscard(draft, parent)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Recriar
              </Button>
              <Link to={`/assessoria/contratos/${draft.id}`}>
                <Button size="sm" variant="outline" disabled={busy}>
                  Revisar <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </Link>
              <Link to={`/assessoria/contratos/${draft.id}?ajustar-plano=1`}>
                <Button size="sm" variant="outline" disabled={busy}
                  className="border-blue-200 text-blue-700 hover:bg-blue-50">
                  <PenLine className="w-3.5 h-3.5 mr-1" /> Trocar plano
                </Button>
              </Link>
              <Button size="sm" disabled={busy}
                className="bg-green-600 hover:bg-green-700"
                onClick={() => onActivate(draft, parent)}>
                {isScheduledActivation ? (
                  <Clock className="w-3.5 h-3.5 mr-1" />
                ) : (
                  <Check className="w-3.5 h-3.5 mr-1" />
                )}
                {isScheduledActivation ? 'Agendar' : 'Ativar'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ScheduledRenewalRow({ contract, parent, customer, coach, modality, onGenerateCharge, onSendMessage, busy }) {
  const total = contractTotal(contract);
  const installments = contract.installments || 1;
  const valuePerInst = installments > 0 ? total / installments : total;
  const planName = contract.plan_snapshot?.name
    || (modality ? `${modality.name} · ${contract.plan_snapshot?.period_months || ''}m` : 'Plano');
  const charged = hasChargeInfo(contract);
  const hasExternalCharge = Boolean(contract.external_payment_link && !contract.asaas_charge_id);
  const sent = Boolean(contract.payment_message_sent_at);
  const pay = PAY_STATUS[contract.payment_status] || { label: contract.payment_status || 'Aguardando', cls: 'bg-gray-100 text-gray-600' };
  const isTerminalPayment = TERMINAL_PAYMENT_STATUSES.has(contract.payment_status);
  const canSendCharge = charged && !isTerminalPayment;
  const chargeDueDate = isTerminalPayment
    ? (contract.due_date || suggestedAssessmentChargeDueDate(contract))
    : suggestedAssessmentChargeDueDate(contract);
  const chargeDueLabel = charged || isTerminalPayment ? 'Vencimento' : 'Vencimento sugerido';

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-blue-700">{contract.contract_number}</span>
              <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Agendada</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${pay.cls}`}>{pay.label}</span>
              {charged && (
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold">
                  {hasExternalCharge ? 'Cobrança externa' : 'Cobrança pronta'}
                </span>
              )}
              {sent && (
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold">Mensagem enviada</span>
              )}
              {parent && (
                <span className="text-[11px] text-muted-foreground">
                  renova <Link to={`/assessoria/contratos/${parent.id}`} className="text-blue-600 hover:underline font-mono">{parent.contract_number}</Link>
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-gray-900 mt-1">{customer?.full_name || '—'}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {modality?.name || '—'} · {planName}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Vigência agendada {formatDate(contract.start_date)} → {formatDate(contract.end_date)}
              </span>
              {chargeDueDate && <span>{chargeDueLabel}: <b className="text-gray-700">{formatDate(chargeDueDate)}</b></span>}
              {coach && <span>Coach: <b className="text-gray-700">{coach.name}</b></span>}
              <span>
                {installments}x de <b className="text-gray-700">{formatCurrency(valuePerInst)}</b>
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-bold text-blue-700 text-base">{formatCurrency(total)}</span>
            <div className="flex gap-1.5 flex-wrap justify-end">
              {!charged && !isTerminalPayment && (
                <Button size="sm" disabled={busy} onClick={() => onGenerateCharge(contract)}
                  className="bg-blue-600 hover:bg-blue-700">
                  {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1" />}
                  Gerar cobrança
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy || !canSendCharge}
                className="border-green-200 text-green-700 hover:bg-green-50 disabled:opacity-50"
                title={!charged ? 'Gere a cobrança antes de enviar' : isTerminalPayment ? 'Pagamento finalizado' : 'Preparar mensagem de cobrança'}
                onClick={() => onSendMessage(contract)}>
                <MessageCircle className="w-3.5 h-3.5 mr-1" /> {sent ? 'Reenviar' : 'Enviar'}
              </Button>
              <Link to={`/assessoria/contratos/${contract.id}`}>
                <Button size="sm" variant="outline" disabled={busy}>
                  Revisar <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </Link>
              {!isTerminalPayment && (
                <Link to={`/assessoria/contratos/${contract.id}?ajustar-plano=1`}>
                  <Button size="sm" variant="outline" disabled={busy}
                    className="border-blue-200 text-blue-700 hover:bg-blue-50">
                    <PenLine className="w-3.5 h-3.5 mr-1" /> Trocar plano
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// PÁGINA
// ─────────────────────────────────────────────────────────────────

export default function Renewals() {
  const [drafts,     setDrafts]     = useState([]);
  const [scheduled,  setScheduled]  = useState([]);
  const [parents,    setParents]    = useState({});
  const [customers,  setCustomers]  = useState({});
  const [coaches,    setCoaches]    = useState({});
  const [modalities, setModalities] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(null);
  const [scanModal,  setScanModal]  = useState(false);
  const [scanForm,   setScanForm]   = useState({ horizon_days: RENEWAL_ATTENTION_WINDOW_DAYS });
  const [scanning,   setScanning]   = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [activationModal, setActivationModal] = useState(null);
  const [chargeModal, setChargeModal] = useState(null);
  const [chargeForm, setChargeForm] = useState({
    mode: 'asaas',
    billing_type: 'PIX',
    due_date: defaultAsaasDueDate(),
    external_link: '',
    external_payment_method: 'pix',
    external_invoice_number: '',
  });
  const [charging, setCharging] = useState(false);
  const [messageTask, setMessageTask] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: renewalData } = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, due_date, installments, enrollment_fee, manual_discount, payment_method, payment_status, parent_contract_id, notes, created_at, updated_at, status, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
        .in('status', ['draft', 'scheduled'])
        .not('parent_contract_id', 'is', null)
        .order('start_date', { ascending: true })
        .order('created_at', { ascending: true });

      const renewalList = [...(renewalData || [])].sort(compareRenewalDrafts);

      if (renewalList.length === 0) {
        setDrafts([]); setScheduled([]);
        setParents({}); setCustomers({}); setCoaches({}); setModalities({});
        setLoading(false); return;
      }

      const parentIds   = [...new Set(renewalList.map(d => d.parent_contract_id).filter(Boolean))];
      const customerIds = [...new Set(renewalList.map(d => d.customer_id).filter(Boolean))];
      const coachIds    = [...new Set(renewalList.map(d => d.coach_id).filter(Boolean))];
      const modalityIds = [...new Set(renewalList.map(d => d.plan_snapshot?.modality_id).filter(Boolean))];

      const [parentRes, custRes, coachRes, modRes] = await Promise.all([
        parentIds.length   ? supabase.from('assessment_contracts').select('id, contract_number, status, end_date, payment_status').in('id', parentIds) : Promise.resolve({ data: [] }),
        customerIds.length ? supabase.from('presale_customers').select('id, full_name, whatsapp, email, cpf').in('id', customerIds)                : Promise.resolve({ data: [] }),
        coachIds.length    ? supabase.from('assessment_coaches').select('id, name').in('id', coachIds)                                           : Promise.resolve({ data: [] }),
        modalityIds.length ? supabase.from('assessment_modalities').select('id, name').in('id', modalityIds)                                     : Promise.resolve({ data: [] }),
      ]);

      await applyAssessmentContractTransitions([...(renewalList || []), ...(parentRes.data || [])]);

      setDrafts(renewalList.filter(contract => contract.status === 'draft'));
      setScheduled(renewalList.filter(contract => contract.status === 'scheduled'));
      setParents(Object.fromEntries((parentRes.data || []).map(p => [p.id, p])));
      setCustomers(Object.fromEntries((custRes.data  || []).map(c => [c.id, c])));
      setCoaches(Object.fromEntries((coachRes.data   || []).map(c => [c.id, c])));
      setModalities(Object.fromEntries((modRes.data  || []).map(m => [m.id, m])));
    } catch (e) {
      console.error('Erro ao carregar pendentes:', e);
      toast.error('Erro ao carregar: ' + (e.message || ''));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // ── Ações: renovação ─────────────────────────────────────────────────────

  const openActivationModal = (draft, parent) => {
    const nextStatus = getActivationStatusForContract(draft);
    setActivationModal({ draft, parent, nextStatus });
  };

  const activateRenewal = async () => {
    if (!activationModal?.draft) return;
    const { draft, parent, nextStatus } = activationModal;
    setBusy(draft.id);
    try {
      await AssessmentContract.update(draft.id, { status: nextStatus });

      if (parent && nextStatus === 'active') {
        await AssessmentContract.update(parent.id, { status: 'finished' });
      }

      await AssessmentContractEvent.create({
        contract_id: draft.id,
        event_type:  nextStatus === 'scheduled' ? 'renewal_scheduled' : 'renewal_activated',
        payload: {
          parent_contract_id:     parent?.id || null,
          parent_contract_number: parent?.contract_number || null,
          status_after:           nextStatus,
          start_date:             draft.start_date || null,
        },
        notes: nextStatus === 'scheduled'
          ? 'Rascunho de renovação aprovado e agendado'
          : 'Rascunho de renovação aprovado e ativado',
      }).catch(() => {});

      toast.success(nextStatus === 'scheduled'
        ? `Renovação ${draft.contract_number} agendada!`
        : `Renovação ${draft.contract_number} ativada!`);
      setActivationModal(null);
      load();
    } catch (e) {
      toast.error('Erro ao ativar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const openChargeModal = (contract) => {
    const customer = customers[contract.customer_id];
    const suggestedDueDate = suggestedAssessmentChargeDueDate(contract);
    const defaultExternalMethod = normalizeExternalChargeMethod(contract.payment_method, contract.installments);
    setChargeForm({
      mode: customer?.cpf ? 'asaas' : 'external',
      billing_type: 'PIX',
      due_date: suggestedDueDate,
      external_link: contract.external_payment_link || '',
      external_payment_method: defaultExternalMethod,
      external_invoice_number: contract.external_invoice_number || '',
    });
    setChargeModal(contract);
  };

  const openMessageForRenewal = (contract) => {
    if (!hasChargeInfo(contract)) {
      toast.error('Gere a cobrança antes de preparar o envio');
      return;
    }
    setMessageTask(chargeTaskForRenewal(contract, {
      customer: customers[contract.customer_id],
      coach: coaches[contract.coach_id],
      modality: modalities[contract.plan_snapshot?.modality_id],
    }));
  };

  const generateScheduledCharge = async () => {
    if (!chargeModal) return;
    const contract = chargeModal;
    const customer = customers[contract.customer_id];
    if (!customer?.cpf) return toast.error('Cadastre o CPF do aluno antes de gerar cobrança');
    setCharging(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-assessment-charge', {
        body: {
          contract_id: contract.id,
          installments: contract.installments,
          cpf: customer.cpf,
          billing_type: chargeForm.billing_type,
          due_date: chargeForm.due_date,
        },
      });
      if (error) {
        let realMessage = error.message;
        try {
          if (error.context && typeof error.context.json === 'function') {
            const body = await error.context.json();
            if (body?.error) realMessage = body.error;
            if (body?.asaas_details?.errors?.[0]?.description) {
              realMessage = body.asaas_details.errors[0].description;
            }
            console.error('[generate-renewal-charge details]', body);
          }
        } catch { /* ignora parse error */ }
        throw new Error(realMessage);
      }
      if (data?.error) throw new Error(data.error);

      await AssessmentContractEvent.create({
        contract_id: contract.id,
        event_type:  'charge_generated',
        payload: {
          billing_type: chargeForm.billing_type,
          installments: contract.installments,
          due_date: chargeForm.due_date,
          asaas_charge_id: data?.asaas_charge_id || null,
          source: 'renewals_page',
        },
        notes: 'Cobrança da renovação gerada pela aba de Renovações',
      }).catch(() => {});

      const { data: updated } = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, due_date, installments, enrollment_fee, manual_discount, payment_method, payment_status, parent_contract_id, notes, created_at, updated_at, status, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
        .eq('id', contract.id)
        .single();

      const nextContract = updated || {
        ...contract,
        due_date: chargeForm.due_date,
        payment_status: 'charge_sent',
        asaas_charge_id: data?.asaas_charge_id || contract.asaas_charge_id,
      };
      toast.success('Cobrança gerada. Mensagem pronta para envio.');
      setChargeModal(null);
      setMessageTask(chargeTaskForRenewal(nextContract, {
        customer,
        coach: coaches[nextContract.coach_id],
        modality: modalities[nextContract.plan_snapshot?.modality_id],
      }));
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao gerar cobrança');
    } finally {
      setCharging(false);
    }
  };

  const saveExternalScheduledCharge = async () => {
    if (!chargeModal) return;
    const contract = chargeModal;
    const customer = customers[contract.customer_id];
    const link = chargeForm.external_link.trim();
    const dueDate = chargeForm.due_date;
    const invoiceNumber = chargeForm.external_invoice_number.trim();
    const paymentMethod = normalizeExternalChargeMethod(chargeForm.external_payment_method, contract.installments);

    if (!link) return toast.error('Informe o link da cobrança externa');
    if (!isSafePaymentUrl(link)) return toast.error('Link inválido — deve começar com https://');
    if (!dueDate) return toast.error('Informe a data de vencimento');
    if (contract.asaas_charge_id) return toast.error('Esta renovação já tem cobrança Asaas');

    setCharging(true);
    try {
      const updates = {
        external_payment_link: link,
        due_date: dueDate,
        payment_method: paymentMethod,
        external_invoice_number: invoiceNumber || null,
      };
      if (['pending', 'awaiting_charge'].includes(contract.payment_status)) {
        updates.payment_status = 'charge_sent';
      }

      await AssessmentContract.update(contract.id, updates);
      await AssessmentContractEvent.create({
        contract_id: contract.id,
        event_type: 'external_charge_registered',
        payload: {
          link,
          due_date: dueDate,
          payment_method: paymentMethod,
          method_label: externalChargeMethodLabel(paymentMethod),
          invoice_number: invoiceNumber || null,
          source: 'renewals_page',
        },
        notes: 'Cobrança externa da renovação registrada pela aba de Renovações',
      }).catch(() => {});

      const { data: updated } = await supabase
        .from('assessment_contracts')
        .select('id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, due_date, installments, enrollment_fee, manual_discount, payment_method, payment_status, parent_contract_id, notes, created_at, updated_at, status, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at')
        .eq('id', contract.id)
        .single();

      const nextContract = updated || {
        ...contract,
        ...updates,
        payment_status: updates.payment_status || contract.payment_status,
      };
      toast.success('Cobrança externa cadastrada. Mensagem pronta para envio.');
      setChargeModal(null);
      setMessageTask(chargeTaskForRenewal(nextContract, {
        customer,
        coach: coaches[nextContract.coach_id],
        modality: modalities[nextContract.plan_snapshot?.modality_id],
      }));
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar cobrança externa');
    } finally {
      setCharging(false);
    }
  };

  const discardRenewal = async (draft, parent) => {
    if (!confirm(`Descartar a renovação ${draft.contract_number}?\n\nO rascunho será excluído e o contrato anterior voltará a ser elegível para nova renovação.`)) return;
    setBusy(draft.id);
    try {
      await AssessmentContract.delete(draft.id);

      if (parent) {
        await AssessmentContract.update(parent.id, { renewal_generated: false });
        await AssessmentContractEvent.create({
          contract_id: parent.id,
          event_type:  'renewal_discarded',
          payload: {
            discarded_draft_id:     draft.id,
            discarded_draft_number: draft.contract_number,
          },
          notes: 'Rascunho de renovação descartado',
        }).catch(() => {});
      }

      toast.success('Rascunho descartado');
      load();
    } catch (e) {
      toast.error('Erro ao descartar: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  const declineRenewal = async (draft, parent) => {
    if (!parent) return toast.error('Contrato anterior não encontrado');
    const shouldFinishNow = parent.end_date <= todayLocalStr();
    const statusText = shouldFinishNow
      ? 'O contrato anterior será concluído agora.'
      : `O contrato anterior fica ativo até ${formatDate(parent.end_date)} e será concluído sem renovação.`;
    if (!confirm(
      `Registrar que ${draft.contract_number} não será renovado?\n\n` +
      `O rascunho será excluído. ${statusText}\n\n` +
      'Não haverá multa, estorno ou cobrança nova.'
    )) return;

    setBusy(draft.id);
    try {
      await AssessmentContract.update(parent.id, {
        renewal_generated: true,
        cancellation_date: parent.end_date,
        cancellation_fee: 0,
        cancellation_reason: 'Não renovou',
        refund_status: null,
        refund_amount: null,
        ...(shouldFinishNow ? { status: 'finished' } : {}),
      });
      await AssessmentContract.delete(draft.id);
      await AssessmentContractEvent.create({
        contract_id: parent.id,
        event_type:  'renewal_declined',
        payload: {
          discarded_draft_id:     draft.id,
          discarded_draft_number: draft.contract_number,
          effective_end_date:     parent.end_date,
          status_after:           shouldFinishNow ? 'finished' : parent.status,
          no_financial_penalty:   true,
        },
        notes: 'Aluno não vai renovar. Encerramento sem multa, estorno ou nova cobrança.',
      }).catch(() => {});

      toast.success('Não renovação registrada sem multa ou estorno.');
      load();
    } catch (e) {
      toast.error('Erro ao registrar não renovação: ' + (e.message || ''));
    } finally {
      setBusy(null);
    }
  };

  // ── Scan de renovações ───────────────────────────────────────────────────

  const runScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('prepare-renewals', {
        body: { horizon_days: normalizeScanDays(scanForm.horizon_days) },
      });
      if (error) {
        let msg = error.message;
        try {
          if (error.context?.json) { const b = await error.context.json(); if (b?.error) msg = b.error; }
        } catch { /**/ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setScanResult(data);
      if (data.drafts_created > 0) {
        toast.success(`${data.drafts_created} rascunho${data.drafts_created !== 1 ? 's' : ''} criado${data.drafts_created !== 1 ? 's' : ''}!`);
        load();
      } else {
        toast.info(data.message || 'Nenhum contrato dentro da janela.');
      }
    } catch (e) {
      toast.error('Erro: ' + (e.message || ''));
    } finally {
      setScanning(false);
    }
  };

  const orderedDrafts = useMemo(
    () => [...drafts].sort((a, b) => compareRenewalDrafts(a, b, parents)),
    [drafts, parents]
  );
  const orderedScheduled = useMemo(
    () => [...scheduled].sort((a, b) => compareRenewalDrafts(a, b, parents)),
    [scheduled, parents]
  );
  const totalValue = [...orderedDrafts, ...orderedScheduled].reduce((s, d) => s + contractTotal(d), 0);
  const scheduledOpenPayments = orderedScheduled.filter(contract =>
    !['paid', 'refunded', 'cancelled'].includes(contract.payment_status)
  );
  const todayStr = todayLocalStr();
  const scanWindowDays = normalizeScanDays(scanForm.horizon_days);
  const scanWindowEnd = addDays(todayStr, scanWindowDays);
  const firstDraft = orderedDrafts[0];
  const firstDraftDaysLeft = firstDraft
    ? renewalDaysLeft(firstDraft, parents[firstDraft.parent_contract_id], todayStr)
    : null;
  const activationDraft = activationModal?.draft;
  const activationParent = activationModal?.parent;
  const activationNextStatus = activationModal?.nextStatus || 'active';
  const activationStartsLater = activationNextStatus === 'scheduled';
  const activationBusy = !!activationDraft && busy === activationDraft.id;
  const activationCustomer = activationDraft ? customers[activationDraft.customer_id] : null;
  const activationTotal = activationDraft ? contractTotal(activationDraft) : 0;
  const chargeModalCustomer = chargeModal ? customers[chargeModal.customer_id] : null;
  const chargeModeIsExternal = chargeForm.mode === 'external';
  const hasRenewalWork = orderedDrafts.length > 0 || orderedScheduled.length > 0;

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <RefreshCcw className="w-5 h-5 text-blue-600" />
            Renovações
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Rascunhos, renovações agendadas e cobranças de continuidade
          </p>
        </div>
        <Button onClick={() => setScanModal(true)} variant="outline">
          <RotateCcw className="w-4 h-4 mr-1.5" />
          Verificar renovações agora
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-blue-50 shrink-0"><RefreshCcw className="w-5 h-5 text-blue-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Pendentes</p>
              <p className="text-xl font-bold text-blue-700">{orderedDrafts.length}</p>
              {firstDraft && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Próxima: {renewalTimingLabel(firstDraftDaysLeft).toLowerCase()}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-blue-50 shrink-0"><Clock className="w-5 h-5 text-blue-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Agendadas</p>
              <p className="text-xl font-bold text-blue-700">{orderedScheduled.length}</p>
              {scheduledOpenPayments.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {scheduledOpenPayments.length} com pagamento aberto
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-gray-50 shrink-0"><Activity className="w-5 h-5 text-gray-600" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Valor potencial</p>
              <p className="text-xl font-bold text-gray-800">{formatCurrency(totalValue)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Carregando...</span>
        </div>
      ) : !hasRenewalWork ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <CheckCheck className="w-10 h-10 text-green-500 mb-3" />
            <p className="text-base font-semibold text-gray-700">Nenhuma renovação pendente</p>
            <p className="text-sm text-muted-foreground mt-1">
              Contratos próximos do vencimento geram rascunhos automaticamente aqui.
            </p>
            <Button className="mt-4" variant="outline" onClick={() => setScanModal(true)}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> Verificar agora
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {orderedDrafts.length > 0 && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Aguardando aprovação</h3>
                <p className="text-xs text-muted-foreground">Aprove a renovação para agendar a continuidade do aluno.</p>
              </div>
              {orderedDrafts.map(draft => (
                <RenewalRow
                  key={draft.id}
                  draft={draft}
                  parent={parents[draft.parent_contract_id]}
                  customer={customers[draft.customer_id]}
                  coach={coaches[draft.coach_id]}
                  modality={modalities[draft.plan_snapshot?.modality_id]}
                  onActivate={openActivationModal}
                  onDecline={declineRenewal}
                  onDiscard={discardRenewal}
                  busy={busy === draft.id}
                />
              ))}
            </section>
          )}

          {orderedScheduled.length > 0 && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Agendadas para cobrança</h3>
                <p className="text-xs text-muted-foreground">Renovações aprovadas que ainda precisam de cobrança, envio ou acompanhamento.</p>
              </div>
              {orderedScheduled.map(contract => (
                <ScheduledRenewalRow
                  key={contract.id}
                  contract={contract}
                  parent={parents[contract.parent_contract_id]}
                  customer={customers[contract.customer_id]}
                  coach={coaches[contract.coach_id]}
                  modality={modalities[contract.plan_snapshot?.modality_id]}
                  onGenerateCharge={openChargeModal}
                  onSendMessage={openMessageForRenewal}
                  busy={busy === contract.id || (chargeModal?.id === contract.id && charging)}
                />
              ))}
            </section>
          )}
        </div>
      )}

      {/* Modal: gerar cobrança da renovação agendada */}
      <Dialog open={!!chargeModal} onOpenChange={open => !open && !charging && setChargeModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-blue-600" /> Gerar cobrança da renovação
            </DialogTitle>
          </DialogHeader>

          {chargeModal && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-blue-700">{chargeModal.contract_number}</p>
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {customers[chargeModal.customer_id]?.full_name || 'Aluno'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatDate(chargeModal.start_date)} → {formatDate(chargeModal.end_date)}
                    </p>
                  </div>
                  <p className="text-sm font-bold text-gray-900 shrink-0">{formatCurrency(contractTotal(chargeModal))}</p>
                </div>
              </div>

              <div>
                <Label>Tipo de cobrança</Label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <Button
                    type="button"
                    variant={chargeForm.mode === 'asaas' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setChargeForm(form => ({ ...form, mode: 'asaas' }))}
                    disabled={charging}
                  >
                    <Zap className="w-3.5 h-3.5 mr-1.5" /> Asaas
                  </Button>
                  <Button
                    type="button"
                    variant={chargeModeIsExternal ? 'default' : 'outline'}
                    size="sm"
                    className={chargeModeIsExternal ? '' : 'border-amber-200 text-amber-700 hover:bg-amber-50'}
                    onClick={() => setChargeForm(form => ({ ...form, mode: 'external' }))}
                    disabled={charging}
                  >
                    <Link2 className="w-3.5 h-3.5 mr-1.5" /> Externa/manual
                  </Button>
                </div>
              </div>

              {chargeForm.mode === 'asaas' ? (
                <>
                  {!chargeModalCustomer?.cpf && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                      Para gerar no Asaas, cadastre o CPF do aluno. A cobrança externa/manual pode ser usada sem CPF.
                    </div>
                  )}

                  <div>
                    <Label>Forma de cobrança</Label>
                    <div className="grid grid-cols-3 gap-2 mt-1">
                      {[
                        { value: 'PIX', label: 'PIX' },
                        { value: 'BOLETO', label: 'Boleto' },
                        { value: 'CREDIT_CARD', label: `Cartão ${chargeModal.installments || 1}x` },
                      ].map(method => (
                        <Button
                          key={method.value}
                          type="button"
                          variant={chargeForm.billing_type === method.value ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setChargeForm(form => ({ ...form, billing_type: method.value }))}
                          disabled={charging}
                        >
                          {method.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <Label>Forma da cobrança externa</Label>
                    <Select
                      value={chargeForm.external_payment_method}
                      onValueChange={value => setChargeForm(form => ({ ...form, external_payment_method: value }))}
                      disabled={charging}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Selecione a forma" />
                      </SelectTrigger>
                      <SelectContent>
                        {EXTERNAL_CHARGE_METHODS.map(method => (
                          <SelectItem key={method.value} value={method.value}>
                            {method.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>Link de pagamento</Label>
                    <Input
                      className="mt-1 font-mono text-xs"
                      placeholder="https://..."
                      value={chargeForm.external_link}
                      onChange={e => setChargeForm(form => ({ ...form, external_link: e.target.value }))}
                      disabled={charging}
                    />
                  </div>

                  <div>
                    <Label>Número da fatura</Label>
                    <Input
                      className="mt-1 font-mono text-xs"
                      placeholder="Opcional"
                      value={chargeForm.external_invoice_number}
                      onChange={e => setChargeForm(form => ({ ...form, external_invoice_number: e.target.value }))}
                      disabled={charging}
                    />
                  </div>
                </>
              )}

              <div>
                <Label>Vencimento</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={chargeForm.due_date}
                  onChange={e => setChargeForm(form => ({ ...form, due_date: e.target.value }))}
                  disabled={charging}
                />
              </div>

              <div className={`rounded-lg border p-3 text-sm ${chargeModeIsExternal ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900'}`}>
                {chargeModeIsExternal
                  ? 'Use quando a cobrança foi gerada por fora. Depois de salvar, o envio para WhatsApp fica pronto com esse link.'
                  : 'Depois de gerar, a mensagem de WhatsApp será aberta já com o link/PIX da cobrança.'}
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" disabled={charging} onClick={() => setChargeModal(null)}>
                  Cancelar
                </Button>
                <Button
                  type="button"
                  disabled={
                    charging ||
                    !chargeForm.due_date ||
                    (chargeForm.mode === 'asaas' && !chargeModalCustomer?.cpf) ||
                    (chargeModeIsExternal && !chargeForm.external_link.trim())
                  }
                  onClick={chargeModeIsExternal ? saveExternalScheduledCharge : generateScheduledCharge}
                >
                  {charging ? (
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  ) : chargeModeIsExternal ? (
                    <Link2 className="w-4 h-4 mr-1.5" />
                  ) : (
                    <Zap className="w-4 h-4 mr-1.5" />
                  )}
                  {charging ? 'Salvando...' : chargeModeIsExternal ? 'Salvar e preparar envio' : 'Gerar e preparar envio'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {messageTask && (
        <CommunicationSendDialog
          key={messageTask.id}
          task={messageTask}
          onClose={() => setMessageTask(null)}
          onSent={() => {
            setMessageTask(null);
            load();
          }}
        />
      )}

      {/* Modal: agendar/ativar renovação */}
      <Dialog open={!!activationModal} onOpenChange={open => !open && !activationBusy && setActivationModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {activationStartsLater ? (
                <Clock className="w-5 h-5 text-blue-600" />
              ) : (
                <Check className="w-5 h-5 text-green-600" />
              )}
              {activationStartsLater ? 'Agendar renovação' : 'Ativar renovação'}
            </DialogTitle>
          </DialogHeader>

          {activationDraft && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-blue-700">{activationDraft.contract_number}</p>
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {activationCustomer?.full_name || 'Aluno'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatDate(activationDraft.start_date)} → {formatDate(activationDraft.end_date)}
                    </p>
                  </div>
                  <p className="text-sm font-bold text-gray-900 shrink-0">{formatCurrency(activationTotal)}</p>
                </div>
              </div>

              {activationStartsLater ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                  A renovação ficará aprovada e a cobrança pode ser tratada agora. Ela só entra como contrato ativo em <b>{formatDate(activationDraft.start_date)}</b>.
                  {activationParent && (
                    <span> O contrato anterior <b>{activationParent.contract_number}</b> permanece ativo até a virada da vigência.</span>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                  A renovação entra em vigor agora.
                  {activationParent && (
                    <span> O contrato anterior <b>{activationParent.contract_number}</b> será marcado como concluído.</span>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  disabled={activationBusy}
                  onClick={() => setActivationModal(null)}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  disabled={activationBusy}
                  className={activationStartsLater ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'}
                  onClick={activateRenewal}
                >
                  {activationBusy ? (
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  ) : activationStartsLater ? (
                    <Clock className="w-4 h-4 mr-1.5" />
                  ) : (
                    <Check className="w-4 h-4 mr-1.5" />
                  )}
                  {activationStartsLater ? 'Agendar' : 'Ativar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal: scan de renovações */}
      <Dialog open={scanModal} onOpenChange={open => !open && !scanning && setScanModal(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-blue-600" /> Verificar renovações
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Busca contratos próximos do vencimento e gera rascunhos de renovação automaticamente.
              Rascunhos já existentes não são duplicados.
            </p>
            <div>
              <Label>Janela de renovação</Label>
              <Input
                type="number" min="1" max="90"
                className="mt-1"
                value={scanForm.horizon_days}
                onChange={e => setScanForm(f => ({ ...f, horizon_days: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Padrão do sistema: {RENEWAL_ATTENTION_WINDOW_DAYS} dias antes do vencimento.
              </p>
            </div>
            <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs text-blue-900 space-y-1">
              <p>
                Com <b>{scanWindowDays} dia{scanWindowDays === 1 ? '' : 's'}</b>, serão considerados contratos que vencem de <b>{formatDate(todayStr)}</b> até <b>{formatDate(scanWindowEnd)}</b>.
              </p>
              <p className="text-blue-700">
                Depois de criados, os rascunhos aparecem do menor prazo para o maior prazo.
              </p>
            </div>

            {scanResult && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-1">
                <p><b>Contratos verificados:</b> {scanResult.processed}</p>
                <p className="text-green-700"><b>Rascunhos criados:</b> {scanResult.drafts_created}</p>
                {scanResult.errors?.length > 0 && (
                  <p className="text-red-700"><b>Erros:</b> {scanResult.errors.length}</p>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1"
                onClick={() => { setScanModal(false); setScanResult(null); }}
                disabled={scanning}>
                Fechar
              </Button>
              <Button className="flex-1" onClick={runScan} disabled={scanning}>
                {scanning ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1.5" />}
                {scanning ? 'Verificando...' : 'Executar agora'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
