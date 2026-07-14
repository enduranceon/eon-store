import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Calendar, CheckCircle2, Clock3, Link2, Loader2, MessageCircle,
  PhoneOff, RefreshCw, Search, SendHorizontal, Settings, WalletCards, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/api/db';
import { DEFAULT_COMMUNITY_LINK, loadCommunicationConfig } from '@/lib/communication-config';
import {
  COMMUNICATION_EVENT_TYPES,
  TASK_BUCKET,
  TASK_KIND,
  buildCommunicationTasks,
  taskChannelLabel,
} from '@/lib/communication-tasks';
import { hasNativePaymentInfo, registerCommunicationIgnore } from '@/lib/communication-send';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { formatCurrency, formatDate, formatDateTime, todayLocalStr } from '@/lib/utils';
import { formatPhoneDisplay } from '@/lib/phone';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';

const TAB_INFO = [
  { value: 'pending', label: 'Pendentes' },
  { value: TASK_BUCKET.CHARGES, label: 'Cobranças' },
  { value: TASK_BUCKET.ONBOARDING, label: 'Onboarding' },
  { value: TASK_BUCKET.RENEWAL, label: 'Renovação' },
  { value: 'history', label: 'Histórico' },
];

const QUICK_FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'overdue', label: 'Vencidas', tabs: ['pending', TASK_BUCKET.CHARGES] },
  { value: 'blocked', label: 'Bloqueios' },
  { value: 'missing_link', label: 'Sem link', tabs: ['pending', TASK_BUCKET.CHARGES] },
  { value: 'ready', label: 'Prontas' },
];

function mapById(rows = []) {
  return new Map(rows.map(row => [row.id, row]));
}

function historyPayload(event = {}) {
  return { ...(event.metadata || {}), ...(event.payload || {}) };
}

function bucketFromTaskKind(kind, eventType = '') {
  if ([TASK_KIND.ONBOARDING_WELCOME, TASK_KIND.ONBOARDING_CHECKIN].includes(kind)) return TASK_BUCKET.ONBOARDING;
  if (kind === TASK_KIND.RENEWAL_REMINDER) return TASK_BUCKET.RENEWAL;
  if ([TASK_KIND.CHARGE_SEND, TASK_KIND.CHARGE_OVERDUE].includes(kind)) return TASK_BUCKET.CHARGES;
  if (eventType === 'renewal_message_sent') return TASK_BUCKET.RENEWAL;
  if (String(eventType).startsWith('onboarding')) return TASK_BUCKET.ONBOARDING;
  if (eventType === 'payment_message_sent') return TASK_BUCKET.CHARGES;
  return TASK_BUCKET.CHARGES;
}

function historyStatus(event = {}) {
  const payload = historyPayload(event);
  if (payload.action === 'snoozed') return { label: 'Adiada', tone: 'warning' };
  if (payload.action === 'ignored' || event.event_type === 'communication_task_ignored') {
    return { label: 'Descartada', tone: 'destructive' };
  }
  return { label: 'Enviada', tone: 'success' };
}

function historyTitle(event = {}) {
  const payload = historyPayload(event);
  if (payload.rule_name) return payload.rule_name;
  if (payload.task_kind === TASK_KIND.CHARGE_OVERDUE) return 'Cobrança vencida';
  if (payload.task_kind === TASK_KIND.CHARGE_SEND) return 'Enviar cobrança';
  if (payload.task_kind === TASK_KIND.ONBOARDING_WELCOME) return 'Boas-vindas pós-pagamento';
  if (payload.task_kind === TASK_KIND.ONBOARDING_CHECKIN) return 'Check-in inicial';
  if (payload.task_kind === TASK_KIND.RENEWAL_REMINDER) return 'Renovação';
  if (event.event_type === 'payment_message_sent') return 'Cobrança';
  if (event.event_type === 'onboarding_welcome_sent') return 'Boas-vindas pós-pagamento';
  if (event.event_type === 'onboarding_checkin_sent') return 'Check-in inicial';
  if (event.event_type === 'renewal_message_sent') return 'Renovação';
  return 'Comunicação';
}

