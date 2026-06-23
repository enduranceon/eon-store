import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Calendar, Check, CheckCircle2, Copy, ExternalLink, Link2,
  Loader2, MessageCircle, RefreshCw, Search, Send, Settings, UserRoundCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/api/db';
import { DEFAULT_COMMUNITY_LINK, loadCommunicationConfig } from '@/lib/communication-config';
import {
  COMMUNICATION_EVENT_TYPES,
  TASK_BUCKET,
  TASK_KIND,
  buildCommunicationTasks,
  buildTaskMessage,
  taskChannelLabel,
  taskEventType,
} from '@/lib/communication-tasks';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { isSafePaymentUrl } from '@/lib/sales';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { phoneDigitsForWhatsApp, formatPhoneDisplay } from '@/lib/phone';

const TAB_INFO = [
  { value: 'pending', label: 'Pendentes' },
  { value: TASK_BUCKET.CHARGES, label: 'Cobranças' },
  { value: TASK_BUCKET.ONBOARDING, label: 'Onboarding' },
  { value: TASK_BUCKET.RENEWAL, label: 'Renovação' },
  { value: 'history', label: 'Histórico' },
];

const EVENT_LABEL = {
  payment_message_sent: 'Cobrança enviada',
  onboarding_welcome_sent: 'Boas-vindas enviadas',
  onboarding_checkin_sent: 'Check-in enviado',
  renewal_message_sent: 'Renovação enviada',
};

function mapById(rows = []) {
  return new Map(rows.map(row => [row.id, row]));
}

function communicationTone(task) {
  if (task.kind === TASK_KIND.CHARGE_OVERDUE) return 'destructive';
  if (task.bucket === TASK_BUCKET.CHARGES) return 'info';
  if (task.bucket === TASK_BUCKET.ONBOARDING) return 'success';
  if (task.bucket === TASK_BUCKET.RENEWAL) return 'purple';
  return 'secondary';
}

function hasNativePaymentInfo(task) {
  return Boolean(task?.asaasPaymentLink || task?.asaasPixCopy || task?.asaasChargeId);
}

function hasAnyPaymentLink(task, externalLink = task?.externalPaymentLink) {
  return Boolean(task?.asaasPaymentLink || task?.asaasPixCopy || String(externalLink || '').trim());
}

function normalizeSaleHistory(ev, presaleMap, stockMap) {
  const row = ev.order_type === 'stock' ? stockMap.get(ev.order_id) : presaleMap.get(ev.order_id);
  if (!row) return null;
  const customerName = ev.order_type === 'stock' ? row.customer_name : row.checkout_name;
  const customerWhatsapp = ev.order_type === 'stock' ? row.customer_whatsapp : row.checkout_whatsapp;
  return {
    id: `sale:${ev.id}`,
    type: 'Cobrança',
    title: ev.reason || 'Cobrança enviada',
    customerName: customerName || 'Cliente',
    customerWhatsapp,
    orderNumber: row.order_number,
    createdAt: ev.created_at,
    href: ev.order_type === 'stock' ? `/estoque/pedidos/${row.id}` : `/pedidos/${row.id}`,
  };
}

function buildHistory(data) {
  const customers = mapById(data.customers || []);
  const contracts = mapById(data.contracts || []);
  const presale = mapById(data.presaleOrders || []);
  const stock = mapById(data.stockOrders || []);
  const contractRows = (data.contractEvents || []).map(ev => {
    const contract = contracts.get(ev.contract_id);
    if (!contract) return null;
    const customer = customers.get(contract.customer_id) || {};
    return {
      id: `contract:${ev.id}`,
      type: taskChannelLabel({ bucket: ev.event_type === 'renewal_message_sent' ? TASK_BUCKET.RENEWAL : ev.event_type.startsWith('onboarding') ? TASK_BUCKET.ONBOARDING : TASK_BUCKET.CHARGES }),
      title: EVENT_LABEL[ev.event_type] || ev.event_type,
      customerName: customer.full_name || 'Aluno',
      customerWhatsapp: customer.whatsapp,
      orderNumber: contract.contract_number,
      createdAt: ev.created_at,
      href: `/assessoria/contratos/${contract.id}`,
    };
  }).filter(Boolean);

  const saleRows = (data.saleEvents || [])
    .filter(ev => ev.new_status === 'charge_sent' || ev.metadata?.source === 'communication_center')
    .map(ev => normalizeSaleHistory(ev, presale, stock))
    .filter(Boolean);

  return [...contractRows, ...saleRows]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 120);
}

