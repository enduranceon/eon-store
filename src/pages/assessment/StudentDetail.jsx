import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Archive,
  CalendarClock,
  Cake,
  ChevronRight,
  CheckCircle2,
  Clock,
  CreditCard,
  Edit2,
  FileText,
  Hash,
  IdCard,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Package,
  Phone,
  Plus,
  Save,
  Send,
  ShoppingBag,
  User,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AssessmentCoach,
  AssessmentContract,
  AssessmentContractEvent,
  AssessmentLeave,
  AssessmentModality,
  AssessmentPlan,
  PreSaleCustomer,
  PreSaleOrder,
  StockOrder,
} from '@/api/entities';
import { normalizePhone, supabase } from '@/api/db';
import {
  COMMUNICATION_EVENT_TYPES,
  TASK_BUCKET,
  TASK_KIND,
  buildCommunicationTasks,
  summarizeCommunicationEvent,
  taskChannelLabel,
} from '@/lib/communication-tasks';
import { DEFAULT_COMMUNITY_LINK, loadCommunicationConfig } from '@/lib/communication-config';
import CommunicationHistory from '@/components/CommunicationHistory';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { formatCurrency, formatDate, formatDateTime, todayLocalStr } from '@/lib/utils';
import { formatCep, formatCustomerAddress, lookupCepAddress, normalizeCep } from '@/lib/br-address';
import {
  buildContractLifecycleRows,
  getContractKindLabel,
  isRenewalContract,
} from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { isEffectiveOpenSale, isEffectiveSale } from '@/lib/sales';
import { toast } from 'sonner';

const CONTRACT_STATUS = {
  scheduled: { label: 'Agendado', cls: 'bg-blue-100 text-blue-700' },
  active: { label: 'Ativo', cls: 'bg-green-100 text-green-700' },
  overdue: { label: 'Atrasado', cls: 'bg-red-100 text-red-700' },
  on_leave: { label: 'Licença', cls: 'bg-amber-100 text-amber-700' },
  finished: { label: 'Concluído', cls: 'bg-gray-100 text-gray-600' },
  cancelled: { label: 'Cancelado', cls: 'bg-red-100 text-red-500' },
  voided: { label: 'Descartado', cls: 'bg-amber-100 text-amber-700' },
};

const PAYMENT_BADGE = {
  paid: 'success',
  partially_paid: 'warning',
  pending: 'warning',
  overdue: 'destructive',
  awaiting_charge: 'secondary',
  charge_sent: 'info',
  cancelled: 'destructive',
  refunded: 'outline',
};

const PAYMENT_LABEL = {
  awaiting_charge: 'Pedido recebido',
  charge_sent: 'Cobrança enviada',
  pending: 'Pendente',
  overdue: 'Atrasado',
  paid: 'Pago',
  partially_paid: 'Parcial',
  cancelled: 'Cancelado',
  refunded: 'Estornado',
};