function historyType(event = {}) {
  const payload = historyPayload(event);
  return taskChannelLabel({ bucket: bucketFromTaskKind(payload.task_kind, event.event_type) });
}

function communicationTone(task) {
  if (task.kind === TASK_KIND.CHARGE_OVERDUE) return 'destructive';
  if (task.bucket === TASK_BUCKET.CHARGES) return 'info';
  if (task.bucket === TASK_BUCKET.ONBOARDING) return 'success';
  if (task.bucket === TASK_BUCKET.RENEWAL) return 'purple';
  return 'secondary';
}

function taskHasWhatsapp(task) {
  return Boolean(String(task?.customerWhatsapp || '').replace(/\D/g, ''));
}

function taskHasPaymentLink(task) {
  return Boolean(task?.asaasPaymentLink || task?.asaasPixCopy || task?.externalPaymentLink);
}

function taskMissingPaymentLink(task) {
  return task?.bucket === TASK_BUCKET.CHARGES && !taskHasPaymentLink(task);
}

function taskIsBlocked(task) {
  return !taskHasWhatsapp(task) || taskMissingPaymentLink(task);
}

function taskIsReady(task) {
  if (!taskHasWhatsapp(task)) return false;
  if (task.bucket === TASK_BUCKET.CHARGES) return taskHasPaymentLink(task);
  return true;
}

function filtersForTab(tab) {
  return QUICK_FILTERS.filter(filter => !filter.tabs || filter.tabs.includes(tab));
}

function taskMatchesQuickFilter(task, filter) {
  if (filter === 'overdue') return task.kind === TASK_KIND.CHARGE_OVERDUE;
  if (filter === 'blocked') return taskIsBlocked(task);
  if (filter === 'missing_link') return taskMissingPaymentLink(task);
  if (filter === 'ready') return taskIsReady(task);
  return true;
}

function taskAccentClass(task) {
  if (task.kind === TASK_KIND.CHARGE_OVERDUE) return 'bg-red-500';
  if (taskIsBlocked(task)) return 'bg-amber-400';
  if (task.bucket === TASK_BUCKET.ONBOARDING) return 'bg-green-500';
  if (task.bucket === TASK_BUCKET.RENEWAL) return 'bg-purple-500';
  return 'bg-blue-500';
}

function taskActionMeta(task) {
  if (!taskHasWhatsapp(task)) return { label: 'Resolver contato', icon: PhoneOff, variant: 'outline' };
  if (taskMissingPaymentLink(task)) return { label: 'Resolver link', icon: Link2, variant: 'outline' };
  if (task.kind === TASK_KIND.CHARGE_OVERDUE) return { label: 'Reenviar', icon: SendHorizontal, variant: 'default' };
  if (task.kind === TASK_KIND.CHARGE_SEND) return { label: 'Enviar cobrança', icon: MessageCircle, variant: 'default' };
  if (task.bucket === TASK_BUCKET.ONBOARDING) return { label: 'Enviar onboarding', icon: MessageCircle, variant: 'default' };
  if (task.bucket === TASK_BUCKET.RENEWAL) return { label: 'Enviar renovação', icon: MessageCircle, variant: 'default' };
  return { label: 'Preparar', icon: MessageCircle, variant: 'default' };
}

function taskDiscardDetails(task) {
  const context = [
    task.customerName,
    task.orderNumber,
    task.title,
  ].filter(Boolean).join(' · ');
  const timelineNote = task.ruleSlug
    ? 'Apenas esta etapa da régua será marcada como descartada. Se houver uma próxima mensagem, ela aparecerá quando chegar a data.'
    : 'Esta tarefa será removida da fila manual.';

  return { context, timelineNote };
}