async function fetchCommunicationData() {
  const [
    presaleOrders,
    stockOrders,
    contracts,
    customers,
    plans,
    modalities,
    coaches,
    contractEvents,
    saleEvents,
    communicationConfig,
  ] = await Promise.all([
    supabase.from('presale_orders')
      .select('id, order_number, checkout_name, checkout_whatsapp, checkout_email, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, payment_preference, items, created_date, status_changed_at, delivery_status')
      .neq('payment_status', 'cancelled')
      .neq('payment_status', 'refunded'),
    supabase.from('stock_orders')
      .select('id, order_number, customer_name, customer_whatsapp, customer_email, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, payment_method, payment_preference, items, created_date, status_changed_at, delivery_status')
      .neq('payment_status', 'cancelled')
      .neq('payment_status', 'refunded'),
    supabase.from('assessment_contracts')
      .select('id, contract_number, customer_id, coach_id, plan_id, status, payment_status, payment_date, due_date, start_date, end_date, created_at, updated_at, parent_contract_id, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, enrollment_fee, manual_discount, credit_balance, installments, plan_snapshot')
      .not('status', 'in', '("cancelled","draft","voided")')
      .neq('payment_status', 'refunded'),
    supabase.from('presale_customers').select('id, full_name, whatsapp, email'),
    supabase.from('assessment_plans').select('id, name, modality_id, period, period_months, price_total, price_monthly'),
    supabase.from('assessment_modalities').select('id, name'),
    supabase.from('assessment_coaches').select('id, name'),
    supabase.from('assessment_contract_event')
      .select('id, contract_id, event_type, payload, notes, created_at')
      .in('event_type', COMMUNICATION_EVENT_TYPES)
      .order('created_at', { ascending: false }),
    supabase.from('sales_status_events')
      .select('id, order_type, order_id, previous_status, new_status, reason, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(200),
    loadCommunicationConfig(),
  ]);

  const responses = { presaleOrders, stockOrders, contracts, customers, plans, modalities, coaches, contractEvents, saleEvents };
  for (const [name, res] of Object.entries(responses)) {
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
  }

  return {
    ...Object.fromEntries(
      Object.entries(responses).map(([name, res]) => [name, res.data || []])
    ),
    communicationConfig,
    communicationRules: communicationConfig.rules,
    communityLink: communicationConfig.communityLink,
  };
}

function TaskCard({ task, onOpen }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={communicationTone(task)}>{taskChannelLabel(task)}</Badge>
          <span className="text-sm font-semibold text-gray-900">{task.title}</span>
          {task.statusLabel && <span className="text-xs text-muted-foreground">{task.statusLabel}</span>}
          {task.needsPaymentLink && (
            <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              link externo necessário
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <Link to={task.href} className="font-medium text-blue-700 hover:underline truncate">
            {task.customerName}
          </Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-xs text-gray-700">{task.orderNumber}</span>
          {task.totalValue > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="font-semibold">{formatCurrency(task.totalValue)}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          {task.scheduledDate && (
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {formatDate(task.scheduledDate)}
            </span>
          )}
          {task.customerWhatsapp && (
            <span>{formatPhoneDisplay(task.customerWhatsapp)}</span>
          )}
          {hasNativePaymentInfo(task) && (
            <span className="text-blue-700">Asaas/link salvo</span>
          )}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <Button size="sm" onClick={() => onOpen(task)} className="gap-1.5">
          <MessageCircle className="w-4 h-4" />
          Preparar
        </Button>
      </div>
    </div>
  );
}

function HistoryRow({ row }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary">{row.type}</Badge>
          <span className="font-semibold text-sm">{row.title}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.orderNumber}</span>
        </div>
        <Link to={row.href} className="text-sm text-blue-700 hover:underline truncate block mt-1">
          {row.customerName}
        </Link>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(row.createdAt)}</span>
    </div>
  );
}