const DELIVERY_STATUS = {
  awaiting_supplier: { label: 'Ag. fornecedor', cls: 'bg-gray-100 text-gray-700' },
  supplier_ordered: { label: 'Pedido ao forn.', cls: 'bg-blue-100 text-blue-700' },
  received: { label: 'Produto recebido', cls: 'bg-sky-100 text-sky-700' },
  awaiting_delivery: { label: 'Ag. entrega', cls: 'bg-gray-100 text-gray-700' },
  separated: { label: 'Separado', cls: 'bg-amber-100 text-amber-700' },
  delivered: { label: 'Entregue', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Cancelado', cls: 'bg-red-100 text-red-700' },
};

const TAB_VALUES = new Set(['overview', 'contracts', 'financial', 'products', 'timeline', 'communication', 'registration']);

const EMPTY_REGISTRATION_FORM = {
  customer_code: '',
  full_name: '',
  whatsapp: '',
  email: '',
  cpf: '',
  birth_date: '',
  address_zip: '',
  address_street: '',
  address_number: '',
  address_complement: '',
  address_neighborhood: '',
  address_city: '',
  address_state: '',
  internal_notes: '',
};

function buildRegistrationForm(customer) {
  return {
    customer_code: customer?.customer_code || '',
    full_name: customer?.full_name || '',
    whatsapp: customer?.whatsapp || '',
    email: customer?.email || '',
    cpf: customer?.cpf || '',
    birth_date: customer?.birth_date || '',
    address_zip: customer?.address_zip ? formatCep(customer.address_zip) : '',
    address_street: customer?.address_street || '',
    address_number: customer?.address_number || '',
    address_complement: customer?.address_complement || '',
    address_neighborhood: customer?.address_neighborhood || '',
    address_city: customer?.address_city || '',
    address_state: customer?.address_state || '',
    internal_notes: customer?.internal_notes || '',
  };
}

function taskTone(task) {
  if (task.kind === TASK_KIND.CHARGE_OVERDUE) return 'destructive';
  if (task.bucket === TASK_BUCKET.ONBOARDING) return 'success';
  if (task.bucket === TASK_BUCKET.RENEWAL) return 'purple';
  return 'info';
}

function dateValue(value) {
  return value || '';
}

function daysOverdue(dueDate, today) {
  if (!dueDate || dueDate >= today) return 0;
  return Math.round((new Date(today) - new Date(dueDate)) / 86400000);
}

function getOrderTypeMeta(type) {
  if (type === 'stock') {
    return {
      label: 'Estoque',
      icon: Archive,
      badgeClass: 'bg-purple-100 text-purple-700 border-purple-200',
      route: id => `/estoque/pedidos/${id}`,
    };
  }
  return {
    label: 'Pré-venda',
    icon: Package,
    badgeClass: 'bg-amber-100 text-amber-700 border-amber-200',
    route: id => `/pedidos/${id}`,
  };
}

function describeOrderItems(order) {
  const items = (order.items || []).filter(item => !item.cancelled);
  if (items.length === 0) return order.campaign_name || order.collection_name || 'Pedido sem itens detalhados';
  const first = items[0];
  const firstName = first.product_name || first.name || 'Produto';
  return items.length === 1 ? firstName : `${firstName} + ${items.length - 1}`;
}

function activeOrderItems(order) {
  return (order.items || []).filter(item => !item.cancelled);
}

function getItemName(item) {
  return item.product_name || item.name || item.product?.name || 'Produto';
}

function getItemVariationLabel(item) {
  return [item.variation, item.size, item.gender].filter(Boolean).join(' · ');
}

function getItemUnitPrice(item) {
  return Number(item.sale_price || 0) + Number(item.extras_total || 0);
}

function getItemTotal(item) {
  return getItemUnitPrice(item) * (Number(item.quantity) || 0);
}

function getDeliveryMeta(status) {
  return DELIVERY_STATUS[status] || { label: status || 'Sem entrega', cls: 'bg-gray-100 text-gray-600' };
}

function ContractStatusBadge({ status }) {
  const current = CONTRACT_STATUS[status] || { label: status || 'Sem status', cls: 'bg-gray-100 text-gray-600' };
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${current.cls}`}>{current.label}</span>;
}

function MetricCard({ label, value, helper, tone = 'default' }) {
  const toneClass = tone === 'dark'
    ? 'bg-gray-900 border-gray-800 text-white'
    : tone === 'danger'
      ? 'border-red-200 bg-red-50/50'
      : '';
  const helperClass = tone === 'dark' ? 'text-gray-400' : tone === 'danger' ? 'text-red-700' : 'text-muted-foreground';
  return (
    <Card className={toneClass}>
      <CardContent className="p-4">
        <p className={`text-xs ${helperClass}`}>{label}</p>
        <p className={`text-xl font-bold mt-1 ${tone === 'danger' ? 'text-red-700' : ''}`}>{value}</p>
        {helper && <p className={`text-xs mt-0.5 ${helperClass}`}>{helper}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyState({ icon: Icon, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon className="w-9 h-9 text-muted-foreground mb-3" />
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

function getPaidValue(row) {
  if (!['paid', 'partially_paid'].includes(row.payment_status)) return 0;
  return Number(row.total_value ?? row.value ?? 0) || 0;
}

function getOpenValue(row) {
  return isEffectiveOpenSale(row) ? Number(row.total_value ?? row.value ?? 0) || 0 : 0;
}

function getFinancialDate(row) {
  return row.payment_date || row.due_date || row.created_date || row.created_at || row.start_date || '';
}

function buildFinancialHistoryRows({ contracts, orders, today }) {
  const contractRows = contracts.map(contract => ({
    id: `contract-${contract.id}`,
    source: 'Assessoria',
    description: contract.contract_number || 'Contrato',
    detail: [
      contract.plan?.name || contract.plan?.period,
      contract.status ? CONTRACT_STATUS[contract.status]?.label || contract.status : null,
    ].filter(Boolean).join(' · '),
    route: `/assessoria/contratos/${contract.id}`,
    date: getFinancialDate(contract),
    dueDate: contract.due_date,
    saleValue: Number(contract.value || 0),
    paidValue: getPaidValue(contract),
    openValue: getOpenValue(contract),
    status: contract.payment_status,
    daysOverdue: daysOverdue(contract.due_date, today),
  }));

  const orderRows = orders.map(order => {
    const meta = getOrderTypeMeta(order._type);
    return {
      id: `${order._type}-${order.id}`,
      source: meta.label,
      description: order.order_number || 'Pedido',
      detail: describeOrderItems(order),
      route: meta.route(order.id),
      date: getFinancialDate(order),
      dueDate: order.due_date,
      saleValue: Number(order.total_value || 0),
      paidValue: getPaidValue(order),
      openValue: getOpenValue(order),
      status: order.payment_status,
      daysOverdue: daysOverdue(order.due_date, today),
    };
  });

  return [...contractRows, ...orderRows]
    .sort((a, b) => dateValue(b.date).localeCompare(dateValue(a.date)));
}

function buildTimelineEvents({ contracts, orders, leaves, commEvents, modalities, coaches }) {
  const events = [];

  for (const contract of contracts) {
    const plan = contract.plan;
    const modality = plan && modalities.find(item => item.id === plan.modality_id);
    const coach = coaches.find(item => item.id === contract.coach_id);
    const contractLabel = [modality?.name, plan?.name || plan?.period, coach?.name].filter(Boolean).join(' · ');

    events.push({
      id: `contract-created-${contract.id}`,
      type: 'contract',
      date: contract.created_at || contract.start_date,
      title: 'Contrato criado',
      description: contractLabel || contract.contract_number,
      badge: CONTRACT_STATUS[contract.status]?.label || contract.status || 'Contrato',
      badgeVariant: contract.status === 'active' ? 'success' : contract.status === 'cancelled' ? 'destructive' : 'secondary',
      value: Number(contract.value || 0),
      route: `/assessoria/contratos/${contract.id}`,
    });

    if (contract.payment_date || contract.payment_status === 'paid') {
      events.push({
        id: `contract-paid-${contract.id}`,
        type: 'payment',
        date: contract.payment_date || contract.due_date || contract.created_at,
        title: 'Pagamento de contrato',
        description: contract.contract_number,
        badge: PAYMENT_LABEL[contract.payment_status] || contract.payment_status,
        badgeVariant: PAYMENT_BADGE[contract.payment_status] || 'secondary',
        value: Number(contract.value || 0),
        route: `/assessoria/contratos/${contract.id}`,
      });
    }

    if (contract.status === 'cancelled') {
      events.push({
        id: `contract-cancelled-${contract.id}`,
        type: 'contract',
        date: contract.cancellation_date || contract.updated_at || contract.end_date,
        title: 'Contrato cancelado',
        description: contract.cancellation_reason || contract.contract_number,
        badge: 'Cancelado',
        badgeVariant: 'destructive',
        route: `/assessoria/contratos/${contract.id}`,
      });
    } else if (contract.status === 'finished') {
      events.push({
        id: `contract-finished-${contract.id}`,
        type: 'contract',
        date: contract.end_date,
        title: 'Contrato finalizado',
        description: contract.contract_number,
        badge: 'Finalizado',
        badgeVariant: 'secondary',
        route: `/assessoria/contratos/${contract.id}`,
      });
    }
  }

  for (const order of orders) {
    const meta = getOrderTypeMeta(order._type);
    events.push({
      id: `order-created-${order._type}-${order.id}`,
      type: 'product',
      date: order.created_date || order.created_at,
      title: `Venda de ${meta.label.toLowerCase()}`,
      description: describeOrderItems(order),
      badge: order.order_number,
      badgeVariant: 'outline',
      value: Number(order.total_value || 0),
      route: meta.route(order.id),
    });

    if (order.payment_date || order.payment_status === 'paid') {
      events.push({
        id: `order-paid-${order._type}-${order.id}`,
        type: 'payment',
        date: order.payment_date || order.due_date || order.created_date,
        title: 'Pagamento de produto',
        description: describeOrderItems(order),
        badge: PAYMENT_LABEL[order.payment_status] || order.payment_status,
        badgeVariant: PAYMENT_BADGE[order.payment_status] || 'secondary',
        value: Number(order.total_value || 0),
        route: meta.route(order.id),
      });
    }
  }

  for (const leave of leaves) {
    events.push({
      id: `leave-start-${leave.id}`,
      type: 'leave',
      date: leave.start_date,
      title: 'Licença iniciada',
      description: leave.end_date ? `${formatDate(leave.start_date)} → ${formatDate(leave.end_date)}` : 'Sem término definido',
      badge: leave.status === 'active' ? 'Ativa' : 'Licença',
      badgeVariant: leave.status === 'active' ? 'warning' : 'secondary',
    });
    if (leave.end_date && leave.status !== 'active') {
      events.push({
        id: `leave-end-${leave.id}`,
        type: 'leave',
        date: leave.end_date,
        title: 'Licença encerrada',
        description: `${leave.days || 0} dias registrados`,
        badge: 'Encerrada',
        badgeVariant: 'secondary',
      });
    }
  }

  for (const event of commEvents) {
    events.push({
      id: `communication-${event.id}`,
      type: 'communication',
      date: event.created_at,
      title: 'Comunicação registrada',
      description: summarizeCommunicationEvent(event) || event.payload?.message || event.event_type,
      badge: event.payload?.channel || 'Contato',
      badgeVariant: 'info',
    });
  }

  return events
    .filter(event => event.date)
    .sort((a, b) => dateValue(b.date).localeCompare(dateValue(a.date)));
}

function getTimelineIcon(type) {
  if (type === 'payment') return CheckCircle2;
  if (type === 'product') return ShoppingBag;
  if (type === 'communication') return MessageCircle;
  if (type === 'leave') return Clock;
  return FileText;
}

function TimelineList({ events }) {
  if (events.length === 0) {
    return <EmptyState icon={CalendarClock} text="Nenhum evento registrado ainda" />;
  }

  return (
    <div className="relative pl-5">
      <div className="absolute left-2 top-2 bottom-2 w-px bg-gray-200" />
      <div className="space-y-3">
        {events.map(event => {
          const Icon = getTimelineIcon(event.type);
          const content = (
            <div className="relative rounded-lg border bg-white px-3 py-3 hover:bg-gray-50 transition-colors">
              <div className="absolute -left-[1.55rem] top-3 w-7 h-7 rounded-full border bg-white flex items-center justify-center">
                <Icon className="w-3.5 h-3.5 text-gray-600" />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold">{event.title}</p>
                    {event.badge && <Badge variant={event.badgeVariant || 'secondary'}>{event.badge}</Badge>}
                  </div>
                  {event.description && <p className="text-xs text-muted-foreground mt-1 break-words">{event.description}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">{event.date?.includes?.('T') ? formatDateTime(event.date) : formatDate(event.date)}</p>
                </div>
                {event.value !== undefined && (
                  <span className="text-sm font-bold shrink-0">{formatCurrency(event.value)}</span>
                )}
              </div>
            </div>
          );
          return event.route ? (
            <Link key={event.id} to={event.route} className="block">{content}</Link>
          ) : (
            <div key={event.id}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}

export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [customer, setCustomer] = useState(null);
  const [contracts, setContracts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [plans, setPlans] = useState([]);
  const [modalities, setModalities] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [commEvents, setCommEvents] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [pendingTasks, setPendingTasks] = useState([]);
  const [communityLink, setCommunityLink] = useState(DEFAULT_COMMUNITY_LINK);
  const [selectedTask, setSelectedTask] = useState(null);
  const [reloadFlag, setReloadFlag] = useState(0);
  const [editingRegistration, setEditingRegistration] = useState(false);
  const [registrationForm, setRegistrationForm] = useState(EMPTY_REGISTRATION_FORM);
  const [savingRegistration, setSavingRegistration] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [student, allPresaleOrders, stockOrders, rawContracts, allCoaches, allPlans, allMod, authRes, config] = await Promise.all([
          PreSaleCustomer.get(id),
          PreSaleOrder.list().catch(() => []),
          StockOrder.filter({ customer_id: id }, '-created_date').catch(() => []),
          AssessmentContract.filter({ customer_id: id }, '-created_at').catch(() => []),
          AssessmentCoach.list().catch(() => []),
          AssessmentPlan.list().catch(() => []),
          AssessmentModality.list().catch(() => []),
          supabase.auth.getUser().catch(() => null),
          loadCommunicationConfig().catch(() => null),
        ]);
        if (!active) return;

        await applyAssessmentContractTransitions(rawContracts);
        if (!active) return;

        const presaleOrders = allPresaleOrders
          .filter(order => order.customer_id === id)
          .map(order => ({ ...order, _type: 'presale' }));
        const stockOrdersTagged = stockOrders.map(order => ({ ...order, _type: 'stock' }));
        const mergedOrders = [...presaleOrders, ...stockOrdersTagged]
          .sort((a, b) => dateValue(b.created_date).localeCompare(dateValue(a.created_date)));

        setCustomer(student);
        setRegistrationForm(buildRegistrationForm(student));
        setContracts(rawContracts);
        setOrders(mergedOrders);
        setCoaches(allCoaches);
        setPlans(allPlans);
        setModalities(allMod);
        setCurrentUserId(authRes?.data?.user?.id || null);
        setCommunityLink(config?.communityLink || DEFAULT_COMMUNITY_LINK);

        if (rawContracts.length === 0) {
          setLeaves([]);
          setCommEvents([]);
          setPendingTasks(buildCommunicationTasks(
            {
              contracts: [],
              customers: [student],
              plans: allPlans,
              modalities: allMod,
              coaches: allCoaches,
              contractEvents: [],
              presaleOrders,
              stockOrders: stockOrdersTagged,
            },
            { rules: config?.rules },
          ));
          return;
        }

        const contractIds = rawContracts.map(contract => contract.id);
        const [allLeaves, events] = await Promise.all([
          Promise.all(rawContracts.map(contract => AssessmentLeave.filter({ contract_id: contract.id }).catch(() => []))),
          AssessmentContractEvent.filter(
            { contract_id: contractIds, event_type: COMMUNICATION_EVENT_TYPES },
            '-created_at',
          ).catch(() => []),
        ]);
        if (!active) return;

        setLeaves(allLeaves.flat().sort((a, b) => dateValue(b.start_date).localeCompare(dateValue(a.start_date))));
        setCommEvents(events);
        setPendingTasks(buildCommunicationTasks(
          {
            contracts: rawContracts,
            customers: [student],
            plans: allPlans,
            modalities: allMod,
            coaches: allCoaches,
            contractEvents: events,
            presaleOrders,
            stockOrders: stockOrdersTagged,
          },
          { rules: config?.rules },
        ));
      } catch (e) {
        console.error('Erro ao carregar aluno:', e);
      }
    };
    load();
    return () => { active = false; };
  }, [id, reloadFlag]);

  const setRegistrationField = (field, value) => {
    setRegistrationForm(form => ({ ...form, [field]: value }));
  };

  const cancelRegistrationEdit = () => {
    setRegistrationForm(buildRegistrationForm(customer));
    setEditingRegistration(false);
    setCepLoading(false);
  };

  const fillAddressByCep = async () => {
    const cep = normalizeCep(registrationForm.address_zip);
    if (!cep) return;
    if (cep.length !== 8) return toast.error('Informe um CEP com 8 dígitos');

    setCepLoading(true);
    try {
      const addressData = await lookupCepAddress(cep);
      setRegistrationForm(form => ({
        ...form,
        address_zip: formatCep(addressData.zip),
        address_street: addressData.street || form.address_street,
        address_complement: form.address_complement || addressData.complement || '',
        address_neighborhood: addressData.neighborhood || form.address_neighborhood,
        address_city: addressData.city || form.address_city,
        address_state: addressData.state || form.address_state,
      }));
      toast.success('Endereço preenchido pelo CEP');
    } catch (e) {
      toast.error(e.message || 'Não foi possível buscar o CEP');
    } finally {
      setCepLoading(false);
    }
  };

  const saveRegistration = async () => {
    if (!registrationForm.full_name?.trim()) return toast.error('Nome obrigatório');

    const cleanCpf = registrationForm.cpf?.replace(/\D/g, '') || null;
    setSavingRegistration(true);
    try {
      if (cleanCpf && cleanCpf !== (customer.cpf || '').replace(/\D/g, '')) {
        const { data: duplicate, error } = await supabase
          .from('presale_customers')
          .select('id, full_name')
          .eq('cpf', cleanCpf)
          .neq('id', id)
          .maybeSingle();
        if (error) throw error;
        if (duplicate) {
          toast.error(`CPF já cadastrado para ${duplicate.full_name}. Use a tela de Clientes para mesclar os perfis.`);
          return;
        }
      }

      const payload = {
        full_name: registrationForm.full_name.trim(),
        whatsapp: registrationForm.whatsapp ? normalizePhone(registrationForm.whatsapp) : null,
        email: registrationForm.email?.trim().toLowerCase() || null,
        cpf: cleanCpf,
        birth_date: registrationForm.birth_date || null,
        address_zip: normalizeCep(registrationForm.address_zip) || null,
        address_street: registrationForm.address_street?.trim() || null,
        address_number: registrationForm.address_number?.trim() || null,
        address_complement: registrationForm.address_complement?.trim() || null,
        address_neighborhood: registrationForm.address_neighborhood?.trim() || null,
        address_city: registrationForm.address_city?.trim() || null,
        address_state: registrationForm.address_state?.trim().toUpperCase() || null,
        internal_notes: registrationForm.internal_notes?.trim() || null,
      };

      await PreSaleCustomer.update(id, payload);
      const updatedCustomer = { ...customer, ...payload };
      setCustomer(updatedCustomer);
      setRegistrationForm(buildRegistrationForm(updatedCustomer));
      setEditingRegistration(false);
      toast.success('Cadastro atualizado!');
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar cadastro');
    } finally {
      setSavingRegistration(false);
    }
  };

  const plansById = useMemo(() => Object.fromEntries(plans.map(plan => [plan.id, plan])), [plans]);
  const lifecycleRows = useMemo(
    () => buildContractLifecycleRows(contracts, { plansById }),
    [contracts, plansById],
  );

  const today = todayLocalStr();
  const activeContracts = lifecycleRows.filter(contract => contract.lifecycle?.counts?.active);
  const scheduledContracts = lifecycleRows.filter(contract => contract.lifecycle?.type === 'scheduled');
  const effectiveOrders = orders.filter(isEffectiveSale);
  const paidOrders = effectiveOrders.filter(order => ['paid', 'partially_paid'].includes(order.payment_status));
  const openOrders = orders
    .filter(isEffectiveOpenSale)
    .map(order => ({ ...order, _daysOverdue: daysOverdue(order.due_date, today), _value: Number(order.total_value) || 0 }));
  const openContracts = lifecycleRows
    .filter(isEffectiveOpenSale)
    .map(contract => ({ ...contract, _daysOverdue: daysOverdue(contract.due_date, today), _value: Number(contract.value) || 0 }));
  const paidContracts = lifecycleRows.filter(contract =>
    contract.payment_status === 'paid' &&
    !['pending_sale', 'voided_sale'].includes(contract.lifecycle?.type)
  );

  const totalProducts = effectiveOrders.reduce((sum, order) => sum + (Number(order.total_value) || 0), 0);
  const totalProductsPaid = paidOrders.reduce((sum, order) => sum + (Number(order.total_value) || 0), 0);
  const totalContractsPaid = paidContracts.reduce((sum, contract) => sum + (Number(contract.value) || 0), 0);
  const totalOpen = openOrders.reduce((sum, order) => sum + order._value, 0) + openContracts.reduce((sum, contract) => sum + contract._value, 0);
  const monthlyActive = activeContracts.reduce((sum, contract) => sum + (Number(contract.monthly) || 0), 0);
  const ltv = totalProductsPaid + totalContractsPaid;

  const currentContract = activeContracts[0] || scheduledContracts[0] || lifecycleRows[0] || null;
  const currentPlan = currentContract?.plan || plans.find(plan => plan.id === currentContract?.plan_id);
  const currentModality = currentPlan && modalities.find(modality => modality.id === currentPlan.modality_id);
  const currentCoach = coaches.find(coach => coach.id === currentContract?.coach_id);
  const latestOrder = orders[0] || null;
  const address = customer ? formatCustomerAddress(customer) : '';
  const financialRows = [
    ...openContracts.map(contract => ({ kind: 'contract', source: 'Contrato', row: contract, date: contract.due_date, value: contract._value, route: `/assessoria/contratos/${contract.id}` })),
    ...openOrders.map(order => {
      const meta = getOrderTypeMeta(order._type);
      return { kind: order._type, source: meta.label, row: order, date: order.due_date, value: order._value, route: meta.route(order.id) };
    }),
  ].sort((a, b) => dateValue(a.date).localeCompare(dateValue(b.date)));
  const financialHistoryRows = buildFinancialHistoryRows({ contracts: lifecycleRows, orders, today });
  const timelineEvents = buildTimelineEvents({ contracts: lifecycleRows, orders, leaves, commEvents, modalities, coaches });
  const requestedTab = searchParams.get('aba');
  const activeTab = TAB_VALUES.has(requestedTab) ? requestedTab : 'overview';
  const setActiveTab = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'overview') next.delete('aba');
    else next.set('aba', value);
    setSearchParams(next, { replace: true });
  };

  if (!customer) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex flex-col gap-4 rounded-lg border bg-white px-4 py-4 lg:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/alunos')} className="shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="w-12 h-12 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
              <User className="w-6 h-6 text-blue-700" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {customer.customer_code && (
                  <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded">
                    {customer.customer_code}
                  </span>
                )}
                <h2 className="text-xl font-bold text-gray-900 truncate">{customer.full_name}</h2>
                <Badge variant={customer.active !== false ? 'success' : 'secondary'}>
                  {customer.active !== false ? 'Cadastro ativo' : 'Cadastro inativo'}
                </Badge>
                {currentContract && <ContractStatusBadge status={currentContract.status} />}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {customer.whatsapp && <span className="inline-flex items-center gap-1"><Phone className="w-3.5 h-3.5" /> {customer.whatsapp}</span>}
                {customer.email && <span className="inline-flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> {customer.email}</span>}
                {customer.cpf && <span className="inline-flex items-center gap-1"><IdCard className="w-3.5 h-3.5" /> {customer.cpf}</span>}
              </div>
              {(currentPlan || currentCoach) && (
                <p className="mt-2 text-sm text-gray-700">
                  {[currentModality?.name, currentPlan?.name || currentPlan?.period, currentCoach?.name].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 lg:justify-end">
            {customer.whatsapp && (
              <Button variant="outline" asChild>
                <a href={`https://wa.me/${customer.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
                  <MessageCircle className="w-4 h-4" /> WhatsApp
                </a>
              </Button>
            )}
            <Button variant="outline" onClick={() => navigate(`/estoque/pedidos/novo?customer_id=${id}`)}>
              <ShoppingBag className="w-4 h-4" /> Venda produto
            </Button>
            <Button onClick={() => navigate(`/assessoria/contratos/novo?customer_id=${id}`)}>
              <Plus className="w-4 h-4" /> Novo contrato
            </Button>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
        <div className="overflow-x-auto">
          <TabsList className="h-auto flex w-max min-w-full justify-start">
            <TabsTrigger value="overview">Visão geral</TabsTrigger>
            <TabsTrigger value="contracts">Contratos</TabsTrigger>
            <TabsTrigger value="financial">Financeiro</TabsTrigger>
            <TabsTrigger value="products">Produtos</TabsTrigger>
            <TabsTrigger value="timeline">Histórico</TabsTrigger>
            <TabsTrigger value="communication">Comunicação</TabsTrigger>
            <TabsTrigger value="registration">Cadastro</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="LTV total" value={formatCurrency(ltv)} helper={monthlyActive > 0 ? `${formatCurrency(monthlyActive)}/mês ativo` : 'Loja + assessoria pagos'} tone="dark" />
            <MetricCard label="Contratos" value={String(lifecycleRows.length)} helper={`${activeContracts.length} ativo${activeContracts.length !== 1 ? 's' : ''}`} />
            <MetricCard label="Produtos" value={formatCurrency(totalProducts)} helper={`${orders.length} pedido${orders.length !== 1 ? 's' : ''}`} />
            <MetricCard label="Em aberto" value={formatCurrency(totalOpen)} helper={`${openContracts.length + openOrders.length} cobrança${openContracts.length + openOrders.length !== 1 ? 's' : ''}`} tone={totalOpen > 0 ? 'danger' : 'default'} />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-600" /> Situação da assessoria
                  </CardTitle>
                  <Button size="sm" variant="outline" onClick={() => navigate(`/assessoria/contratos/novo?customer_id=${id}`)}>
                    <Plus className="w-3.5 h-3.5" /> Contrato
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!currentContract ? (
                  <EmptyState icon={FileText} text="Sem contrato de assessoria cadastrado" />
                ) : (
                  <Link to={`/assessoria/contratos/${currentContract.id}`} className="flex items-center gap-3 rounded-lg border px-3 py-3 hover:bg-gray-50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-mono text-sm font-semibold text-blue-700">{currentContract.contract_number}</p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          isRenewalContract(currentContract) ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {getContractKindLabel(currentContract)}
                        </span>
                        <ContractStatusBadge status={currentContract.status} />
                      </div>
                      <p className="text-sm mt-1">
                        {[currentModality?.name, currentPlan?.name || currentPlan?.period, currentCoach?.name].filter(Boolean).join(' · ') || 'Contrato sem plano vinculado'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDate(currentContract.start_date)} → {formatDate(currentContract.end_date)}
                      </p>
                      {currentContract.scheduled_cancellation_date && (
                        <p className="text-xs font-semibold text-blue-700 mt-1">
                          Cancelamento agendado para {formatDate(currentContract.scheduled_cancellation_date)}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold">{formatCurrency(currentContract.value || 0)}</p>
                      <p className="text-xs text-muted-foreground">{formatCurrency(currentContract.monthly || 0)}/mês</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  </Link>
                )}
              </CardContent>
            </Card>

            <Card className={totalOpen > 0 ? 'border-red-200 bg-red-50/30' : ''}>
              <CardHeader className="pb-2">
                <CardTitle className={`text-base flex items-center gap-2 ${totalOpen > 0 ? 'text-red-700' : ''}`}>
                  <CreditCard className="w-4 h-4" /> Financeiro
                </CardTitle>
              </CardHeader>
              <CardContent>
                {financialRows.length === 0 ? (
                  <div className="rounded-lg border bg-white px-3 py-3">
                    <p className="text-sm font-semibold text-green-700">Nada em aberto</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Pagamentos e cobranças estão em dia.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {financialRows.slice(0, 3).map(item => (
                      <Link key={`${item.kind}-${item.row.id}`} to={item.route} className="flex items-center gap-3 rounded-lg border bg-white px-3 py-2 hover:border-red-300">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate">{item.source}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.date ? formatDate(item.date) : 'Sem vencimento'}
                            {item.row._daysOverdue > 0 && <span className="text-red-700 font-semibold"> · {item.row._daysOverdue}d atraso</span>}
                          </p>
                        </div>
                        <span className="text-sm font-bold text-red-700">{formatCurrency(item.value)}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4 text-emerald-600" /> Vendas de produtos
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!latestOrder ? (
                  <EmptyState
                    icon={ShoppingBag}
                    text="Nenhuma compra de produto ainda"
                    action={<Button className="mt-4" size="sm" onClick={() => navigate(`/estoque/pedidos/novo?customer_id=${id}`)}>Nova venda</Button>}
                  />
                ) : (
                  <div className="space-y-2">
                    {orders.slice(0, 4).map(order => {
                      const meta = getOrderTypeMeta(order._type);
                      const Icon = meta.icon;
                      return (
                        <Link key={`${order._type}-${order.id}`} to={meta.route(order.id)} className="flex items-center gap-3 rounded-lg border px-3 py-2 hover:bg-gray-50">
                          <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold truncate">{describeOrderItems(order)}</p>
                            <p className="text-xs text-muted-foreground">
                              <span className="font-mono">{order.order_number}</span> · {formatDate(order.created_date)}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-bold">{formatCurrency(order.total_value || 0)}</p>
                            <Badge variant={PAYMENT_BADGE[order.payment_status] || 'secondary'}>{PAYMENT_LABEL[order.payment_status] || order.payment_status}</Badge>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Send className="w-4 h-4 text-blue-600" /> Comunicação
                </CardTitle>
              </CardHeader>
              <CardContent>
                {pendingTasks.length === 0 ? (
                  <div className="rounded-lg border px-3 py-3">
                    <p className="text-sm font-semibold text-gray-900">{commEvents.length} contato{commEvents.length !== 1 ? 's' : ''} registrado{commEvents.length !== 1 ? 's' : ''}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Nenhuma ação pendente agora.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pendingTasks.slice(0, 4).map(task => (
                      <div key={task.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant={taskTone(task)}>{taskChannelLabel(task)}</Badge>
                            <p className="text-sm font-semibold truncate">{task.title}</p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">{task.statusLabel || task.orderNumber}</p>
                        </div>
                        <Button size="sm" onClick={() => setSelectedTask(task)}>Preparar</Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="contracts" className="space-y-5">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Contratos ({lifecycleRows.length})</CardTitle>
                <Button size="sm" onClick={() => navigate(`/assessoria/contratos/novo?customer_id=${id}`)}><Plus className="w-3.5 h-3.5" /> Novo contrato</Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {lifecycleRows.length === 0 ? (
                <EmptyState icon={FileText} text="Sem contratos ainda" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Contrato</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Plano</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Período</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Valor</th>
                        <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {lifecycleRows.map(contract => {
                        const plan = contract.plan || plans.find(p => p.id === contract.plan_id);
                        const modality = plan && modalities.find(mod => mod.id === plan.modality_id);
                        const coach = coaches.find(coachRow => coachRow.id === contract.coach_id);
                        return (
                          <tr key={contract.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/contratos/${contract.id}`)}>
                            <td className="px-3 py-3">
                              <p className="font-mono text-xs font-semibold text-blue-700">{contract.contract_number}</p>
                              <p className="text-xs text-muted-foreground">{getContractKindLabel(contract)}</p>
                            </td>
                            <td className="px-3 py-3">
                              <p className="font-semibold">{plan?.name || plan?.period || '—'}</p>
                              <p className="text-xs text-muted-foreground">{[modality?.name, coach?.name].filter(Boolean).join(' · ') || '—'}</p>
                            </td>
                            <td className="px-3 py-3 text-muted-foreground">{formatDate(contract.start_date)} → {formatDate(contract.end_date)}</td>
                            <td className="px-3 py-3 text-right font-semibold">{formatCurrency(contract.value || 0)}</td>
                            <td className="px-3 py-3 text-center"><ContractStatusBadge status={contract.status} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {leaves.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Licenças ({leaves.length})</CardTitle></CardHeader>
              <CardContent className="pt-0">
                <div className="divide-y text-sm">
                  {leaves.map(leave => (
                    <div key={leave.id} className="flex items-center justify-between gap-3 py-2">
                      <span>{formatDate(leave.start_date)} → {leave.end_date ? formatDate(leave.end_date) : 'sem término'} <span className="text-xs text-muted-foreground">({leave.days || 0} dias)</span></span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${leave.status === 'active' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                        {leave.status === 'active' ? 'Ativa' : 'Encerrada'}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="financial" className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Pago em assessoria" value={formatCurrency(totalContractsPaid)} />
            <MetricCard label="Pago em produtos" value={formatCurrency(totalProductsPaid)} />
            <MetricCard label="Em aberto" value={formatCurrency(totalOpen)} tone={totalOpen > 0 ? 'danger' : 'default'} />
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><CreditCard className="w-4 h-4" /> Cobranças em aberto</CardTitle></CardHeader>
            <CardContent>
              {financialRows.length === 0 ? (
                <EmptyState icon={CreditCard} text="Nenhuma cobrança em aberto" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Origem</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Descrição</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Vencimento</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Valor</th>
                        <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {financialRows.map(item => (
                        <tr key={`${item.kind}-${item.row.id}`} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(item.route)}>
                          <td className="px-3 py-3 font-semibold">{item.source}</td>
                          <td className="px-3 py-3">
                            <p className="font-semibold">{item.kind === 'contract' ? item.row.contract_number : item.row.order_number}</p>
                            <p className="text-xs text-muted-foreground">{item.kind === 'contract' ? 'Contrato de assessoria' : describeOrderItems(item.row)}</p>
                          </td>
                          <td className="px-3 py-3">
                            {item.date ? formatDate(item.date) : '—'}
                            {item.row._daysOverdue > 0 && <p className="text-xs font-semibold text-red-700">{item.row._daysOverdue}d em atraso</p>}
                          </td>
                          <td className="px-3 py-3 text-right font-bold text-red-700">{formatCurrency(item.value)}</td>
                          <td className="px-3 py-3 text-center">
                            <Badge variant={PAYMENT_BADGE[item.row.payment_status] || 'secondary'}>{PAYMENT_LABEL[item.row.payment_status] || item.row.payment_status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="w-4 h-4" /> Histórico financeiro ({financialHistoryRows.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {financialHistoryRows.length === 0 ? (
                <EmptyState icon={CreditCard} text="Nenhum movimento financeiro encontrado" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Data</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Origem</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Descrição</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Venda</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Pago</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Aberto</th>
                        <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {financialHistoryRows.map(item => (
                        <tr key={item.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(item.route)}>
                          <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{formatDate(item.date)}</td>
                          <td className="px-3 py-3 font-semibold whitespace-nowrap">{item.source}</td>
                          <td className="px-3 py-3">
                            <p className="font-semibold">{item.description}</p>
                            <p className="text-xs text-muted-foreground">{item.detail || '—'}</p>
                            {item.daysOverdue > 0 && <p className="text-xs font-semibold text-red-700">{item.daysOverdue}d em atraso</p>}
                          </td>
                          <td className="px-3 py-3 text-right font-semibold">{formatCurrency(item.saleValue)}</td>
                          <td className="px-3 py-3 text-right text-green-700 font-semibold">{formatCurrency(item.paidValue)}</td>
                          <td className="px-3 py-3 text-right text-red-700 font-semibold">{formatCurrency(item.openValue)}</td>
                          <td className="px-3 py-3 text-center">
                            <Badge variant={PAYMENT_BADGE[item.status] || 'secondary'}>{PAYMENT_LABEL[item.status] || item.status || '—'}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="products" className="space-y-5">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><ShoppingBag className="w-4 h-4" /> Produtos comprados ({orders.length})</CardTitle>
                <Button size="sm" onClick={() => navigate(`/estoque/pedidos/novo?customer_id=${id}`)}><Plus className="w-3.5 h-3.5" /> Nova venda</Button>
              </div>
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <EmptyState icon={ShoppingBag} text="Nenhum produto vendido para este aluno" />
              ) : (
                <div className="space-y-3">
                  {orders.map(order => {
                    const meta = getOrderTypeMeta(order._type);
                    const Icon = meta.icon;
                    const delivery = getDeliveryMeta(order.delivery_status);
                    const items = activeOrderItems(order);
                    return (
                      <div key={`${order._type}-${order.id}`} className="rounded-lg border bg-white overflow-hidden">
                        <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0">
                              <Icon className="w-4 h-4 text-gray-600" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Link to={meta.route(order.id)} className="font-semibold text-blue-700 hover:underline">
                                  {order.order_number || 'Pedido'}
                                </Link>
                                <span className={`text-[10px] font-semibold border px-1.5 py-0.5 rounded-full ${meta.badgeClass}`}>{meta.label}</span>
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${delivery.cls}`}>{delivery.label}</span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {formatDate(order.created_date)} · {items.length || 0} item{items.length !== 1 ? 's' : ''}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 sm:text-right">
                            <div>
                              <p className="font-bold">{formatCurrency(order.total_value || 0)}</p>
                              <Badge variant={PAYMENT_BADGE[order.payment_status] || 'secondary'}>{PAYMENT_LABEL[order.payment_status] || order.payment_status}</Badge>
                            </div>
                            <Button size="sm" variant="outline" asChild>
                              <Link to={meta.route(order.id)}>Abrir</Link>
                            </Button>
                          </div>
                        </div>

                        {items.length === 0 ? (
                          <div className="border-t px-3 py-3 text-sm text-muted-foreground">
                            {describeOrderItems(order)}
                          </div>
                        ) : (
                          <div className="border-t overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead className="bg-gray-50 border-b">
                                <tr>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Item</th>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Variação</th>
                                  <th className="text-center px-3 py-2 font-medium text-muted-foreground">Qtd</th>
                                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Unit.</th>
                                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Total</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y">
                                {items.map((item, index) => (
                                  <tr key={`${order.id}-${item.product_id || item.product_name || index}`}>
                                    <td className="px-3 py-2">
                                      <p className="font-semibold">{getItemName(item)}</p>
                                      {item.extras?.length > 0 && (
                                        <p className="text-xs text-muted-foreground">
                                          Extras: {item.extras.map(extra => extra.name).filter(Boolean).join(', ')}
                                        </p>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-muted-foreground">{getItemVariationLabel(item) || '—'}</td>
                                    <td className="px-3 py-2 text-center font-semibold">{item.quantity || 0}</td>
                                    <td className="px-3 py-2 text-right">{formatCurrency(getItemUnitPrice(item))}</td>
                                    <td className="px-3 py-2 text-right font-semibold">{formatCurrency(getItemTotal(item))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeline" className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Eventos" value={String(timelineEvents.length)} helper="Contratos, vendas, pagamentos e contatos" />
            <MetricCard label="Último evento" value={timelineEvents[0] ? formatDate(timelineEvents[0].date) : '—'} helper={timelineEvents[0]?.title || 'Sem histórico'} />
            <MetricCard label="Comunicações" value={String(commEvents.length)} helper={`${pendingTasks.length} ação${pendingTasks.length !== 1 ? 'ões' : ''} pendente${pendingTasks.length !== 1 ? 's' : ''}`} />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="w-4 h-4" /> Linha do tempo do aluno
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TimelineList events={timelineEvents} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="communication" className="space-y-5">
          {pendingTasks.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Send className="w-4 h-4" /> Ações pendentes ({pendingTasks.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="divide-y">
                  {pendingTasks.map(task => (
                    <li key={task.id} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={taskTone(task)}>{taskChannelLabel(task)}</Badge>
                          <span className="text-sm font-semibold">{task.title}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          <span className="font-mono">{task.orderNumber}</span>
                          {task.statusLabel ? ` · ${task.statusLabel}` : ''}
                        </p>
                      </div>
                      <Button size="sm" className="gap-1.5 shrink-0" onClick={() => setSelectedTask(task)}>
                        <MessageCircle className="w-4 h-4" /> Preparar
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <MessageCircle className="w-4 h-4" /> Histórico de contatos ({commEvents.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <CommunicationHistory events={commEvents} currentUserId={currentUserId} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="registration" className="space-y-5">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2"><IdCard className="w-4 h-4" /> Cadastro</CardTitle>
                {editingRegistration ? (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={cancelRegistrationEdit} disabled={savingRegistration}>
                      <X className="w-3.5 h-3.5" /> Cancelar
                    </Button>
                    <Button size="sm" onClick={saveRegistration} disabled={savingRegistration}>
                      {savingRegistration ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      Salvar
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setEditingRegistration(true)}>
                    <Edit2 className="w-3.5 h-3.5" /> Editar
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {editingRegistration ? (
                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
                    <div>
                      <Label>Código</Label>
                      <Input value={registrationForm.customer_code || '—'} className="mt-1 font-mono bg-gray-50" disabled />
                    </div>
                    <div>
                      <Label>Nome completo *</Label>
                      <Input value={registrationForm.full_name} onChange={event => setRegistrationField('full_name', event.target.value)} className="mt-1" />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label>WhatsApp</Label>
                      <Input value={registrationForm.whatsapp || ''} onChange={event => setRegistrationField('whatsapp', event.target.value)} className="mt-1" placeholder="(48) 99999-9999" />
                    </div>
                    <div>
                      <Label>Email</Label>
                      <Input type="email" value={registrationForm.email || ''} onChange={event => setRegistrationField('email', event.target.value)} className="mt-1" placeholder="aluno@email.com" />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label>CPF</Label>
                      <Input value={registrationForm.cpf || ''} onChange={event => setRegistrationField('cpf', event.target.value)} className="mt-1" placeholder="000.000.000-00" />
                      <p className="text-xs text-muted-foreground mt-1">Se esse CPF existir em outro cadastro, o salvamento será bloqueado para evitar duplicidade.</p>
                    </div>
                    <div>
                      <Label>Nascimento</Label>
                      <Input type="date" value={registrationForm.birth_date || ''} onChange={event => setRegistrationField('birth_date', event.target.value)} className="mt-1" />
                    </div>
                  </div>

                  <div className="border-t pt-4 space-y-4">
                    <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5" /> Endereço
                    </p>
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                      <div>
                        <Label>CEP</Label>
                        <Input
                          className="mt-1"
                          value={registrationForm.address_zip || ''}
                          onChange={event => setRegistrationField('address_zip', formatCep(event.target.value))}
                          onBlur={fillAddressByCep}
                          placeholder="00000-000"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="self-end"
                        onClick={fillAddressByCep}
                        disabled={cepLoading || normalizeCep(registrationForm.address_zip).length !== 8}
                      >
                        {cepLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
                      <div>
                        <Label>Rua</Label>
                        <Input className="mt-1" value={registrationForm.address_street || ''} onChange={event => setRegistrationField('address_street', event.target.value)} />
                      </div>
                      <div>
                        <Label>Número</Label>
                        <Input className="mt-1" value={registrationForm.address_number || ''} onChange={event => setRegistrationField('address_number', event.target.value)} />
                      </div>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <Label>Complemento</Label>
                        <Input className="mt-1" value={registrationForm.address_complement || ''} onChange={event => setRegistrationField('address_complement', event.target.value)} />
                      </div>
                      <div>
                        <Label>Bairro</Label>
                        <Input className="mt-1" value={registrationForm.address_neighborhood || ''} onChange={event => setRegistrationField('address_neighborhood', event.target.value)} />
                      </div>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-[1fr_90px]">
                      <div>
                        <Label>Cidade</Label>
                        <Input className="mt-1" value={registrationForm.address_city || ''} onChange={event => setRegistrationField('address_city', event.target.value)} />
                      </div>
                      <div>
                        <Label>UF</Label>
                        <Input className="mt-1 uppercase" maxLength={2} value={registrationForm.address_state || ''} onChange={event => setRegistrationField('address_state', event.target.value.toUpperCase())} />
                      </div>
                    </div>
                  </div>

                  <div>
                    <Label>Observações internas</Label>
                    <Textarea value={registrationForm.internal_notes || ''} onChange={event => setRegistrationField('internal_notes', event.target.value)} className="mt-1" rows={4} />
                  </div>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Hash className="w-3 h-3" /> Código</p>
                    <p className="font-mono font-semibold">{customer.customer_code || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Cake className="w-3 h-3" /> Nascimento</p>
                    <p className="font-semibold">{customer.birth_date ? formatDate(customer.birth_date) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" /> Telefone</p>
                    <p className="font-semibold">{customer.whatsapp || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="w-3 h-3" /> Email</p>
                    <p className="font-semibold break-all">{customer.email || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><IdCard className="w-3 h-3" /> CPF</p>
                    <p className="font-semibold">{customer.cpf || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Cliente desde</p>
                    <p className="font-semibold">{customer.created_date ? formatDate(customer.created_date) : '—'}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Endereço</p>
                    <p className="font-semibold">{address || '—'}</p>
                  </div>
                  {customer.internal_notes && (
                    <div className="sm:col-span-2 rounded-lg border bg-yellow-50 px-3 py-3">
                      <p className="text-xs font-semibold text-yellow-900">Observações internas</p>
                      <p className="mt-1 whitespace-pre-wrap">{customer.internal_notes}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <CommunicationSendDialog
        key={selectedTask?.id || 'none'}
        task={selectedTask}
        communityLink={communityLink}
        onClose={() => setSelectedTask(null)}
        onSent={() => { setSelectedTask(null); setReloadFlag(flag => flag + 1); }}
      />
    </div>
  );
}