function buildWorkSections(tasks = [], activeTab = 'pending') {
  const blocked = tasks.filter(taskIsBlocked);
  const available = tasks.filter(task => !taskIsBlocked(task));

  const sectionDefs = activeTab === TASK_BUCKET.CHARGES
    ? [
        {
          id: 'blocked',
          title: 'Resolver bloqueios',
          detail: 'Falta WhatsApp ou link antes de enviar.',
          tone: 'amber',
          tasks: blocked,
        },
        {
          id: 'overdue',
          title: 'Cobranças vencidas',
          detail: 'Prioridade de cobrança e reenvio.',
          tone: 'red',
          tasks: available.filter(task => task.kind === TASK_KIND.CHARGE_OVERDUE),
        },
        {
          id: 'ready',
          title: 'Cobranças prontas',
          detail: 'Já têm contato e link para envio.',
          tone: 'blue',
          tasks: available.filter(task => task.kind !== TASK_KIND.CHARGE_OVERDUE),
        },
      ]
    : activeTab === TASK_BUCKET.ONBOARDING
      ? [
          {
            id: 'blocked',
            title: 'Onboarding bloqueado',
            detail: 'Falta contato para iniciar a jornada.',
            tone: 'amber',
            tasks: blocked,
          },
          {
            id: 'ready',
            title: 'Onboarding pronto',
            detail: 'Boas-vindas e check-ins para enviar.',
            tone: 'green',
            tasks: available,
          },
        ]
      : activeTab === TASK_BUCKET.RENEWAL
        ? [
            {
              id: 'blocked',
              title: 'Renovações bloqueadas',
              detail: 'Falta contato para seguir.',
              tone: 'amber',
              tasks: blocked,
            },
            {
              id: 'ready',
              title: 'Renovações prontas',
              detail: 'Alunos próximos do fim do contrato.',
              tone: 'purple',
              tasks: available,
            },
          ]
        : [
            {
              id: 'blocked',
              title: '1. Resolver bloqueios',
              detail: 'Sem WhatsApp, sem link ou cobrança incompleta.',
              tone: 'amber',
              tasks: blocked,
            },
            {
              id: 'overdue',
              title: '2. Cobranças vencidas',
              detail: 'Comece pelas cobranças já atrasadas.',
              tone: 'red',
              tasks: available.filter(task => task.kind === TASK_KIND.CHARGE_OVERDUE),
            },
            {
              id: 'ready_charges',
              title: '3. Cobranças prontas',
              detail: 'Cobranças com contato e link disponíveis.',
              tone: 'blue',
              tasks: available.filter(task => task.bucket === TASK_BUCKET.CHARGES && task.kind !== TASK_KIND.CHARGE_OVERDUE),
            },
            {
              id: 'onboarding',
              title: '4. Onboarding',
              detail: 'Boas-vindas e check-ins iniciais.',
              tone: 'green',
              tasks: available.filter(task => task.bucket === TASK_BUCKET.ONBOARDING),
            },
            {
              id: 'renewal',
              title: '5. Renovações',
              detail: 'Continuidade de contrato e retenção.',
              tone: 'purple',
              tasks: available.filter(task => task.bucket === TASK_BUCKET.RENEWAL),
            },
          ];

  return sectionDefs.filter(section => section.tasks.length > 0);
}