export default function CommunicationCenter() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [selectedTask, setSelectedTask] = useState(null);
  const [messageText, setMessageText] = useState('');
  const [externalLink, setExternalLink] = useState('');
  const [dueDate, setDueDate] = useState(defaultPaymentDueDate());
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [communityLink, setCommunityLink] = useState(DEFAULT_COMMUNITY_LINK);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const nextData = await fetchCommunicationData();
      setData(nextData);
      setCommunityLink(nextData.communityLink || DEFAULT_COMMUNITY_LINK);
    } catch (e) {
      toast.error(e.message || 'Erro ao carregar comunicação');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchCommunicationData()
      .then(nextData => {
        if (!active) return;
        setData(nextData);
        setCommunityLink(nextData.communityLink || DEFAULT_COMMUNITY_LINK);
      })
      .catch(e => {
        if (active) toast.error(e.message || 'Erro ao carregar comunicação');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const tasks = useMemo(() => data ? buildCommunicationTasks(data, { rules: data.communicationRules }) : [], [data]);
  const history = useMemo(() => data ? buildHistory(data) : [], [data]);

  const counts = useMemo(() => ({
    pending: tasks.length,
    [TASK_BUCKET.CHARGES]: tasks.filter(t => t.bucket === TASK_BUCKET.CHARGES).length,
    [TASK_BUCKET.ONBOARDING]: tasks.filter(t => t.bucket === TASK_BUCKET.ONBOARDING).length,
    [TASK_BUCKET.RENEWAL]: tasks.filter(t => t.bucket === TASK_BUCKET.RENEWAL).length,
    history: history.length,
  }), [tasks, history]);

  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter(task => {
      if (activeTab !== 'pending' && task.bucket !== activeTab) return false;
      if (!q) return true;
      return [
        task.title,
        task.customerName,
        task.customerWhatsapp,
        task.orderNumber,
        task.statusLabel,
      ].some(value => String(value || '').toLowerCase().includes(q));
    });
  }, [tasks, activeTab, search]);

  const visibleHistory = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return history;
    return history.filter(row => [
      row.title,
      row.customerName,
      row.customerWhatsapp,
      row.orderNumber,
      row.type,
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }, [history, search]);

  const openTask = (task) => {
    const nextExternalLink = task.externalPaymentLink || '';
    const nextDueDate = task.dueDate || defaultPaymentDueDate();
    setSelectedTask(task);
    setExternalLink(nextExternalLink);
    setDueDate(nextDueDate);
    setCopied(false);
    setMessageText(buildTaskMessage(task, {
      externalLink: nextExternalLink,
      dueDate: nextDueDate,
      communityLink,
    }));
  };

  const rebuildMessage = (patch = {}) => {
    if (!selectedTask) return;
    const nextExternalLink = patch.externalLink ?? externalLink;
    const nextDueDate = patch.dueDate ?? dueDate;
    const nextCommunityLink = patch.communityLink ?? communityLink;
    setMessageText(buildTaskMessage(selectedTask, {
      externalLink: nextExternalLink,
      dueDate: nextDueDate,
      communityLink: nextCommunityLink,
    }));
  };

  const updateExternalLink = (value) => {
    setExternalLink(value);
    rebuildMessage({ externalLink: value });
  };

  const updateDueDate = (value) => {
    setDueDate(value);
    rebuildMessage({ dueDate: value });
  };

  const updateCommunityLink = (value) => {
    setCommunityLink(value);
    rebuildMessage({ communityLink: value });
  };

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
    if (!selectedTask) return;
    const phone = phoneDigitsForWhatsApp(selectedTask.customerWhatsapp);
    if (!phone || phone === '55') return toast.error('Cliente sem WhatsApp cadastrado');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(messageText)}`, '_blank');
  };

  const insertContractEvent = async (task, eventType, payload, notes) => {
    const { error } = await supabase.from('assessment_contract_event').insert({
      contract_id: task.sourceId,
      event_type: eventType,
      payload,
      notes,
    });
    if (error) throw error;
  };

  const insertSaleEvent = async (task, newStatus, payload, reason) => {
    const { error } = await supabase.from('sales_status_events').insert({
      order_type: task.sourceType === 'stock' ? 'stock' : 'presale',
      order_id: task.sourceId,
      previous_status: task.paymentStatus || null,
      new_status: newStatus,
      reason,
      metadata: payload,
    });
    if (error) throw error;
  };

  const markAsSent = async () => {
    if (!selectedTask) return;
    const message = messageText.trim();
    if (!message) return toast.error('Mensagem vazia');

    const trimmedLink = externalLink.trim();
    const isChargeTask = selectedTask.bucket === TASK_BUCKET.CHARGES;
    const nativePaymentInfo = hasNativePaymentInfo(selectedTask);

    if (isChargeTask && !nativePaymentInfo && !trimmedLink) {
      return toast.error('Informe o link externo antes de registrar o envio');
    }
    if (trimmedLink && !isSafePaymentUrl(trimmedLink)) {
      return toast.error('Informe um link válido começando com http:// ou https://');
    }

    setSaving(true);
    try {
      const eventType = taskEventType(selectedTask);
      const payload = {
        source: 'communication_center',
        task_kind: selectedTask.kind,
        rule_slug: selectedTask.ruleSlug || null,
        rule_name: selectedTask.ruleName || null,
        channel: 'whatsapp',
        message,
        due_date: dueDate || null,
        external_payment_link: trimmedLink || null,
        has_asaas_link: Boolean(selectedTask.asaasPaymentLink || selectedTask.asaasPixCopy),
        community_link: selectedTask.kind === TASK_KIND.ONBOARDING_WELCOME ? (communityLink.trim() || null) : null,
      };

      if (isChargeTask) {
        const updates = { payment_message_sent_at: new Date().toISOString() };
        if (!nativePaymentInfo) {
          updates.external_payment_link = trimmedLink || null;
          updates.due_date = dueDate || defaultPaymentDueDate();
        }
        if (['awaiting_charge', 'pending'].includes(selectedTask.paymentStatus)) {
          updates.payment_status = 'charge_sent';
        }

        const { error } = await supabase
          .from(selectedTask.tableName)
          .update(updates)
          .eq('id', selectedTask.sourceId);
        if (error) throw error;

        if (selectedTask.sourceType === 'contract') {
          await insertContractEvent(selectedTask, eventType, payload, 'Mensagem enviada pela Central de Comunicação');
        } else {
          await insertSaleEvent(
            selectedTask,
            updates.payment_status || selectedTask.paymentStatus || 'charge_sent',
            payload,
            selectedTask.kind === TASK_KIND.CHARGE_OVERDUE ? 'Cobrança vencida reenviada' : 'Cobrança enviada pela Central de Comunicação'
          );
        }
      } else {
        await insertContractEvent(
          selectedTask,
          eventType,
          payload,
          `${selectedTask.title} pela Central de Comunicação`
        );
      }

      toast.success('Envio registrado');
      setSelectedTask(null);
      await load({ quiet: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar envio');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Carregando comunicação...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-blue-600" />
            Central de Comunicação
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cobranças, onboarding e renovações em uma fila manual.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" asChild className="gap-1.5">
            <Link to="/comunicacao/configuracoes">
              <Settings className="w-4 h-4" />
              Configurar mensagens
            </Link>
          </Button>
          <Button variant="outline" onClick={() => load({ quiet: true })} disabled={refreshing} className="gap-1.5">
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Atualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Pendentes</p><p className="text-2xl font-bold">{counts.pending}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Cobranças</p><p className="text-2xl font-bold text-blue-700">{counts[TASK_BUCKET.CHARGES]}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Onboarding</p><p className="text-2xl font-bold text-green-700">{counts[TASK_BUCKET.ONBOARDING]}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Renovação</p><p className="text-2xl font-bold text-purple-700">{counts[TASK_BUCKET.RENEWAL]}</p></CardContent></Card>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="h-auto flex-wrap justify-start">
            {TAB_INFO.map(tab => (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                {tab.label}
                <span className="text-[10px] rounded-full bg-gray-100 px-1.5 py-0.5 text-gray-600">
                  {counts[tab.value] || 0}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative w-full md:w-72">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            className="pl-9"
            placeholder="Buscar cliente, pedido..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {activeTab === 'history' ? (
        <div className="space-y-2">
          {visibleHistory.length === 0 ? (
            <div className="rounded-lg border bg-white p-10 text-center text-sm text-muted-foreground">
              Nenhum envio registrado ainda.
            </div>
          ) : visibleHistory.map(row => <HistoryRow key={row.id} row={row} />)}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleTasks.length === 0 ? (
            <div className="rounded-lg border bg-white p-10 text-center">
              <CheckCircle2 className="w-8 h-8 text-green-600 mx-auto mb-2" />
              <p className="font-semibold text-gray-900">Nada pendente nessa fila</p>
              <p className="text-sm text-muted-foreground mt-1">As próximas mensagens aparecerão aqui conforme os dados mudarem.</p>
            </div>
          ) : visibleTasks.map(task => <TaskCard key={task.id} task={task} onOpen={openTask} />)}
        </div>
      )}

      <Dialog open={!!selectedTask} onOpenChange={open => !open && setSelectedTask(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedTask && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Send className="w-5 h-5 text-blue-600" />
                  {selectedTask.title}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-lg border bg-gray-50 p-3 text-sm grid gap-2 md:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground block text-xs">Cliente</span>
                    <span className="font-semibold">{selectedTask.customerName}</span>
                    {selectedTask.customerWhatsapp && (
                      <span className="text-muted-foreground block text-xs mt-0.5">{formatPhoneDisplay(selectedTask.customerWhatsapp)}</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">{selectedTask.sourceLabel}</span>
                    <Link to={selectedTask.href} className="font-mono font-semibold text-blue-700 hover:underline">
                      {selectedTask.orderNumber}
                    </Link>
                  </div>
                </div>

                {selectedTask.bucket === TASK_BUCKET.CHARGES && (
                  <div className="grid gap-3 md:grid-cols-2">
                    {!hasNativePaymentInfo(selectedTask) && (
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
                    {!hasNativePaymentInfo(selectedTask) && (
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
                    {hasNativePaymentInfo(selectedTask) && (
                      <div className="md:col-span-2 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>Cobrança Asaas ou link salvo encontrado. A mensagem usa esses dados automaticamente.</span>
                      </div>
                    )}
                    {!hasAnyPaymentLink(selectedTask, externalLink) && (
                      <div className="md:col-span-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>Para registrar envio de cobrança, informe um link externo ou gere a cobrança Asaas na tela de origem.</span>
                      </div>
                    )}
                  </div>
                )}

                {selectedTask.kind === TASK_KIND.ONBOARDING_WELCOME && (
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

                <Button className="w-full" onClick={markAsSent} disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <UserRoundCheck className="w-4 h-4 mr-1.5" />}
                  {saving ? 'Registrando...' : 'Marcar como enviada'}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
