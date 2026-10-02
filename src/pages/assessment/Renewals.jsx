import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  RefreshCcw, RotateCcw, ChevronRight, Check, XCircle,
  Calendar, Loader2, CheckCheck, Activity, Ban, Clock, Zap, MessageCircle, PenLine, Link2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { activateAssessmentContractRenewal, transitionAssessmentRenewalStage } from '@/api/client';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';
import { getActivationStatusForContract } from '@/lib/assessment-contract-lifecycle';
import { defaultAsaasDueDate } from '@/lib/payment-methods';
import { suggestedAssessmentChargeDueDate } from '@/lib/assessment-renewal-billing';
import { normalizeExternalChargeMethod } from '@/lib/external-charge';
import {
  generateAssessmentContractCharge,
  registerExternalAssessmentContractCharge,
} from '@/lib/assessment-contract-operations';
import { TASK_BUCKET, TASK_KIND } from '@/lib/communication-tasks';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import RenewalResolutionDialog from '@/components/RenewalResolutionDialog';
import ExternalChargeDialog from '@/components/billing/ExternalChargeDialog';
import { canResolveAssessmentRenewal } from '@/lib/assessment-renewal-resolution';
import {
  hasRenewalPaymentLink, isVisibleOnRenewalBoard, needsRenewalReview,
  renewalDaysUntilEnd, renewalTerminalDaysRemaining, saoPauloDate, todaySaoPaulo,
} from '@/lib/assessment-renewal-board';

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
  const credit     = Number(contract.credit_balance || 0);
  return Math.max(0, base + enrollment - discount - credit);
}

function hasChargeInfo(contract) {
  return Boolean(
    contract?.asaas_charge_id ||
    contract?.asaas_payment_link ||
    contract?.asaas_pix_copy ||
    contract?.asaas_pix_qrcode ||
    contract?.external_payment_link ||
    contract?.external_invoice_number
  );
}

function hasNativeChargeInfo(contract) {
  return Boolean(
    contract?.asaas_charge_id || contract?.asaas_payment_link ||
    contract?.asaas_pix_copy || contract?.asaas_pix_qrcode
  );
}