function SummaryCard({ icon: Icon, label, value, tone = 'blue', detail }) {
  const tones = {
    gray: 'text-gray-700 bg-gray-50 border-gray-200',
    red: 'text-red-700 bg-red-50 border-red-200',
    amber: 'text-amber-700 bg-amber-50 border-amber-200',
    green: 'text-green-700 bg-green-50 border-green-200',
    blue: 'text-blue-700 bg-blue-50 border-blue-200',
  };
  return (
    <Card className="border-gray-200 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold text-gray-950 mt-1">{value}</p>
            {detail && <p className="text-xs text-muted-foreground mt-1">{detail}</p>}
          </div>
          <div className={`rounded-lg border p-2 ${tones[tone] || tones.blue}`}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function normalizeSaleHistory(ev, presaleMap, stockMap) {
  const row = ev.order_type === 'stock' ? stockMap.get(ev.order_id) : presaleMap.get(ev.order_id);
  if (!row) return null;
  const customerName = ev.order_type === 'stock' ? row.customer_name : row.checkout_name;
  const customerWhatsapp = ev.order_type === 'stock' ? row.customer_whatsapp : row.checkout_whatsapp;
  const status = historyStatus(ev);
  return {
    id: `sale:${ev.id}`,
    type: historyType(ev),
    title: historyTitle(ev),
    statusLabel: status.label,
    statusTone: status.tone,
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
    const status = historyStatus(ev);
    return {
      id: `contract:${ev.id}`,
      type: historyType(ev),
      title: historyTitle(ev),
      statusLabel: status.label,
      statusTone: status.tone,
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
      .select('id, contract_number, customer_id, coach_id, plan_id, status, payment_status, payment_date, due_date, start_date, end_date, created_at, updated_at, parent_contract_id, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, payment_message_sent_at, enrollment_fee, manual_discount, discount_recurring, credit_balance, installments, plan_snapshot')
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
  await applyAssessmentContractTransitions(contracts.data || []);

  return {
    ...Object.fromEntries(
      Object.entries(responses).map(([name, res]) => [name, res.data || []])
    ),
    communicationConfig,
    communicationRules: communicationConfig.rules,
    communityLink: communicationConfig.communityLink,
  };
}

function TaskCard({ task, onOpen, onDiscard, discarding }) {
  const hasWhatsapp = taskHasWhatsapp(task);
  const missingLink = taskMissingPaymentLink(task);
  const hasExternalLink = Boolean(task.externalPaymentLink);
  const nativePaymentInfo = hasNativePaymentInfo(task);
  const isOverdue = task.kind === TASK_KIND.CHARGE_OVERDUE;
  const isReady = taskIsReady(task);
  const action = taskActionMeta(task);
  const ActionIcon = action.icon;

  return (
    <div className="relative overflow-hidden rounded-lg border bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className={`absolute left-0 top-0 h-full w-1 ${taskAccentClass(task)}`} />
      <div className="grid gap-4 px-4 py-4 pl-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={communicationTone(task)}>{taskChannelLabel(task)}</Badge>
            {isOverdue && task.statusLabel && (
              <Badge variant="destructive" className="gap-1">
                <Clock3 className="w-3 h-3" />
                {task.statusLabel}
              </Badge>
            )}
            {missingLink && (
              <Badge variant="warning" className="gap-1">
                <Link2 className="w-3 h-3" />
                Sem link
              </Badge>
            )}
            {!hasWhatsapp && (
              <Badge variant="warning" className="gap-1">
                <PhoneOff className="w-3 h-3" />
                Sem WhatsApp
              </Badge>
            )}
            {nativePaymentInfo && <Badge variant="info">Asaas</Badge>}
            {!nativePaymentInfo && hasExternalLink && <Badge variant="outline">Link externo</Badge>}
            {isReady && <Badge variant="success">Pronta</Badge>}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link to={task.href} className="min-w-0 break-words text-base font-semibold leading-tight text-blue-700 hover:underline">
                {task.customerName}
              </Link>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono text-xs text-gray-700">{task.orderNumber}</span>
              {task.totalValue > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-semibold text-gray-950">{formatCurrency(task.totalValue)}</span>
                </>
              )}
            </div>
            {task.itemSummary && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">{task.itemSummary}</p>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {task.scheduledDate && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {formatDate(task.scheduledDate)}
              </span>
            )}
            {hasWhatsapp && <span>{formatPhoneDisplay(task.customerWhatsapp)}</span>}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-gray-100 bg-gray-50 p-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">Etapa</p>
            <p className="mt-0.5 text-sm font-semibold leading-snug text-gray-950">{task.title}</p>
            {!isOverdue && task.statusLabel && (
              <p className="mt-0.5 text-xs text-muted-foreground">{task.statusLabel}</p>
            )}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <Button
              size="sm"
              variant={action.variant}
              onClick={() => onOpen(task)}
              disabled={discarding}
              className="w-full gap-1.5"
            >
              <ActionIcon className="w-4 h-4" />
              {action.label}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDiscard(task)}
              disabled={discarding}
              className="w-full gap-1.5 border-gray-200 text-gray-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              {discarding ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
              Descartar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskSection({ section, onOpen, onDiscard, discardingTaskId }) {
  const toneClass = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-800',
    blue: 'border-blue-200 bg-blue-50 text-blue-800',
    green: 'border-green-200 bg-green-50 text-green-800',
    purple: 'border-purple-200 bg-purple-50 text-purple-800',
  }[section.tone] || 'border-gray-200 bg-gray-50 text-gray-800';
  const dotClass = {
    amber: 'bg-amber-400',
    red: 'bg-red-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    purple: 'bg-purple-500',
  }[section.tone] || 'bg-gray-400';

  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
            <div className="min-w-0">
              <h3 className="text-sm font-bold">{section.title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{section.detail}</p>
            </div>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${toneClass}`}>
            {section.tasks.length}
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {section.tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            onOpen={onOpen}
            onDiscard={onDiscard}
            discarding={discardingTaskId === task.id}
          />
        ))}
      </div>
    </section>
  );
}

function DiscardTaskDialog({ task, saving, onClose, onConfirm }) {
  if (!task) return null;
  const { context, timelineNote } = taskDiscardDetails(task);

  return (
    <Dialog open={!!task} onOpenChange={open => !open && !saving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <XCircle className="h-5 w-5" />
            Descartar etapa
          </DialogTitle>
          <DialogDescription>
            Essa ação remove esta tarefa da fila manual, sem cancelar cliente, contrato ou cobrança.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-900">
              Tem certeza que quer descartar esse contato?
            </p>
            <p className="mt-2 text-sm text-red-800">{context}</p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            {timelineNote}
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Descartar etapa
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryRow({ row }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary">{row.type}</Badge>
          {row.statusLabel && <Badge variant={row.statusTone || 'outline'}>{row.statusLabel}</Badge>}
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
  const [quickFilter, setQuickFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedTask, setSelectedTask] = useState(null);
  const [discardTask, setDiscardTask] = useState(null);
  const [discardingTaskId, setDiscardingTaskId] = useState(null);
  const [communityLink, setCommunityLink] = useState(DEFAULT_COMMUNITY_LINK);

  const handleTabChange = useCallback((value) => {
    setActiveTab(value);
    setQuickFilter('all');
  }, []);

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

  const historyTodayCount = useMemo(() => (
    history.filter(row => String(row.createdAt || '').slice(0, 10) === todayLocalStr()).length
  ), [history]);

  const operationCounts = useMemo(() => ({
    overdue: tasks.filter(t => t.kind === TASK_KIND.CHARGE_OVERDUE).length,
    blocked: tasks.filter(taskIsBlocked).length,
    missing_link: tasks.filter(taskMissingPaymentLink).length,
    ready: tasks.filter(taskIsReady).length,
  }), [tasks]);

  const tabTasks = useMemo(() => (
    activeTab === 'pending' ? tasks : tasks.filter(task => task.bucket === activeTab)
  ), [tasks, activeTab]);

  const quickCounts = useMemo(() => ({
    all: tabTasks.length,
    overdue: tabTasks.filter(t => t.kind === TASK_KIND.CHARGE_OVERDUE).length,
    blocked: tabTasks.filter(taskIsBlocked).length,
    missing_link: tabTasks.filter(taskMissingPaymentLink).length,
    ready: tabTasks.filter(taskIsReady).length,
  }), [tabTasks]);

  const availableQuickFilters = useMemo(() => filtersForTab(activeTab), [activeTab]);

  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tabTasks.filter(task => {
      if (!taskMatchesQuickFilter(task, quickFilter)) return false;
      if (!q) return true;
      return [
        task.title,
        task.customerName,
        task.customerWhatsapp,
        task.orderNumber,
        task.statusLabel,
        task.itemSummary,
      ].some(value => String(value || '').toLowerCase().includes(q));
    });
  }, [tabTasks, quickFilter, search]);

  const visibleHistory = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return history;
    return history.filter(row => [
      row.title,
      row.customerName,
      row.customerWhatsapp,
      row.orderNumber,
      row.type,
      row.statusLabel,
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }, [history, search]);

  const workSections = useMemo(() => (
    activeTab === 'history' ? [] : buildWorkSections(visibleTasks, activeTab)
  ), [activeTab, visibleTasks]);

  const handleSent = useCallback(() => {
    setSelectedTask(null);
    load({ quiet: true });
  }, [load]);

  const handleRequestDiscard = useCallback((task) => {
    setDiscardTask(task);
  }, []);

  const handleConfirmDiscard = useCallback(async () => {
    const task = discardTask;
    if (!task) return;
    setDiscardingTaskId(task.id);
    try {
      await registerCommunicationIgnore(task, {
        reason: 'Descartado pela fila da Central de Comunicação',
      });
      toast.success('Etapa descartada');
      setDiscardTask(null);
      await load({ quiet: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao descartar contato');
    } finally {
      setDiscardingTaskId(null);
    }
  }, [discardTask, load]);

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

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <SummaryCard
          icon={WalletCards}
          label="Pendentes"
          value={counts.pending}
          tone="blue"
          detail={`${counts[TASK_BUCKET.CHARGES]} cobrança${counts[TASK_BUCKET.CHARGES] === 1 ? '' : 's'} · ${historyTodayCount} hoje`}
        />
        <SummaryCard
          icon={Clock3}
          label="Vencidas"
          value={operationCounts.overdue}
          tone={operationCounts.overdue ? 'red' : 'gray'}
          detail="com lembrete ativo"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Bloqueios"
          value={operationCounts.blocked}
          tone={operationCounts.blocked ? 'amber' : 'gray'}
          detail={`${operationCounts.missing_link} sem link`}
        />
        <SummaryCard
          icon={SendHorizontal}
          label="Prontas"
          value={operationCounts.ready}
          tone="green"
          detail="com contato e link"
        />
      </div>

      <div className="rounded-lg border bg-white p-3 shadow-sm space-y-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
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
          <div className="relative w-full xl:w-80">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              className="pl-9"
              placeholder="Buscar cliente, pedido, item..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {activeTab !== 'history' && (
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            {availableQuickFilters.map(filter => {
              const active = quickFilter === filter.value;
              return (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setQuickFilter(filter.value)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-blue-200 hover:bg-blue-50'
                  }`}
                >
                  {filter.label}
                  <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                    active ? 'bg-white/20 text-white' : 'bg-white text-gray-600'
                  }`}>
                    {quickCounts[filter.value] || 0}
                  </span>
                </button>
              );
            })}
          </div>
        )}
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
        <div className="space-y-5">
          {visibleTasks.length === 0 ? (
            <div className="rounded-lg border bg-white p-10 text-center">
              <CheckCircle2 className="w-8 h-8 text-green-600 mx-auto mb-2" />
              <p className="font-semibold text-gray-900">Nada pendente nessa fila</p>
            </div>
          ) : workSections.map(section => (
            <TaskSection
              key={section.id}
              section={section}
              onOpen={setSelectedTask}
              onDiscard={handleRequestDiscard}
              discardingTaskId={discardingTaskId}
            />
          ))}
        </div>
      )}

      <CommunicationSendDialog
        key={selectedTask?.id || 'none'}
        task={selectedTask}
        communityLink={communityLink}
        onClose={() => setSelectedTask(null)}
        onSent={handleSent}
      />
      <DiscardTaskDialog
        task={discardTask}
        saving={Boolean(discardingTaskId)}
        onClose={() => setDiscardTask(null)}
        onConfirm={handleConfirmDiscard}
      />
    </div>
  );
}
