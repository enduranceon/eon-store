import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, User, UserCheck, FileText, Calendar, Zap, MessageCircle, Copy, Check, ExternalLink,
  QrCode, RefreshCw, History, Pause, XCircle, AlertTriangle, RotateCcw, ArrowUpRight, ArrowDownRight,
  HandCoins, Activity, Plus, PenLine, Banknote, RefreshCcw, Ban,
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
import { suggestFeePercent } from '@/lib/payment-methods';
import { loadActivePaymentMethods, calcFee, createManualInstallments } from '@/lib/manual-payment';
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
  const [cancelFeePct, setCancelFeePct] = useState(20);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelInstData, setCancelInstData]         = useState(null);  // parcelas Asaas
  const [loadingCancelInst, setLoadingCancelInst]   = useState(false);
  const [chargeLoading, setChargeLoading] = useState(false);
  const [chargeConfirmModal, setChargeConfirmModal] = useState(null); // null | 'PIX' | 'BOLETO' | 'CREDIT_CARD'
  const [renewModal, setRenewModal]         = useState(false);
  const [renewLoading, setRenewLoading]     = useState(false);
  const [manualPayModal, setManualPayModal] = useState(false);
  const [manualPayForm, setManualPayForm]   = useState({ method_id: '', date: '', value: '' });
  const [manualPaySaving, setManualPaySaving] = useState(false);
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
        body: { contract_id: id, installments: contract.installments, cpf: student.cpf, billing_type },
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
  const cancellationCalc = () => {
    if (!contract || !plan) return { remaining: 0, fee: 0, refund: 0 };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(contract.start_date + 'T00:00:00');
    const end   = new Date(contract.end_date + 'T00:00:00');
    const totalDays   = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const remainingDays = Math.max(0, Math.round((end - today) / 86400000) + 1);
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
    const c = cancellationCalc();
    if (!confirm(`Cancelar contrato com multa de ${formatCurrency(c.fee)} (${cancelFeePct}%)? Estorno: ${formatCurrency(c.refund)}.`)) return;
    try {
      await AssessmentContract.update(id, {
        status:              'cancelled',
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
        payment_status_before: contract.payment_status,
      }, cancelReason || null);
      toast.success(c.refund > 0 ? 'Contrato cancelado. Estorno registrado como pendente.' : 'Contrato cancelado.');
      setCancelModal(false); load();
    } catch (e) { toast.error(e.message); }
  };

  const renewContract = async () => {
    if (!plan) return toast.error('Plano inválido');

    // Avisa (não bloqueia) se o contrato atual ainda tem pagamento em aberto
    const hasOpenPayment = contract.payment_status &&
      !['paid', 'refunded', 'cancelled'].includes(contract.payment_status);
    if (hasOpenPayment) {
      const labels = {
        pending: 'aguardando',
        awaiting_charge: 'aguardando cobrança',
        message_sent: 'mensagem enviada',
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
        due_date:           newEnd,
        installments:       contract.installments,
        enrollment_fee:     0, // renovações não cobram taxa de matrícula
        auto_renewal:       contract.auto_renewal ?? false,
        parent_contract_id: contract.id,
        notes:              `Renovação manual de ${contract.contract_number}`,
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

    setManualPaySaving(true);
    try {
      const totalV = Number(manualPayForm.value);
      const fee    = calcFee(method, totalV);
      await AssessmentContract.update(id, {
        payment_status:  'paid',
        payment_method:  method.internal_code || method.kind,
        payment_date:    manualPayForm.date,
        manual_payment:  true,
        manual_fee:      fee > 0 ? Math.round(fee * 100) / 100 : null,
      });
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
        fee:          Math.round(fee * 100) / 100,
        installments: result.installments,
      });
      toast.success(`Pagamento registrado! ${result.installments > 1 ? `${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      setManualPayModal(false);
      load();
    } catch (e) { toast.error(e.message); }
    finally { setManualPaySaving(false); }
  };

  const openWhatsApp = () => {
    if (!student) return;
    const phone = '55' + (student.whatsapp || '').replace(/\D/g, '');
    const msg = buildMessage();
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const buildMessage = () => {
    if (!contract || !student || !plan || !modality) return '';
    const total = Number(planVal('price_total') || 0) - (contract.credit_balance || 0);
    const pix = contract.asaas_pix_copy;
    const link = contract.asaas_payment_link;
    let m = `Olá, ${student.full_name.split(' ')[0]}! 👋\n\n`;
    m += `Aqui está sua cobrança da Assessoria EON:\n\n`;
    m += `📋 Contrato: *${contract.contract_number}*\n`;
    m += `🏃 Modalidade: ${modality.name}\n`;
    m += `📅 Período: ${periodLabel(plan)} (${contract.installments}x)\n`;
    m += `💰 Total: *${formatCurrency(total)}*\n\n`;
    if (pix) m += `📲 PIX Copia e Cola:\n\`${pix}\`\n\n`;
    if (link) m += `🔗 Link de pagamento:\n${link}\n\n`;
    m += `Qualquer dúvida, estou aqui!`;
    return m;
  };

  if (loading || !contract) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const ps = PAY[contract.payment_status] || { label: contract.payment_status, badge: 'secondary' };
  const st = STATUS[contract.status] || { label: contract.status, badge: 'secondary' };
  const calc = cancellationCalc();
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
        lockedReason={contract.asaas_charge_id
          ? 'Já existe uma cobrança gerada no Asaas. Cancele a cobrança atual antes de aplicar desconto.'
          : null}
        entityType="assessment_contract"
        entityId={contract.id}
        onSave={async (newValue, reason) => {
          await AssessmentContract.update(contract.id, {
            manual_discount: newValue,
            discount_reason: reason || null,
          });
          await load();
        }}
      />

      {/* Cobrança Asaas */}
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
              <div className="border-t pt-3 flex justify-center">
                <Button size="sm" variant="outline" className="text-green-700 border-green-300 hover:bg-green-50" onClick={openManualPay}>
                  <HandCoins className="w-3.5 h-3.5 mr-1.5" /> Registrar pagamento manual
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
            <Button
              variant="outline"
              className="text-red-600 hover:bg-red-50"
              onClick={openCancelModal}
            >
              <XCircle className="w-4 h-4 mr-1.5" /> Cancelar contrato
            </Button>
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
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Vencimento</span>
                    <span className="font-medium">
                      {(() => { const d = new Date(); d.setDate(d.getDate() + 3);
                        return d.toLocaleDateString('pt-BR'); })()} (em 3 dias)
                    </span>
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

      {/* MODAL: cancelar */}
      <Dialog open={cancelModal} onOpenChange={setCancelModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <XCircle className="w-5 h-5" /> Cancelar contrato
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">

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
    </div>
  );
}