function isMonthlyAutomatic(contract, plans = {}) {
  return Boolean(contract?.auto_renewal) &&
    Number(contract.plan_snapshot?.period_months || plans[contract.plan_id]?.period_months) === 1;
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
const BOARD_STAGES = [
  { id: 'contact_pending', label: 'Enviar mensagem', color: 'text-blue-700' },
  { id: 'waiting_response', label: 'Aguardando decisão', color: 'text-violet-700' },
  { id: 'charge_pending', label: 'Enviar cobrança', color: 'text-amber-700' },
  { id: 'waiting_payment', label: 'Aguardando pagamento', color: 'text-red-700' },
  { id: 'renewed', label: 'Renovou', color: 'text-green-700' },
  { id: 'not_renewed', label: 'Não renovou', color: 'text-gray-700' },
];
const OPEN_BOARD_STAGES = BOARD_STAGES.slice(0, 4).map(stage => stage.id);
const TERMINAL_BOARD_STAGES = BOARD_STAGES.slice(4).map(stage => stage.id);
const RENEWAL_FIELDS_LEGACY = 'id, contract_number, customer_id, coach_id, plan_id, plan_snapshot, start_date, end_date, due_date, installments, enrollment_fee, manual_discount, credit_balance, payment_method, payment_status, payment_date, manual_payment, refund_status, refund_amount, refund_date, refund_notes, parent_contract_id, notes, created_at, updated_at, status, auto_renewal, asaas_charge_id, asaas_payment_link, asaas_pix_copy, asaas_pix_qrcode, external_payment_link, external_invoice_number, payment_message_sent_at';
const RENEWAL_FIELDS_BOARD = `${RENEWAL_FIELDS_LEGACY}, renewal_stage, renewal_stage_updated_at, renewal_entered_at, renewal_response_code, renewal_response_at, renewal_follow_up_at, renewal_resolved_at, renewal_last_contact_at`;
const PAGE_SIZE = 500;

function missingRenewalSchema(error) {
  return ['42703', 'PGRST204'].includes(error?.code) &&
    /renewal_(stage|entered|resolved|response|follow_up|last_contact)/i.test(error?.message || '');
}

async function fetchRenewalPages(makeQuery) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function fetchRelatedRows(table, fields, ids) {
  if (ids.length === 0) return [];
  const chunks = [];
  for (let offset = 0; offset < ids.length; offset += 200) chunks.push(ids.slice(offset, offset + 200));
  const results = await Promise.all(chunks.map(chunk =>
    supabase.from(table).select(fields).in('id', chunk)
  ));
  const error = results.find(result => result.error)?.error;
  if (error) throw error;
  return results.flatMap(result => result.data || []);
}
const RESPONSE_LABELS = {
  will_renew: 'Sim, vou renovar',
  thinking: 'Ainda estou pensando',
  change_plan_or_coach: 'Mudar plano/treinador',
  needs_agent: 'Falar com atendente',
  not_renewing: 'Não vou renovar',
};
const EVENT_LABELS = {
  renewal_message_sent: 'Mensagem de intenção enviada',
  renewal_declined: 'Não renovação registrada',
  external_charge_registered: 'Cobrança externa registrada',
  external_charge_updated: 'Cobrança externa atualizada',
  manual_payment_recorded: 'Pagamento manual registrado',
  renewal_scheduled: 'Renovação agendada',
  renewal_activated: 'Nova vigência iniciada',
  renewal_subscription_link_registered: 'Link da assinatura cadastrado',
};

function renewalEventLabel(event) {
  if (event.event_type === 'renewal_stage_changed') {
    const before = BOARD_STAGES.find(stage => stage.id === event.payload?.stage_before)?.label || 'Entrada no pipeline';
    const after = BOARD_STAGES.find(stage => stage.id === event.payload?.stage_after)?.label || 'Sem etapa';
    const response = RESPONSE_LABELS[event.payload?.response_code];
    return `${before} → ${after}${event.payload?.action === 'register_response' && response ? ` · ${response}` : ''}`;
  }
  return event.notes || EVENT_LABELS[event.event_type] || event.event_type;
}
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

function daysBetween(dateStr, todayStr = todaySaoPaulo()) {
  return renewalDaysUntilEnd(dateStr, todayStr);
}

function renewalDate(draft, parent) {
  return parent?.end_date || draft.start_date || draft.end_date || '';
}

function renewalDaysLeft(draft, parent, todayStr = todaySaoPaulo()) {
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
    updatedAt: contract.updated_at,
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
              {draft.auto_renewal && (
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold">
                  Automática
                </span>
              )}
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
                title="Descarta esta venda sem registrar saída da atleta."
                onClick={() => onDiscard(draft, parent)}>
                <XCircle className="w-3.5 h-3.5 mr-1" /> Descartar venda
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

function ScheduledRenewalRow({ contract, parent, customer, coach, modality, onGenerateCharge, onSendMessage, onResolve, busy }) {
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
  const resolutionAllowed = canResolveAssessmentRenewal(contract);
  const canSendCharge = charged
    && !isTerminalPayment
    && !contract.manual_payment
    && !contract.refund_status
    && Number(contract.refund_amount || 0) === 0
    && !contract.refund_date
    && !String(contract.refund_notes || '').trim()
    && (contract.payment_status === 'partially_paid' || !contract.payment_date);
  const lifecycle = {
    scheduled: 'Agendada',
    active: 'Ativa',
    overdue: 'Vigência vencida',
    on_leave: 'Em pausa',
  }[contract.status] || contract.status;
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
              <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">{lifecycle}</span>
              {contract.auto_renewal && (
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold">
                  Automática
                </span>
              )}
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
              {!charged && resolutionAllowed && (
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
              {resolutionAllowed && (
                <Link to={`/assessoria/contratos/${contract.id}?ajustar-plano=1`}>
                  <Button size="sm" variant="outline" disabled={busy}
                    className="border-blue-200 text-blue-700 hover:bg-blue-50">
                    <PenLine className="w-3.5 h-3.5 mr-1" /> Trocar plano
                  </Button>
                </Link>
              )}
              {resolutionAllowed && (
                <Button size="sm" variant="outline" disabled={busy}
                  className="border-amber-200 text-amber-700 hover:bg-amber-50"
                  onClick={() => onResolve(contract, parent)}>
                  <Ban className="w-3.5 h-3.5 mr-1" /> Encerrar renovação
                </Button>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [drafts,     setDrafts]     = useState([]);
  const [scheduled,  setScheduled]  = useState([]);
  const [boardRows,  setBoardRows]  = useState([]);
  const [parents,    setParents]    = useState({});
  const [customers,  setCustomers]  = useState({});
  const [coaches,    setCoaches]    = useState({});
  const [modalities, setModalities] = useState({});
  const [plans, setPlans] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(null);
  const [scanModal,  setScanModal]  = useState(false);
  const [scanForm,   setScanForm]   = useState({ horizon_days: RENEWAL_ATTENTION_WINDOW_DAYS });
  const [scanning,   setScanning]   = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [activationModal, setActivationModal] = useState(null);
  const [chargeModal, setChargeModal] = useState(null);
  const [chargeForm, setChargeForm] = useState({
    billing_type: 'PIX',
    due_date: defaultAsaasDueDate(),
  });
  const [externalChargeModal, setExternalChargeModal] = useState(null);
  const [externalChargeForm, setExternalChargeForm] = useState({
    link: '',
    due_date: defaultAsaasDueDate(),
    payment_method: 'pix',
    invoice_number: '',
  });
  const [charging, setCharging] = useState(false);
  const [messageTask, setMessageTask] = useState(null);
  const [resolutionTarget, setResolutionTarget] = useState(null);
  const [boardSearch, setBoardSearch] = useState('');
  const [boardFilters, setBoardFilters] = useState({ plan: '', coach: '', modality: '', hideCompleted: false });
  const [selectedCard, setSelectedCard] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [responseTarget, setResponseTarget] = useState(null);
  const [responseForm, setResponseForm] = useState({ code: 'will_renew', followUpAt: '' });
  const [intentTarget, setIntentTarget] = useState(null);
  const [intentText, setIntentText] = useState('');
  const [intentOpened, setIntentOpened] = useState(false);
  const [boardAvailable, setBoardAvailable] = useState(true);
  const [subscriptionTarget, setSubscriptionTarget] = useState(null);
  const [subscriptionLink, setSubscriptionLink] = useState('');
  const [changeTarget, setChangeTarget] = useState(null);
  const [changeConfirmed, setChangeConfirmed] = useState(false);
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [followUpDate, setFollowUpDate] = useState('');
  const [todayStr, setTodayStr] = useState(todaySaoPaulo);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let renewalList;
      let hasBoardSchema = true;
      try {
        // Keep all open cards, however old their dates are. Fetch only recent terminal
        // cards for the board and KPI; pagination avoids PostgREST's default row cap.
        const recentCutoff = new Date(Date.now() - 32 * DAY_MS).toISOString();
        const [open, terminal, terminalMissingDate] = await Promise.all([
          fetchRenewalPages(() => supabase.from('assessment_contracts')
            .select(RENEWAL_FIELDS_BOARD)
            .in('renewal_stage', OPEN_BOARD_STAGES)
            .not('parent_contract_id', 'is', null)
            .order('start_date', { ascending: true }).order('id', { ascending: true })),
          fetchRenewalPages(() => supabase.from('assessment_contracts')
            .select(RENEWAL_FIELDS_BOARD)
            .in('renewal_stage', TERMINAL_BOARD_STAGES)
            .gte('renewal_resolved_at', recentCutoff)
            .not('parent_contract_id', 'is', null)
            .order('start_date', { ascending: true }).order('id', { ascending: true })),
          fetchRenewalPages(() => supabase.from('assessment_contracts')
            .select(RENEWAL_FIELDS_BOARD)
            .in('renewal_stage', TERMINAL_BOARD_STAGES)
            .is('renewal_resolved_at', null)
            .not('parent_contract_id', 'is', null)
            .order('start_date', { ascending: true }).order('id', { ascending: true })),
        ]);
        renewalList = [...open, ...terminal, ...terminalMissingDate];
      } catch (error) {
        if (!missingRenewalSchema(error)) throw error;
        hasBoardSchema = false;
        renewalList = await fetchRenewalPages(() => supabase.from('assessment_contracts')
          .select(RENEWAL_FIELDS_LEGACY)
          .in('status', ['draft', 'scheduled', 'active', 'overdue', 'on_leave'])
          .not('parent_contract_id', 'is', null)
          .order('start_date', { ascending: true }).order('id', { ascending: true }));
      }
      renewalList.sort(compareRenewalDrafts);
      setBoardAvailable(hasBoardSchema);

      if (renewalList.length === 0) {
        setDrafts([]); setScheduled([]); setBoardRows([]);
        setParents({}); setCustomers({}); setCoaches({}); setModalities({}); setPlans({});
        return;
      }

      const parentIds   = [...new Set(renewalList.map(d => d.parent_contract_id).filter(Boolean))];
      const customerIds = [...new Set(renewalList.map(d => d.customer_id).filter(Boolean))];
      const coachIds    = [...new Set(renewalList.map(d => d.coach_id).filter(Boolean))];
      const modalityIds = [...new Set(renewalList.map(d => d.plan_snapshot?.modality_id).filter(Boolean))];
      const planIds = [...new Set(renewalList.map(d => d.plan_id).filter(Boolean))];

      const [parentRows, customerRows, coachRows, modalityRows, planRows] = await Promise.all([
        fetchRelatedRows('assessment_contracts', 'id, contract_number, status, end_date, payment_status', parentIds),
        fetchRelatedRows('presale_customers', 'id, full_name, whatsapp, email, cpf', customerIds),
        fetchRelatedRows('assessment_coaches', 'id, name', coachIds),
        fetchRelatedRows('assessment_modalities', 'id, name', modalityIds),
        fetchRelatedRows('assessment_plans', 'id, name, period_months', planIds),
      ]);

      setDrafts(renewalList.filter(contract => contract.status === 'draft'));
      setScheduled(renewalList.filter(contract =>
        ['scheduled', 'active', 'overdue', 'on_leave'].includes(contract.status)
        && !TERMINAL_PAYMENT_STATUSES.has(contract.payment_status)
      ));
      setBoardRows(hasBoardSchema ? renewalList : []);
      setParents(Object.fromEntries(parentRows.map(p => [p.id, p])));
      setCustomers(Object.fromEntries(customerRows.map(c => [c.id, c])));
      setCoaches(Object.fromEntries(coachRows.map(c => [c.id, c])));
      setModalities(Object.fromEntries(modalityRows.map(m => [m.id, m])));
      setPlans(Object.fromEntries(planRows.map(p => [p.id, p])));
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

  useEffect(() => {
    const timer = setInterval(() => setTodayStr(todaySaoPaulo()), 60000);
    return () => clearInterval(timer);
  }, []);

  // ── Ações: renovação ─────────────────────────────────────────────────────

  const openActivationModal = (draft, parent) => {
    const nextStatus = getActivationStatusForContract(draft);
    setActivationModal({ draft, parent, nextStatus });
  };

  const activateRenewal = async () => {
    if (!activationModal?.draft) return;
    const { draft, nextStatus } = activationModal;
    setBusy(draft.id);
    try {
      const result = await activateAssessmentContractRenewal(
        draft.id,
        draft.updated_at,
      );
      const activatedStatus = result.contract?.status || nextStatus;

      toast.success(activatedStatus === 'scheduled'
        ? `Renovação ${draft.contract_number} agendada!`
        : `Renovação ${draft.contract_number} ativada!`);
      setActivationModal(null);
      load();
    } catch (e) {
      toast.error('Erro ao ativar: ' + (e.message || ''));
      if (e.status === 409) { setActivationModal(null); await load(); }
    } finally {
      setBusy(null);
    }
  };

  const openExternalChargeModal = (contract, dueDate = '') => {
    if (isMonthlyAutomatic(contract, plans)) {
      toast.error('Assinatura automática: cadastre somente o link da cobrança já existente');
      return;
    }
    if (hasNativeChargeInfo(contract)) {
      toast.error('Esta renovação já possui dados de cobrança Asaas. Confira a cobrança no contrato.');
      return;
    }
    const suggestedDueDate = suggestedAssessmentChargeDueDate(contract);
    const defaultExternalMethod = normalizeExternalChargeMethod(contract.payment_method, contract.installments);
    setExternalChargeForm({
      link: contract.external_payment_link || '',
      due_date: dueDate || suggestedDueDate,
      payment_method: defaultExternalMethod,
      invoice_number: contract.external_invoice_number || '',
    });
    setExternalChargeModal(contract);
  };

  const openSubscriptionLink = contract => {
    setSubscriptionTarget(contract);
    setSubscriptionLink(contract.asaas_payment_link || '');
  };

  const openChargeModal = (contract) => {
    const customer = customers[contract.customer_id];
    if (contract.external_payment_link || !customer?.cpf) {
      openExternalChargeModal(contract);
      return;
    }
    const suggestedDueDate = suggestedAssessmentChargeDueDate(contract);
    setChargeForm({
      billing_type: 'PIX',
      due_date: suggestedDueDate,
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
      await generateAssessmentContractCharge({
        contract,
        customer,
        billingType: chargeForm.billing_type,
        dueDate: chargeForm.due_date,
        source: 'renewals_page',
      });
      setChargeModal(null);
      toast.success('Cobrança gerada. Envie a mensagem quando estiver pronto.');
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao gerar cobrança');
    } finally {
      setCharging(false);
    }
  };

  const saveExternalScheduledCharge = async () => {
    if (!externalChargeModal) return;
    const contract = externalChargeModal;
    const link = externalChargeForm.link.trim();
    const dueDate = externalChargeForm.due_date;
    const invoiceNumber = externalChargeForm.invoice_number.trim();
    const paymentMethod = normalizeExternalChargeMethod(externalChargeForm.payment_method, contract.installments);

    setCharging(true);
    try {
      await registerExternalAssessmentContractCharge({
        contract,
        link,
        dueDate,
        paymentMethod,
        invoiceNumber,
        source: 'renewals_page',
      });
      setExternalChargeModal(null);
      toast.success('Cobrança externa cadastrada. Envie a mensagem quando estiver pronto.');
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar cobrança externa');
      if (e.status === 409) { setExternalChargeModal(null); await load(); }
    } finally {
      setCharging(false);
    }
  };

  const openResolution = useCallback((contract, parent, initialChoice = '') => {
    if (!parent) {
      toast.error('Contrato anterior não encontrado; atualize a lista antes de continuar');
      return;
    }
    if (!canResolveAssessmentRenewal(contract)) {
      toast.error('Esta renovação possui movimentação ou situação que exige revisão');
      return;
    }
    setResolutionTarget({
      contract,
      parent,
      customerName: customers[contract.customer_id]?.full_name || '',
      initialChoice: parent.status === 'cancelled' ? 'parent_cancelled' : initialChoice,
    });
  }, [customers]);

  const discardRenewal = (draft, parent) => openResolution(draft, parent, 'created_in_error');
  const declineRenewal = (draft, parent) => openResolution(draft, parent, 'customer_declined');

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
      const errorCount = data?.errors?.length || 0;
      if (Number(data?.processed || 0) > 0) {
        const changes = [];
        if (data.drafts_created > 0) changes.push(`${data.drafts_created} rascunho${data.drafts_created !== 1 ? 's' : ''}`);
        if (data.automatic_renewals_scheduled > 0) changes.push(`${data.automatic_renewals_scheduled} automática${data.automatic_renewals_scheduled !== 1 ? 's' : ''} agendada${data.automatic_renewals_scheduled !== 1 ? 's' : ''}`);
        if (data.automatic_renewals_activated > 0) changes.push(`${data.automatic_renewals_activated} automática${data.automatic_renewals_activated !== 1 ? 's' : ''} ativada${data.automatic_renewals_activated !== 1 ? 's' : ''}`);
        if (data.scheduled_renewals_activated > 0) changes.push(`${data.scheduled_renewals_activated} agendada${data.scheduled_renewals_activated !== 1 ? 's' : ''} iniciada${data.scheduled_renewals_activated !== 1 ? 's' : ''}`);
        toast.success(changes.length > 0 ? changes.join(' · ') : 'Renovações atualizadas!');
        await load();
        if (errorCount > 0) toast.error(`${errorCount} ${errorCount === 1 ? 'renovação precisa' : 'renovações precisam'} de revisão.`);
      } else if (errorCount > 0) {
        toast.error(`${errorCount} ${errorCount === 1 ? 'renovação não pôde ser processada' : 'renovações não puderam ser processadas'}.`);
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
  const hasRenewalWork = orderedDrafts.length > 0 || orderedScheduled.length > 0;
  const useLegacyView = !boardAvailable || searchParams.get('view') === 'legacy';
  const board = boardRows.filter(contract => isVisibleOnRenewalBoard(contract, todayStr));
  const displayedBoard = board.filter(contract => {
    const customer = customers[contract.customer_id];
    const term = boardSearch.trim().toLocaleLowerCase('pt-BR');
    if (term && !`${customer?.full_name || ''} ${contract.contract_number || ''}`
      .toLocaleLowerCase('pt-BR').includes(term)) return false;
    if (boardFilters.plan && contract.plan_id !== boardFilters.plan) return false;
    if (boardFilters.coach && contract.coach_id !== boardFilters.coach) return false;
    if (boardFilters.modality && contract.plan_snapshot?.modality_id !== boardFilters.modality) return false;
    if (boardFilters.hideCompleted && ['renewed', 'not_renewed'].includes(contract.renewal_stage)) return false;
    return true;
  });
  const selectedBoardCard = boardRows.find(row => row.id === selectedCard?.id) || selectedCard;
  const boardOpen = board.filter(row => !['renewed', 'not_renewed'].includes(row.renewal_stage));
  const boardAttention = boardOpen.filter(row => {
    const left = renewalDaysLeft(row, parents[row.parent_contract_id], todayStr);
    return (left !== null && left <= 3) ||
      (row.renewal_follow_up_at && row.renewal_follow_up_at <= todayStr) ||
      row.payment_status === 'overdue' || needsRenewalReview(row);
  });
  const boardWaitingPayment = boardOpen.filter(row => row.renewal_stage === 'waiting_payment');
  const boardRecentRenewed = boardRows.filter(row => row.renewal_stage === 'renewed' &&
    saoPauloDate(row.renewal_resolved_at) >= addDays(todayStr, -30));

  const runBoardAction = async (contract, action, { responseCode = null, followUpAt = null, subscriptionLink: link = null } = {}) => {
    if (needsRenewalReview(contract)) {
      toast.error('Esta renovação precisa de conferência financeira antes de novas ações');
      return false;
    }
    setBusy(contract.id);
    try {
      await transitionAssessmentRenewalStage(contract.id, {
        action, responseCode, followUpAt, subscriptionLink: link,
        expectedUpdatedAt: contract.updated_at,
      });
      toast.success('Renovação atualizada');
      await load();
      return true;
    } catch (error) {
      toast.error(error.status === 409
        ? 'Esta renovação mudou. O quadro será atualizado.'
        : error.message || 'Não foi possível atualizar a renovação');
      if (error.status === 409) {
        setIntentTarget(null); setResponseTarget(null); setFollowUpTarget(null);
        setChangeTarget(null); setSubscriptionTarget(null);
        await load();
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openTimeline = async contract => {
    setSelectedCard(contract);
    setTimeline([]);
    setTimelineLoading(true);
    const ids = [contract.id, contract.parent_contract_id].filter(Boolean);
    const { data, error } = await supabase.from('assessment_contract_event')
      .select('id, contract_id, event_type, notes, created_at, payload')
      .in('contract_id', ids)
      .order('created_at', { ascending: false })
      .limit(80);
    if (error) toast.error('Não foi possível carregar o histórico');
    else setTimeline(data || []);
    setTimelineLoading(false);
  };

  const openIntent = contract => {
    const firstName = (customers[contract.customer_id]?.full_name || 'atleta').split(' ')[0];
    const left = renewalDaysLeft(contract, parents[contract.parent_contract_id], todayStr);
    const timing = left !== null && left < 0
      ? `seu plano venceu em ${formatDate(renewalDate(contract, parents[contract.parent_contract_id]))}`
      : 'seu plano vence nos próximos dias';
    setIntentText(`Oi, ${firstName}! Tudo bem?\nSou o Pebinha, assistente virtual da EON. Estou aqui pra te lembrar que ${timing}.\nPra ajudar nosso time nesse processo, você gostaria de realizar a renovação?\n1. Sim, vou renovar.\n2. Ainda estou pensando.\n3. Gostaria de mudar de plano/treinador.\n4. Gostaria de falar com um atendente.\n5. Não vou renovar.`);
    setIntentOpened(false);
    setIntentTarget(contract);
  };

  useEffect(() => {
    const renewalId = searchParams.get('resolver');
    if (!renewalId || loading || resolutionTarget) return;

    const contract = [...orderedDrafts, ...orderedScheduled]
      .find(candidate => candidate.id === renewalId);
    const timer = setTimeout(() => {
      if (contract) {
        openResolution(contract, parents[contract.parent_contract_id]);
      } else {
        toast.error('A renovação solicitada não está disponível para encerramento');
      }
      setSearchParams({}, { replace: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [loading, openResolution, orderedDrafts, orderedScheduled, parents, resolutionTarget, searchParams, setSearchParams]);

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
            Acompanhe cada renovação da primeira abordagem até a decisão final
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="ghost" disabled={loading}>
            <RefreshCcw className="w-4 h-4 mr-1.5" /> Atualizar quadro
          </Button>
          <Button onClick={() => setScanModal(true)} variant="outline">
            <RotateCcw className="w-4 h-4 mr-1.5" />
            Verificar renovações agora
          </Button>
        </div>
      </div>

      {!loading && !boardAvailable && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
        O quadro será exibido após a atualização do banco. A lista anterior continua disponível nesta prévia.
      </div>}

      {useLegacyView ? <>
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
              Renovações manuais geram rascunhos; as automáticas são agendadas 5 dias antes.
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
                <p className="text-xs text-muted-foreground">As manuais aguardam aprovação; rascunhos automáticos antigos serão agendados 5 dias antes.</p>
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
                  onResolve={openResolution}
                  busy={busy === contract.id || (chargeModal?.id === contract.id && charging)}
                />
              ))}
            </section>
          )}
        </div>
      )}

      </> : <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          { label: 'No pipeline', value: boardOpen.length, tone: 'text-blue-700' },
          { label: 'Exigem atenção', value: boardAttention.length, tone: 'text-red-700' },
          { label: 'Aguardando pagamento', value: boardWaitingPayment.length, tone: 'text-amber-700' },
          { label: 'Renovaram em 30 dias', value: boardRecentRenewed.length, tone: 'text-green-700' },
        ].map(kpi => <Card key={kpi.label}><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{kpi.label}</p>
          <p className={`text-2xl font-bold mt-1 ${kpi.tone}`}>{kpi.value}</p>
        </CardContent></Card>)}
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        A data coloca a renovação no fluxo e aumenta a urgência. Nenhuma pendência sai do quadro só porque venceu.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
        <Input className="md:col-span-2" placeholder="Buscar atleta ou contrato" aria-label="Buscar atleta ou contrato" value={boardSearch}
          onChange={event => setBoardSearch(event.target.value)} />
        <select className="h-10 rounded-md border bg-white px-3 text-sm" aria-label="Filtrar por plano" value={boardFilters.plan}
          onChange={event => setBoardFilters(value => ({ ...value, plan: event.target.value }))}>
          <option value="">Todos os planos</option>
          {[...new Map(boardRows.map(row => [row.plan_id, row.plan_snapshot?.name || 'Plano'])).entries()]
            .filter(([id]) => id).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className="h-10 rounded-md border bg-white px-3 text-sm" aria-label="Filtrar por coach" value={boardFilters.coach}
          onChange={event => setBoardFilters(value => ({ ...value, coach: event.target.value }))}>
          <option value="">Todos os coaches</option>
          {Object.values(coaches).sort((a, b) => a.name.localeCompare(b.name))
            .map(coach => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
        </select>
        <select className="h-10 rounded-md border bg-white px-3 text-sm" aria-label="Filtrar por modalidade" value={boardFilters.modality}
          onChange={event => setBoardFilters(value => ({ ...value, modality: event.target.value }))}>
          <option value="">Todas as modalidades</option>
          {Object.values(modalities).sort((a, b) => a.name.localeCompare(b.name))
            .map(modality => <option key={modality.id} value={modality.id}>{modality.name}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={boardFilters.hideCompleted}
          onChange={event => setBoardFilters(value => ({ ...value, hideCompleted: event.target.checked }))} />
        Ocultar concluídos
      </label>

      {loading ? <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" /> Carregando renovações...
      </div> : <div className="overflow-x-auto pb-4" aria-label="Quadro de renovações">
        <div className="flex gap-3 min-w-max items-start">
          {BOARD_STAGES.map(stage => {
            const cards = displayedBoard.filter(row => row.renewal_stage === stage.id)
              .sort((a, b) => compareRenewalDrafts(a, b, parents));
            return <section key={stage.id} className="w-[275px] shrink-0 rounded-xl border bg-slate-50 min-h-[240px]">
              <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-slate-100 px-3 py-3 rounded-t-xl">
                <h3 className={`text-sm font-semibold ${stage.color}`}>{stage.label}</h3>
                <span className="rounded-full bg-white border px-2 py-0.5 text-xs font-semibold">{cards.length}</span>
              </div>
              <div className="p-2 space-y-2">
                {cards.length === 0 && <p className="text-xs text-muted-foreground p-3">Nenhuma renovação</p>}
                {cards.map(contract => {
                  const parent = parents[contract.parent_contract_id];
                  const customer = customers[contract.customer_id];
                  const coach = coaches[contract.coach_id];
                  const modality = modalities[contract.plan_snapshot?.modality_id];
                  const left = renewalDaysLeft(contract, parent, todayStr);
                  const followUpLate = contract.renewal_follow_up_at && contract.renewal_follow_up_at < todayStr;
                  const urgent = !['renewed', 'not_renewed'].includes(stage.id) &&
                    ((left !== null && left <= 3) || followUpLate || contract.payment_status === 'overdue');
                  const auto = isMonthlyAutomatic(contract, plans);
                  const missingLink = auto && stage.id === 'waiting_payment' && !hasRenewalPaymentLink(contract);
                  const review = needsRenewalReview(contract);
                  const startDays = renewalDaysUntilEnd(contract.start_date, todayStr);
                  const terminalDays = renewalTerminalDaysRemaining(contract, todayStr) ?? 5;
                  return <Card key={contract.id} className={`${urgent ? 'border-l-4 border-l-red-500' : ''} ${['renewed', 'not_renewed'].includes(stage.id) ? 'opacity-80' : ''}`}>
                    <CardContent className="p-3 space-y-2">
                      <button type="button" className="w-full text-left" onClick={() => openTimeline(contract)}>
                        <p className="font-semibold text-sm text-gray-900 truncate">{customer?.full_name || 'Atleta'}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{contract.contract_number}</p>
                      </button>
                      <p className="text-xs text-gray-600 truncate">
                        {modality?.name || contract.plan_snapshot?.modality_name || 'Modalidade'} · {contract.plan_snapshot?.name || 'Plano'}
                      </p>
                      <p className="text-[11px] text-muted-foreground">Coach: {coach?.name || '—'}</p>
                      <div className="flex flex-wrap gap-1 text-[10px] font-medium">
                        {auto && <span className="rounded bg-violet-100 text-violet-700 px-1.5 py-0.5">Assinatura automática</span>}
                        {contract.renewal_response_code === 'change_plan_or_coach' && stage.id === 'waiting_response' &&
                          <span className="rounded bg-violet-100 text-violet-700 px-1.5 py-0.5">Mudar plano/coach</span>}
                        {contract.renewal_response_code === 'needs_agent' && stage.id === 'waiting_response' &&
                          <span className="rounded bg-violet-100 text-violet-700 px-1.5 py-0.5">Atendimento pendente</span>}
                        {missingLink && <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5">Link ausente</span>}
                        {left !== null && <span className={`rounded px-1.5 py-0.5 ${renewalTimingClass(left)}`}>{renewalTimingLabel(left)}</span>}
                        {review && <span className="rounded bg-red-100 text-red-800 px-1.5 py-0.5">Precisa de conferência</span>}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        <p>Fim da vigência: {formatDate(parent?.end_date)}</p>
                        <p>Nova vigência: {formatDate(contract.start_date)}</p>
                        {contract.renewal_entered_at && <p>No pipeline desde {formatDate(saoPauloDate(contract.renewal_entered_at))}</p>}
                        <p>Valor: {formatCurrency(contractTotal(contract))}</p>
                      </div>
                      {urgent && <p className="rounded bg-red-50 p-2 text-[11px] text-red-700">
                        {stage.id === 'contact_pending' && left < 0
                          ? 'A abordagem ficou atrasada, mas o card permanece no fluxo.'
                          : stage.id === 'waiting_payment' && startDays !== null && startDays < 0
                          ? `A nova vigência começou há ${-startDays} dia(s) e o pagamento continua pendente.`
                          : followUpLate
                          ? `Follow-up atrasado há ${-renewalDaysUntilEnd(contract.renewal_follow_up_at, todayStr)} dia(s).`
                          : left < 0 ? 'A vigência passou. A ação continua pendente.' : 'Ação urgente antes do vencimento.'}
                      </p>}
                      {contract.renewal_follow_up_at && stage.id === 'waiting_response' &&
                        <p className={`text-[11px] ${contract.renewal_follow_up_at < todayStr ? 'text-red-700' : 'text-gray-600'}`}>
                          Follow-up: {formatDate(contract.renewal_follow_up_at)}
                        </p>}
                      {missingLink && <p className="text-[11px] text-amber-800">Link da cobrança ainda não informado. O card segue ativo.</p>}
                      {review && <p className="text-[11px] text-red-800">Etapa e pagamento não conferem. Verifique o contrato antes de avançar.</p>}
                      {stage.id === 'waiting_payment' && <p className="text-[11px] text-blue-700">Também em Vendas em aberto.</p>}
                      {['renewed', 'not_renewed'].includes(stage.id) &&
                        <p className="text-[11px] text-muted-foreground">{contract.renewal_resolved_at
                          ? `Sai do quadro em ${terminalDays} dia(s). Histórico preservado.`
                          : 'Data de resolução ausente. Conferência necessária.'}</p>}
                      {stage.id === 'contact_pending' && <Button size="sm" className="w-full" disabled={Boolean(busy) || review}
                        onClick={() => openIntent(contract)}>Enviar mensagem</Button>}
                      {stage.id === 'contact_pending' && <Button size="sm" variant="ghost" className="w-full" disabled={Boolean(busy) || review}
                        onClick={() => { setResponseTarget(contract); setResponseForm({ code: 'will_renew', followUpAt: '' }); }}>
                        Resposta já recebida</Button>}
                      {stage.id === 'waiting_response' && <Button size="sm" className="w-full" disabled={Boolean(busy) || review}
                        onClick={() => { setResponseTarget(contract); setResponseForm({ code: 'will_renew', followUpAt: contract.renewal_follow_up_at || '' }); }}>
                        Registrar resposta</Button>}
                      {stage.id === 'waiting_response' && contract.renewal_response_code === 'change_plan_or_coach' &&
                        <div className="space-y-1"><Link className="block text-center text-xs text-blue-700 underline" to={`/assessoria/contratos/${contract.id}?ajustar-plano=1`}>
                          Resolver alteração no contrato</Link><Button size="sm" variant="outline" className="w-full" disabled={Boolean(busy) || review}
                            onClick={() => { setChangeConfirmed(false); setChangeTarget(contract); }}>Seguir para cobrança</Button></div>}
                      {stage.id === 'waiting_response' && <Button size="sm" variant="ghost" className="w-full" disabled={Boolean(busy) || review}
                        onClick={() => { setFollowUpTarget(contract); setFollowUpDate(contract.renewal_follow_up_at || ''); }}>Definir follow-up</Button>}
                      {stage.id === 'charge_pending' && (hasNativeChargeInfo(contract)
                        ? <Link className="block text-center text-xs text-blue-700 underline" to={`/assessoria/contratos/${contract.id}`}>Revisar cobrança no contrato</Link>
                        : <Button size="sm" className="w-full" disabled={Boolean(busy) || review}
                          onClick={() => openExternalChargeModal(contract)}>Cadastrar cobrança</Button>)}
                      {stage.id === 'waiting_payment' && (hasNativeChargeInfo(contract) && !auto
                        ? <Link className="block text-center text-xs text-blue-700 underline" to={`/assessoria/contratos/${contract.id}`}>Ver cobrança no contrato</Link>
                        : <Button size="sm" variant="outline" className="w-full" disabled={Boolean(busy) || review}
                          onClick={() => auto ? openSubscriptionLink(contract) : openExternalChargeModal(contract)}>
                          {auto ? (contract.asaas_payment_link ? 'Atualizar link da assinatura' : 'Adicionar link da assinatura') : 'Ver cobrança'}</Button>)}
                      {stage.id === 'waiting_payment' && !auto && hasChargeInfo(contract) &&
                        <Button size="sm" variant="ghost" className="w-full" disabled={Boolean(busy) || review}
                          onClick={() => openMessageForRenewal(contract)}>
                          {contract.payment_message_sent_at ? 'Reenviar cobrança' : 'Enviar cobrança'}
                        </Button>}
                      {stage.id === 'waiting_payment' && <Link className="block text-center text-xs text-blue-700 underline" to={`/assessoria/contratos/${contract.id}`}>
                        Registrar pagamento no contrato</Link>}
                      {!['renewed', 'not_renewed'].includes(stage.id) && <Button size="sm" variant="ghost"
                        className="w-full text-red-700" disabled={Boolean(busy) || review}
                        onClick={() => openResolution(contract, parent, 'customer_declined')}>Não renovar</Button>}
                      {!['renewed', 'not_renewed'].includes(stage.id) && <Button size="sm" variant="ghost"
                        className="w-full text-gray-600" disabled={Boolean(busy) || review}
                        onClick={() => openResolution(contract, parent, 'created_in_error')}>Descartar venda</Button>}
                    </CardContent>
                  </Card>;
                })}
              </div>
            </section>;
          })}
        </div>
      </div>}
      </>}

      {resolutionTarget && (
        <RenewalResolutionDialog
          key={`${resolutionTarget.contract.id}:${resolutionTarget.initialChoice}`}
          target={resolutionTarget}
          onClose={() => setResolutionTarget(null)}
          onResolved={load}
          onRefresh={load}
        />
      )}

      <Dialog open={Boolean(intentTarget)} onOpenChange={open => !open && busy !== intentTarget?.id && setIntentTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Mensagem de intenção de renovação</DialogTitle></DialogHeader>
          {intentTarget && <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Edite o texto antes de abrir o WhatsApp. Confirme o envio apenas depois de mandar a mensagem.</p>
            <textarea className="w-full min-h-[250px] rounded-md border p-3 text-sm" value={intentText}
              onChange={event => setIntentText(event.target.value)} disabled={busy === intentTarget.id} />
            <div className="flex flex-wrap gap-2 justify-end">
              <Button variant="outline" disabled={busy === intentTarget.id} onClick={() => setIntentTarget(null)}>Cancelar</Button>
              {customers[intentTarget.customer_id]?.whatsapp?.replace(/\D/g, '') ?
                <Button variant="outline" asChild><a target="_blank" rel="noopener noreferrer"
                  href={`https://wa.me/${customers[intentTarget.customer_id].whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(intentText)}`}
                  onClick={() => setIntentOpened(true)}>Abrir WhatsApp</a></Button> :
                <Button variant="outline" onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(intentText);
                    setIntentOpened(true);
                    toast.info('Mensagem copiada. Envie pelo canal de atendimento.');
                  } catch {
                    toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
                  }
                }}>Copiar mensagem</Button>}
              <Button disabled={!intentOpened || busy === intentTarget.id} onClick={async () => {
                const ok = await runBoardAction(intentTarget, 'message_sent');
                if (ok) setIntentTarget(null);
              }}>{busy === intentTarget.id ? 'Salvando...' : 'Confirmo que enviei'}</Button>
            </div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(responseTarget)} onOpenChange={open => !open && busy !== responseTarget?.id && setResponseTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Registrar resposta do atleta</DialogTitle></DialogHeader>
          {responseTarget && <div className="space-y-4">
            <div><Label>Resposta</Label><select className="mt-1 h-10 w-full rounded-md border bg-white px-3 text-sm"
              value={responseForm.code} onChange={event => setResponseForm(value => ({ ...value, code: event.target.value }))}>
              {Object.entries(RESPONSE_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select></div>
            {responseForm.code === 'thinking' && <div><Label>Próximo contato</Label>
              <Input type="date" value={responseForm.followUpAt}
                onChange={event => setResponseForm(value => ({ ...value, followUpAt: event.target.value }))} /></div>}
            {responseForm.code === 'change_plan_or_coach' &&
              <p className="rounded bg-violet-50 p-3 text-sm text-violet-900">O card ficará aguardando a alteração. Resolva o plano ou coach no contrato antes de avançar para cobrança.</p>}
            {responseForm.code === 'not_renewing' &&
              <p className="rounded bg-red-50 p-3 text-sm text-red-900">A saída seguirá pela resolução segura, com confirmação dos efeitos financeiros.</p>}
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setResponseTarget(null)}>Cancelar</Button>
              <Button disabled={busy === responseTarget.id} onClick={async () => {
                if (responseForm.code === 'not_renewing') {
                  openResolution(responseTarget, parents[responseTarget.parent_contract_id], 'customer_declined');
                  setResponseTarget(null);
                  return;
                }
                const ok = await runBoardAction(responseTarget, 'register_response', {
                  responseCode: responseForm.code,
                  followUpAt: responseForm.code === 'thinking' ? responseForm.followUpAt || null : null,
                });
                if (ok) setResponseTarget(null);
              }}>Registrar resposta</Button></div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(followUpTarget)} onOpenChange={open => !open && busy !== followUpTarget?.id && setFollowUpTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Agendar follow-up</DialogTitle></DialogHeader>
          {followUpTarget && <div className="space-y-4">
            <p className="text-sm text-muted-foreground">O card permanece em Aguardando decisão até a equipe registrar uma resposta.</p>
            <div><Label htmlFor="renewal-follow-up">Data do próximo contato</Label>
              <Input id="renewal-follow-up" className="mt-1" type="date" value={followUpDate}
                onChange={event => setFollowUpDate(event.target.value)} disabled={busy === followUpTarget.id} /></div>
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy === followUpTarget.id}
              onClick={() => setFollowUpTarget(null)}>Cancelar</Button>
              <Button disabled={!followUpDate || busy === followUpTarget.id} onClick={async () => {
                const ok = await runBoardAction(followUpTarget, 'set_follow_up', { followUpAt: followUpDate });
                if (ok) setFollowUpTarget(null);
              }}>Salvar follow-up</Button></div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(changeTarget)} onOpenChange={open => !open && busy !== changeTarget?.id && setChangeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Concluir alteração de plano ou coach</DialogTitle></DialogHeader>
          {changeTarget && <div className="space-y-4">
            <p className="text-sm text-gray-700">Confirme somente depois de salvar a alteração no contrato. A renovação irá para Enviar cobrança.</p>
            <Link to={`/assessoria/contratos/${changeTarget.id}?ajustar-plano=1`} className="text-sm text-blue-700 underline">
              Abrir ajuste no contrato
            </Link>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={changeConfirmed}
              onChange={event => setChangeConfirmed(event.target.checked)} />
              <span>A alteração solicitada pelo atleta já foi resolvida e salva.</span></label>
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy === changeTarget.id}
              onClick={() => setChangeTarget(null)}>Cancelar</Button>
              <Button disabled={!changeConfirmed || busy === changeTarget.id} onClick={async () => {
                const ok = await runBoardAction(changeTarget, 'change_resolved');
                if (ok) setChangeTarget(null);
              }}>Seguir para cobrança</Button></div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(subscriptionTarget)} onOpenChange={open => !open && busy !== subscriptionTarget?.id && setSubscriptionTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Link da assinatura automática</DialogTitle></DialogHeader>
          {subscriptionTarget && <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Cole o link da cobrança que a assinatura já criou. Esta ação não gera uma nova cobrança no Asaas.</p>
            <div><Label htmlFor="renewal-subscription-link">Link HTTPS da cobrança existente</Label>
              <Input id="renewal-subscription-link" className="mt-1" type="url" value={subscriptionLink}
                placeholder="https://..." onChange={event => setSubscriptionLink(event.target.value)}
                disabled={busy === subscriptionTarget.id} /></div>
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy === subscriptionTarget.id}
              onClick={() => setSubscriptionTarget(null)}>Cancelar</Button>
              <Button disabled={busy === subscriptionTarget.id || !/^https:\/\/[^\s]+$/i.test(subscriptionLink.trim())}
                onClick={async () => {
                  const ok = await runBoardAction(subscriptionTarget, 'register_subscription_link', {
                    subscriptionLink: subscriptionLink.trim(),
                  });
                  if (ok) setSubscriptionTarget(null);
                }}>Salvar link existente</Button></div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedCard)} onOpenChange={open => !open && setSelectedCard(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Histórico da renovação {selectedBoardCard?.contract_number}</DialogTitle></DialogHeader>
          {selectedBoardCard && <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <p className="font-semibold">{customers[selectedBoardCard.customer_id]?.full_name || 'Atleta'}</p>
              <p>Etapa: {BOARD_STAGES.find(stage => stage.id === selectedBoardCard.renewal_stage)?.label || 'Sem etapa'}</p>
              <p>Contrato anterior: {parents[selectedBoardCard.parent_contract_id]?.contract_number || '—'}</p>
              <p>Resposta: {RESPONSE_LABELS[selectedBoardCard.renewal_response_code] || 'Ainda não registrada'}</p>
            </div>
            <div><h4 className="font-semibold text-sm mb-2">Linha do tempo</h4>
              {timelineLoading ? <p className="text-sm text-muted-foreground">Carregando eventos...</p> :
                timeline.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum evento encontrado.</p> :
                <ol className="space-y-2 border-l pl-4 text-sm">{timeline.map(event =>
                  <li key={event.id} className="relative before:absolute before:-left-[21px] before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-blue-500">
                    <p className="font-medium">{renewalEventLabel(event)}</p>
                    <p className="text-xs text-muted-foreground">{new Date(event.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {event.contract_id === selectedBoardCard.id ? 'Renovação' : 'Contrato anterior'}</p>
                  </li>)}</ol>}
            </div>
            <Link className="text-sm text-blue-700 underline" to={`/assessoria/contratos/${selectedBoardCard.id}`}>Abrir contrato</Link>
          </div>}
        </DialogContent>
      </Dialog>

      <ExternalChargeDialog
        open={Boolean(externalChargeModal)}
        onCancel={() => setExternalChargeModal(null)}
        hasCharge={Boolean(externalChargeModal?.external_payment_link)}
        form={externalChargeForm}
        setForm={setExternalChargeForm}
        saving={charging}
        onSave={saveExternalScheduledCharge}
      />

      {/* Modal: gerar cobrança Asaas da renovação */}
      <Dialog open={!!chargeModal} onOpenChange={open => !open && !charging && setChargeModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blue-700">
              <Zap className="w-5 h-5" /> Gerar cobrança via Asaas
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

              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                A cobrança fica registrada. Envie a mensagem quando estiver pronto.
              </div>

              <div className="flex gap-2 pt-1">
                <Button type="button" variant="outline" className="flex-1" disabled={charging} onClick={() => setChargeModal(null)}>
                  Cancelar
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={charging || !chargeForm.due_date || !chargeModalCustomer?.cpf}
                  onClick={generateScheduledCharge}
                >
                  {charging ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Zap className="w-4 h-4 mr-1.5" />}
                  {charging ? 'Salvando...' : 'Gerar cobrança'}
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full text-amber-700 border-amber-300 hover:bg-amber-50"
                disabled={charging}
                onClick={() => {
                  const contract = chargeModal;
                  setChargeModal(null);
                  if (contract) openExternalChargeModal(contract, chargeForm.due_date);
                }}
              >
                <Link2 className="w-4 h-4 mr-1.5" /> Cadastrar cobrança externa
              </Button>
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
              Contratos manuais geram rascunhos para revisão. Contratos com renovação
              automática são agendados 5 dias antes, sem acessar o Asaas.
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
                Com <b>{scanWindowDays} dia{scanWindowDays === 1 ? '' : 's'}</b>, serão considerados contratos que vencem até <b>{formatDate(scanWindowEnd)}</b>, inclusive os já vencidos e ainda pendentes.
              </p>
              <p className="text-blue-700">
                Renovações existentes não são duplicadas.
              </p>
            </div>

            {scanResult && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-1">
                <p><b>Alterações processadas:</b> {scanResult.processed}</p>
                <p className="text-green-700"><b>Rascunhos criados:</b> {scanResult.drafts_created}</p>
                <p className="text-green-700"><b>Automáticas agendadas:</b> {scanResult.automatic_renewals_scheduled || 0}</p>
                <p className="text-green-700"><b>Renovações iniciadas:</b> {(scanResult.automatic_renewals_activated || 0) + (scanResult.scheduled_renewals_activated || 0)}</p>
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
