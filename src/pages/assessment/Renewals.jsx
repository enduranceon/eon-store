import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCheck, Check, Clock, Info, Loader2, RefreshCcw, RotateCcw,
  Search, Wallet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { activateAssessmentContractRenewal, transitionAssessmentRenewalStage } from '@/api/client';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { toast } from 'sonner';
import { RENEWAL_ATTENTION_WINDOW_DAYS } from '@/lib/assessment-renewal-window';
import { getActivationStatusForContract, opensChargeMessageAfterRegister } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { defaultAsaasDueDate } from '@/lib/payment-methods';
import { suggestedAssessmentChargeDueDate } from '@/lib/assessment-renewal-billing';
import { normalizeExternalChargeMethod } from '@/lib/external-charge';
import { registerExternalAssessmentContractCharge } from '@/lib/assessment-contract-operations';
import { buildContractChargeTask, buildRenewalMessageTask } from '@/lib/communication-tasks';
import { loadCommunicationConfig } from '@/lib/communication-config';
import { canResolveAssessmentRenewal } from '@/lib/assessment-renewal-resolution';
import {
  buildRenewalBoard,
  renewalChangeHref,
  renewalSaleTotal,
  summarizeRenewalBoard,
} from '@/lib/assessment-renewal-pipeline';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import RenewalResolutionDialog from '@/components/RenewalResolutionDialog';
import ExternalChargeDialog from '@/components/billing/ExternalChargeDialog';
import RenewalCard from '@/components/renewals/RenewalCard';
import RenewalDetailDialog from '@/components/renewals/RenewalDetailDialog';
import RenewalResponseDialog from '@/components/renewals/RenewalResponseDialog';
import RenewalFollowUpDialog from '@/components/renewals/RenewalFollowUpDialog';
import RenewalPaymentDialog from '@/components/renewals/RenewalPaymentDialog';
import RenewalFarewellDialog from '@/components/renewals/RenewalFarewellDialog';

// ─────────────────────────────────────────────────────────────────
// Quadro de Renovações. A etapa é gravada e movida pelo servidor; esta tela só
// lê e chama as ações (nenhuma mudança de etapa sai direto do navegador).
// ─────────────────────────────────────────────────────────────────

const RENEWAL_FIELDS = [
  'id', 'contract_number', 'customer_id', 'coach_id', 'plan_id', 'plan_snapshot', 'status',
  'start_date', 'end_date', 'due_date', 'installments', 'enrollment_fee', 'manual_discount',
  'credit_balance', 'discount_recurring', 'payment_method', 'payment_status', 'payment_date',
  'manual_payment', 'refund_status', 'refund_amount', 'refund_date', 'refund_notes',
  'parent_contract_id', 'auto_renewal', 'asaas_charge_id', 'asaas_payment_link', 'asaas_pix_copy',
  'asaas_pix_qrcode', 'external_payment_link', 'external_invoice_number', 'payment_message_sent_at',
  'created_at', 'updated_at', 'renewal_stage', 'renewal_entered_at', 'renewal_stage_updated_at',
  'renewal_response_code', 'renewal_response_at', 'renewal_follow_up_at', 'renewal_last_contact_at',
  'renewal_resolved_at', 'renewal_contact_step', 'renewal_contact_step_at',
].join(', ');

const ALL = 'all';

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalDateStr(d);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

function normalizeScanDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return RENEWAL_ATTENTION_WINDOW_DAYS;
  return Math.max(1, Math.min(90, Math.round(n)));
}

