import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, User, UserCheck, FileText, Calendar, Zap, MessageCircle, Copy, Check, ExternalLink,
  Link2, QrCode, RefreshCw, History, Pause, XCircle, RotateCcw,
  HandCoins, Activity, Plus, PenLine, Banknote, RefreshCcw, Ban, AlertCircle,
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
} from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { DEFAULT_ASAAS_DUE_DAYS, defaultAsaasDueDate } from '@/lib/payment-methods';
import { isSafePaymentUrl } from '@/lib/sales';
import { phoneDigitsForWhatsApp, formatPhoneDisplay } from '@/lib/phone';
import { loadActivePaymentMethods, createManualInstallments, adjustManualInstallmentsValue, getPaymentMethodLabel } from '@/lib/manual-payment';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import DiscountInput from '@/components/DiscountInput';

function addPeriod(startStr, plan) {
  const d = new Date(startStr + 'T12:00:00');
  const months = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  d.setMonth(d.getMonth() + months);
  return toLocalDateStr(d);
}

function periodLabel(plan) {
  const m = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  const names = { 1: '1 mês', 2: '2 meses', 3: '3 meses', 6: '6 meses', 12: '12 meses' };
  return names[m] || `${m} meses`;
}
import { toast } from 'sonner';

const STATUS = {
  active:    { label: 'Ativo',     badge: 'success' },
  overdue:   { label: 'Atrasado',  badge: 'destructive' },
  on_leave:  { label: 'Em licença',badge: 'warning' },
  finished:  { label: 'Concluído', badge: 'secondary' },
  cancelled: { label: 'Cancelado', badge: 'destructive' },
};

const PAY = {
  pending:            { label: 'Aguardando',   badge: 'secondary' },
  paid:               { label: 'Pago',         badge: 'success' },
  overdue:            { label: 'Vencido',      badge: 'destructive' },
  refunded:           { label: 'Estornado',    badge: 'outline' },
  partially_refunded: { label: 'Est. parcial', badge: 'warning' },
};

