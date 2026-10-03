import ManualInstallmentsEditor from '@/components/ManualInstallmentsEditor';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { studentProfilePath } from '@/lib/customer-profile';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, User, UserCheck, FileText, Calendar, Zap, MessageCircle, Copy, Check, ExternalLink,
  Link2, QrCode, RefreshCw, History, Pause, XCircle, RotateCcw,
  HandCoins, Activity, Plus, PenLine, Banknote, RefreshCcw, Ban, Clock, TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  AssessmentContract, PreSaleCustomer, AssessmentCoach, AssessmentPlan, AssessmentModality,
  AssessmentLeave, AssessmentContractCoachHist, AssessmentContractEvent,
  AssessmentContractPlanChange, AssessmentContractPlanHistory, AssessmentPlanTransitionRead,
} from '@/api/entities';
import { supabase } from '@/api/db';
import {
  cancelAssessmentContract,
  scheduleAssessmentContractCancellation,
  unscheduleAssessmentContractCancellation,
  cancelOrderCharge,
  cancelAssessmentContractCoachChange,
  changeAssessmentContractCoach,
  changeAssessmentContractPlan,
  createAssessmentContractRenewal,
  finishAssessmentContractLeave,
  listCommunicationCases,
  removeAssessmentContractExternalCharge,
  setAssessmentContractAutoRenewal,
  startAssessmentContractLeave,
  updateAssessmentContractDates,
  updateAssessmentContractDiscount,
  voidAssessmentContractSale,
} from '@/api/client';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { DEFAULT_ASAAS_DUE_DAYS, defaultAsaasDueDate } from '@/lib/payment-methods';
import { suggestedAssessmentChargeDueDate } from '@/lib/assessment-renewal-billing';
import { externalChargeMethodLabel, normalizeExternalChargeMethod } from '@/lib/external-charge';
import {
  generateAssessmentContractCharge,
  markAssessmentContractNonRenewal,
  registerExternalAssessmentContractCharge,
} from '@/lib/assessment-contract-operations';
import { loadActivePaymentMethods, createManualInstallments, adjustManualInstallmentsValue, getPaymentMethodLabel, reopenManualPayment } from '@/lib/manual-payment';
import { getContractKindLabel, isRenewalContract } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { isOpenPlanChangeCharge, planChangeUnusedValue } from '@/lib/assessment-plan-change';
import { refundMethodLabel } from '@/lib/contract-refund';
import { coachHistorySegments, pendingCoachChange } from '@/lib/assessment-coach-history';
import { allowsAutoRenewal, AUTO_RENEWAL_MONTHLY_ONLY_MESSAGE } from '@/lib/assessment-renewal-pipeline';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import ConfirmDialog from '@/components/ConfirmDialog';
import DiscountInput from '@/components/DiscountInput';
import ExternalChargeDialog from '@/components/billing/ExternalChargeDialog';
import ExternalChargeSummary from '@/components/billing/ExternalChargeSummary';
import PlanChangesCard from '@/components/assessment/PlanChangesCard';

function addPeriod(startStr, plan) {
  const d = new Date(startStr + 'T12:00:00');
  const months = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  const originalDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(originalDay, lastDay));
  return toLocalDateStr(d);
}

function periodLabel(plan) {
  const m = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  const names = { 1: '1 mês', 2: '2 meses', 3: '3 meses', 6: '6 meses', 12: '12 meses' };
  return names[m] || `${m} meses`;
}

function getPlanMonths(plan) {
  return plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
}

import { toast } from 'sonner';

const STATUS = {
  draft:     { label: 'Prospect',  badge: 'secondary' },
  scheduled: { label: 'Agendado',  badge: 'info' },
  active:    { label: 'Ativo',     badge: 'success' },
  overdue:   { label: 'Atrasado',  badge: 'destructive' },
  on_leave:  { label: 'Em licença',badge: 'warning' },
  finished:  { label: 'Concluído', badge: 'secondary' },
  cancelled: { label: 'Cancelado', badge: 'destructive' },
  voided:    { label: 'Descartado', badge: 'warning' },
};

const PAY = {
  pending:            { label: 'Aguardando',   badge: 'secondary' },
  awaiting_charge:    { label: 'Pedido recebido', badge: 'secondary' },
  charge_sent:        { label: 'Cobrança enviada', badge: 'warning' },
  paid:               { label: 'Pago',         badge: 'success' },
  overdue:            { label: 'Vencido',      badge: 'destructive' },
  partially_paid:     { label: 'Pago parcial', badge: 'warning' },
  refunded:           { label: 'Estornado',    badge: 'outline' },
  partially_refunded: { label: 'Est. parcial', badge: 'warning' },
};

const ADJUSTABLE_PAYMENT_STATUSES = new Set(['pending', 'awaiting_charge', 'charge_sent', 'overdue']);

function isNonRenewalReason(reason) {
  const text = String(reason || '').toLowerCase();
  return text.includes('não renovou') || text.includes('nao renovou')
    || text.includes('não vai renovar') || text.includes('nao vai renovar');
}

function leavePeriodLabel(leave) {
  if (!leave) return '';
  if (!leave.end_date) return `${formatDate(leave.start_date)} → sem data definida`;
  return `${formatDate(leave.start_date)} → ${formatDate(leave.end_date)} (${leave.days} dia${leave.days !== 1 ? 's' : ''})`;
}