function Kpi({ icon: Icon, label, value, detail, tone = 'blue' }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-600',
    red: 'bg-red-50 text-red-600',
    orange: 'bg-orange-50 text-orange-600',
    green: 'bg-green-50 text-green-600',
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`p-2 rounded-full shrink-0 ${tones[tone]}`}><Icon className="w-5 h-5" /></div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-bold text-gray-900">{value}</p>
          {detail && <p className="text-[11px] text-muted-foreground mt-0.5">{detail}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function FilterSelect({ value, onChange, placeholder, options }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-full sm:w-auto sm:min-w-44 whitespace-nowrap bg-white">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {options.map(option => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Renewals() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [contracts, setContracts] = useState([]);
  const [parents, setParents] = useState({});
  const [customers, setCustomers] = useState({});
  const [coaches, setCoaches] = useState({});
  const [modalities, setModalities] = useState({});
  const [issues, setIssues] = useState([]);
  const [renewed30, setRenewed30] = useState(0);
  const [communicationRules, setCommunicationRules] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [filters, setFilters] = useState({
    search: '', planName: ALL, coachId: ALL, modalityId: ALL, hideCompleted: false,
  });

  const [detailId, setDetailId] = useState(null);
  const [responseCard, setResponseCard] = useState(null);
  const [followUpCard, setFollowUpCard] = useState(null);
  const [paymentCard, setPaymentCard] = useState(null);
  const [changeCard, setChangeCard] = useState(null);
  const [messageTask, setMessageTask] = useState(null);
  const [farewellTarget, setFarewellTarget] = useState(null);
  const [resolutionTarget, setResolutionTarget] = useState(null);
  const [activationCard, setActivationCard] = useState(null);
  const [externalChargeModal, setExternalChargeModal] = useState(null);
  const [externalChargeForm, setExternalChargeForm] = useState({
    link: '', due_date: defaultAsaasDueDate(), payment_method: 'pix', invoice_number: '',
  });
  const [charging, setCharging] = useState(false);
  const [scanModal, setScanModal] = useState(false);
  const [scanForm, setScanForm] = useState({ horizon_days: RENEWAL_ATTENTION_WINDOW_DAYS });
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Aplica as viradas de vigência do dia antes de ler o quadro.
      await applyAssessmentContractTransitions([]);
      const recent = daysAgo(7);
      const [renewalRes, renewedRes, issuesRes, config] = await Promise.all([
        supabase.from('assessment_contracts')
          .select(RENEWAL_FIELDS)
          .not('parent_contract_id', 'is', null)
          .or(`renewal_stage.in.(contact_pending,waiting_response,charge_pending,waiting_payment),and(renewal_stage.in.(renewed,not_renewed),renewal_resolved_at.gte.${recent})`),
        supabase.from('assessment_contracts')
          .select('id', { count: 'exact', head: true })
          .eq('renewal_stage', 'renewed')
          .gte('renewal_resolved_at', daysAgo(30)),
        supabase.from('assessment_renewal_pipeline_issues')
          .select('contract_id, contract_number, customer_id, parent_contract_id, issue_code, issue_label'),
        loadCommunicationConfig().catch(() => null),
      ]);
      const firstError = [renewalRes, renewedRes, issuesRes].find(result => result.error)?.error;
      if (firstError) throw firstError;

      const rows = renewalRes.data || [];
      const issueRows = issuesRes.data || [];
      const parentIds = [...new Set(rows.map(row => row.parent_contract_id).filter(Boolean))];
      const customerIds = [...new Set([
        ...rows.map(row => row.customer_id),
        ...issueRows.map(row => row.customer_id),
      ].filter(Boolean))];
      const coachIds = [...new Set(rows.map(row => row.coach_id).filter(Boolean))];
      const modalityIds = [...new Set(rows.map(row => row.plan_snapshot?.modality_id).filter(Boolean))];

      const [parentRes, customerRes, coachRes, modalityRes] = await Promise.all([
        parentIds.length
          ? supabase.from('assessment_contracts').select('id, contract_number, status, end_date, payment_status, cancellation_reason, auto_renewal').in('id', parentIds)
          : Promise.resolve({ data: [] }),
        customerIds.length
          ? supabase.from('presale_customers').select('id, full_name, whatsapp, email').in('id', customerIds)
          : Promise.resolve({ data: [] }),
        coachIds.length
          ? supabase.from('assessment_coaches').select('id, name').in('id', coachIds)
          : Promise.resolve({ data: [] }),
        modalityIds.length
          ? supabase.from('assessment_modalities').select('id, name').in('id', modalityIds)
          : Promise.resolve({ data: [] }),
      ]);
      const relatedError = [parentRes, customerRes, coachRes, modalityRes].find(result => result.error)?.error;
      if (relatedError) throw relatedError;

      setContracts(rows);
      setParents(Object.fromEntries((parentRes.data || []).map(row => [row.id, row])));
      setCustomers(Object.fromEntries((customerRes.data || []).map(row => [row.id, row])));
      setCoaches(Object.fromEntries((coachRes.data || []).map(row => [row.id, row])));
      setModalities(Object.fromEntries((modalityRes.data || []).map(row => [row.id, row])));
      setIssues(issueRows);
      setRenewed30(renewedRes.count || 0);
      setCommunicationRules(config?.rules || null);
    } catch (error) {
      console.error('Erro ao carregar renovações:', error);
      toast.error('Erro ao carregar: ' + (error.message || ''));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const todayStr = todayLocalStr();
  const issuesByContract = useMemo(() => issues.reduce((acc, issue) => {
    if (!acc[issue.contract_id]) acc[issue.contract_id] = [];
    acc[issue.contract_id].push(issue);
    return acc;
  }, {}), [issues]);

  const activeFilters = useMemo(() => ({
    search: filters.search,
    planName: filters.planName === ALL ? '' : filters.planName,
    coachId: filters.coachId === ALL ? '' : filters.coachId,
    modalityId: filters.modalityId === ALL ? '' : filters.modalityId,
    hideCompleted: filters.hideCompleted,
  }), [filters]);

  const board = useMemo(() => buildRenewalBoard(contracts, {
    parents, customers, issuesByContract, todayStr, filters: activeFilters,
  }), [contracts, parents, customers, issuesByContract, todayStr, activeFilters]);
  const summary = useMemo(() => summarizeRenewalBoard(board.cards), [board.cards]);

  const cardIds = useMemo(() => new Set(board.cards.map(card => card.contract.id)), [board.cards]);
  const outsideIssues = issues.filter(issue => !cardIds.has(issue.contract_id));

  const filterOptions = useMemo(() => {
    const planNames = [...new Set(contracts.map(row => row.plan_snapshot?.name).filter(Boolean))].sort();
    return {
      plans: planNames.map(name => ({ value: name, label: name })),
      coaches: Object.values(coaches).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .map(coach => ({ value: coach.id, label: coach.name })),
      modalities: Object.values(modalities).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .map(modality => ({ value: modality.id, label: modality.name })),
    };
  }, [contracts, coaches, modalities]);

  const findCard = useCallback(
    (id) => board.cards.find(card => card.contract.id === id) || null,
    [board.cards],
  );
  const detailCard = detailId ? findCard(detailId) : null;

  // ── Ações ──────────────────────────────────────────────────────────────

  const openResolution = useCallback((card, initialChoice) => {
    const { contract, parent, customer } = card;
    if (!parent) return toast.error('Contrato anterior não encontrado; atualize a página');
    if (!canResolveAssessmentRenewal(contract)) {
      return toast.error('Esta renovação possui movimentação ou situação que exige revisão');
    }
    setDetailId(null);
    setResolutionTarget({
      contract,
      parent,
      customerName: customer?.full_name || '',
      initialChoice: parent.status === 'cancelled' ? 'parent_cancelled' : initialChoice,
    });
    return null;
  }, []);

  const openExternalCharge = useCallback((contract) => {
    setExternalChargeForm({
      link: contract.external_payment_link || '',
      due_date: suggestedAssessmentChargeDueDate(contract),
      payment_method: normalizeExternalChargeMethod(contract.payment_method, contract.installments),
      invoice_number: contract.external_invoice_number || '',
    });
    setExternalChargeModal(contract);
  }, []);

  // Mensagem da régua (ou a despedida), com o texto do passo e o fim do plano atual.
  const openRenewalMessage = (contract, parent, step) => {
    setMessageTask(buildRenewalMessageTask(contract, {
      customers: Object.values(customers),
      coaches: Object.values(coaches),
      modalities: Object.values(modalities),
    }, { rules: communicationRules || undefined, todayStr, step, parentEndDate: parent?.end_date }));
  };

  // Depois do "Não vai renovar", abre a despedida com o contrato já encerrado.
  const openFarewell = async (contractId, parent) => {
    const { data, error } = await supabase.from('assessment_contracts')
      .select(RENEWAL_FIELDS).eq('id', contractId).maybeSingle();
    if (error || data?.renewal_stage !== 'not_renewed') return;
    setFarewellTarget({
      contract: data,
      parent,
      customer: customers[data.customer_id],
      coaches: Object.values(coaches),
      modalities: Object.values(modalities),
    });
  };

  const lookupsFor = (contract) => ({
    customer: customers[contract.customer_id],
    coach: coaches[contract.coach_id],
    modality: modalities[contract.plan_snapshot?.modality_id],
  });

  const handleAction = (key, card) => {
    const { contract } = card;
    if (key === 'details') { setDetailId(contract.id); return; }
    setDetailId(null);
    if (key === 'change_plan') {
      // A troca é feita no contrato da renovação, com as mesmas regras de lá.
      navigate(renewalChangeHref(contract.id, 'plan'));
      return;
    }
    if (key === 'message') {
      const step = card.state.contactStep?.step;
      openRenewalMessage(contract, card.parent, step && step !== 'close' ? step : 'intent');
    } else if (key === 'close_no_response') {
      openResolution(card, 'no_response');
    } else if (key === 'response') {
      setResponseCard(card);
    } else if (key === 'followup') {
      setFollowUpCard(card);
    } else if (key === 'change_resolved') {
      setChangeCard(card);
    } else if (key === 'charge') {
      openExternalCharge(contract);
    } else if (key === 'charge_message') {
      setMessageTask(buildContractChargeTask(contract, lookupsFor(contract)));
    } else if (key === 'payment') {
      setPaymentCard(card);
    } else if (key === 'activate') {
      setActivationCard(card);
    } else if (key === 'decline') {
      openResolution(card, 'customer_declined');
    } else if (key === 'discard') {
      openResolution(card, 'created_in_error');
    }
  };

  const onConflict = () => {
    setResponseCard(null);
    setFollowUpCard(null);
    load();
  };

  const resolveChange = async () => {
    if (!changeCard) return;
    const { contract } = changeCard;
    setBusyId(contract.id);
    try {
      const result = await transitionAssessmentRenewalStage(contract.id, {
        action: 'change_resolved',
        expectedUpdatedAt: contract.updated_at,
      });
      setChangeCard(null);
      if (result?.contract?.updated_at) {
        // Segue direto para o cadastro da cobrança, já com a versão nova do contrato.
        toast.success('Mudança resolvida. Registre a cobrança da renovação.');
        openExternalCharge({ ...contract, ...result.contract });
      } else {
        toast.success('Mudança resolvida. A renovação foi para "Enviar cobrança".');
      }
      load();
    } catch (error) {
      toast.error(error.message || 'Não foi possível atualizar a renovação');
      if (error?.status === 409) {
        setChangeCard(null);
        load();
      }
    } finally {
      setBusyId(null);
    }
  };

  const activateRenewal = async () => {
    if (!activationCard) return;
    const { contract } = activationCard;
    setBusyId(contract.id);
    try {
      const result = await activateAssessmentContractRenewal(contract.id, contract.updated_at);
      const status = result.contract?.status || getActivationStatusForContract(contract);
      toast.success(status === 'scheduled'
        ? `Renovação ${contract.contract_number} aprovada e agendada.`
        : `Renovação ${contract.contract_number} aprovada e ativa.`);
      setActivationCard(null);
      load();
    } catch (error) {
      toast.error('Erro ao aprovar: ' + (error.message || ''));
    } finally {
      setBusyId(null);
    }
  };

  const saveExternalCharge = async () => {
    if (!externalChargeModal) return;
    const contract = externalChargeModal;
    setCharging(true);
    try {
      const result = await registerExternalAssessmentContractCharge({
        contract,
        link: externalChargeForm.link.trim(),
        dueDate: externalChargeForm.due_date,
        paymentMethod: normalizeExternalChargeMethod(externalChargeForm.payment_method, contract.installments),
        invoiceNumber: externalChargeForm.invoice_number.trim(),
        source: 'renewals_page',
      });
      setExternalChargeModal(null);
      // Cobrança ainda não enviada: já abre a mensagem de renovação confirmada,
      // com o link e o vencimento salvos.
      if (opensChargeMessageAfterRegister(contract)) {
        toast.success('Cobrança registrada. Copie a mensagem e envie para o atleta.');
        setMessageTask(buildContractChargeTask({ ...contract, ...result.updates }, lookupsFor(contract)));
      } else {
        toast.success('Cobrança registrada. A venda está em "Aguardando pagamento" e em Vendas em aberto.');
      }
      load();
    } catch (error) {
      toast.error(error.message || 'Erro ao salvar cobrança externa');
    } finally {
      setCharging(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('prepare-renewals', {
        body: { horizon_days: normalizeScanDays(scanForm.horizon_days) },
      });
      if (error) {
        let message = error.message;
        try {
          if (error.context?.json) { const body = await error.context.json(); if (body?.error) message = body.error; }
        } catch { /* mantém a mensagem original */ }
        throw new Error(message);
      }
      if (data?.error) throw new Error(data.error);
      setScanResult(data);
      if (Number(data?.processed || 0) > 0) {
        toast.success('Renovações atualizadas.');
        load();
      } else if (data?.errors?.length) {
        toast.error(`${data.errors.length} renovação(ões) não puderam ser processadas.`);
      } else {
        toast.info(data?.message || 'Nenhum contrato novo dentro da janela.');
      }
    } catch (error) {
      toast.error('Erro: ' + (error.message || ''));
    } finally {
      setScanning(false);
    }
  };

  // Atalho vindo de outras telas: /assessoria/renovacoes?resolver=<id>
  useEffect(() => {
    const renewalId = searchParams.get('resolver');
    if (!renewalId || loading || resolutionTarget) return undefined;
    const timer = setTimeout(() => {
      const card = findCard(renewalId);
      if (card) openResolution(card, '');
      else toast.error('A renovação pedida não está aberta no quadro');
      setSearchParams({}, { replace: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [findCard, loading, openResolution, resolutionTarget, searchParams, setSearchParams]);

  // Atalho vindo do contrato depois da troca de plano/coach: /assessoria/renovacoes?cobrar=<id>
  useEffect(() => {
    const renewalId = searchParams.get('cobrar');
    if (!renewalId || loading) return undefined;
    const timer = setTimeout(() => {
      const card = findCard(renewalId);
      if (card?.contract.renewal_stage === 'charge_pending') openExternalCharge(card.contract);
      else if (!card) toast.error('A renovação pedida não está aberta no quadro');
      setSearchParams({}, { replace: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [findCard, loading, openExternalCharge, searchParams, setSearchParams]);

  const scanWindowDays = normalizeScanDays(scanForm.horizon_days);
  const activationContract = activationCard?.contract;
  const activationLater = activationContract
    ? getActivationStatusForContract(activationContract) === 'scheduled'
    : false;
  const hasFilters = filters.search || filters.planName !== ALL || filters.coachId !== ALL || filters.modalityId !== ALL;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <RefreshCcw className="w-5 h-5 text-blue-600" />
            Renovações
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cada renovação fica no quadro até a decisão e o pagamento; nenhuma pendência some por data.
          </p>
        </div>
        <Button onClick={() => setScanModal(true)} variant="outline">
          <RotateCcw className="w-4 h-4 mr-1.5" />
          Verificar agora
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={RefreshCcw} label="No quadro" value={summary.inPipeline} detail="renovações em aberto" />
        <Kpi icon={AlertTriangle} label="Exigem atenção" value={summary.needsAttention} detail="atrasadas ou vencidas" tone="red" />
        <Kpi
          icon={Wallet}
          label="Aguardando pagamento"
          value={summary.waitingPaymentCount}
          detail={formatCurrency(summary.waitingPaymentTotal)}
          tone="orange"
        />
        <Kpi icon={CheckCheck} label="Renovaram (30 dias)" value={renewed30} detail="pagamentos confirmados" tone="green" />
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          <b>Regra do quadro:</b> a data coloca a renovação no quadro e aumenta a urgência, mas não remove uma renovação pendente.
          Renovou e Não renovou saem da tela 5 dias depois, sem apagar o histórico.
        </span>
      </div>

      {outsideIssues.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 space-y-1">
          <p className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" /> Precisam de conferência ({outsideIssues.length})
          </p>
          <ul className="space-y-0.5">
            {outsideIssues.slice(0, 8).map(issue => (
              <li key={`${issue.contract_id}:${issue.issue_code}`}>
                <Link to={`/assessoria/contratos/${issue.contract_id}`} className="font-mono underline">
                  {issue.contract_number}
                </Link>
                {customers[issue.customer_id]?.full_name ? ` · ${customers[issue.customer_id].full_name}` : ''} — {issue.issue_label}
              </li>
            ))}
            {outsideIssues.length > 8 && <li>e mais {outsideIssues.length - 8}.</li>}
          </ul>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-wrap">
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            className="h-9 pl-9 bg-white"
            placeholder="Buscar atleta ou contrato"
            value={filters.search}
            onChange={e => setFilters(current => ({ ...current, search: e.target.value }))}
          />
        </div>
        <FilterSelect
          value={filters.planName}
          onChange={value => setFilters(current => ({ ...current, planName: value }))}
          placeholder="Todos os planos"
          options={filterOptions.plans}
        />
        <FilterSelect
          value={filters.coachId}
          onChange={value => setFilters(current => ({ ...current, coachId: value }))}
          placeholder="Todos os coaches"
          options={filterOptions.coaches}
        />
        <FilterSelect
          value={filters.modalityId}
          onChange={value => setFilters(current => ({ ...current, modalityId: value }))}
          placeholder="Todas as modalidades"
          options={filterOptions.modalities}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 accent-blue-600"
            checked={filters.hideCompleted}
            onChange={e => setFilters(current => ({ ...current, hideCompleted: e.target.checked }))}
          />
          Ocultar concluídos
        </label>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters(current => ({ ...current, search: '', planName: ALL, coachId: ALL, modalityId: ALL }))}
          >
            Limpar filtros
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Carregando...</span>
        </div>
      ) : (
        // As colunas dividem a largura da tela (mínimo de 260px; abaixo disso o
        // quadro rola para o lado). Em tela grande cada coluna cabe na altura da
        // tela e rola sozinha, com o título sempre visível.
        <div className="overflow-x-auto pb-2 -mx-1 px-1">
          <div
            className="grid gap-3 items-start"
            style={{ gridTemplateColumns: `repeat(${board.columns.length}, minmax(260px, 1fr))` }}
          >
            {board.columns.map(column => (
              <section
                key={column.stage}
                className="min-w-0 flex flex-col rounded-2xl border bg-slate-50/70 p-3 lg:max-h-[calc(100vh-7rem)]"
                aria-label={column.title}
              >
                <div className="mb-3 flex shrink-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${column.dot}`} aria-hidden="true" />
                      {column.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-snug">{column.hint}</p>
                    {column.stage === 'waiting_payment' && column.items.length > 0 && (
                      <p className="text-[11px] font-semibold text-gray-700 mt-0.5">{formatCurrency(column.total)}</p>
                    )}
                  </div>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${column.badge}`}>
                    {column.items.length}
                  </span>
                </div>
                {column.items.length === 0 ? (
                  <div className="rounded-xl border border-dashed bg-white/70 px-3 py-8 text-center text-xs text-muted-foreground">
                    {hasFilters ? 'Nada com esses filtros.' : 'Sem renovações aqui.'}
                  </div>
                ) : (
                  <div className="space-y-2 lg:min-h-0 lg:overflow-y-auto lg:-m-1 lg:p-1">
                    {column.items.map(card => (
                      <RenewalCard
                        key={card.contract.id}
                        card={card}
                        coach={coaches[card.contract.coach_id]}
                        modality={modalities[card.contract.plan_snapshot?.modality_id]}
                        onOpen={selected => setDetailId(selected.contract.id)}
                        onAction={handleAction}
                        busy={busyId === card.contract.id}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      )}

      {detailCard && (
        <RenewalDetailDialog
          key={detailCard.contract.id}
          card={detailCard}
          coach={coaches[detailCard.contract.coach_id]}
          modality={modalities[detailCard.contract.plan_snapshot?.modality_id]}
          onClose={() => setDetailId(null)}
          onAction={handleAction}
          busy={busyId === detailCard.contract.id}
        />
      )}

      {responseCard && (
        <RenewalResponseDialog
          key={responseCard.contract.id}
          card={responseCard}
          onClose={() => setResponseCard(null)}
          onDone={() => { setResponseCard(null); load(); }}
          onConflict={onConflict}
          onNotRenewing={card => { setResponseCard(null); openResolution(card, 'customer_declined'); }}
          onChangeRequested={(card, target) => { setResponseCard(null); navigate(renewalChangeHref(card.contract.id, target)); }}
          onWillRenew={(card, contract) => { setResponseCard(null); openExternalCharge(contract); load(); }}
          onThinking={(card, contract) => { setResponseCard(null); openRenewalMessage(contract, card.parent, 'thinking_ack'); load(); }}
        />
      )}

      {followUpCard && (
        <RenewalFollowUpDialog
          key={followUpCard.contract.id}
          card={followUpCard}
          onClose={() => setFollowUpCard(null)}
          onDone={() => { setFollowUpCard(null); load(); }}
          onConflict={onConflict}
        />
      )}

      {paymentCard && (
        <RenewalPaymentDialog
          key={paymentCard.contract.id}
          card={paymentCard}
          onClose={() => setPaymentCard(null)}
          onDone={() => { setPaymentCard(null); load(); }}
        />
      )}

      <ConfirmDialog
        open={!!changeCard}
        onOpenChange={open => { if (!open) setChangeCard(null); }}
        title="Mudança resolvida?"
        icon={Check}
        iconClassName="text-green-600"
        confirmLabel="Seguir para cobrança"
        busy={!!changeCard && busyId === changeCard.contract.id}
        onConfirm={resolveChange}
      >
        <p>
          Confirme que a mudança de plano ou treinador de <b>{changeCard?.customer?.full_name || 'o atleta'}</b> já
          foi feita no contrato da renovação.
        </p>
        <p className="text-muted-foreground">
          A renovação vai para "Enviar cobrança" e já abre o cadastro da cobrança. Nada é cobrado agora.
        </p>
      </ConfirmDialog>

      {messageTask && (
        <CommunicationSendDialog
          key={messageTask.id}
          task={messageTask}
          sourceUi="renewals"
          preventOutsideClose
          onChanged={() => load()}
          showQueueActions={false}
          onClose={() => setMessageTask(null)}
          onSent={() => { setMessageTask(null); load(); }}
        />
      )}

      {farewellTarget && (
        <RenewalFarewellDialog
          key={farewellTarget.contract.id}
          target={farewellTarget}
          rules={communicationRules || undefined}
          onClose={() => setFarewellTarget(null)}
          onDone={() => setFarewellTarget(null)}
        />
      )}

      {resolutionTarget && (
        <RenewalResolutionDialog
          key={`${resolutionTarget.contract.id}:${resolutionTarget.initialChoice}`}
          target={resolutionTarget}
          onClose={() => setResolutionTarget(null)}
          onResolved={async (result, choice) => {
            await load();
            if (choice === 'customer_declined') {
              await openFarewell(resolutionTarget.contract.id, resolutionTarget.parent);
            }
          }}
          onRefresh={load}
        />
      )}

      <ExternalChargeDialog
        open={Boolean(externalChargeModal)}
        onCancel={() => setExternalChargeModal(null)}
        hasCharge={Boolean(externalChargeModal?.external_payment_link)}
        form={externalChargeForm}
        setForm={setExternalChargeForm}
        saving={charging}
        onSave={saveExternalCharge}
        summary={externalChargeModal && (
          <p className="text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-900">
            {customers[externalChargeModal.customer_id]?.full_name || 'Atleta'} · {externalChargeModal.contract_number}
            {externalChargeModal.plan_snapshot?.name && ` · ${externalChargeModal.plan_snapshot.name}`}
            <br />
            Total da renovação: <strong>{formatCurrency(renewalSaleTotal(externalChargeModal))}</strong>
            {Number(externalChargeModal.installments) > 1 && ` em ${externalChargeModal.installments}x`}
          </p>
        )}
      />

      <Dialog open={!!activationCard} onOpenChange={open => { if (!open && !busyId) setActivationCard(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-blue-600" /> Aprovar renovação sem cobrança
            </DialogTitle>
          </DialogHeader>
          {activationContract && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3 text-sm">
                <p className="font-mono font-semibold text-blue-700">{activationContract.contract_number}</p>
                <p className="font-semibold text-gray-900">{activationCard.customer?.full_name || 'Atleta'}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDate(activationContract.start_date)} → {formatDate(activationContract.end_date)} · {formatCurrency(renewalSaleTotal(activationContract))}
                </p>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                {activationLater
                  ? <>A renovação fica aprovada e começa em <b>{formatDate(activationContract.start_date)}</b>.</>
                  : <>A renovação entra em vigor agora e o contrato anterior é concluído.</>}
                {' '}A venda abre em Vendas em aberto e o card vai para "Aguardando pagamento", com o aviso de cobrança pendente.
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={!!busyId} onClick={() => setActivationCard(null)}>Voltar</Button>
                <Button disabled={!!busyId} onClick={activateRenewal}>
                  {busyId ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
                  Aprovar
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={scanModal} onOpenChange={open => { if (!open && !scanning) { setScanModal(false); setScanResult(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-blue-600" /> Verificar renovações
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              A rotina já roda todo dia às 5h. Use este botão só para forçar uma verificação: as manuais entram em
              "Enviar mensagem" e as mensais automáticas em "Aguardando pagamento", 5 dias antes, sem acessar o Asaas.
            </p>
            <div>
              <Label>Janela da renovação manual</Label>
              <Input
                type="number" min="1" max="90"
                className="mt-1"
                value={scanForm.horizon_days}
                onChange={e => setScanForm(form => ({ ...form, horizon_days: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Padrão do sistema: {RENEWAL_ATTENTION_WINDOW_DAYS} dias antes do vencimento.
              </p>
            </div>
            <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs text-blue-900 space-y-1">
              <p>
                Com <b>{scanWindowDays} dia{scanWindowDays === 1 ? '' : 's'}</b>, entram os contratos manuais que vencem até{' '}
                <b>{formatDate(addDays(todayStr, scanWindowDays))}</b> (inclusive os já vencidos sem renovação).
              </p>
              <p className="text-blue-700">Renovações existentes não são duplicadas.</p>
            </div>
            {scanResult && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-1">
                <p><b>Alterações processadas:</b> {scanResult.processed}</p>
                <p className="text-green-700"><b>Novas em "Enviar mensagem":</b> {scanResult.drafts_created}</p>
                <p className="text-green-700"><b>Automáticas agendadas:</b> {scanResult.automatic_renewals_scheduled || 0}</p>
                {scanResult.errors?.length > 0 && (
                  <p className="text-red-700"><b>Erros:</b> {scanResult.errors.length}</p>
                )}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" disabled={scanning}
                onClick={() => { setScanModal(false); setScanResult(null); }}>
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