// ─── Timeline de eventos ─────────────────────────────────────────────────────
const EVENT_META = {
  created:                  { icon: Plus,       color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Contrato criado' },
  coach_changed:            { icon: UserCheck,  color: 'text-purple-600', bg: 'bg-purple-50', label: 'Coach trocado' },
  plan_changed:             { icon: PenLine,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Plano alterado' },
  discount_applied:         { icon: HandCoins,  color: 'text-green-600',  bg: 'bg-green-50',  label: 'Desconto aplicado' },
  leave_started:            { icon: Pause,      color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Licença iniciada' },
  leave_ended:              { icon: RotateCcw,  color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Licença encerrada' },
  charge_generated:         { icon: Zap,        color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Cobrança gerada' },
  external_charge_registered: { icon: Link2,    color: 'text-amber-600',  bg: 'bg-amber-50',  label: 'Cobrança externa registrada' },
  external_charge_removed:    { icon: Link2,    color: 'text-gray-500',   bg: 'bg-gray-100',  label: 'Cobrança externa removida' },
  payment_message_sent:       { icon: MessageCircle, color: 'text-green-600', bg: 'bg-green-50', label: 'Mensagem de cobrança enviada' },
  manual_payment_recorded:  { icon: Banknote,   color: 'text-green-700',  bg: 'bg-green-50',  label: 'Pagamento manual' },
  renewed:                  { icon: RefreshCcw, color: 'text-green-600',  bg: 'bg-green-50',  label: 'Renovado' },
  cancelled:                { icon: Ban,        color: 'text-red-600',    bg: 'bg-red-50',    label: 'Cancelado' },
  refund_completed:         { icon: HandCoins,  color: 'text-purple-600', bg: 'bg-purple-50', label: 'Estorno realizado' },
};

function formatEventSummary(ev) {
  const p = ev.payload || {};
  switch (ev.event_type) {
    case 'created':
      return p.via === 'renewal'
        ? `Criado como renovação de ${p.parent_contract_num || '—'}`
        : (p.prior_cancelled > 0 ? `Aluno já cancelou ${p.prior_cancelled}x antes` : 'Contrato inicial');
    case 'coach_changed':
      return `${p.from_coach_name || '—'} → ${p.to_coach_name || '—'}`;
    case 'leave_started':
      return `${p.days} dia${p.days !== 1 ? 's' : ''}${p.reason ? ' · ' + p.reason : ''}`;
    case 'leave_ended':
      return `Após ${p.days || '?'} dia(s)`;
    case 'charge_generated':
      return `${p.billing_type || ''}${p.installments > 1 ? ` · ${p.installments}x` : ''}`;
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
    case 'cancelled':
      return `Multa R$ ${Number(p.cancellation_fee || 0).toFixed(2)} · Estorno R$ ${Number(p.refund_amount || 0).toFixed(2)}`;
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
            {ev.notes && ev.event_type !== 'leave_started' && (
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
  const [contract, setContract] = useState(null);
  const [student, setStudent]   = useState(null);
  const [coach, setCoach]       = useState(null);
  const [plan, setPlan]         = useState(null);
  const [modality, setModality] = useState(null);
  // Parcelas projetadas (asaas_payments) — detalhamento do pagamento
  const [paymentInstallments, setPaymentInstallments] = useState([]);
  const [coaches, setCoaches]   = useState([]);
  const [history, setHistory]   = useState([]);
  const [leaves, setLeaves]     = useState([]);
  const [events, setEvents]     = useState([]);
  const [parentContract, setParentContract] = useState(null);
  const [loading, setLoading]   = useState(true);

  // Modais
  const [changeCoachModal, setChangeCoachModal] = useState(false);
  const [newCoachId, setNewCoachId] = useState('');
  const [leaveModal, setLeaveModal] = useState(false);
  const [leaveForm, setLeaveForm] = useState({ start_date: todayLocalStr(), end_date: todayLocalStr(), reason: '' });
  const [cancelModal, setCancelModal]   = useState(false);
  const [voidModal, setVoidModal]       = useState(false);
  const [voiding, setVoiding]           = useState(false);
  const [reopenModal, setReopenModal]   = useState(false);
  const [reopenLoading, setReopenLoading] = useState(false);
  const [cancelDate, setCancelDate] = useState(todayLocalStr());  // Data de cancelamento (pode ser retroativa)
  const [cancelFeePct, setCancelFeePct] = useState(20);
  const [cancelReason, setCancelReason] = useState('');
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
  const [externalSaleForm, setExternalSaleForm]   = useState({ link: '', due_date: '' });
  const [externalSaleSaving, setExternalSaleSaving] = useState(false);
  // WhatsApp — preview e envio
  const [whatsappModal, setWhatsappModal] = useState(false);
  const [whatsappCopied, setWhatsappCopied] = useState(false);
  const [methodGroups, setMethodGroups]     = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const c = await AssessmentContract.get(id);
      setContract(c);
      const [s, co, p, allC, h, l, ev] = await Promise.all([
        PreSaleCustomer.get(c.customer_id).catch(() => null),
        c.coach_id ? AssessmentCoach.get(c.coach_id).catch(() => null) : Promise.resolve(null),
        AssessmentPlan.get(c.plan_id).catch(() => null),
        AssessmentCoach.filter({ active: true }, 'name').catch(() => []),
        AssessmentContractCoachHist.filter({ contract_id: id }).catch(() => []),
        AssessmentLeave.filter({ contract_id: id }, '-start_date').catch(() => []),
        AssessmentContractEvent.filter({ contract_id: id }, '-created_at').catch(() => []),
      ]);
      setStudent(s); setCoach(co); setPlan(p); setCoaches(allC);
      setHistory(h.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || '')));
      setLeaves(l);
      setEvents(ev);
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
  };

  useEffect(() => { load(); }, [id]);

  // Lê valor do plano: prefere o snapshot gravado no contrato (histórico preservado),
  // cai pro plano vivo se snapshot ausente (contratos legados pré-backfill).
  const planVal = (field) => {
    const snap = contract?.plan_snapshot;
    if (snap && snap[field] != null) return snap[field];
    return plan?.[field];
  };

  // Registra evento de auditoria — best-effort, nunca quebra a ação principal
  const logEvent = async (event_type, payload = {}, notes = null) => {
    try {
      await AssessmentContractEvent.create({ contract_id: id, event_type, payload, notes });
    } catch (e) {
      console.warn(`[contract_event] falha ao registrar ${event_type}:`, e.message);
    }
  };

  // ───────── ACTIONS ─────────
  // Abre modal de confirmação (não chama Asaas ainda)
  const openChargeConfirm = (billing_type = 'PIX') => {
    if (!student?.cpf) return toast.error('Cadastre o CPF do aluno antes de gerar cobrança');
    setChargeConfirmModal(billing_type);
  };

  const generateCharge = async (billing_type = 'PIX') => {
    if (!student?.cpf) return toast.error('Cadastre o CPF do aluno antes de gerar cobrança');
    setChargeLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-assessment-charge', {
        body: { contract_id: id, installments: contract.installments, cpf: student.cpf, billing_type, due_date: chargeDueDate },
      });
      // Quando edge function retorna não-2xx, supabase-js cria erro genérico.
      // Extraímos o body da resposta pra mostrar mensagem real.
      if (error) {
        let realMessage = error.message;
        try {
          if (error.context && typeof error.context.json === 'function') {
            const body = await error.context.json();
            if (body?.error) realMessage = body.error;
            if (body?.asaas_details?.errors?.[0]?.description) {
              realMessage = body.asaas_details.errors[0].description;
            }
            console.error('[generate-charge details]', body);
          }
        } catch { /* ignora parse error */ }
        throw new Error(realMessage);
      }
      if (data?.error) throw new Error(data.error);
      await logEvent('charge_generated', {
        billing_type,
        installments: contract.installments,
        due_date: chargeDueDate,
        asaas_charge_id: data?.asaas_charge_id || null,
      });
      toast.success('Cobrança gerada!');
      setChargeConfirmModal(null);
      load();
    } catch (e) { toast.error(e.message || 'Erro ao gerar cobrança'); }
    finally { setChargeLoading(false); }
  };

  const changeCoach = async () => {
    if (!newCoachId || newCoachId === contract.coach_id) return setChangeCoachModal(false);
    try {
      const oldCoach = coach;
      const newCoach = coaches.find(c => c.id === newCoachId);
      await AssessmentContract.update(id, { coach_id: newCoachId });
      await logEvent('coach_changed', {
        from_coach_id:   contract.coach_id,
        from_coach_name: oldCoach?.name || null,
        to_coach_id:     newCoachId,
        to_coach_name:   newCoach?.name || null,
      });
      toast.success('Coach trocado!'); setChangeCoachModal(false); load();
    } catch (e) { toast.error(e.message); }
  };

  const addLeave = async () => {
    if (!leaveForm.start_date || !leaveForm.end_date) return toast.error('Datas obrigatórias');
    if (leaveForm.end_date < leaveForm.start_date) return toast.error('Fim antes do início');
    if (contract.status === 'on_leave') return toast.error('Contrato já está em licença');
    try {
      const days = Math.round(
        (new Date(leaveForm.end_date + 'T12:00:00') - new Date(leaveForm.start_date + 'T12:00:00')) / 86400000
      ) + 1;
      // Estender vencimento do contrato pelos dias de licença
      const newEnd = new Date(contract.end_date + 'T12:00:00');
      newEnd.setDate(newEnd.getDate() + days);
      const newEndStr = toLocalDateStr(newEnd);

      await Promise.all([
        AssessmentLeave.create({
          contract_id: id,
          start_date:  leaveForm.start_date,
          end_date:    leaveForm.end_date,
          days,
          status:      'active',
          reason:      leaveForm.reason || null,
        }),
        AssessmentContract.update(id, {
          status:   'on_leave',
          end_date: newEndStr,
        }),
      ]);
      await logEvent('leave_started', {
        leave_start: leaveForm.start_date,
        leave_end:   leaveForm.end_date,
        days,
        reason:      leaveForm.reason || null,
        old_end_date: contract.end_date,
        new_end_date: newEndStr,
      });
      toast.success(`Licença registrada (${days} dias). Novo vencimento: ${formatDate(newEndStr)}.`);
      setLeaveModal(false);
      setLeaveForm({ start_date: todayLocalStr(), end_date: todayLocalStr(), reason: '' });
      load();
    } catch (e) { toast.error(e.message); }
  };

  const finishLeave = async (leave) => {
    if (!confirm(`Encerrar licença de ${leave.days} dias? O aluno retorna ao plano.`)) return;
    try {
      const today     = todayLocalStr();
      const newStatus = contract.end_date < today ? 'overdue' : 'active';
      await Promise.all([
        AssessmentLeave.update(leave.id, { status: 'finished' }),
        AssessmentContract.update(id, { status: newStatus }),
      ]);
      await logEvent('leave_ended', {
        leave_id: leave.id,
        days:     leave.days,
        new_status: newStatus,
      });
      toast.success(`Licença encerrada. Aluno ${newStatus === 'active' ? 'retornou ao plano ativo' : 'com contrato vencido'}.`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  // Calcula valor restante proporcional aos dias não usufruídos
  // Usa cancelDate (data de cancelamento, pode ser retroativa) ou today como data de corte
  const cancellationCalc = (cancelDateStr = null) => {
    if (!contract || !plan) return { remaining: 0, fee: 0, refund: 0 };
    const cutoffDate = cancelDateStr ? new Date(cancelDateStr + 'T00:00:00') : new Date();
    cutoffDate.setHours(0, 0, 0, 0);
    const start = new Date(contract.start_date + 'T00:00:00');
    const end   = new Date(contract.end_date + 'T00:00:00');
    const totalDays   = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const remainingDays = Math.max(0, Math.round((end - cutoffDate) / 86400000) + 1);
    const remaining = Number(planVal('price_total') || 0) * (remainingDays / totalDays);
    const fee = remaining * (Number(cancelFeePct) / 100);
    const refund = Math.max(0, remaining - fee);
    return { remainingDays, remaining: Math.round(remaining * 100) / 100, fee: Math.round(fee * 100) / 100, refund: Math.round(refund * 100) / 100 };
  };

  // Abre modal de cancelamento e já busca parcelas do Asaas
  const openCancelModal = async () => {
    setCancelModal(true);
    setCancelInstData(null);
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
    const c = cancellationCalc(cancelDate);
    const isRetroactive = cancelDate < todayLocalStr();
    const retroactiveNote = isRetroactive ? ` (retroativo de ${formatDate(cancelDate)})` : '';
    if (!confirm(`Cancelar contrato com multa de ${formatCurrency(c.fee)} (${cancelFeePct}%)? Estorno: ${formatCurrency(c.refund)}.${retroactiveNote}`)) return;
    try {
      await AssessmentContract.update(id, {
        status:              'cancelled',
        cancellation_date:   cancelDate,  // Data de cancelamento (pode ser retroativa)
        cancellation_fee:    c.fee,
        cancellation_reason: cancelReason || null,
        // Controle de estorno pendente
        refund_status: c.refund > 0 ? 'pending' : null,
        refund_amount: c.refund > 0 ? c.refund  : null,
      });
      await logEvent('cancelled', {
        remaining_days:      c.remainingDays,
        remaining_value:     c.remaining,
        cancellation_fee:    c.fee,
        cancellation_fee_pct: Number(cancelFeePct),
        refund_amount:       c.refund,
        cancellation_reason: cancelReason || null,
        cancellation_date:   cancelDate,  // Data quando foi cancelado
        payment_status_before: contract.payment_status,
      }, cancelReason || null);
      toast.success(c.refund > 0 ? 'Contrato cancelado. Estorno registrado como pendente.' : 'Contrato cancelado.');
      setCancelModal(false);
      // Reset cancel form
      setCancelDate(todayLocalStr());
      setCancelReason('');
      load();
    } catch (e) { toast.error(e.message); }
  };

  // Anular venda — para contratos NÃO pagos (pending/awaiting_charge/charge_sent/overdue).
  // Diferente de cancelContract porque:
  //   - Não calcula multa nem refund (nada foi pago)
  //   - Cancela cobrança Asaas via API (se houver) pra não ficar vagando
  //   - Marca payment_status='cancelled' (trigger SQL limpa asaas_payments)
  //   - Coach já está protegido (edge function exige payment_status='paid')
  const voidContract = async () => {
    setVoiding(true);
    try {
      // 1. Se tem cobrança Asaas ativa, cancela primeiro (best-effort)
      if (contract.asaas_charge_id) {
        try {
          const { error } = await supabase.functions.invoke('create-asaas-charge', {
            body: { action: 'cancel', order_id: id, order_type: 'contract' },
          });
          if (error) console.warn('[voidContract] Asaas cancel falhou:', error);
        } catch (e) {
          console.warn('[voidContract] Asaas cancel exception:', e);
          // não bloqueia — usuário pode cancelar manualmente no Asaas depois
        }
      }

      // 2. Marca contrato como anulado (status + payment_status = cancelled)
      // Trigger SQL cuida de zerar asaas_payments associados.
      await AssessmentContract.update(id, {
        status:              'cancelled',
        payment_status:      'cancelled',
        cancellation_date:   todayLocalStr(),
        cancellation_fee:    0,
        cancellation_reason: 'Venda não concretizada (cliente nunca pagou)',
        refund_status:       null,
        refund_amount:       null,
        // Limpa referências da cobrança Asaas
        asaas_charge_id:     null,
        asaas_payment_link:  null,
        asaas_pix_copy:      null,
      });

      // 3. Log de evento distinto (sale_voided ≠ cancelled)
      await logEvent('sale_voided', {
        had_asaas_charge:     !!contract.asaas_charge_id,
        previous_payment_status: contract.payment_status,
        previous_due_date:    contract.due_date,
      }, 'Venda não concretizada');

      toast.success('Venda anulada. Cobrança Asaas cancelada e contrato encerrado sem multa.');
      setVoidModal(false);
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao anular venda');
    } finally {
      setVoiding(false);
    }
  };

  // Detecta se o contrato está em estado "não pago" — permite anular venda
  const isUnpaid = contract && !['paid', 'refunded', 'cancelled'].includes(contract.payment_status || '');

  // Reabre pagamento manual: desfaz registro e volta a status anterior.
  const reopenPayment = async () => {
    setReopenLoading(true);
    try {
      // 1. Apaga parcelas manuais em asaas_payments
      await supabase.from('asaas_payments')
        .delete()
        .eq('order_id', id)
        .eq('order_type', 'contract')
        .eq('source', 'manual');

      // 2. Reseta contrato
      await AssessmentContract.update(id, {
        payment_status: 'pending',
        payment_date:   null,
        payment_method: null,
        manual_payment: false,
        manual_fee:     null,
      });

      await logEvent('payment_reverted', {
        method_before: contract.payment_method,
        fee_before:    contract.manual_fee,
      }, 'Pagamento manual revertido');

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
      const newStart = contract.end_date;
      const newEnd   = addPeriod(newStart, plan);
      const created  = await AssessmentContract.create({
        customer_id:        contract.customer_id,
        coach_id:           contract.coach_id,
        plan_id:            contract.plan_id,
        start_date:         newStart,
        end_date:           newEnd,
        original_end_date:  newEnd,
        due_date:           defaultAsaasDueDate(),
        installments:       contract.installments,
        enrollment_fee:     0,
        auto_renewal:       contract.auto_renewal ?? false,
        parent_contract_id: contract.id,
        notes:              `Renovação manual de ${contract.contract_number}`,
        // Copia desconto se marcado como recorrente
        ...(contract.discount_recurring && contract.manual_discount > 0 ? {
          manual_discount:    contract.manual_discount,
          discount_reason:    contract.discount_reason || null,
          discount_recurring: true,
        } : {}),
      });
      await AssessmentContract.update(id, { renewal_generated: true, status: 'finished' });
      await logEvent('renewed', {
        new_contract_id:     created.id,
        new_contract_number: created.contract_number,
        new_start: newStart,
        new_end:   newEnd,
        plan_id:   contract.plan_id,
        installments: contract.installments,
        had_open_payment: hasOpenPayment,
      });
      // Registra também no novo contrato pra rastrear que ele é uma renovação
      try {
        await AssessmentContractEvent.create({
          contract_id: created.id,
          event_type:  'created',
          payload: {
            via:                  'renewal',
            parent_contract_id:   contract.id,
            parent_contract_num:  contract.contract_number,
            plan_id:              contract.plan_id,
            installments:         contract.installments,
          },
          notes: `Renovação de ${contract.contract_number}`,
        });
      } catch { /* best-effort */ }
      toast.success(`Contrato ${created.contract_number} criado!`);
      setRenewModal(false);
      navigate(`/assessoria/contratos/${created.id}`);
    } catch (e) { toast.error(e.message || 'Erro ao renovar'); }
    finally { setRenewLoading(false); }
  };

  const toggleAutoRenewal = async () => {
    try {
      await AssessmentContract.update(id, { auto_renewal: !contract.auto_renewal });
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
        method_id:    defaultMethod?.id || '',
        date:         todayLocalStr(),
        value:        total.toFixed(2),
        installments: 1,
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
      );
      await logEvent('manual_payment_recorded', {
        method:       method.internal_code || method.kind,
        method_name:  method.name,
        date:         manualPayForm.date,
        value:        totalV,
        fee:          result.total_fee,
        installments: result.installments,
      });
      toast.success(`Pagamento registrado! ${result.installments > 1 ? `${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      load();
    } catch (e) { toast.error(e.message); }
    finally { setManualPaySaving(false); }
  };

  const buildMessage = () => {
    if (!contract || !student || !plan || !modality) return '';
    const total       = Number(planVal('price_total') || 0) - (contract.credit_balance || 0);
    const enrollment  = Number(contract.enrollment_fee || 0);
    const installments = contract.installments || 1;
    const instValue   = installments > 1 ? total / installments : null;
    const pix         = contract.asaas_pix_copy;
    const link        = contract.asaas_payment_link || contract.external_payment_link;
    const firstName   = (student.full_name || '').split(' ')[0] || 'aluno(a)';

    let m = `Olá, ${firstName}!\n\n`;
    m += `Sua adesão na *Assessoria Esportiva Endurance On* está confirmada! 💙🧡\n\n`;
    m += `🏃 Modalidade: *${modality.name.charAt(0).toUpperCase() + modality.name.slice(1)}*\n`;
    const periodName = { mensal: 'Mensal', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual' }[plan?.period] || periodLabel(plan);
    m += `📅 Plano: *${periodName}*\n`;
    if (coach?.name) m += `👤 Coach: *${coach.name}*\n`;
    m += `💰 Total: *${formatCurrency(total)}*`;
    if (instValue) m += ` em *${installments}x de ${formatCurrency(instValue)}*`;
    m += '\n';
    if (enrollment > 0) m += `📌 Matrícula: ${formatCurrency(enrollment)} _(cobrada na 1ª mensalidade)_\n`;
    if (contract.due_date) m += `📆 Vencimento: *${formatDate(contract.due_date)}*\n`;
    m += '\n';
    if (pix)  m += `📲 PIX Copia e Cola:\n\`${pix}\`\n\n`;
    if (link) m += `🔗 Link de pagamento:\n${link}\n\n`;
    m += `Qualquer dúvida, estou à disposição!`;
    return m;
  };

  const openWhatsApp = () => {
    if (!student) return;
    setWhatsappCopied(false);
    setWhatsappModal(true);
  };

  const sendWhatsAppDirect = () => {
    const phone = phoneDigitsForWhatsApp(student.whatsapp);
    const msg = buildMessage();
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const copyWhatsAppMessage = () => {
    navigator.clipboard.writeText(buildMessage()).then(() => {
      setWhatsappCopied(true);
      setTimeout(() => setWhatsappCopied(false), 2000);
    });
  };

  const markMessageSent = async () => {
    try {
      const updates = { payment_message_sent_at: new Date().toISOString() };
      if (['pending', 'awaiting_charge'].includes(contract.payment_status)) {
        updates.payment_status = 'charge_sent';
      }
      await AssessmentContract.update(id, updates);
      await logEvent('payment_message_sent', {
        via: 'whatsapp',
        has_asaas_link:   !!contract.asaas_payment_link,
        has_external_link: !!contract.external_payment_link,
      });
      toast.success('Mensagem marcada como enviada!');
      setWhatsappModal(false);
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar envio');
    }
  };

  const openExternalSaleModal = () => {
    setExternalSaleForm({
      link:     contract?.external_payment_link || '',
      due_date: contract?.due_date || defaultAsaasDueDate(),
    });
    setExternalSaleModal(true);
  };

  const saveExternalSale = async () => {
    const link = externalSaleForm.link.trim();
    const dueDate = externalSaleForm.due_date;
    if (!link)                  return toast.error('Informe o link de cobrança');
    if (!isSafePaymentUrl(link)) return toast.error('Link inválido — deve começar com https://');
    if (!dueDate)                return toast.error('Informe a data de vencimento');

    setExternalSaleSaving(true);
    try {
      const updates = {
        external_payment_link: link,
        due_date:              dueDate,
      };
      if (['pending', 'awaiting_charge'].includes(contract.payment_status)) {
        updates.payment_status = 'charge_sent';
      }
      await AssessmentContract.update(id, updates);
      await logEvent('external_charge_registered', { link, due_date: dueDate });
      toast.success('Cobrança externa registrada! Agora envie a mensagem pro aluno.');
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
      const updates = {
        external_payment_link:   null,
        payment_message_sent_at: null,
      };
      if (contract.payment_status === 'charge_sent') {
        updates.payment_status = 'pending';
      }
      await AssessmentContract.update(id, updates);
      await logEvent('external_charge_removed', {});
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
  const canCancel = !['cancelled', 'finished'].includes(contract.status);

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
          <Badge variant={st.badge}>{st.label}</Badge>
          <Badge variant={ps.badge}>{ps.label}</Badge>
          {student?.whatsapp && <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsApp}><MessageCircle className="w-4 h-4 mr-1" /> WhatsApp</Button>}
        </div>
      </div>

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
                  {formatDate(activeLeave.start_date)} → {formatDate(activeLeave.end_date)} ({activeLeave.days} dias)
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
            <Link to={`/clientes/${student?.id}`} className="font-semibold hover:underline">{student?.full_name}</Link>
            <p className="text-xs text-muted-foreground">{student?.whatsapp} {student?.email && `· ${student.email}`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><UserCheck className="w-4 h-4" /> Coach atual</CardTitle></CardHeader>
          <CardContent>
            <p className="font-semibold">{coach?.name}</p>
            <p className="text-xs text-muted-foreground capitalize">{coach?.role}</p>
            {canCancel && <button onClick={() => { setNewCoachId(coach?.id || ''); setChangeCoachModal(true); }} className="text-xs text-blue-600 hover:underline mt-1.5 inline-flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Trocar coach</button>}
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
          <div className="border-t mt-4 pt-3 flex items-center justify-between text-sm flex-wrap gap-2">
            <span><Calendar className="w-3.5 h-3.5 inline mr-1" /> {formatDate(contract.start_date)} → {formatDate(contract.end_date)}</span>
            <div className="flex items-center gap-2 flex-wrap">
              {contract.original_end_date !== contract.end_date && (
                <span className="text-xs text-amber-700">Original: {formatDate(contract.original_end_date)} (estendido por licenças)</span>
              )}
              <button
                onClick={toggleAutoRenewal}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-all ${
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
        </CardContent>
      </Card>

      {/* Desconto manual */}
      <DiscountInput
        subtotal={Number(plan?.price_total || 0) + (Number(contract.enrollment_fee) || 0)}
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
          await AssessmentContract.update(contract.id, {
            manual_discount:    newValue,
            discount_reason:    reason || null,
            discount_recurring: recurring || false,
          });
          // Recalcula parcelas manuais se já estava pago manualmente
          if (contract.manual_payment && contract.payment_status === 'paid') {
            const basePrice = Number(planVal('price_total')) || 0;
            const enroll    = Number(contract.enrollment_fee) || 0;
            const newTotal  = Math.max(0, basePrice + enroll - newValue);
            await adjustManualInstallmentsValue(
              { order_id: contract.id, order_type: 'contract' },
              newTotal,
            );
          }
          await load();
        }}
      />

      {/* Status do pagamento (read-only + detalhamento) — aparece quando PAID ou REFUNDED */}
      {['paid', 'refunded'].includes(contract.payment_status) && (() => {
        const activeInstallments = paymentInstallments.filter(p => !['CANCELLED','REFUNDED'].includes(p.status));
        const totalGross = activeInstallments.reduce((s,p) => s + (Number(p.value) || 0), 0);
        const totalNet   = activeInstallments.reduce((s,p) => s + (Number(p.net_value) || 0), 0);
        const totalFee   = totalGross - totalNet;
        const registeredAt = activeInstallments[0]?.last_synced_at || activeInstallments[0]?.created_at
                          || paymentInstallments[0]?.last_synced_at || paymentInstallments[0]?.created_at;
        const sourceLabel = contract.manual_payment ? 'Registro manual' : 'Cobrança Asaas';
        const sourceBadgeColor = contract.manual_payment ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700';
        const methodLabel = getPaymentMethodLabel(contract.payment_method);
        const planTotal = Number(planVal('price_total')) || 0;
        const enroll    = Number(contract.enrollment_fee) || 0;
        const totalPaid = planTotal + enroll - (Number(contract.manual_discount) || 0);
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

              {/* Breakdown bruto / taxa / líquido */}
              {(totalFee > 0 || totalGross > 0) && (
                <div className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div className="bg-gray-50 border rounded-lg py-2">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Bruto</p>
                    <p className="font-semibold mt-0.5">{formatCurrency(totalGross)}</p>
                  </div>
                  <div className="bg-gray-50 border rounded-lg py-2">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Taxa</p>
                    <p className="font-semibold mt-0.5 text-red-600">−{formatCurrency(totalFee)}</p>
                  </div>
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg py-2">
                    <p className="text-[10px] text-emerald-700 uppercase tracking-wide">Líquido</p>
                    <p className="font-bold mt-0.5 text-emerald-700">{formatCurrency(totalNet)}</p>
                  </div>
                </div>
              )}

              {/* Parcelas projetadas */}
              {activeInstallments.length > 0 && (
                <div className="border rounded-xl overflow-hidden">
                  <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    {activeInstallments.length === 1
                      ? 'Recebimento no fluxo de caixa'
                      : `${activeInstallments.length} parcelas no fluxo de caixa`}
                  </div>
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
                            <p className="font-semibold text-sm">{formatCurrency(p.net_value || p.value || 0)}</p>
                            {Number(p.value) !== Number(p.net_value) && (
                              <p className="text-[10px] text-muted-foreground">bruto {formatCurrency(p.value)}</p>
                            )}
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
                      disabled={reopenLoading}
                    >
                      <Zap className="w-3.5 h-3.5 mr-1.5" /> Converter pra cobrança Asaas
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-amber-700 border-amber-300 hover:bg-amber-50"
                      onClick={() => setReopenModal(true)}
                      disabled={reopenLoading}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reabrir pagamento
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <strong>Converter:</strong> desfaz o registro manual e libera o card de cobrança Asaas. ·{' '}
                    <strong>Reabrir:</strong> só desfaz (use se foi erro de registro).
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Cobrança Asaas — só aparece se ainda há ação a tomar */}
      {!['paid', 'refunded', 'cancelled'].includes(contract.payment_status) && contract.status !== 'cancelled' && (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Zap className="w-4 h-4 text-blue-600" /> Cobrança Asaas</CardTitle></CardHeader>
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
            <div className="space-y-3">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Link2 className="w-4 h-4 text-amber-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-amber-800">Cobrança externa registrada</p>
                    <p className="text-sm text-amber-700 truncate">{contract.external_payment_link}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(contract.external_payment_link); toast.success('Link copiado!'); }}>
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="flex items-center justify-between text-xs text-amber-800">
                  <span>📆 Vence em <strong>{contract.due_date ? formatDate(contract.due_date) : '—'}</strong></span>
                  {contract.payment_message_sent_at ? (
                    <span className="text-green-700 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Mensagem enviada em {formatDate(contract.payment_message_sent_at)}
                    </span>
                  ) : (
                    <span className="text-amber-700 italic">Mensagem ainda não enviada</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 justify-center flex-wrap border-t pt-3">
                {student?.whatsapp && (
                  <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={openWhatsApp}>
                    <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> Enviar via WhatsApp
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={openExternalSaleModal}>
                  <PenLine className="w-3.5 h-3.5 mr-1.5" /> Editar link
                </Button>
                <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={removeExternalSale}>
                  <XCircle className="w-3.5 h-3.5 mr-1.5" /> Remover
                </Button>
                <Button size="sm" variant="outline" className="text-green-700 border-green-300 hover:bg-green-50" onClick={openManualPay}>
                  <HandCoins className="w-3.5 h-3.5 mr-1.5" /> Marcar como pago
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-center py-2">
                <p className="text-sm text-muted-foreground mb-3">Nenhuma cobrança gerada ainda</p>
                {!student?.cpf && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 inline-block mb-3">⚠ Cadastre o CPF do aluno primeiro</p>}
                <div className="flex gap-2 justify-center flex-wrap">
                  <Button size="sm" onClick={() => openChargeConfirm('PIX')} disabled={chargeLoading || !student?.cpf}><Zap className="w-3.5 h-3.5 mr-1" /> Gerar via Asaas (PIX)</Button>
                  <Button size="sm" variant="outline" onClick={() => openChargeConfirm('BOLETO')} disabled={chargeLoading || !student?.cpf}>Boleto</Button>
                  <Button size="sm" variant="outline" onClick={() => openChargeConfirm('CREDIT_CARD')} disabled={chargeLoading || !student?.cpf}>Cartão {contract.installments}x</Button>
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

      {/* Aviso simples para contratos cancelados */}
      {(contract.status === 'cancelled' || contract.payment_status === 'cancelled') && (
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
      {history.length > 1 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" /> Histórico de coaches</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {history.map(h => {
                const c = coaches.find(x => x.id === h.coach_id);
                return (
                  <div key={h.id} className="flex items-center justify-between">
                    <span className="font-medium">{c?.name || '—'}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(h.started_at)} → {h.ended_at ? formatDate(h.ended_at) : 'atual'}</span>
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
                    <p className="font-medium">{formatDate(l.start_date)} → {formatDate(l.end_date)} <span className="text-xs text-muted-foreground">({l.days} dias)</span></p>
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
      {canCancel && (
        <Card className="border-gray-100">
          <CardContent className="pt-4 flex flex-wrap gap-2">
            {!contract.renewal_generated && (
              <Button
                variant="outline"
                className="text-blue-600 hover:bg-blue-50 border-blue-200"
                onClick={() => setRenewModal(true)}
              >
                <RotateCcw className="w-4 h-4 mr-1.5" /> Renovar contrato
              </Button>
            )}
            {isUnpaid ? (
              <Button
                variant="outline"
                className="text-amber-700 border-amber-300 hover:bg-amber-50"
                onClick={() => setVoidModal(true)}
                title="Cliente nunca pagou — anula a venda sem multa nem cobrança ao coach"
              >
                <XCircle className="w-4 h-4 mr-1.5" /> Anular venda
              </Button>
            ) : (
              <Button
                variant="outline"
                className="text-red-600 hover:bg-red-50"
                onClick={openCancelModal}
              >
                <XCircle className="w-4 h-4 mr-1.5" /> Cancelar contrato
              </Button>
            )}
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
                      <p className="mt-1 text-[11px] text-muted-foreground">padrão D+{DEFAULT_ASAAS_DUE_DAYS}</p>
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
                      <span>+ Taxa de matrícula</span>
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
              {coaches.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({c.role})</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">A troca é registrada no histórico. No fechamento mensal cada coach recebe proporcional aos dias.</p>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setChangeCoachModal(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={changeCoach}>Confirmar troca</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: licença */}
      <Dialog open={leaveModal} onOpenChange={setLeaveModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Registrar licença</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Início</Label><Input type="date" value={leaveForm.start_date} onChange={e => setLeaveForm(f => ({ ...f, start_date: e.target.value }))} /></div>
              <div><Label>Fim</Label><Input type="date" value={leaveForm.end_date} onChange={e => setLeaveForm(f => ({ ...f, end_date: e.target.value }))} /></div>
            </div>
            <div><Label>Motivo (opcional)</Label><Textarea rows={2} value={leaveForm.reason} onChange={e => setLeaveForm(f => ({ ...f, reason: e.target.value }))} /></div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-700">
              O vencimento do contrato será estendido automaticamente pelos dias de licença.
            </div>
            <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setLeaveModal(false)}>Cancelar</Button><Button className="flex-1" onClick={addLeave}>Registrar</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: Enviar via WhatsApp */}
      <Dialog open={whatsappModal} onOpenChange={setWhatsappModal}>
        <DialogContent className="max-w-lg" onInteractOutside={e => e.preventDefault()} onFocusOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-green-600" /> Enviar mensagem via WhatsApp
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {!contract.asaas_charge_id && !contract.external_payment_link && (
              <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                <span className="text-amber-800">
                  Sem cobrança gerada. A mensagem irá <strong>sem link de pagamento</strong>.
                  Considere gerar uma cobrança Asaas ou cadastrar uma externa antes.
                </span>
              </div>
            )}

            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm whitespace-pre-wrap font-mono max-h-[50vh] overflow-y-auto text-green-900">
              {buildMessage()}
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <MessageCircle className="w-3 h-3" />
              <span>Para: <strong>{formatPhoneDisplay(student?.whatsapp)}</strong></span>
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={copyWhatsAppMessage}>
                {whatsappCopied ? <><Check className="w-4 h-4 mr-1.5 text-green-600" /> Copiado!</> : <><Copy className="w-4 h-4 mr-1.5" /> Copiar mensagem</>}
              </Button>
              <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={sendWhatsAppDirect}>
                <ExternalLink className="w-4 h-4 mr-1.5" /> Abrir WhatsApp
              </Button>
            </div>

            <div className="border-t pt-3">
              <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white" onClick={markMessageSent}>
                <Check className="w-4 h-4 mr-1.5" /> Marcar como enviada
              </Button>
              <p className="text-[11px] text-muted-foreground text-center mt-1.5">
                Depois de enviar a mensagem pelo WhatsApp, clique aqui pra registrar o envio.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* MODAL: cadastrar/editar cobrança externa */}
      <Dialog open={externalSaleModal} onOpenChange={setExternalSaleModal}>
        <DialogContent className="max-w-md" onInteractOutside={e => e.preventDefault()} onFocusOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-amber-600" /> Cadastrar cobrança externa
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Use quando a cobrança foi gerada fora da plataforma (Asaas no painel, Stone, etc.).
              O contrato entra em "vendas em aberto" e você acompanha pelo painel.
            </p>
            <div>
              <Label className="text-xs">Link de pagamento *</Label>
              <Input
                className="mt-1 font-mono text-xs"
                placeholder="https://..."
                value={externalSaleForm.link}
                onChange={e => setExternalSaleForm(f => ({ ...f, link: e.target.value }))}
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground mt-1">Cole aqui o link da cobrança gerada externamente.</p>
            </div>
            <div>
              <Label className="text-xs">Data de vencimento *</Label>
              <Input
                className="mt-1"
                type="date"
                value={externalSaleForm.due_date}
                onChange={e => setExternalSaleForm(f => ({ ...f, due_date: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setExternalSaleModal(false)} disabled={externalSaleSaving}>
                Cancelar
              </Button>
              <Button className="flex-1" onClick={saveExternalSale} disabled={externalSaleSaving}>
                <Check className="w-4 h-4 mr-1.5" />
                {externalSaleSaving ? 'Salvando...' : 'Salvar cobrança'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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

      {/* MODAL: anular venda (contrato não pago) */}
      <Dialog open={voidModal} onOpenChange={open => !open && !voiding && setVoidModal(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <XCircle className="w-5 h-5" /> Anular venda
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm space-y-2">
              <p className="font-semibold text-amber-900">
                Este contrato nunca foi pago.
              </p>
              <p className="text-amber-800">
                Como o cliente não chegou a pagar (status: <strong>{contract?.payment_status}</strong>),
                não há multa nem reembolso a calcular. A operação é simples e reversível pelo histórico.
              </p>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600 shrink-0" />
                <span>Contrato é marcado como <strong>cancelado</strong></span>
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
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setVoidModal(false)} disabled={voiding}>
                Voltar
              </Button>
              <Button
                className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
                onClick={voidContract}
                disabled={voiding}
              >
                {voiding ? 'Anulando...' : 'Confirmar anulação'}
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

            {/* Data de cancelamento (pode ser retroativa) */}
            <div>
              <Label>Data do cancelamento (quando foi solicitado)</Label>
              <Input type="date" className="mt-1"
                min={contract.start_date}
                max={todayLocalStr()}
                value={cancelDate}
                onChange={e => { setCancelDate(e.target.value); }}
              />
              {cancelDate < todayLocalStr() && (
                <p className="text-xs text-amber-600 mt-1">⚠️ Cancelamento retroativo — ajusta cálculo e relatórios</p>
              )}
            </div>

            {/* Resumo proporcional */}
            <div className="bg-gray-50 border rounded-xl p-3 text-sm grid grid-cols-2 gap-y-1">
              <span className="text-muted-foreground">Dias restantes</span>
              <span className="font-semibold text-right">{calc.remainingDays}</span>
              <span className="text-muted-foreground">Valor proporcional</span>
              <span className="font-semibold text-right">{formatCurrency(calc.remaining)}</span>
            </div>

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
                          💰 Valor líquido a estornar ao aluno: {formatCurrency(calc.refund)}
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
                ℹ️ O estorno de <strong>{formatCurrency(calc.refund)}</strong> ficará como <strong>pendente</strong> no painel Financeiro até você confirmar que foi realizado.
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setCancelModal(false)}>Voltar</Button>
              <Button className="flex-1 bg-red-500 hover:bg-red-600 text-white" onClick={cancelContract}>
                Confirmar cancelamento
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
                <li>Forma, data e taxa são removidos</li>
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
    </div>
  );
}