// ─── Timeline de eventos ─────────────────────────────────────────────────────
const EVENT_META = {
  created:                  { icon: Plus,       color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Contrato criado' },
  coach_changed:            { icon: UserCheck,  color: 'text-purple-600', bg: 'bg-purple-50', label: 'Coach trocado' },
  coach_change_scheduled:   { icon: Clock,      color: 'text-purple-600', bg: 'bg-purple-50', label: 'Troca de coach agendada' },
  coach_change_cancelled:   { icon: XCircle,    color: 'text-gray-600',   bg: 'bg-gray-100',  label: 'Troca de coach cancelada' },
  plan_changed:             { icon: PenLine,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Plano alterado' },
  discount_applied:         { icon: HandCoins,  color: 'text-green-600',  bg: 'bg-green-50',  label: 'Desconto aplicado' },
  leave_started:            { icon: Pause,      color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Licença iniciada' },
  leave_ended:              { icon: RotateCcw,  color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Licença encerrada' },
  charge_generated:         { icon: Zap,        color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Cobrança gerada' },
  external_charge_registered: { icon: Link2,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Cobrança externa registrada' },
  external_charge_updated:    { icon: Link2,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Cobrança externa alterada' },
  external_charge_removed:    { icon: Link2,    color: 'text-gray-500',   bg: 'bg-gray-100',  label: 'Cobrança externa removida' },
  payment_message_sent:       { icon: MessageCircle, color: 'text-green-600', bg: 'bg-green-50', label: 'Mensagem de cobrança enviada' },
  manual_payment_installments_edited: { icon: Banknote, color: 'text-blue-700', bg: 'bg-blue-50', label: 'Parcelas editadas' },
  manual_payment_recorded:  { icon: Banknote,   color: 'text-green-700',  bg: 'bg-green-50',  label: 'Pagamento manual' },
  renewed:                  { icon: RefreshCcw, color: 'text-green-600',  bg: 'bg-green-50',  label: 'Renovado' },
  sale_voided:              { icon: XCircle,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Venda descartada' },
  sale_replaced:            { icon: RotateCcw,  color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Venda substituída' },
  cancelled:                { icon: Ban,        color: 'text-red-600',    bg: 'bg-red-50',    label: 'Cancelado' },
  refund_completed:         { icon: HandCoins,  color: 'text-purple-600', bg: 'bg-purple-50', label: 'Estorno realizado' },
  refund_reopened:          { icon: RotateCcw,  color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Registro do estorno desfeito' },
  dates_changed:            { icon: Calendar,   color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Datas alteradas' },
  enrollment_activated:     { icon: Check,      color: 'text-green-600',  bg: 'bg-green-50',  label: 'Adesão confirmada' },
  renewal_activated:        { icon: Check,      color: 'text-green-600',  bg: 'bg-green-50',  label: 'Renovação ativada' },
  renewal_scheduled:        { icon: Clock,      color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Renovação agendada' },
  renewal_declined:         { icon: Ban,        color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Não renovou' },
  auto_renewal_changed:     { icon: RotateCcw,  color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Auto-renovação alterada' },
  charge_cancelled:         { icon: XCircle,    color: 'text-red-500',    bg: 'bg-red-50',    label: 'Cobrança cancelada' },
  cancellation_scheduled:       { icon: Clock,  color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Cancelamento agendado' },
  cancellation_schedule_removed:{ icon: RotateCcw, color: 'text-gray-600', bg: 'bg-gray-50',  label: 'Agendamento desfeito' },
  plan_change_created:          { icon: TrendingUp, color: 'text-indigo-600', bg: 'bg-indigo-50', label: 'Mudança de plano registrada' },
  plan_change_applied:          { icon: Check,      color: 'text-indigo-600', bg: 'bg-indigo-50', label: 'Mudança de plano aplicada' },
  plan_change_updated:          { icon: PenLine,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Mudança de plano corrigida' },
  plan_change_cancelled:        { icon: XCircle,    color: 'text-gray-600',   bg: 'bg-gray-100',  label: 'Mudança de plano cancelada' },
  plan_change_charge_registered:{ icon: Link2,      color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Cobrança da diferença registrada' },
  plan_change_charge_updated:   { icon: Link2,      color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Cobrança da diferença alterada' },
  plan_change_payment_recorded: { icon: Banknote,   color: 'text-green-700',  bg: 'bg-green-50',  label: 'Diferença paga' },
  plan_change_payment_reverted: { icon: RotateCcw,  color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Pagamento da diferença desfeito' },
};

// Eventos cujo texto de observação é gerado pelo sistema e repete o rótulo.
const EVENTS_WITH_SYSTEM_NOTES = new Set(['leave_started', 'plan_change_applied', 'plan_change_payment_reverted']);

function formatEventSummary(ev) {
  const p = ev.payload || {};
  switch (ev.event_type) {
    case 'created':
      return p.via === 'renewal'
        ? `Criado como renovação de ${p.parent_contract_num || '—'}`
        : (p.prior_cancelled > 0 ? `Aluno já cancelou ${p.prior_cancelled}x antes` : 'Contrato inicial');
    case 'coach_changed':
    case 'coach_change_scheduled':
      return `${p.from_coach_name || '—'} → ${p.to_coach_name || '—'}`
        + (p.effective_date ? ` · a partir de ${formatDate(p.effective_date)}` : '');
    case 'coach_change_cancelled':
      return `${p.coach_name || '—'} começaria em ${formatDate(p.effective_date)}`;
    case 'leave_started':
      return `${p.open_ended || p.days == null ? 'Sem data definida' : `${p.days} dia${p.days !== 1 ? 's' : ''}`}${p.reason ? ' · ' + p.reason : ''}`;
    case 'leave_ended':
      return `Após ${p.days || '?'} dia(s)`;
    case 'charge_generated':
      return `${p.billing_type || ''}${p.installments > 1 ? ` · ${p.installments}x` : ''}`;
    case 'external_charge_updated':
      return `${p.from_method_label || '—'} → ${p.to_method_label || '—'}${p.due_date ? ' · venc. ' + formatDate(p.due_date) : ''}`;
    case 'manual_payment_recorded':
      return `${p.method || ''}${p.value ? ' · R$ ' + Number(p.value).toFixed(2) : ''}`;
    case 'external_charge_registered':
      return p.due_date ? `Vence em ${formatDate(p.due_date)}` : 'Link externo salvo';
    case 'external_charge_removed':
      return 'Link externo removido';
    case 'payment_message_sent':
      return p.via === 'whatsapp' ? 'Enviada via WhatsApp' : 'Confirmada como enviada';
    case 'renewed':
      return `Novo contrato ${p.new_contract_number || ''}`;
    case 'sale_voided':
      return 'Cliente não pagou; registro fora das métricas';
    case 'sale_replaced':
      return `Novo contrato ${p.new_contract_number || ''}`;
    case 'cancelled':
      return `${p.source === 'scheduled' ? 'Agendado · ' : ''}${p.cancellation_date ? `Último dia ${formatDate(p.cancellation_date)} · ` : ''}Multa R$ ${Number(p.cancellation_fee || 0).toFixed(2)} · Estorno R$ ${Number(p.refund_amount || 0).toFixed(2)}`
        + (Number(p.upgrade_unused_value) > 0 ? ` · inclui ${formatCurrency(p.upgrade_unused_value)} de upgrade não usado` : '');
    case 'cancellation_scheduled':
      return `Sai em ${formatDate(p.scheduled_cancellation_date)}${Number(p.cancellation_fee_pct) > 0 ? ` · multa ${p.cancellation_fee_pct}%` : ' · sem multa'}`;
    case 'cancellation_schedule_removed':
      return `Estava agendado para ${formatDate(p.previous_scheduled_cancellation_date)}`;
    case 'dates_changed':
      return `${formatDate(p.old_start)} → ${formatDate(p.new_start)} · fim: ${formatDate(p.new_end)}`;
    case 'refund_completed':
      return [
        p.method ? refundMethodLabel(p.method) : null,
        p.refund_amount != null ? formatCurrency(p.refund_amount) : null,
        p.refund_date ? formatDate(p.refund_date) : null,
        Array.isArray(p.allocations) && p.allocations.length
          ? `${p.allocations.length} parcela${p.allocations.length > 1 ? 's' : ''}`
          : null,
      ].filter(Boolean).join(' · ');
    case 'refund_reopened':
      return `Volta para pendente: ${formatCurrency(p.refund_amount)}`;
    case 'plan_change_created':
      return `${p.from_plan?.name || '—'} → ${p.to_plan?.name || '—'} · a partir de ${formatDate(p.effective_date)} · `
        + (Number(p.amount) > 0 ? `diferença ${formatCurrency(p.amount)}` : 'sem cobrança');
    case 'plan_change_applied':
      return `Vale desde ${formatDate(p.effective_date)}`;
    case 'plan_change_updated':
      return `A partir de ${formatDate(p.before?.effective_date)} → ${formatDate(p.after?.effective_date)} · `
        + `${formatCurrency(p.before?.amount)} → ${formatCurrency(p.after?.amount)}`
        + (p.charge_reset ? ' · cobrança refeita' : '');
    case 'plan_change_cancelled':
      return (Number(p.amount) > 0 ? `Diferença de ${formatCurrency(p.amount)} não cobrada` : 'Troca desfeita')
        + (p.source === 'contract_cancellation' ? ' · junto com o contrato' : '');
    case 'plan_change_charge_registered':
      return `${externalChargeMethodLabel(p.payment_method)} · ${formatCurrency(p.amount)}${p.due_date ? ' · vence ' + formatDate(p.due_date) : ''}`;
    case 'plan_change_charge_updated':
      return `${externalChargeMethodLabel(p.previous_payment_method)} → ${externalChargeMethodLabel(p.payment_method)}${p.due_date ? ' · vence ' + formatDate(p.due_date) : ''}`;
    case 'plan_change_payment_recorded':
      return `${p.method_name || p.method || ''} · ${formatCurrency(p.value)}${Number(p.installments) > 1 ? ` · ${p.installments}x` : ''}`;
    case 'plan_change_payment_reverted':
      return p.payment_status_after === 'charge_sent'
        ? 'Cobrança da diferença volta a ficar em aberto'
        : 'Diferença volta a aguardar cobrança';
    default:
      return ev.notes || '';
  }
}

function ContractTimeline({ events }) {
  if (!events?.length) {
    return (
      <p className="text-sm text-muted-foreground text-center py-3">
        Nenhum evento registrado ainda.
      </p>
    );
  }
  return (
    <ol className="relative border-l-2 border-gray-200 ml-3 space-y-3">
      {events.map(ev => {
        const meta = EVENT_META[ev.event_type] || {
          icon: Activity, color: 'text-gray-500', bg: 'bg-gray-100', label: ev.event_type,
        };
        const Icon = meta.icon;
        const summary = formatEventSummary(ev);
        const date = ev.created_at ? new Date(ev.created_at) : null;
        return (
          <li key={ev.id} className="pl-5 relative">
            <span className={`absolute -left-[14px] top-0 w-6 h-6 rounded-full ${meta.bg} flex items-center justify-center ring-2 ring-white`}>
              <Icon className={`w-3.5 h-3.5 ${meta.color}`} />
            </span>
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-semibold text-sm">{meta.label}</p>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                {date ? date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
              </span>
            </div>
            {summary && <p className="text-xs text-muted-foreground mt-0.5">{summary}</p>}
            {ev.notes && !EVENTS_WITH_SYSTEM_NOTES.has(ev.event_type) && (
              <p className="text-xs text-gray-700 italic mt-0.5">"{ev.notes}"</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function ContractDetail() {
  // Contract detail page — handles assessment contracts with full event timeline
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [contract, setContract] = useState(null);
  const [student, setStudent]   = useState(null);
  const [coach, setCoach]       = useState(null);
  const [plan, setPlan]         = useState(null);
  const [modality, setModality] = useState(null);
  // Parcelas projetadas (asaas_payments) — detalhamento do pagamento
  const [paymentInstallments, setPaymentInstallments] = useState([]);
  const [coaches, setCoaches]   = useState([]);
  const [plans, setPlans]       = useState([]);
  const [modalities, setModalities] = useState([]);
  const [history, setHistory]   = useState([]);
  const [leaves, setLeaves]     = useState([]);
  const [events, setEvents]     = useState([]);
  const [parentContract, setParentContract] = useState(null);
  // Mudança de plano no meio do ciclo: pedidos, trechos de plano e a matriz.
  // allPlans/allCoaches incluem inativos, para nomes em históricos.
  const [planChanges, setPlanChanges] = useState([]);
  const [planHistory, setPlanHistory] = useState([]);
  const [planTransitions, setPlanTransitions] = useState([]);
  const [allPlans, setAllPlans] = useState([]);
  const [allCoaches, setAllCoaches] = useState([]);
  const [loading, setLoading]   = useState(true);

  // Modais
  const [changeCoachModal, setChangeCoachModal] = useState(false);
  const [newCoachId, setNewCoachId] = useState('');
  const [newCoachDate, setNewCoachDate] = useState(todayLocalStr());
  const [coachSaving, setCoachSaving] = useState(false);
  const [cancelCoachChangeModal, setCancelCoachChangeModal] = useState(false);
  const [noRenewalModal, setNoRenewalModal] = useState(false);
  const [noRenewalSaving, setNoRenewalSaving] = useState(false);
  const [leaveModal, setLeaveModal] = useState(false);
  const [leaveForm, setLeaveForm] = useState({ start_date: todayLocalStr(), end_date: todayLocalStr(), open_ended: false, reason: '' });
  const [cancelModal, setCancelModal]   = useState(false);
  const [voidModal, setVoidModal]       = useState(false);
  const [voiding, setVoiding]           = useState(false);
  const [adjustPlanModal, setAdjustPlanModal] = useState(false);
  const [adjustPlanSaving, setAdjustPlanSaving] = useState(false);
  const [adjustPlanForm, setAdjustPlanForm] = useState({
    plan_id: '',
    start_date: '',
    installments: 1,
    enrollment_fee: 0,
    manual_discount: 0,
    discount_reason: '',
  });
  const [reopenModal, setReopenModal]   = useState(false);
  const [reopenLoading, setReopenLoading] = useState(false);
  const [cancelDate, setCancelDate] = useState(todayLocalStr());  // Retroativa cancela na hora; futura agenda
  const [cancelFeePct, setCancelFeePct] = useState(20);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSaving, setCancelSaving] = useState(false);
  const [cancelInstData, setCancelInstData]         = useState(null);  // parcelas Asaas
  const [loadingCancelInst, setLoadingCancelInst]   = useState(false);
  const [chargeLoading, setChargeLoading] = useState(false);
  const [chargeConfirmModal, setChargeConfirmModal] = useState(null); // null | 'PIX' | 'BOLETO' | 'CREDIT_CARD'
  const [chargeDueDate, setChargeDueDate] = useState(defaultAsaasDueDate);
  const [renewModal, setRenewModal]         = useState(false);
  const [renewLoading, setRenewLoading]     = useState(false);
  const [manualPayModal, setManualPayModal] = useState(false);
  const [manualPayForm, setManualPayForm]   = useState({ method_id: '', date: '', value: '' });
  const [manualPaySaving, setManualPaySaving] = useState(false);
  // Cobrança externa (link gerado fora da plataforma)
  const [externalSaleModal, setExternalSaleModal] = useState(false);
  const [externalSaleForm, setExternalSaleForm]   = useState({ link: '', due_date: '', payment_method: 'pix', invoice_number: '' });
  const [externalSaleSaving, setExternalSaleSaving] = useState(false);
  // WhatsApp — preview e envio
  const [communicationCaseId, setCommunicationCaseId] = useState(null);
  const [communicationOpening, setCommunicationOpening] = useState(false);
  const [methodGroups, setMethodGroups]     = useState([]);
  // Edição de datas
  const [dateModal, setDateModal]     = useState(false);
  const [dateForm, setDateForm]       = useState({ start_date: '', end_date: '' });
  const [dateSaving, setDateSaving]   = useState(false);
  // Cancelar cobrança Asaas
  const [cancelChargeModal, setCancelChargeModal] = useState(false);
  const [cancelChargeLoading, setCancelChargeLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const loadPlanChanges = () => AssessmentContractPlanChange
        .filter({ contract_id: id }, 'effective_date')
        .catch(() => []);
      let [c, changeRows] = await Promise.all([AssessmentContract.get(id), loadPlanChanges()]);
      // Mudança agendada cuja data já chegou: aplica antes de mostrar o contrato.
      if (['scheduled', 'active', 'overdue', 'on_leave'].includes(c.status)
        && changeRows.some(row => row.status === 'scheduled' && row.effective_date <= todayLocalStr())) {
        await applyAssessmentContractTransitions();
        [c, changeRows] = await Promise.all([AssessmentContract.get(id), loadPlanChanges()]);
      }
      setContract(c);
      setPlanChanges(changeRows);
      const [s, co, p, coachRows, h, l, ev, planRows, allModalities, planHistoryRows, transitionRows] = await Promise.all([
        PreSaleCustomer.get(c.customer_id).catch(() => null),
        c.coach_id ? AssessmentCoach.get(c.coach_id).catch(() => null) : Promise.resolve(null),
        AssessmentPlan.get(c.plan_id).catch(() => null),
        AssessmentCoach.list('name').catch(() => []),
        AssessmentContractCoachHist.filter({ contract_id: id }).catch(() => []),
        AssessmentLeave.filter({ contract_id: id }, '-start_date').catch(() => []),
        AssessmentContractEvent.filter({ contract_id: id }, '-created_at').catch(() => []),
        AssessmentPlan.list().catch(() => []),
        AssessmentModality.filter({ active: true }).catch(() => []),
        AssessmentContractPlanHistory.filter({ contract_id: id }, 'valid_from').catch(() => []),
        AssessmentPlanTransitionRead.list('from_plan_id').catch(() => []),
      ]);
      setStudent(s); setCoach(co); setPlan(p);
      setAllCoaches(coachRows || []);
      setCoaches((coachRows || []).filter(row => row.active === true));
      setAllPlans(planRows || []);
      setPlans((planRows || []).filter(row => row.active === true));
      setModalities(allModalities || []);
      setHistory(h.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || '')
        || (a.created_at || '').localeCompare(b.created_at || '')));
      setLeaves(l);
      setEvents(ev);
      setPlanHistory(planHistoryRows || []);
      setPlanTransitions(transitionRows || []);
      if (p) {
        const mod = await AssessmentModality.get(p.modality_id).catch(() => null);
        setModality(mod);
      }
      // Contrato pai (se for uma renovação)
      if (c.parent_contract_id) {
        const parent = await AssessmentContract.get(c.parent_contract_id).catch(() => null);
        setParentContract(parent);
      } else {
        setParentContract(null);
      }
      // Parcelas projetadas para detalhamento do pagamento
      supabase.from('asaas_payments')
        .select('*')
        .eq('order_id', id)
        .eq('order_type', 'contract')
        .order('installment_number', { ascending: true })
        .then(({ data }) => setPaymentInstallments(data || []))
        .catch(() => setPaymentInstallments([]));
    } catch (e) {
      console.error('Erro ao carregar contrato:', e);
      toast.error('Erro ao carregar contrato: ' + (e.message || 'desconhecido'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Lê valor do plano: prefere o snapshot gravado no contrato (histórico preservado),
  // cai pro plano vivo se snapshot ausente (contratos legados pré-backfill).
  const planVal = (field) => {
    const snap = contract?.plan_snapshot;
    if (snap && snap[field] != null) return snap[field];
    return plan?.[field];
  };

  // Edição de datas
  const openDateModal = () => {
    setDateForm({ start_date: contract.start_date || '', end_date: contract.end_date || '' });
    setDateModal(true);
  };

  const onDateStartChange = (val) => {
    const newEnd = val && plan ? addPeriod(val, plan) : dateForm.end_date;
    setDateForm(f => ({ ...f, start_date: val, end_date: newEnd }));
  };

  const saveDates = async () => {
    if (!dateForm.start_date || !dateForm.end_date) return toast.error('Preencha ambas as datas');
    if (dateForm.end_date <= dateForm.start_date) return toast.error('Data final deve ser após a inicial');
    setDateSaving(true);
    try {
      await updateAssessmentContractDates(id, {
        startDate: dateForm.start_date,
        endDate: dateForm.end_date,
        expectedUpdatedAt: contract.updated_at,
      });
      toast.success('Datas atualizadas');
      setDateModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar datas');
    } finally {
      setDateSaving(false);
    }
  };

  const cancelAsaasCharge = async () => {
    setCancelChargeLoading(true);
    try {
      await cancelOrderCharge(
        'contract',
        id,
        'Cobrança cancelada para ajuste do contrato',
      );
      toast.success('Cobrança cancelada. Aplique o desconto e gere uma nova cobrança.');
      setCancelChargeModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao cancelar cobrança');
    } finally {
      setCancelChargeLoading(false);
    }
  };

  // ───────── ACTIONS ─────────
  // Abre modal de confirmação (não chama Asaas ainda)
  const openChargeConfirm = (billing_type = 'PIX') => {
    if (!student?.cpf) return toast.error('Cadastre o CPF do aluno antes de gerar cobrança');
    setChargeDueDate(suggestedAssessmentChargeDueDate(contract));
    setChargeConfirmModal(billing_type);
  };

  const generateCharge = async (billing_type = 'PIX') => {
    if (!student?.cpf) return toast.error('Cadastre o CPF do aluno antes de gerar cobrança');
    setChargeLoading(true);
    try {
      await generateAssessmentContractCharge({
        contract,
        customer: student,
        billingType: billing_type,
        dueDate: chargeDueDate,
        source: 'contract_detail',
      });
      toast.success('Cobrança gerada!');
      setChargeConfirmModal(null);
      load();
    } catch (e) { toast.error(e.message || 'Erro ao gerar cobrança'); }
    finally { setChargeLoading(false); }
  };

  const changeCoach = async () => {
    if (!newCoachId || newCoachId === contract.coach_id) return setChangeCoachModal(false);
    if (!newCoachDate) return toast.error('Informe a data em que o novo coach começa');
    setCoachSaving(true);
    try {
      const result = await changeAssessmentContractCoach(id, {
        coachId: newCoachId,
        effectiveDate: newCoachDate,
        expectedUpdatedAt: contract.updated_at,
      });
      toast.success(result?.applies_now === false
        ? `Troca agendada: o novo coach começa em ${formatDate(newCoachDate)}`
        : 'Coach trocado!');
      if (result?.regenerate_competence) {
        toast.warning(`O fechamento de ${formatDate(result.regenerate_competence).slice(3)} precisa ser gerado de novo.`);
      }
      setChangeCoachModal(false); load();
    } catch (e) { toast.error(e.message); }
    finally { setCoachSaving(false); }
  };

  const cancelScheduledCoachChange = async () => {
    setCoachSaving(true);
    try {
      await cancelAssessmentContractCoachChange(id, { expectedUpdatedAt: contract.updated_at });
      toast.success('Troca de coach cancelada');
      setCancelCoachChangeModal(false);
      load();
    } catch (e) { toast.error(e.message); }
    finally { setCoachSaving(false); }
  };

  const addLeave = async () => {
    if (!leaveForm.start_date) return toast.error('Data de início obrigatória');
    if (!leaveForm.open_ended && !leaveForm.end_date) return toast.error('Informe o fim ou marque “Sem data definida”');
    if (!leaveForm.open_ended && leaveForm.end_date < leaveForm.start_date) return toast.error('Fim antes do início');
    if (contract.status === 'on_leave') return toast.error('Contrato já está em licença');
    try {
      const result = await startAssessmentContractLeave(id, {
        startDate: leaveForm.start_date,
        endDate: leaveForm.open_ended ? null : leaveForm.end_date,
        reason: leaveForm.reason || null,
        expectedUpdatedAt: contract.updated_at,
      });
      const days = result.leave.days;
      const newEndStr = result.contract.end_date;
      toast.success(leaveForm.open_ended
        ? 'Licença iniciada sem data definida. O vencimento será ajustado quando ela for encerrada.'
        : `Licença registrada (${days} dias). Novo vencimento: ${formatDate(newEndStr)}.`);
      setLeaveModal(false);
      setLeaveForm({ start_date: todayLocalStr(), end_date: todayLocalStr(), open_ended: false, reason: '' });
      load();
    } catch (e) { toast.error(e.message); }
  };

  const finishLeave = async (leave) => {
    const message = leave.end_date
      ? `Encerrar licença de ${leave.days} dias? O aluno retorna ao plano.`
      : 'Encerrar esta licença sem data definida hoje? O vencimento será prorrogado pelos dias efetivamente transcorridos.';
    if (!confirm(message)) return;
    try {
      const result = await finishAssessmentContractLeave(
        id,
        leave.id,
        contract.updated_at,
      );
      const newStatus = result.contract.status;
      toast.success(`Licença encerrada. Aluno ${newStatus === 'active' ? 'retornou ao plano ativo' : 'com contrato vencido'}.`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  // Calcula valor restante proporcional aos dias não usufruídos
  // Usa cancelDate (data de cancelamento, pode ser retroativa) ou today como data de corte.
  // Mesma conta do banco: venda original + parte não usada dos upgrades pagos,
  // arredonda o restante e calcula a multa sobre ele.
  const cancellationCalc = (cancelDateStr = null) => {
    const empty = { remainingDays: 0, saleRemaining: 0, upgradeRemaining: 0, remaining: 0, fee: 0, refund: 0 };
    if (!contract || !plan) return empty;
    const cutoffDate = cancelDateStr ? new Date(cancelDateStr + 'T00:00:00') : new Date();
    cutoffDate.setHours(0, 0, 0, 0);
    const start = new Date(contract.start_date + 'T00:00:00');
    const end   = new Date(contract.end_date + 'T00:00:00');
    if (cutoffDate >= end) return empty;
    const round2 = value => Math.round(value * 100) / 100;
    const totalDays   = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const remainingDays = Math.max(0, Math.round((end - cutoffDate) / 86400000) + 1);
    const saleRemaining = Number(planVal('price_total') || 0) * (remainingDays / totalDays);
    const upgradeRemaining = planChangeUnusedValue(planChanges, contract, toLocalDateStr(cutoffDate));
    const remaining = round2(saleRemaining + upgradeRemaining);
    const fee = round2(remaining * (Number(cancelFeePct) / 100));
    const refund = Math.max(0, round2(remaining - fee));
    return {
      remainingDays,
      saleRemaining: round2(saleRemaining),
      upgradeRemaining: round2(upgradeRemaining),
      remaining,
      fee,
      refund,
    };
  };

  // Abre modal de cancelamento e já busca parcelas do Asaas
  const openCancelModal = async () => {
    setCancelModal(true);
    setCancelInstData(null);
    // Já existe agendamento? Abre com a data e a multa combinadas, para
    // reagendar ser o caminho natural em vez de recomeçar do zero.
    if (contract?.scheduled_cancellation_date) {
      setCancelDate(contract.scheduled_cancellation_date);
      setCancelFeePct(Number(contract.scheduled_cancellation_fee_pct) || 0);
      setCancelReason(contract.scheduled_cancellation_reason || '');
    }
    if (contract?.asaas_charge_id) {
      setLoadingCancelInst(true);
      try {
        const { data, error } = await supabase.functions.invoke('fetch-contract-installments', {
          body: { contract_id: id },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        setCancelInstData(data);
      } catch (e) {
        console.error('[fetch-contract-installments]', e);
        setCancelInstData({ installments: [], asaasError: true });
      } finally {
        setLoadingCancelInst(false);
      }
    }
  };

  const cancelContract = async () => {
    if (contract?.end_date && cancelDate >= contract.end_date) {
      return toast.error('Para fim de vigência sem renovação, use "Não renovar".');
    }
    const c = cancellationCalc(cancelDate);
    const scheduling = cancelDate > todayLocalStr();
    const isRetroactive = cancelDate < todayLocalStr();
    const retroactiveNote = isRetroactive ? ` (retroativo de ${formatDate(cancelDate)})` : '';
    const question = scheduling
      ? `Agendar o cancelamento para ${formatDate(cancelDate)}? O aluno segue ativo até lá. Na data: multa de ${formatCurrency(c.fee)} (${cancelFeePct}%) e estorno de ${formatCurrency(c.refund)}.`
      : `Cancelar contrato com multa de ${formatCurrency(c.fee)} (${cancelFeePct}%)? Estorno: ${formatCurrency(c.refund)}.${retroactiveNote}`;
    if (!confirm(question)) return;
    setCancelSaving(true);
    try {
      const payload = {
        cancellationDate: cancelDate,
        cancellationFeePct: Number(cancelFeePct),
        reason: cancelReason || null,
        expectedUpdatedAt: contract.updated_at,
      };
      if (scheduling) {
        await scheduleAssessmentContractCancellation(id, payload);
        toast.success(`Cancelamento agendado para ${formatDate(cancelDate)}.`);
      } else {
        const result = await cancelAssessmentContract(id, payload);
        toast.success(result.refund_amount > 0 ? 'Contrato cancelado. Estorno registrado como pendente.' : 'Contrato cancelado.');
      }
      setCancelModal(false);
      // Reset cancel form
      setCancelDate(todayLocalStr());
      setCancelReason('');
      load();
    } catch (e) { toast.error(e.message); }
    finally { setCancelSaving(false); }
  };

  const removeCancellationSchedule = async () => {
    if (!confirm('Desfazer o agendamento de cancelamento? O contrato volta a seguir normalmente.')) return;
    setCancelSaving(true);
    try {
      await unscheduleAssessmentContractCancellation(id, contract.updated_at);
      toast.success('Agendamento desfeito.');
      load();
    } catch (e) { toast.error(e.message); }
    finally { setCancelSaving(false); }
  };

  const markNoRenewal = async () => {
    if (!contract?.end_date) return toast.error('Contrato sem data final');

    const { data: openRenewals, error: renewalLookupError } = await supabase
      .from('assessment_contracts')
      .select('id, contract_number')
      .eq('parent_contract_id', contract.id)
      .in('status', ['draft', 'scheduled', 'active', 'overdue', 'on_leave'])
      .limit(1);
    if (renewalLookupError) {
      return toast.error('Não foi possível conferir as vendas de renovação');
    }
    if (openRenewals?.length) {
      toast.info(`Resolva primeiro a venda de renovação ${openRenewals[0].contract_number}`);
      navigate(`/assessoria/renovacoes?resolver=${openRenewals[0].id}`);
      return;
    }

    setNoRenewalModal(true);
  };

  const confirmNoRenewal = async () => {
    const shouldFinishNow = contract.end_date <= todayLocalStr();
    setNoRenewalSaving(true);
    try {
      await markAssessmentContractNonRenewal({
        contract,
      });

      toast.success(shouldFinishNow
        ? 'Contrato concluído por não renovação.'
        : 'Não renovação registrada. O contrato segue ativo até o fim da vigência.');
      setNoRenewalModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar não renovação');
    } finally {
      setNoRenewalSaving(false);
    }
  };

  // Descartar venda — para contratos NÃO pagos (pending/awaiting_charge/charge_sent/overdue).
  // Diferente de cancelContract porque:
  //   - Não calcula multa nem refund (nada foi pago)
  //   - Cancela cobrança Asaas via API (se houver) pra não ficar vagando
  //   - Marca status='voided' e payment_status='cancelled' (trigger SQL limpa asaas_payments)
  //   - Coach já está protegido (edge function exige payment_status='paid')
  const voidContract = async () => {
    if (isRenewalContract(contract)) {
      toast.info('Renovações devem ser encerradas pela tela de Renovações');
      setVoidModal(false);
      navigate(`/assessoria/renovacoes?resolver=${contract.id}`);
      return;
    }
    setVoiding(true);
    try {
      await voidAssessmentContractSale(id);

      toast.success('Venda descartada. Cobrança Asaas cancelada e contrato encerrado sem multa.');
      setVoidModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao descartar venda');
    } finally {
      setVoiding(false);
    }
  };

  // Detecta se o contrato está em estado "não pago" — permite ajuste ou descarte.
  const isUnpaid = contract
    && ADJUSTABLE_PAYMENT_STATUSES.has(contract.payment_status || 'pending')
    && !contract.manual_payment
    && !contract.payment_date
    && !contract.refund_status
    && Number(contract.refund_amount || 0) === 0
    && !contract.refund_date
    && !String(contract.refund_notes || '').trim();

  const selectedAdjustPlan = plans.find(p => p.id === adjustPlanForm.plan_id) || null;
  const selectedAdjustModality = modalities.find(m => m.id === selectedAdjustPlan?.modality_id) || null;
  // O banco só aceita o plano se o treinador atual atende a modalidade dele;
  // avisa antes de enviar, para a troca não falhar no meio.
  const adjustModalityLabel = selectedAdjustModality?.name
    ? selectedAdjustModality.name.charAt(0).toUpperCase() + selectedAdjustModality.name.slice(1)
    : 'a modalidade deste plano';
  const adjustCoachIssue = !selectedAdjustPlan || !coach
    ? ''
    : coach.active !== true
      ? `O treinador atual (${coach.name}) está inativo. Troque o treinador do contrato antes de trocar o plano.`
      : !(coach.modality_ids || []).includes(selectedAdjustPlan.modality_id)
        ? `O treinador atual (${coach.name}) não atende ${adjustModalityLabel}. Troque o treinador do contrato antes de trocar o plano.`
        : '';
  const adjustedEndDate = selectedAdjustPlan && adjustPlanForm.start_date
    ? addPeriod(adjustPlanForm.start_date, selectedAdjustPlan)
    : '';

  const openAdjustPlanModal = useCallback(() => {
    setAdjustPlanForm({
      plan_id: contract.plan_id || '',
      start_date: contract.start_date || todayLocalStr(),
      installments: contract.installments || 1,
      enrollment_fee: Number(contract.enrollment_fee) || 0,
      manual_discount: Number(contract.manual_discount) || 0,
      discount_reason: contract.discount_reason || '',
    });
    setAdjustPlanModal(true);
  }, [contract]);

  useEffect(() => {
    if (searchParams.get('ajustar-plano') !== '1' || loading || !contract) return;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('ajustar-plano');
    setSearchParams(nextParams, { replace: true });

    if (!isUnpaid) {
      toast.error('Só é possível trocar o plano antes do pagamento');
      return;
    }
    const timer = setTimeout(openAdjustPlanModal, 0);
    return () => clearTimeout(timer);
  }, [contract, isUnpaid, loading, openAdjustPlanModal, searchParams, setSearchParams]);

  const savePlanAdjustment = async () => {
    if (!isUnpaid) return toast.error('Só é possível ajustar plano antes do pagamento');
    if (!selectedAdjustPlan) return toast.error('Selecione um plano');
    if (!adjustPlanForm.start_date) return toast.error('Informe a data de início');
    if (adjustCoachIssue) return toast.error(adjustCoachIssue);

    const installments = Math.min(
      Math.max(Number(adjustPlanForm.installments) || 1, 1),
      selectedAdjustPlan.max_installments || 1,
    );
    const enrollmentFee = Math.max(Number(adjustPlanForm.enrollment_fee) || 0, 0);
    const manualDiscount = Math.max(Number(adjustPlanForm.manual_discount) || 0, 0);

    setAdjustPlanSaving(true);
    try {
      await changeAssessmentContractPlan(id, {
        planId: selectedAdjustPlan.id,
        startDate: adjustPlanForm.start_date,
        installments,
        enrollmentFee,
        manualDiscount,
        discountReason: adjustPlanForm.discount_reason || null,
      });

      toast.success(isRenewalContract(contract)
        ? 'Renovação ajustada. Gere ou envie a cobrança correta agora.'
        : 'Contrato ajustado. Gere ou envie a cobrança correta agora.');
      setAdjustPlanModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao ajustar plano');
    } finally {
      setAdjustPlanSaving(false);
    }
  };

  // Reabre pagamento manual: desfaz registro e volta a status anterior.
  const reopenPayment = async () => {
    setReopenLoading(true);
    try {
      await reopenManualPayment({ order_id: id, order_type: 'contract' });

      toast.success('Pagamento revertido. Contrato voltou para "Pendente".');
      setReopenModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao reabrir pagamento');
    } finally {
      setReopenLoading(false);
    }
  };

  // Atalho: reabre pagamento manual e prepara fluxo de cobrança Asaas.
  const convertToAsaas = async () => {
    await reopenPayment();
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
  };

  const renewContract = async () => {
    if (!plan) return toast.error('Plano inválido');

    // Avisa (não bloqueia) se o contrato atual ainda tem pagamento em aberto
    const hasOpenPayment = contract.payment_status &&
      !['paid', 'refunded', 'cancelled'].includes(contract.payment_status);
    if (hasOpenPayment) {
      const labels = {
        pending: 'aguardando',
        awaiting_charge: 'pedido recebido',
        charge_sent: 'cobrança enviada',
        partially_paid: 'parcialmente pago',
        overdue: 'vencido',
      };
      const statusLabel = labels[contract.payment_status] || contract.payment_status;
      const confirmed = confirm(
        `⚠️ Atenção:\n\n` +
        `Este contrato ainda tem pagamento em aberto (status: ${statusLabel}).\n` +
        `Valor: ${formatCurrency(planVal('price_total'))}\n\n` +
        `Renovar mesmo assim?\n\n` +
        `(O contrato atual permanecerá com a cobrança pendente — ele aparecerá em "Pagamentos em aberto" no perfil do aluno até ser resolvido)`
      );
      if (!confirmed) return;
    }

    setRenewLoading(true);
    try {
      const result = await createAssessmentContractRenewal(id, contract.updated_at);
      const created = result.contract;
      toast.success(created.status === 'scheduled'
        ? `Renovação ${created.contract_number} agendada!`
        : `Contrato ${created.contract_number} criado!`);
      setRenewModal(false);
      navigate(`/assessoria/contratos/${created.id}`);
    } catch (e) { toast.error(e.message || 'Erro ao renovar'); }
    finally { setRenewLoading(false); }
  };

  const toggleAutoRenewal = async () => {
    if (!contract.auto_renewal && !allowsAutoRenewal({ period_months: planVal('period_months'), period: planVal('period') })) {
      toast.error(AUTO_RENEWAL_MONTHLY_ONLY_MESSAGE);
      return;
    }
    try {
      await setAssessmentContractAutoRenewal(
        id,
        !contract.auto_renewal,
        contract.updated_at,
      );
      toast.success(contract.auto_renewal ? 'Renovação automática desativada' : 'Renovação automática ativada!');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const openManualPay = async () => {
    const baseV = Number(planVal('price_total')) || 0;
    const enrV  = Number(contract.enrollment_fee) || 0;
    const discV = Number(contract.manual_discount) || 0;
    const credV = Number(contract.credit_balance) || 0;
    const total = Math.max(0, baseV + enrV - discV - credV);
    try {
      const groups = await loadActivePaymentMethods();
      setMethodGroups(groups);
      const allMethods = groups.flatMap(([, list]) => list);
      const defaultMethod = allMethods.find(m => m.internal_code === 'pix_manual') || allMethods[0];
      setManualPayForm({
        method_id: defaultMethod?.id || '',
        date:      todayLocalStr(),
        value:     total.toFixed(2),
      });
      setManualPayModal(true);
    } catch (e) {
      toast.error('Erro ao carregar métodos: ' + e.message);
    }
  };

  const recordManualPayment = async () => {
    if (!manualPayForm.method_id) return toast.error('Selecione um método');
    if (!manualPayForm.date)      return toast.error('Informe a data do pagamento');
    if (!manualPayForm.value || isNaN(Number(manualPayForm.value))) return toast.error('Informe o valor recebido');
    const method = methodGroups.flatMap(([, list]) => list).find(m => m.id === manualPayForm.method_id);
    if (!method) return toast.error('Método inválido');
    if (contract?.asaas_charge_id) return toast.error('Cancele a cobrança Asaas antes de registrar pagamento por fora');

    setManualPaySaving(true);
    try {
      const totalV = Number(manualPayForm.value);
      const expectedTotal = Math.max(
        0,
        (Number(planVal('price_total')) || 0) +
        (Number(contract.enrollment_fee) || 0) -
        (Number(contract.manual_discount) || 0) -
        (Number(contract.credit_balance) || 0)
      );
      if (Math.abs(totalV - expectedTotal) > 0.009) {
        throw new Error('Pagamento parcial ainda não está habilitado. Informe o valor integral do contrato.');
      }
      const result = await createManualInstallments(
        method, manualPayForm.date,
        { order_id: id, order_type: 'contract', external_reference: contract.contract_number },
        totalV,
        manualPayForm.installments,
      );
      toast.success(`Pagamento registrado! ${result.installments > 1 ? `${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      load();
    } catch (e) { toast.error(e.message); }
    finally { setManualPaySaving(false); }
  };

  // Atalho ?receber=1 (vindo da lista de Vendas em aberto) → abre o modal direto
  useEffect(() => {
    if (searchParams.get('receber') !== '1' || loading || !contract) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('receber');
    setSearchParams(nextParams, { replace: true });
    const timer = setTimeout(openManualPay, 0);
    return () => clearTimeout(timer);
  }, [contract, loading, openManualPay, searchParams, setSearchParams]);

  const openWhatsApp = async () => {
    if (!student?.whatsapp || communicationOpening) return;
    setCommunicationOpening(true);
    try {
      const result = await listCommunicationCases({ state: 'open', source_type: 'contract', source_id: id, limit: 20 });
      const target = `/comunicacao?source_type=contract&source_id=${encodeURIComponent(id)}`;
      if (result.rollout?.enabled === false) {
        navigate(target);
      } else if (result.items?.length === 1 && !result.next_cursor) {
        setCommunicationCaseId(result.items[0].id);
      } else if (result.items?.length) {
        navigate(target);
      } else {
        navigate(`${target}&state=resolved`);
      }
    } catch (error) {
      toast.error(error?.message || 'Não foi possível localizar o acompanhamento deste contrato.');
    } finally {
      setCommunicationOpening(false);
    }
  };

  const openExternalSaleModal = () => {
    setExternalSaleForm({
      link:           contract?.external_payment_link || '',
      due_date:       suggestedAssessmentChargeDueDate(contract),
      payment_method: normalizeExternalChargeMethod(contract?.payment_method, contract?.installments),
      invoice_number: contract?.external_invoice_number || '',
    });
    setExternalSaleModal(true);
  };

  const saveExternalSale = async () => {
    const link = externalSaleForm.link.trim();
    const dueDate = externalSaleForm.due_date;
    const invoiceNumber = externalSaleForm.invoice_number.trim();
    const paymentMethod = normalizeExternalChargeMethod(externalSaleForm.payment_method, contract.installments);

    setExternalSaleSaving(true);
    try {
      const hadExternalLink = !!contract.external_payment_link;
      await registerExternalAssessmentContractCharge({
        contract,
        link,
        dueDate,
        paymentMethod,
        invoiceNumber,
        source: 'contract_detail',
      });
      toast.success(hadExternalLink ? 'Cobrança externa atualizada!' : 'Cobrança externa registrada! Agora envie a mensagem pro aluno.');
      setExternalSaleModal(false);
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar cobrança externa');
    } finally {
      setExternalSaleSaving(false);
    }
  };

  const removeExternalSale = async () => {
    if (!window.confirm('Remover o link de cobrança externa? Isso volta o contrato para aguardando cobrança.')) return;
    try {
      await removeAssessmentContractExternalCharge(id, contract.updated_at);
      toast.success('Cobrança externa removida.');
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao remover');
    }
  };

  if (loading || !contract) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const ps = PAY[contract.payment_status] || { label: contract.payment_status, badge: 'secondary' };
  const st = STATUS[contract.status] || { label: contract.status, badge: 'secondary' };
  // Quando modal de cancelamento está aberta, usa cancelDate; senão usa hoje
  const calc = cancelModal ? cancellationCalc(cancelDate) : cancellationCalc();
  const canCancel = !['cancelled', 'finished', 'voided'].includes(contract.status);
  const compatibleCoaches = coaches.filter(c => (c.modality_ids || []).includes(plan?.modality_id));
  // Troca de coach com data: trechos pela regra do repasse e a troca agendada.
  const coachToday = todayLocalStr();
  const coachSegments = coachHistorySegments(history, {
    startDate: contract.start_date, endDate: contract.end_date, today: coachToday,
  });
  const scheduledCoachChange = pendingCoachChange(history, { startDate: contract.start_date, today: coachToday });
  const scheduledCoach = scheduledCoachChange
    ? allCoaches.find(c => c.id === scheduledCoachChange.coach_id)
    : null;
  const coachReferenceDay = contract.start_date > coachToday ? contract.start_date : coachToday;
  const coachSegmentNow = coachSegments.find(segment => segment.from <= coachReferenceDay
    && (!segment.to || segment.to >= coachReferenceDay));
  // O novo coach começa entre o início do coach atual e o último dia do contrato.
  const coachDateMin = coachSegmentNow?.from || contract.start_date;
  const contractLastDay = contract.end_date
    ? toLocalDateStr(new Date(new Date(`${contract.end_date}T12:00:00`).getTime() - 86400000))
    : undefined;
  const defaultCoachDate = coachDateMin > coachToday ? coachDateMin : coachToday;
  const coachFromFirstDay = newCoachDate === contract.start_date && contract.start_date > coachToday;
  const canCreateRenewal = !contract.parent_contract_id
    && !contract.renewal_generated
    && !isNonRenewalReason(contract.cancellation_reason)
    && ['active', 'overdue', 'on_leave', 'finished'].includes(contract.status);
  const canMarkNoRenewal = canCancel
    && !isUnpaid
    && !contract.parent_contract_id
    && ['active', 'overdue', 'on_leave'].includes(contract.status)
    && !String(contract.cancellation_reason || '').trim()
    && !contract.cancellation_date
    && Number(contract.cancellation_fee || 0) === 0
    && !contract.refund_status
    && Number(contract.refund_amount || 0) === 0
    && !contract.refund_date
    && !String(contract.refund_notes || '').trim()
    && !['refunded', 'partially_refunded'].includes(contract.payment_status);
  const canVoidUnpaidSale = isUnpaid && (
    !isRenewalContract(contract)
    || ['draft', 'scheduled', 'active', 'overdue'].includes(contract.status)
  );
  const cancelDateAtOrAfterEnd = !!(contract.end_date && cancelDate >= contract.end_date);
  const latestAppliedChange = planChanges
    .filter(change => change.status === 'applied')
    .sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)))[0] || null;
  const openPlanChangeCharges = planChanges.filter(change => change.status !== 'cancelled' && isOpenPlanChangeCharge(change));
  const hasActivePlanChanges = planChanges.some(change => change.status !== 'cancelled');
  const showPlanChanges = planChanges.length > 0
    || (contract.payment_status === 'paid' && ['active', 'on_leave', 'scheduled'].includes(contract.status));
  // Data futura dentro da vigência não cancela agora: agenda.
  const isScheduledCancellation = cancelDate > todayLocalStr() && !cancelDateAtOrAfterEnd;

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/contratos')}><ArrowLeft className="w-4 h-4" /></Button>
        <div>
          <h2 className="text-xl font-bold font-mono">{contract.contract_number}</h2>
          <p className="text-sm text-muted-foreground">criado em {formatDate(contract.created_at?.split('T')[0])}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Badge variant={isRenewalContract(contract) ? 'purple' : 'info'}>
            {getContractKindLabel(contract)}
          </Badge>
          <Badge variant={st.badge}>{st.label}</Badge>
          {contract.scheduled_cancellation_date && (
            <Badge variant="info" title="O aluno segue ativo até esta data">
              Sai {formatDate(contract.scheduled_cancellation_date)}
            </Badge>
          )}
          <Badge variant={ps.badge}>{ps.label}</Badge>
          {student?.whatsapp && <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsApp} disabled={communicationOpening}><MessageCircle className="w-4 h-4 mr-1" /> {communicationOpening ? 'Carregando contato...' : 'Acompanhar contato'}</Button>}
        </div>
      </div>

      {contract.status === 'scheduled' && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="py-3 px-4 flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="text-blue-900">
              <strong>{isRenewalContract(contract) ? 'Renovação agendada.' : 'Contrato agendado.'}</strong>{' '}
              A cobrança pode ser tratada agora, mas a vigência só conta como ativa a partir de {formatDate(contract.start_date)}.
              {isRenewalContract(contract) && ' O contrato anterior permanece operacional até essa virada.'}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Banner: contrato pai (se este for uma renovação) */}
      {parentContract && (() => {
        const parentHasOpenPayment = parentContract.payment_status &&
          !['paid', 'refunded', 'cancelled'].includes(parentContract.payment_status);
        return (
          <div className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 border ${
            parentHasOpenPayment
              ? 'bg-amber-50 border-amber-300'
              : 'bg-blue-50 border-blue-200'
          }`}>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <RotateCcw className={`w-4 h-4 shrink-0 ${parentHasOpenPayment ? 'text-amber-600' : 'text-blue-600'}`} />
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${parentHasOpenPayment ? 'text-amber-900' : 'text-blue-900'}`}>
                  Este contrato é uma renovação de{' '}
                  <Link to={`/assessoria/contratos/${parentContract.id}`}
                    className="font-mono hover:underline">
                    {parentContract.contract_number}
                  </Link>
                </p>
                {parentHasOpenPayment ? (
                  <p className="text-xs text-amber-800 mt-0.5">
                    ⚠️ O contrato anterior ainda está com pagamento em aberto (status: {parentContract.payment_status}).
                  </p>
                ) : (
                  <p className="text-xs text-blue-700 mt-0.5">
                    Anterior: {formatDate(parentContract.start_date)} → {formatDate(parentContract.end_date)} · {parentContract.payment_status === 'paid' ? '✓ pago' : parentContract.payment_status}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Banner de licença ativa */}
      {contract.status === 'on_leave' && (() => {
        const activeLeave = leaves.find(l => l.status === 'active');
        return (
          <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-amber-800 flex items-center gap-1.5">
                <Pause className="w-4 h-4" /> Aluno em licença
              </p>
              {activeLeave && (
                <p className="text-xs text-amber-700 mt-0.5">
                  {leavePeriodLabel(activeLeave)}
                  {activeLeave.reason && ` · ${activeLeave.reason}`}
                </p>
              )}
            </div>
            {activeLeave && (
              <Button size="sm" variant="outline" className="border-amber-400 text-amber-800 hover:bg-amber-100 shrink-0"
                onClick={() => finishLeave(activeLeave)}>
                Encerrar licença
              </Button>
            )}
          </div>
        );
      })()}

      {/* Cards info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><User className="w-4 h-4" /> Aluno</CardTitle></CardHeader>
          <CardContent>
            <Link to={studentProfilePath(student?.id, 'contracts')} className="font-semibold hover:underline">{student?.full_name}</Link>
            <p className="text-xs text-muted-foreground">{student?.whatsapp} {student?.email && `· ${student.email}`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><UserCheck className="w-4 h-4" /> Coach atual</CardTitle></CardHeader>
          <CardContent>
            <p className="font-semibold">{coach?.name}</p>
            <p className="text-xs text-muted-foreground capitalize">{coach?.role}</p>
            {scheduledCoachChange && (
              <div className="mt-2 rounded-md border border-purple-200 bg-purple-50 px-2.5 py-1.5 text-xs text-purple-900">
                <p>Troca agendada: <strong>{scheduledCoach?.name || '—'}</strong> a partir de {formatDate(scheduledCoachChange.started_at)}</p>
                {canCancel && <button onClick={() => setCancelCoachChangeModal(true)} className="mt-1 text-purple-700 hover:underline">Cancelar troca</button>}
              </div>
            )}
            {canCancel && !scheduledCoachChange && <button onClick={() => { setNewCoachId(coach?.id || ''); setNewCoachDate(defaultCoachDate); setChangeCoachModal(true); }} className="text-xs text-blue-600 hover:underline mt-1.5 inline-flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Trocar coach</button>}
          </CardContent>
        </Card>
      </div>

      {/* Plano */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Plano</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div><p className="text-xs text-muted-foreground">Modalidade</p><p className="font-semibold capitalize">{modality?.name}</p></div>
            <div><p className="text-xs text-muted-foreground">Período</p><p className="font-semibold">{periodLabel(plan)}</p></div>
            <div><p className="text-xs text-muted-foreground">Parcelas</p><p className="font-semibold">{contract.installments}x</p></div>
            <div><p className="text-xs text-muted-foreground">Mensal</p><p className="font-semibold">{formatCurrency(planVal('price_monthly'))}</p></div>
            <div><p className="text-xs text-muted-foreground">Total</p><p className="font-semibold">{formatCurrency(planVal('price_total'))}</p></div>
            {contract.payment_method && (
              <div><p className="text-xs text-muted-foreground">Forma pref.</p><p className="font-semibold">{{ card: 'Cartão de crédito', pix_boleto: 'PIX / Boleto', pix_manual: 'PIX manual', cash: 'Dinheiro', bank_transfer: 'Transferência', card_machine: 'Maquininha' }[contract.payment_method] || contract.payment_method}</p></div>
            )}
            {contract.credit_balance > 0 && <div><p className="text-xs text-muted-foreground">Crédito</p><p className="font-semibold text-green-600">-{formatCurrency(contract.credit_balance)}</p></div>}
          </div>
          {latestAppliedChange && (
            <p className="mt-3 text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
              Plano atual: <b>{plan?.name || '—'}</b>, desde {formatDate(latestAppliedChange.effective_date)}.
              {' '}Mensal e total acima são da venda original{contract.plan_snapshot?.name ? ` (${contract.plan_snapshot.name})` : ''}; a diferença do upgrade está em Mudanças de plano.
            </p>
          )}
          <div className="border-t mt-4 pt-3 flex items-center justify-between text-sm flex-wrap gap-2">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 inline" /> {formatDate(contract.start_date)} → {formatDate(contract.end_date)}
              <button onClick={openDateModal} className="text-blue-600 hover:underline text-xs ml-1 inline-flex items-center gap-0.5">
                <PenLine className="w-3 h-3" /> editar
              </button>
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              {contract.original_end_date !== contract.end_date && (
                <span className="text-xs text-amber-700">Original: {formatDate(contract.original_end_date)} (estendido por licenças)</span>
              )}
              <button
                onClick={toggleAutoRenewal}
                disabled={!contract.auto_renewal && !allowsAutoRenewal({ period_months: planVal('period_months'), period: planVal('period') })}
                title={!contract.auto_renewal && !allowsAutoRenewal({ period_months: planVal('period_months'), period: planVal('period') })
                  ? AUTO_RENEWAL_MONTHLY_ONLY_MESSAGE
                  : undefined}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  contract.auto_renewal
                    ? 'bg-green-100 text-green-700 border-green-300 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                }`}
              >
                <RotateCcw className="w-3 h-3 inline mr-1" />
                {contract.auto_renewal ? 'Auto-renovação: ON' : 'Auto-renovação: OFF'}
              </button>
            </div>
          </div>

          {contract.status === 'cancelled' && contract.cancellation_date && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-900">
              <Ban className="w-3.5 h-3.5 inline mr-1" />
              Cancelado · último dia <b>{formatDate(contract.cancellation_date)}</b>
              <span className="block text-xs text-red-700 mt-0.5">O aluno conta no repasse até esse dia.</span>
            </div>
          )}

          {contract.scheduled_cancellation_date && (
            <div className="mt-3 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-sm text-blue-900">
                <Calendar className="w-3.5 h-3.5 inline mr-1" />
                Cancelamento agendado para <b>{formatDate(contract.scheduled_cancellation_date)}</b>
                {Number(contract.scheduled_cancellation_fee_pct) > 0 && ` — multa de ${contract.scheduled_cancellation_fee_pct}%`}
                {contract.scheduled_cancellation_reason && ` — ${contract.scheduled_cancellation_reason}`}
                <span className="block text-xs text-blue-700 mt-0.5">O aluno segue ativo até lá e conta no repasse. O sistema cancela sozinho na data.</span>
              </span>
              <button
                onClick={removeCancellationSchedule}
                disabled={cancelSaving}
                className="text-xs font-semibold px-2.5 py-1 rounded-full border border-blue-300 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                Desfazer
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {showPlanChanges && (
        <PlanChangesCard
          contract={contract}
          changes={planChanges}
          history={planHistory}
          plans={allPlans}
          transitions={planTransitions}
          coaches={allCoaches}
          onChanged={load}
        />
      )}

      {/* Desconto manual */}
      <DiscountInput
        subtotal={Math.max(
          0,
          (Number(planVal('price_total')) || 0) +
          (Number(contract.enrollment_fee) || 0) -
          (Number(contract.credit_balance) || 0),
        )}
        currentDiscount={Number(contract.manual_discount) || 0}
        currentReason={contract.discount_reason || ''}
        currentRecurring={contract.discount_recurring || false}
        showRecurring={true}
        lockedReason={contract.asaas_charge_id
          ? 'Já existe uma cobrança gerada no Asaas. Cancele a cobrança atual antes de aplicar desconto.'
          : null}
        entityType="assessment_contract"
        entityId={contract.id}
        onSave={async (newValue, reason, recurring) => {
          if (contract.manual_payment && contract.payment_status === 'paid') {
            const basePrice = Number(planVal('price_total')) || 0;
            const enroll    = Number(contract.enrollment_fee) || 0;
            const credit    = Number(contract.credit_balance) || 0;
            const newTotal  = Math.max(0, basePrice + enroll - newValue - credit);
            const result = await adjustManualInstallmentsValue(
              { order_id: contract.id, order_type: 'contract' },
              {
                total: newTotal,
                manualDiscount: newValue,
                discountReason: reason,
                discountRecurring: recurring,
              },
            );
            await load();
            return result;
          }
          await updateAssessmentContractDiscount(contract.id, {
            manualDiscount: newValue,
            discountReason: reason || null,
            discountRecurring: recurring || false,
            expectedUpdatedAt: contract.updated_at,
          });
          await load();
          return undefined;
        }}
      />

      {/* Status do pagamento (read-only + detalhamento) — aparece quando PAID ou REFUNDED */}
      {['paid', 'refunded'].includes(contract.payment_status) && (() => {
        const activeInstallments = paymentInstallments.filter(p => !['CANCELLED','REFUNDED'].includes(p.status));
        const registeredAt = activeInstallments[0]?.last_synced_at || activeInstallments[0]?.created_at
                          || paymentInstallments[0]?.last_synced_at || paymentInstallments[0]?.created_at;
        const sourceLabel = contract.manual_payment ? 'Registro manual' : 'Cobrança Asaas';
        const sourceBadgeColor = contract.manual_payment ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700';
        const methodLabel = getPaymentMethodLabel(contract.payment_method);
        const planTotal = Number(planVal('price_total')) || 0;
        const enroll    = Number(contract.enrollment_fee) || 0;
        const totalPaid = Math.max(
          0,
          planTotal + enroll -
          (Number(contract.manual_discount) || 0) -
          (Number(contract.credit_balance) || 0),
        );
        const isRefunded = contract.payment_status === 'refunded';
        const blockColors = isRefunded
          ? { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', valueText: 'text-purple-800' }
          : { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700',  valueText: 'text-green-800' };
        return (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                Status do pagamento
                <Badge variant={ps.badge}>{ps.label}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Bloco de destaque (verde=pago, roxo=estornado) */}
              <div className={`${blockColors.bg} border ${blockColors.border} rounded-xl p-3 space-y-2`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className={`text-xs ${blockColors.text} font-medium uppercase tracking-wide`}>
                      {isRefunded ? 'Estornado' : 'Pago'}
                    </p>
                    <p className={`text-lg font-bold ${blockColors.valueText} mt-0.5`}>
                      {formatCurrency(totalPaid)}
                    </p>
                    <p className={`text-xs ${blockColors.text} mt-0.5`}>
                      {methodLabel}
                      {' · '}
                      <span className="font-medium">{contract.payment_date ? formatDate(contract.payment_date) : '—'}</span>
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full ${sourceBadgeColor}`}>
                    {sourceLabel}
                  </span>
                </div>
                {registeredAt && (
                  <p className={`text-[11px] ${blockColors.text} flex items-center gap-1`}>
                    <Calendar className="w-3 h-3" />
                    Registrado em {new Date(registeredAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                )}
                {isRefunded && contract.cancellation_reason && (
                  <p className={`text-[11px] ${blockColors.text}`}>
                    <strong>Motivo:</strong> {contract.cancellation_reason}
                  </p>
                )}
              </div>

              {/* Parcelas projetadas */}
              {activeInstallments.length > 0 && (
                <div className="border rounded-xl overflow-hidden">
                  <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    {activeInstallments.length === 1
                      ? 'Recebimento no fluxo de caixa'
                      : `${activeInstallments.length} parcelas no fluxo de caixa`}
                  </div>
                  <ManualInstallmentsEditor orderType="contract" order={contract} installments={paymentInstallments} onSaved={load} />
                  <div className="divide-y">
                    {activeInstallments.map(p => {
                      const isPaid = ['RECEIVED','CONFIRMED','RECEIVED_IN_CASH'].includes(p.status);
                      const isPast = p.credit_date && new Date(p.credit_date) <= new Date();
                      return (
                        <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className="text-xs font-bold text-muted-foreground w-12 shrink-0">
                            {activeInstallments.length === 1 ? '1x' : `${p.installment_number}/${p.total_installments || activeInstallments.length}`}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-gray-700">
                              {p.credit_date ? formatDate(p.credit_date) : '—'}
                              {isPast && isPaid && <span className="ml-1.5 text-[10px] text-emerald-600 font-medium">✓ creditado</span>}
                              {!isPast && <span className="ml-1.5 text-[10px] text-blue-600">a receber</span>}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-semibold text-sm">{formatCurrency(p.value || 0)}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Ações em pagamentos manuais ativos */}
              {contract.payment_status === 'paid' && contract.manual_payment && (
                <div className="pt-3 border-t space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-blue-700 border-blue-300 hover:bg-blue-50"
                      onClick={convertToAsaas}
                      disabled={reopenLoading || hasActivePlanChanges}
                    >
                      <Zap className="w-3.5 h-3.5 mr-1.5" /> Converter pra cobrança Asaas
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-amber-700 border-amber-300 hover:bg-amber-50"
                      onClick={() => setReopenModal(true)}
                      disabled={reopenLoading || hasActivePlanChanges}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reabrir pagamento
                    </Button>
                  </div>
                  {hasActivePlanChanges ? (
                    <p className="text-[11px] text-muted-foreground">
                      Com mudança de plano registrada, desfaça o pagamento da diferença e cancele a mudança antes de reabrir o pagamento do contrato.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      <strong>Converter:</strong> desfaz o registro manual e libera o card de cobrança Asaas. ·{' '}
                      <strong>Reabrir:</strong> só desfaz (use se foi erro de registro).
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Cobrança Asaas — só aparece se ainda há ação a tomar */}
      {!['paid', 'refunded', 'cancelled'].includes(contract.payment_status) && !['cancelled', 'voided'].includes(contract.status) && (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Zap className="w-4 h-4 text-blue-600" /> Cobrança e pagamento</CardTitle></CardHeader>
        <CardContent>
          {contract.asaas_charge_id ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-mono text-muted-foreground">{contract.asaas_charge_id}</span>
                <div className="flex gap-1.5">
                  {contract.asaas_payment_link && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={contract.asaas_payment_link} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5 mr-1" /> Ver fatura</a>
                    </Button>
                  )}
                </div>
              </div>
              {contract.asaas_pix_copy && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><QrCode className="w-3.5 h-3.5" /> PIX Copia e Cola</p>
                  <div className="flex gap-2">
                    <input readOnly value={contract.asaas_pix_copy} className="flex-1 text-xs font-mono bg-gray-50 border rounded-lg px-3 py-2 truncate" />
                    <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(contract.asaas_pix_copy); toast.success('Copiado!'); }}><Copy className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>
              )}
              <div className="border-t pt-3">
                <button
                  onClick={() => setCancelChargeModal(true)}
                  className="text-xs text-red-600 hover:underline flex items-center gap-1"
                >
                  <XCircle className="w-3.5 h-3.5" /> Cancelar cobrança (para aplicar desconto e gerar nova)
                </button>
              </div>
            </div>
          ) : contract.manual_payment ? (
            <div className="flex items-center gap-3 py-2">
              <HandCoins className="w-5 h-5 text-green-600 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-green-700">Pago manualmente</p>
                <p className="text-xs text-muted-foreground capitalize">
                  {({ pix_manual: 'PIX manual', cash: 'Dinheiro', bank_transfer: 'Transferência bancária', card_machine: 'Cartão na máquina' }[contract.payment_method]) || contract.payment_method}
                  {contract.payment_date && ` · ${contract.payment_date}`}
                </p>
              </div>
            </div>
          ) : contract.external_payment_link ? (
            <ExternalChargeSummary
              externalLink={contract.external_payment_link}
              paymentMethod={contract.payment_method}
              installments={contract.installments}
              invoiceNumber={contract.external_invoice_number}
              dueDateLabel={contract.due_date ? formatDate(contract.due_date) : null}
              messageSentLabel={contract.payment_message_sent_at ? `em ${formatDate(contract.payment_message_sent_at)}` : null}
              onCopy={() => { navigator.clipboard.writeText(contract.external_payment_link); toast.success('Link copiado!'); }}
              onMessage={student?.whatsapp ? openWhatsApp : undefined}
              onEdit={openExternalSaleModal}
              onRemove={removeExternalSale}
              onRecordPayment={openManualPay}
            />
          ) : (
            <div className="space-y-3">
              <div className="text-center py-2">
                <p className="text-sm text-muted-foreground mb-3">Nenhuma cobrança gerada ainda</p>
                {!student?.cpf && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 inline-block mb-3">⚠ Cadastre o CPF do aluno primeiro</p>}
                <div className="flex gap-2 justify-center flex-wrap">
                  <Button size="sm" onClick={() => openChargeConfirm('PIX')} disabled={chargeLoading || !student?.cpf}><Zap className="w-3.5 h-3.5 mr-1" /> Gerar via Asaas (PIX)</Button>
                  <Button size="sm" variant="outline" onClick={() => openChargeConfirm('BOLETO')} disabled={chargeLoading || !student?.cpf}>Boleto</Button>
                  <Button size="sm" variant="outline" onClick={() => openChargeConfirm('CREDIT_CARD')} disabled={chargeLoading || !student?.cpf}>Cartão {contract.installments}x</Button>
                  <Button size="sm" variant="outline" className="text-amber-700 border-amber-300 hover:bg-amber-50" onClick={openExternalSaleModal}>
                    <Link2 className="w-3.5 h-3.5 mr-1" /> Informar link externo
                  </Button>
                </div>
              </div>
              <div className="border-t pt-3 flex gap-2 justify-center flex-wrap">
                <Button size="sm" variant="outline" className="text-amber-700 border-amber-300 hover:bg-amber-50" onClick={openExternalSaleModal}>
                  <Link2 className="w-3.5 h-3.5 mr-1.5" /> Cadastrar cobrança externa
                </Button>
                <Button size="sm" variant="outline" className="text-green-700 border-green-300 hover:bg-green-50" onClick={openManualPay}>
                  <HandCoins className="w-3.5 h-3.5 mr-1.5" /> Registrar pagamento manual
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Aviso simples para vendas descartadas */}
      {contract.status === 'voided' && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="py-3 px-4 flex items-center gap-2 text-sm">
            <XCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="text-amber-900">
              <strong>Venda descartada.</strong>
              {contract.cancellation_reason && ` Motivo: ${contract.cancellation_reason}`}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Aviso simples para contratos cancelados */}
      {(contract.status === 'cancelled' || (contract.payment_status === 'cancelled' && contract.status !== 'voided')) && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3 px-4 flex items-center gap-2 text-sm">
            <Ban className="w-4 h-4 text-red-600 shrink-0" />
            <span className="text-red-800">
              <strong>Contrato cancelado.</strong>
              {contract.cancellation_reason && ` Motivo: ${contract.cancellation_reason}`}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Timeline de eventos */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600" />
            Histórico do contrato
            {events.length > 0 && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                {events.length} evento{events.length !== 1 ? 's' : ''}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ContractTimeline events={events} />
        </CardContent>
      </Card>

      {/* Histórico de coaches */}
      {coachSegments.length > 1 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" /> Histórico de coaches</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {coachSegments.map(segment => {
                const c = allCoaches.find(x => x.id === segment.coachId);
                return (
                  <div key={`${segment.coachId}-${segment.from}`} className="flex items-center justify-between">
                    <span className="font-medium">{c?.name || '—'}</span>
                    <span className="text-xs text-muted-foreground">
                      {segment.scheduled
                        ? `a partir de ${formatDate(segment.from)} (agendado)`
                        : `${formatDate(segment.from)} → ${segment.current ? 'atual' : formatDate(segment.to)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Licenças */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Pause className="w-4 h-4" /> Licenças</CardTitle>
            {contract.status === 'active' && <Button size="sm" variant="outline" onClick={() => setLeaveModal(true)}>+ Registrar licença</Button>}
          </div>
        </CardHeader>
        <CardContent>
          {leaves.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-2">Nenhuma licença registrada</p>
          ) : (
            <div className="divide-y">
              {leaves.map(l => (
                <div key={l.id} className="flex items-center justify-between py-2">
                  <div className="text-sm">
                    <p className="font-medium">{leavePeriodLabel(l)}</p>
                    {l.reason && <p className="text-xs text-muted-foreground">{l.reason}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${l.status === 'active' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>{l.status === 'active' ? 'Ativa' : 'Encerrada'}</span>
                    {l.status === 'active' && <button onClick={() => finishLeave(l)} className="text-xs text-blue-600 hover:underline">Encerrar</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ações de fim de contrato */}
      {(canCancel || canCreateRenewal) && (
        <Card className="border-gray-100">
          <CardContent className="pt-4 flex flex-wrap gap-2">
            {canCreateRenewal && (
              <Button
                variant="outline"
                className="text-blue-600 hover:bg-blue-50 border-blue-200"
                onClick={() => setRenewModal(true)}
              >
                <RotateCcw className="w-4 h-4 mr-1.5" /> Renovar contrato
              </Button>
            )}
            {canMarkNoRenewal && (
              <Button
                variant="outline"
                className="text-amber-700 hover:bg-amber-50 border-amber-200"
                onClick={markNoRenewal}
                title="Use quando o aluno vai cumprir a vigência atual, mas não continuará no próximo ciclo."
              >
                <Ban className="w-4 h-4 mr-1.5" /> Não renovar
              </Button>
            )}
            {canCancel && (canVoidUnpaidSale ? (
              <>
                <Button
                  variant="outline"
                  className="text-blue-700 border-blue-300 hover:bg-blue-50"
                  onClick={openAdjustPlanModal}
                  title="Cliente pediu outro plano antes de pagar. Ajusta este contrato e limpa a cobrança antiga."
                >
                  <PenLine className="w-4 h-4 mr-1.5" /> {isRenewalContract(contract) ? 'Trocar plano' : 'Ajustar plano'}
                </Button>
                <Button
                  variant="outline"
                  className="text-amber-700 border-amber-300 hover:bg-amber-50"
                  onClick={() => {
                    if (isRenewalContract(contract)) {
                      toast.info('Escolha o motivo do encerramento na tela de Renovações');
                      navigate(`/assessoria/renovacoes?resolver=${contract.id}`);
                    } else {
                      setVoidModal(true);
                    }
                  }}
                  title="Cliente desistiu antes do pagamento — descarta a venda sem multa nem cobrança ao coach"
                >
                  <XCircle className="w-4 h-4 mr-1.5" /> Descartar venda
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="text-red-600 hover:bg-red-50"
                onClick={openCancelModal}
                title={contract.scheduled_cancellation_date
                  ? `Já existe cancelamento agendado para ${formatDate(contract.scheduled_cancellation_date)}`
                  : undefined}
              >
                <XCircle className="w-4 h-4 mr-1.5" />
                {contract.scheduled_cancellation_date ? 'Alterar cancelamento' : 'Cancelar contrato'}
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* MODAL: confirmar geração de cobrança Asaas */}
      <Dialog open={!!chargeConfirmModal} onOpenChange={open => !open && !chargeLoading && setChargeConfirmModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-blue-600" /> Confirmar geração de cobrança
            </DialogTitle>
          </DialogHeader>
          {chargeConfirmModal && (() => {
            const baseV = Number(plan?.price_total) || 0;
            const enrV  = Number(contract.enrollment_fee) || 0;
            const discV = Number(contract.manual_discount) || 0;
            const creditV = Number(contract.credit_balance) || 0;
            const totalV = Math.max(0, baseV + enrV - discV - creditV);
            const inst   = chargeConfirmModal === 'CREDIT_CARD' ? (contract.installments || 1) : 1;
            const methodLabel = chargeConfirmModal === 'PIX' ? '⚡ PIX'
              : chargeConfirmModal === 'BOLETO' ? '📄 Boleto'
              : `💳 Cartão de crédito${inst > 1 ? ` em ${inst}x` : ''}`;
            const methodColor = chargeConfirmModal === 'PIX' ? 'bg-green-100 text-green-700'
              : chargeConfirmModal === 'BOLETO' ? 'bg-amber-100 text-amber-700'
              : 'bg-blue-100 text-blue-700';

            return (
              <div className="space-y-4">
                {/* Aluno */}
                <div className="bg-blue-50/40 border border-blue-100 rounded-lg p-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-1">Aluno</p>
                  <p className="font-semibold">{student?.full_name}</p>
                  <p className="text-xs text-muted-foreground">
                    CPF: {student?.cpf || '—'} · {student?.whatsapp || 'sem WhatsApp'}
                  </p>
                </div>

                {/* Plano + Forma */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Plano</span>
                    <span className="font-medium">{plan?.name?.trim() || `${modality?.name} · ${plan?.period_months}m`}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Forma de cobrança</span>
                    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${methodColor}`}>
                      {methodLabel}
                    </span>
                  </div>
                  <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
                    <span className="text-muted-foreground">Vencimento</span>
                    <div className="text-right">
                      <Input
                        type="date"
                        className="h-9 w-40 text-sm"
                        value={chargeDueDate}
                        onChange={e => setChargeDueDate(e.target.value)}
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {isRenewalContract(contract) ? 'padrão: início da nova vigência' : `padrão D+${DEFAULT_ASAAS_DUE_DAYS}`}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Breakdown de valor */}
                <div className="bg-gray-50 border rounded-lg p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mensalidades ({plan?.period_months}x)</span>
                    <span>{formatCurrency(baseV)}</span>
                  </div>
                  {enrV > 0 && (
                    <div className="flex justify-between text-amber-700">
                      <span>+ Matrícula</span>
                      <span>{formatCurrency(enrV)}</span>
                    </div>
                  )}
                  {discV > 0 && (
                    <div className="flex justify-between text-green-700">
                      <span>− Desconto manual</span>
                      <span>−{formatCurrency(discV)}</span>
                    </div>
                  )}
                  {creditV > 0 && (
                    <div className="flex justify-between text-blue-700">
                      <span>− Crédito disponível</span>
                      <span>−{formatCurrency(creditV)}</span>
                    </div>
                  )}
                  <div className="flex justify-between pt-2 mt-2 border-t font-bold text-base">
                    <span>Total a cobrar</span>
                    <span className="text-blue-700">{formatCurrency(totalV)}</span>
                  </div>
                  {chargeConfirmModal === 'CREDIT_CARD' && inst > 1 && (
                    <p className="text-xs text-muted-foreground pt-1">
                      = {inst}x de {formatCurrency(totalV / inst)}
                    </p>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  Ao confirmar, será criada uma cobrança no Asaas. O aluno recebe link/QR
                  por WhatsApp/email e o status atualiza automaticamente quando pago.
                </p>

                <div className="flex gap-2 pt-1">
                  <Button variant="outline" className="flex-1"
                    onClick={() => setChargeConfirmModal(null)} disabled={chargeLoading}>
                    Cancelar
                  </Button>
                  <Button className="flex-1"
                    onClick={() => generateCharge(chargeConfirmModal)} disabled={chargeLoading}>
                    <Zap className="w-4 h-4 mr-1.5" />
                    {chargeLoading ? 'Gerando...' : 'Confirmar e gerar'}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* MODAL: renovar contrato */}
      <Dialog open={renewModal} onOpenChange={setRenewModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><RotateCcw className="w-4 h-4 text-blue-600" /> Renovar contrato</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1.5">
              <p><span className="text-muted-foreground">Aluno:</span> <strong>{student?.full_name}</strong></p>
              <p><span className="text-muted-foreground">Plano:</span> <strong className="capitalize">{modality?.name} · {periodLabel(plan)}</strong></p>
              <p><span className="text-muted-foreground">Novo início:</span> <strong>{formatDate(contract.end_date)}</strong></p>
              <p><span className="text-muted-foreground">Novo fim:</span> <strong>{plan ? formatDate(addPeriod(contract.end_date, plan)) : '—'}</strong></p>
              <p><span className="text-muted-foreground">Valor:</span> <strong>{formatCurrency(plan?.price_total)}</strong></p>
            </div>
            <p className="text-xs text-muted-foreground">
              Será criado um novo contrato. Este contrato ficará como <strong>Concluído</strong>.
              A cobrança do novo contrato deverá ser gerada separadamente.
            </p>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setRenewModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={renewContract} disabled={renewLoading}>
                {renewLoading ? 'Criando...' : 'Confirmar renovação'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: trocar coach */}
      <Dialog open={changeCoachModal} onOpenChange={setChangeCoachModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Trocar coach</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Coach atual: <strong>{coach?.name}</strong></p>
          <Label>Novo coach</Label>
          <Select value={newCoachId} onValueChange={setNewCoachId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {compatibleCoaches.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({c.role})</SelectItem>)}
            </SelectContent>
          </Select>
          <Label>O novo coach começa em</Label>
          <Input
            type="date"
            value={newCoachDate}
            min={coachDateMin}
            max={contractLastDay}
            onChange={event => setNewCoachDate(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {coachFromFirstDay
              ? 'O contrato ainda não começou: o novo coach assume desde o primeiro dia.'
              : newCoachDate > coachToday
                ? 'A troca fica agendada: o coach do contrato muda sozinho nessa data.'
                : newCoachDate < coachToday
                  ? 'Troca para trás: até o dia anterior, os dias ficam com o coach atual.'
                  : 'A troca vale a partir de hoje.'}
            {' '}No fechamento mensal, cada coach recebe pelos dias dele.
          </p>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setChangeCoachModal(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={changeCoach} disabled={coachSaving || !newCoachDate}>
              {coachSaving ? 'Salvando...' : newCoachDate > coachToday && !coachFromFirstDay ? 'Agendar troca' : 'Confirmar troca'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelCoachChangeModal}
        onOpenChange={setCancelCoachChangeModal}
        title="Cancelar troca de coach"
        icon={XCircle}
        iconClassName="text-purple-600"
        confirmLabel="Cancelar troca"
        confirmClassName="bg-purple-600 hover:bg-purple-700 text-white"
        busy={coachSaving}
        onConfirm={cancelScheduledCoachChange}
      >
        {scheduledCoachChange && (
          <p>
            A troca para <b>{scheduledCoach?.name || '—'}</b> a partir de{' '}
            <b>{formatDate(scheduledCoachChange.started_at)}</b> deixa de existir.
            O contrato continua com <b>{coach?.name || '—'}</b>.
          </p>
        )}
      </ConfirmDialog>

      {/* MODAL: não renovar */}
      <ConfirmDialog
        open={noRenewalModal}
        onOpenChange={setNoRenewalModal}
        title="Não renovar"
        icon={Ban}
        iconClassName="text-amber-600"
        confirmLabel="Confirmar não renovação"
        confirmClassName="bg-amber-600 hover:bg-amber-700 text-white"
        busy={noRenewalSaving}
        busyLabel="Registrando..."
        onConfirm={confirmNoRenewal}
      >
        <p>Registrar que <b>{contract.contract_number}</b> não será renovado?</p>
        <div className="rounded-xl border bg-gray-50 px-3 py-2 space-y-1">
          <p>
            {contract.end_date && contract.end_date <= todayLocalStr()
              ? 'O contrato será marcado como concluído agora.'
              : <>O contrato permanece ativo até <b>{formatDate(contract.end_date)}</b>.</>}
          </p>
          <p className="text-muted-foreground">Não haverá multa, estorno ou nova cobrança.</p>
        </div>
      </ConfirmDialog>

      {/* MODAL: licença */}
      <Dialog open={leaveModal} onOpenChange={setLeaveModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Registrar licença</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Início</Label><Input type="date" value={leaveForm.start_date} onChange={e => setLeaveForm(f => ({ ...f, start_date: e.target.value }))} /></div>
              <div><Label>Fim</Label><Input type="date" value={leaveForm.end_date} disabled={leaveForm.open_ended} onChange={e => setLeaveForm(f => ({ ...f, end_date: e.target.value }))} /></div>
            </div>
            <label className="flex items-start gap-2.5 rounded-lg border bg-gray-50 px-3 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-blue-600"
                checked={leaveForm.open_ended}
                onChange={e => setLeaveForm(f => ({ ...f, open_ended: e.target.checked }))}
              />
              <span><span className="block text-sm font-medium">Sem data definida</span><span className="block text-xs text-muted-foreground">O fim e a prorrogação serão calculados quando o aluno retornar.</span></span>
            </label>
            <div><Label>Motivo (opcional)</Label><Textarea rows={2} value={leaveForm.reason} onChange={e => setLeaveForm(f => ({ ...f, reason: e.target.value }))} /></div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-700">
              {leaveForm.open_ended
                ? 'O vencimento não muda agora. Ao encerrar, será estendido pelos dias efetivos da licença.'
                : 'O vencimento do contrato será estendido automaticamente pelos dias de licença.'}
            </div>
            <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setLeaveModal(false)}>Cancelar</Button><Button className="flex-1" onClick={addLeave}>Registrar</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <CommunicationSendDialog
        caseId={communicationCaseId}
        sourceUi="contract_detail"
        onClose={() => setCommunicationCaseId(null)}
        onChanged={() => load()}
        onSent={() => { setCommunicationCaseId(null); load(); }}
      />

      <ExternalChargeDialog
        open={externalSaleModal}
        onCancel={() => setExternalSaleModal(false)}
        hasCharge={Boolean(contract?.external_payment_link)}
        form={externalSaleForm}
        setForm={setExternalSaleForm}
        saving={externalSaleSaving}
        onSave={saveExternalSale}
        preventOutsideClose
      />

      {/* MODAL: pagamento manual */}
      <Dialog open={manualPayModal} onOpenChange={setManualPayModal}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="w-4 h-4 text-green-600" /> Registrar pagamento manual
            </DialogTitle>
          </DialogHeader>
          <ManualPaymentForm
            form={manualPayForm}
            setForm={setManualPayForm}
            methodGroups={methodGroups}
            saving={manualPaySaving}
            onSave={recordManualPayment}
            onCancel={() => setManualPayModal(false)}
          />
        </DialogContent>
      </Dialog>

      {/* MODAL: ajustar plano antes do pagamento */}
      <Dialog open={adjustPlanModal} onOpenChange={open => !open && !adjustPlanSaving && setAdjustPlanModal(false)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blue-700">
              <PenLine className="w-5 h-5" /> {isRenewalContract(contract) ? 'Trocar plano da renovação' : 'Ajustar plano'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              {isRenewalContract(contract)
                ? 'Use quando o aluno vai continuar, mas em outro plano ou modalidade. A renovação continua ligada ao contrato anterior; cobrança/link antigo serão limpos para você gerar ou enviar a cobrança correta.'
                : 'Ajuste usado quando o cliente ainda não pagou e pediu outra condição. O contrato continua sendo o mesmo; cobrança/link antigo serão limpos para você gerar ou enviar a cobrança correta.'}
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <Label>Plano</Label>
                <Select
                  value={adjustPlanForm.plan_id}
                  onValueChange={value => {
                    const nextPlan = plans.find(p => p.id === value);
                    const months = getPlanMonths(nextPlan);
                    setAdjustPlanForm(f => ({
                      ...f,
                      plan_id: value,
                      installments: Math.min(months, nextPlan?.max_installments || months),
                      enrollment_fee: isRenewalContract(contract) ? 0 : Number(nextPlan?.enrollment_fee) || 0,
                    }));
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Selecione o plano" />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map(p => {
                      const mod = modalities.find(m => m.id === p.modality_id);
                      const name = p.name?.trim() || `${mod?.name || 'Plano'} · ${periodLabel(p)}`;
                      return (
                        <SelectItem key={p.id} value={p.id}>
                          {name} · {formatCurrency(p.price_total)}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Data de início</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={adjustPlanForm.start_date}
                  onChange={e => setAdjustPlanForm(f => ({ ...f, start_date: e.target.value }))}
                />
              </div>

              <div>
                <Label>Parcelas</Label>
                <Input
                  type="number"
                  min="1"
                  max={selectedAdjustPlan?.max_installments || 1}
                  className="mt-1"
                  value={adjustPlanForm.installments}
                  onChange={e => setAdjustPlanForm(f => ({ ...f, installments: e.target.value }))}
                />
              </div>

              <div>
                <Label>Matrícula</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="mt-1"
                  value={adjustPlanForm.enrollment_fee}
                  onChange={e => setAdjustPlanForm(f => ({ ...f, enrollment_fee: e.target.value }))}
                />
              </div>

              <div>
                <Label>Desconto</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="mt-1"
                  value={adjustPlanForm.manual_discount}
                  onChange={e => setAdjustPlanForm(f => ({ ...f, manual_discount: e.target.value }))}
                />
              </div>

              <div className="sm:col-span-2">
                <Label>Motivo do ajuste</Label>
                <Input
                  className="mt-1"
                  placeholder="Ex: cliente pediu trimestral em vez de semestral"
                  value={adjustPlanForm.discount_reason}
                  onChange={e => setAdjustPlanForm(f => ({ ...f, discount_reason: e.target.value }))}
                />
              </div>
            </div>

            {selectedAdjustPlan && (
              <div className="rounded-xl border bg-gray-50 px-4 py-3 text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Modalidade</span>
                  <strong className="capitalize">{selectedAdjustModality?.name || '—'}</strong>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Período</span>
                  <strong>{periodLabel(selectedAdjustPlan)} · até {selectedAdjustPlan.max_installments || 1}x</strong>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Novo término</span>
                  <strong>{adjustedEndDate ? formatDate(adjustedEndDate) : '—'}</strong>
                </div>
                <div className="flex justify-between gap-3 border-t pt-2 mt-2">
                  <span className="text-muted-foreground">Total a cobrar</span>
                  <strong className="text-green-700">
                    {formatCurrency(Math.max(
                      0,
                      Number(selectedAdjustPlan.price_total || 0) +
                        Number(adjustPlanForm.enrollment_fee || 0) -
                        Number(adjustPlanForm.manual_discount || 0),
                    ))}
                  </strong>
                </div>
              </div>
            )}

            {adjustCoachIssue && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {adjustCoachIssue}
              </p>
            )}

            {(contract?.asaas_charge_id || contract?.external_payment_link || contract?.asaas_payment_link) && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Ao salvar, a cobrança/link atual será removida para evitar cobrança duplicada.
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setAdjustPlanModal(false)} disabled={adjustPlanSaving}>
                Voltar
              </Button>
              <Button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white" onClick={savePlanAdjustment} disabled={adjustPlanSaving || Boolean(adjustCoachIssue)}>
                {adjustPlanSaving ? 'Salvando...' : 'Salvar ajuste'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: descartar venda (contrato não pago) */}
      <Dialog open={voidModal} onOpenChange={open => !open && !voiding && setVoidModal(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <XCircle className="w-5 h-5" />
              Descartar venda
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm space-y-2">
              <p className="font-semibold text-amber-900">
                Este contrato nunca foi pago.
              </p>
              <p className="text-amber-800">
                Como o cliente não chegou a pagar (status: <strong>{contract?.payment_status}</strong>),
                não há multa, estorno ou saída real a calcular.
                A operação fica registrada no histórico como venda não concretizada.
              </p>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600 shrink-0" />
                <span>Contrato fica fora das métricas de entrada, saída e MRR</span>
              </div>
              {contract?.asaas_charge_id && (
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-green-600 shrink-0" />
                  <span>Cobrança Asaas é <strong>cancelada</strong> automaticamente</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600 shrink-0" />
                <span>Coach <strong>não recebe</strong> nada por esse contrato (sempre foi assim)</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600 shrink-0" />
                <span>Registra evento <strong>"Venda não concretizada"</strong> no histórico</span>
              </div>
              {contract?.external_payment_link && (
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-green-600 shrink-0" />
                  <span>Remove o link externo salvo para evitar cobrança duplicada</span>
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setVoidModal(false)} disabled={voiding}>
                Voltar
              </Button>
              <Button
                className="flex-1 text-white bg-amber-600 hover:bg-amber-700"
                onClick={voidContract}
                disabled={voiding}
              >
                {voiding ? 'Descartando...' : 'Confirmar descarte'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: cancelar */}
      <Dialog open={cancelModal} onOpenChange={setCancelModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <XCircle className="w-5 h-5" /> Cancelar contrato
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">

            {contract.scheduled_cancellation_date && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800">
                Já existe cancelamento agendado para <b>{formatDate(contract.scheduled_cancellation_date)}</b>.
                Salvar aqui <b>substitui</b> esse agendamento. Para cancelar o agendamento sem
                encerrar o contrato, use o <b>Desfazer</b> na faixa azul do contrato.
              </div>
            )}

            {/* Data de cancelamento: passada/hoje cancela na hora, futura agenda */}
            <div>
              <Label>Data do cancelamento (quando o aluno sai)</Label>
              <Input type="date" className="mt-1"
                min={contract.start_date}
                max={contract.end_date}
                value={cancelDate}
                onChange={e => { setCancelDate(e.target.value); }}
              />
              {cancelDate < todayLocalStr() && (
                <p className="text-xs text-amber-600 mt-1">⚠️ Cancelamento retroativo — ajusta cálculo e relatórios</p>
              )}
              {isScheduledCancellation && (
                <p className="text-xs text-blue-700 mt-1">
                  📅 Data futura: o cancelamento fica <b>agendado</b>. O aluno segue ativo até {formatDate(cancelDate)} — contando normalmente para o repasse do treinador — e o sistema cancela sozinho quando o dia chegar.
                </p>
              )}
              {cancelDateAtOrAfterEnd && (
                <p className="text-xs text-amber-700 mt-1">
                  Esta data está no fim ou após a vigência. Para aluno que apenas não vai renovar, use <b>Não renovar</b>: não há multa, estorno ou cobrança nova.
                </p>
              )}
            </div>

            {/* Resumo proporcional */}
            <div className="bg-gray-50 border rounded-xl p-3 text-sm grid grid-cols-2 gap-y-1">
              <span className="text-muted-foreground">Dias restantes</span>
              <span className="font-semibold text-right">{calc.remainingDays}</span>
              {calc.upgradeRemaining > 0 ? (
                <>
                  <span className="text-muted-foreground">Venda original</span>
                  <span className="font-semibold text-right">{formatCurrency(calc.saleRemaining)}</span>
                  <span className="text-muted-foreground">Upgrade não usado</span>
                  <span className="font-semibold text-right">{formatCurrency(calc.upgradeRemaining)}</span>
                  <span className="text-muted-foreground">Valor proporcional</span>
                  <span className="font-semibold text-right">{formatCurrency(calc.remaining)}</span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Valor proporcional</span>
                  <span className="font-semibold text-right">{formatCurrency(calc.remaining)}</span>
                </>
              )}
            </div>
            {openPlanChangeCharges.length > 0 && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                A mudança de plano com a diferença sem pagamento é cancelada junto: o plano anterior volta desde {formatDate(openPlanChangeCharges[0].effective_date)} e a cobrança da diferença deixa de valer.
              </p>
            )}

            {/* Multa */}
            <div>
              <Label>Multa (%)</Label>
              <Input type="number" min="0" max="100" className="mt-1"
                value={cancelFeePct} onChange={e => setCancelFeePct(e.target.value)} />
            </div>

            {/* Resultado */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-amber-800">Multa ({cancelFeePct}%)</span>
                <strong className="text-amber-800">{formatCurrency(calc.fee)}</strong>
              </div>
              <div className="flex justify-between border-t border-amber-200 pt-1 mt-1">
                <span className="text-green-700 font-semibold">Estorno ao aluno</span>
                <strong className="text-green-700">{formatCurrency(calc.refund)}</strong>
              </div>
              {(() => {
                const pm = (contract.payment_method || '').toLowerCase();
                const isCard = pm === 'credit_card' || (pm.startsWith('card_') && pm !== 'card_machine');
                const isManual = contract.manual_payment;
                const manualLabels = { pix_manual: 'PIX manual', cash: 'dinheiro', bank_transfer: 'transferência bancária', card_machine: 'maquininha' };
                if (isCard && !isManual) return <p className="text-xs text-blue-700 mt-1">💳 Via Asaas (cartão) — veja detalhes de parcelas abaixo</p>;
                if (isManual && pm) return <p className="text-xs text-blue-700 mt-1">📋 Pago via {manualLabels[pm] || pm} — estorno manual</p>;
                const isBoleto = pm === 'boleto';
                return <p className="text-xs text-blue-700 mt-1">{isBoleto ? '📄 Boleto' : '⚡ PIX'} — estorno via Asaas</p>;
              })()}
            </div>

            {/* ── Parcelas Asaas ─────────────────────────────────── */}
            {contract.asaas_charge_id && (
              <div className="border rounded-xl overflow-hidden">
                <div className="bg-gray-50 px-3 py-2 border-b flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-700">💳 Parcelas no Asaas</span>
                  {loadingCancelInst && (
                    <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin ml-auto" />
                  )}
                </div>

                {loadingCancelInst ? (
                  <p className="text-xs text-muted-foreground text-center py-4">Buscando parcelas...</p>
                ) : cancelInstData?.asaasError ? (
                  <p className="text-xs text-red-500 text-center py-4">Erro ao buscar parcelas no Asaas</p>
                ) : cancelInstData?.noCharge ? (
                  <p className="text-xs text-muted-foreground text-center py-4">Sem cobrança Asaas vinculada</p>
                ) : cancelInstData?.installments?.length > 0 ? (() => {
                  const insts   = cancelInstData.installments;
                  const paid    = insts.filter(i => i.isPaid);
                  const pending = insts.filter(i => i.isPending);
                  const paidTotal    = paid.reduce((s, i) => s + i.value, 0);
                  const pendingTotal = pending.reduce((s, i) => s + i.value, 0);
                  return (
                    <>
                      <div className="divide-y max-h-44 overflow-y-auto">
                        {insts.map(inst => (
                          <div key={inst.id} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-50">
                            <span className="text-muted-foreground w-24 shrink-0">
                              {cancelInstData.isSingle ? 'Pagamento' : `Parcela ${inst.number}/${inst.total}`}
                            </span>
                            <span className="flex-1 text-muted-foreground text-[11px]">
                              vence {inst.dueDate ? new Date(inst.dueDate + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}
                            </span>
                            <span className={`font-medium mr-3 ${inst.isPaid ? 'text-green-700' : 'text-amber-600'}`}>
                              {inst.isPaid ? '✅ Paga' : '⏳ Pendente'}
                            </span>
                            <span className="font-semibold w-20 text-right">{formatCurrency(inst.value)}</span>
                            <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-semibold w-16 text-center ${inst.isPaid ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                              {inst.isPaid ? 'Estornar' : 'Cancelar'}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="bg-blue-50 border-t px-3 py-2 space-y-0.5 text-xs">
                        {paid.length > 0 && (
                          <p className="text-red-700">
                            🔄 <strong>{paid.length}</strong> parcela{paid.length !== 1 ? 's' : ''} cobrada{paid.length !== 1 ? 's' : ''} ({formatCurrency(paidTotal)}) → estornar no Asaas
                          </p>
                        )}
                        {pending.length > 0 && (
                          <p className="text-gray-600">
                            ❌ <strong>{pending.length}</strong> parcela{pending.length !== 1 ? 's' : ''} pendente{pending.length !== 1 ? 's' : ''} ({formatCurrency(pendingTotal)}) → cancelar no Asaas
                          </p>
                        )}
                        <p className="text-blue-700 font-medium pt-0.5">
                          💰 Valor a estornar ao aluno: {formatCurrency(calc.refund)}
                        </p>
                      </div>
                    </>
                  );
                })() : (
                  <p className="text-xs text-muted-foreground text-center py-4">Nenhuma parcela encontrada</p>
                )}
              </div>
            )}

            {/* Motivo */}
            <div>
              <Label>Motivo do cancelamento</Label>
              <Textarea rows={2} className="mt-1" value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="Motivo do cancelamento..." />
            </div>

            {calc.refund > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800">
                {isScheduledCancellation ? (
                  <>ℹ️ Projeção: o estorno de <strong>{formatCurrency(calc.refund)}</strong> só é registrado em {formatDate(cancelDate)}, quando o cancelamento executar. Até lá não aparece como pendente no Financeiro, e desfazer o agendamento não deixa resíduo.</>
                ) : (
                  <>ℹ️ O estorno de <strong>{formatCurrency(calc.refund)}</strong> ficará como <strong>pendente</strong> no painel Financeiro até você confirmar que foi realizado.</>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setCancelModal(false)}>Voltar</Button>
              <Button
                className={`flex-1 text-white ${isScheduledCancellation ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-500 hover:bg-red-600'}`}
                onClick={cancelContract}
                disabled={cancelDateAtOrAfterEnd || cancelSaving}
                title={cancelDateAtOrAfterEnd ? 'Use Não renovar para fim natural de vigência' : undefined}
              >
                {isScheduledCancellation ? 'Agendar cancelamento' : 'Confirmar cancelamento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal de reabrir pagamento */}
      <Dialog open={reopenModal} onOpenChange={open => !open && !reopenLoading && setReopenModal(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <RotateCcw className="w-5 h-5" /> Reabrir pagamento
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <p className="font-semibold text-amber-900">Atenção</p>
              <p className="text-amber-800 mt-1">Isso vai <strong>desfazer</strong> o registro de pagamento manual:</p>
              <ul className="mt-2 ml-4 text-xs text-amber-700 list-disc space-y-0.5">
                <li>Apaga as parcelas projetadas no fluxo de caixa</li>
                <li>Status volta para <strong>Pendente</strong></li>
                <li>Forma e data são removidas</li>
              </ul>
              <p className="text-xs text-amber-700 mt-2">
                Use só se foi um registro errado.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setReopenModal(false)} disabled={reopenLoading}>Voltar</Button>
              <Button className="flex-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={reopenPayment} disabled={reopenLoading}>
                {reopenLoading ? 'Revertendo...' : 'Confirmar reabertura'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: editar datas */}
      <Dialog open={dateModal} onOpenChange={open => !open && !dateSaving && setDateModal(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-600" /> Editar datas do contrato
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Data de início</Label>
              <Input type="date" className="mt-1" value={dateForm.start_date}
                onChange={e => onDateStartChange(e.target.value)} />
              <p className="text-xs text-muted-foreground">A data final é recalculada automaticamente pelo período do plano.</p>
            </div>
            <div className="space-y-1">
              <Label>Data final</Label>
              <Input type="date" className="mt-1" value={dateForm.end_date}
                onChange={e => setDateForm(f => ({ ...f, end_date: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Pode ajustar manualmente se precisar adiar ou antecipar o término.</p>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setDateModal(false)} disabled={dateSaving}>
                Cancelar
              </Button>
              <Button className="flex-1" onClick={saveDates} disabled={dateSaving}>
                <Check className="w-3.5 h-3.5 mr-1" /> {dateSaving ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: cancelar cobrança Asaas */}
      <Dialog open={cancelChargeModal} onOpenChange={open => !open && !cancelChargeLoading && setCancelChargeModal(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <XCircle className="w-5 h-5" /> Cancelar cobrança Asaas
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm space-y-2">
              <p className="font-semibold text-amber-900">O que vai acontecer:</p>
              <div className="space-y-1 text-amber-800">
                <p>• A cobrança atual no Asaas será <strong>cancelada</strong></p>
                <p>• O link/PIX enviado anteriormente deixará de funcionar</p>
                <p>• O contrato continua <strong>ativo</strong> (não é um cancelamento de contrato)</p>
                <p>• Você poderá aplicar o desconto e gerar uma nova cobrança</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setCancelChargeModal(false)} disabled={cancelChargeLoading}>
                Voltar
              </Button>
              <Button className="flex-1 bg-red-500 hover:bg-red-600 text-white" onClick={cancelAsaasCharge} disabled={cancelChargeLoading}>
                {cancelChargeLoading ? 'Cancelando...' : 'Confirmar cancelamento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
