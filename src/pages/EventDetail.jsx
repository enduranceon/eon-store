import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CalendarDays, Check, CheckCircle2, ChevronRight,
  Clock, Copy, ExternalLink, FileText, HandCoins, Info, Layers, Link2, Loader2,
  MapPin, MessageCircle, Navigation, Pencil, Plus, ReceiptText, Search, Trash2,
  UserPlus, Users, X, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AssessmentCoach, EventExpense, EventRecord, EventRegistration, EventRegistrationType, PreSaleCustomer,
} from '@/api/entities';
import { supabase } from '@/api/db';
import {
  cancelEventRegistration, confirmEventRegistrationCustomer,
  createEventRegistration, createOrderCharge, linkEventRegistrationCustomer,
  removeEventExternalCharge, saveEventExternalCharge,
} from '@/api/client';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import ExternalChargeDialog from '@/components/billing/ExternalChargeDialog';
import ExternalChargeSummary from '@/components/billing/ExternalChargeSummary';
import { studentProfilePath } from '@/lib/customer-profile';
import { normalizeExternalChargeMethod } from '@/lib/external-charge';
import { TASK_BUCKET, TASK_KIND } from '@/lib/communication-tasks';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { createManualInstallments, findPreferredPaymentMethod, loadActivePaymentMethods } from '@/lib/manual-payment';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { summarizeFinancialMovements } from '@/lib/financial-dashboard';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const EVENT_STATUS = {
  draft:     { label: 'Rascunho', variant: 'secondary' },
  open:      { label: 'Inscrições abertas', variant: 'success' },
  closed:    { label: 'Encerrado', variant: 'info' },
  cancelled: { label: 'Cancelado', variant: 'destructive' },
};

const REG_PAYMENT = {
  pending:        { label: 'Aguardando cobrança', variant: 'secondary' },
  awaiting_charge:{ label: 'Aguardando cobrança', variant: 'secondary' },
  charge_sent:    { label: 'Cobrança enviada', variant: 'info' },
  paid:           { label: 'Pago', variant: 'success' },
  cancelled:      { label: 'Cancelada', variant: 'destructive' },
  refunded:       { label: 'Reembolsada', variant: 'purple' },
};

// Tipos de campo do formulário dinâmico. Conjunto fixo por decisão do usuário
// (18/ago): cobre os casos reais (tamanho de camiseta, observação, confirmação)
// sem exigir um construtor de formulário genérico.
const FIELD_KINDS = [
  { value: 'text',     label: 'Texto curto' },
  { value: 'textarea', label: 'Texto longo' },
  { value: 'select',   label: 'Escolha entre opções' },
  { value: 'boolean',  label: 'Sim / Não' },
  { value: 'number',   label: 'Número' },
];

const EMPTY_EVENT_FORM = {
  name: '',
  slug: '',
  event_date: '',
  end_date: '',
  start_time: '',
  end_time: '',
  location: '',
  address: '',
  map_url: '',
  description: '',
  public_notes: '',
  internal_notes: '',
};
const EMPTY_FIELD = { key: '', label: '', kind: 'text', required: false, options: [] };
const EMPTY_TYPE_FORM = { name: '', price: '', max_quantity: '', active: true, fields: [] };
const EMPTY_EXPENSE_FORM = { description: '', category: '', amount: '', expense_date: todayLocalStr(), notes: '' };

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function isEventRegistrationUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname.startsWith('/inscricao/');
  } catch {
    return false;
  }
}

function timeValue(value) {
  return String(value || '').slice(0, 5);
}

function timeSummary(event) {
  const start = timeValue(event.start_time);
  const end = timeValue(event.end_time);
  if (start && end) return `${start} - ${end}`;
  return start || end || '';
}

function dateSummary(event) {
  if (!event.event_date) return 'Data a definir';
  if (event.end_date && event.end_date !== event.event_date) {
    return `${formatDate(event.event_date)} - ${formatDate(event.end_date)}`;
  }
  return formatDate(event.event_date);
}

function eventMapUrl(event) {
  const explicitUrl = event?.map_url || event?.online_url;
  if (explicitUrl) return explicitUrl;
  const query = [event?.address, event?.location].filter(Boolean).join(' ');
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function eventToForm(event) {
  return {
    ...EMPTY_EVENT_FORM,
    name: event.name || '',
    slug: event.slug || '',
    event_date: event.event_date || '',
    end_date: event.end_date || '',
    start_time: timeValue(event.start_time),
    end_time: timeValue(event.end_time),
    location: event.location || '',
    address: event.address || '',
    map_url: event.map_url || event.online_url || '',
    description: event.description || '',
    public_notes: event.public_notes || '',
    internal_notes: event.internal_notes || '',
  };
}

function eventPayload(form) {
  return {
    name: form.name.trim(),
    slug: form.slug.trim() || slugify(form.name),
    event_date: form.event_date || null,
    end_date: form.end_date || null,
    start_time: form.start_time || null,
    end_time: form.end_time || null,
    location: form.location.trim() || null,
    address: form.address.trim() || null,
    map_url: normalizeUrl(form.map_url) || null,
    online_url: null,
    description: form.description.trim() || null,
    public_notes: form.public_notes.trim() || null,
    internal_notes: form.internal_notes.trim() || null,
  };
}

function fieldKeyFromLabel(label) {
  return label
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

async function loadEventDetail(eventId) {
  const [event, types, registrations, customers, expenses, coaches, movementsRes] = await Promise.all([
    EventRecord.get(eventId),
    EventRegistrationType.filter({ event_id: eventId }),
    EventRegistration.filter({ event_id: eventId }),
    PreSaleCustomer.list('full_name'),
    EventExpense.filter({ event_id: eventId }, '-expense_date'),
    AssessmentCoach.list('name').catch(() => []),
    supabase
      .from('financial_movements')
      .select('movement_id,order_id,order_type,business_unit,movement_kind,cash_direction,is_actual,gross_amount,fee_amount,net_amount,signed_net_amount,occurred_on,due_on,recognition_on,scheduled_on,description,reference,metadata')
      .eq('order_type', 'event'),
  ]);
  if (movementsRes.error) throw movementsRes.error;
  return { event, types, registrations, customers, expenses, coaches, financialMovements: movementsRes.data || [] };
}

// Desenha um formulário a partir da definição de campos do tipo de inscrição.
// É a peça que permite cada tipo ter seu próprio formulário sem código novo.
function DynamicForm({ fields, answers, onChange }) {
  if (!fields?.length) {
    return <p className="text-xs text-muted-foreground">Este tipo de inscrição não tem campos extras.</p>;
  }
  return (
    <div className="space-y-3">
      {fields.map(field => {
        const value = answers[field.key] ?? '';
        const set = v => onChange({ ...answers, [field.key]: v });
        return (
          <div key={field.key}>
            <Label className="text-sm">
              {field.label}
              {field.required && <span className="text-red-500 ml-0.5">*</span>}
            </Label>
            {field.kind === 'textarea' ? (
              <Textarea className="mt-1" rows={2} value={value} onChange={e => set(e.target.value)} />
            ) : field.kind === 'select' ? (
              <Select value={value || undefined} onValueChange={set}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {(field.options || []).map(opt => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : field.kind === 'boolean' ? (
              <Select value={value === true ? 'sim' : value === false ? 'nao' : undefined}
                onValueChange={v => set(v === 'sim')}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sim">Sim</SelectItem>
                  <SelectItem value="nao">Não</SelectItem>
                </SelectContent>
              </Select>
            ) : field.kind === 'number' ? (
              <Input className="mt-1" type="number" value={value}
                onChange={e => set(e.target.value === '' ? '' : Number(e.target.value))} />
            ) : (
              <Input className="mt-1" value={value} onChange={e => set(e.target.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function hasConfirmedCustomerLink(registration) {
  return Boolean(registration?.customer_link_confirmed_at);
}

function hasRegistrationChargeInfo(registration) {
  return Boolean(
    registration?.asaas_charge_id ||
    registration?.asaas_payment_link ||
    registration?.asaas_pix_copy ||
    registration?.external_payment_link ||
    registration?.external_invoice_number
  );
}

function buildEventChargeTask(registration, { customer, type, event }) {
  const total = Number(type?.price || 0);
  const label = [event?.name, type?.name].filter(Boolean).join(' - ') || 'Inscrição de evento';
  return {
    id: `event-charge:${registration.id}:${registration.updated_at || registration.payment_message_sent_at || ''}`,
    kind: TASK_KIND.CHARGE_SEND,
    bucket: TASK_BUCKET.CHARGES,
    sourceType: 'event',
    tableName: 'event_registrations',
    sourceId: registration.id,
    sourceLabel: 'Inscrição de evento',
    orderNumber: registration.registration_number,
    customerName: customer?.full_name || 'Cliente',
    customerWhatsapp: customer?.whatsapp || '',
    customerEmail: customer?.email || '',
    totalValue: total,
    paymentStatus: registration.payment_status || 'pending',
    dueDate: registration.due_date || defaultPaymentDueDate(),
    paymentDate: registration.payment_date || '',
    asaasChargeId: registration.asaas_charge_id,
    asaasPaymentLink: registration.asaas_payment_link,
    asaasPixCopy: registration.asaas_pix_copy,
    externalPaymentLink: registration.external_payment_link,
    paymentMessageSentAt: registration.payment_message_sent_at,
    updatedAt: registration.updated_at,
    items: [{ label, quantity: 1, unitPrice: total, lineTotal: total }],
    itemSummary: label,
    href: `/eventos/${registration.event_id}`,
    title: registration.payment_message_sent_at ? 'Reenviar cobrança do evento' : 'Enviar cobrança do evento',
    statusLabel: registration.due_date ? `vence em ${formatDate(registration.due_date)}` : 'definir vencimento',
    scheduledDate: registration.due_date || defaultPaymentDueDate(),
    sortDate: registration.due_date || defaultPaymentDueDate(),
    priority: 20,
    needsPaymentLink: !registration.asaas_payment_link && !registration.asaas_pix_copy,
  };
}

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    data: { event, types, registrations, customers, expenses, coaches, financialMovements },
    loading, refresh,
  } = usePageData({
    key: `events:detail:${id}`,
    loader: () => loadEventDetail(id),
    initialData: { event: null, types: [], registrations: [], customers: [], expenses: [], coaches: [], financialMovements: [] },
    tags: ['events', 'event_registration_types', 'event_registrations', 'presale_customers', 'event_expenses', 'assessment_coaches', 'financial_movements'],
    forceOnMount: true,
    onError: () => toast.error('Erro ao carregar o evento'),
  });

  const customersById = useMemo(
    () => Object.fromEntries(customers.map(c => [c.id, c])),
    [customers],
  );
  const coachesById = useMemo(
    () => Object.fromEntries(coaches.map(c => [c.id, c])),
    [coaches],
  );
  const typesById = useMemo(
    () => Object.fromEntries(types.map(t => [t.id, t])),
    [types],
  );
  const sortedTypes = useMemo(
    () => [...types].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [types],
  );
  const activeRegs = registrations.filter(r => r.payment_status !== 'cancelled');
  const usedByType = useMemo(() => {
    const counts = {};
    for (const reg of registrations) {
      counts[reg.registration_type_id] = (counts[reg.registration_type_id] || 0) + 1;
    }
    return counts;
  }, [registrations]);

  // ----- informações gerais do evento -----
  const [eventModal, setEventModal] = useState(false);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT_FORM);
  const [eventSaving, setEventSaving] = useState(false);

  const openEditEvent = () => {
    setEventForm(eventToForm(event));
    setEventModal(true);
  };

  const saveEvent = async () => {
    if (!eventForm.name.trim()) return toast.error('Informe o nome do evento');
    if ((eventForm.slug.trim() || slugify(eventForm.name)).length < 3) return toast.error('Informe um link válido para o evento');
    if (!eventForm.event_date && eventForm.end_date) return toast.error('Informe a data inicial antes da data final');
    if (eventForm.event_date && eventForm.end_date && eventForm.end_date < eventForm.event_date) return toast.error('Data final anterior à data inicial');
    if (eventForm.start_time && eventForm.end_time && eventForm.end_time < eventForm.start_time) return toast.error('Horário final anterior ao horário inicial');

    setEventSaving(true);
    try {
      await EventRecord.update(id, eventPayload(eventForm));
      setEventModal(false);
      toast.success('Evento atualizado');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao atualizar evento');
    } finally {
      setEventSaving(false);
    }
  };

  // ----- tipo de inscrição (criar/editar) -----
  const [typeModal, setTypeModal] = useState(false);
  const [editingTypeId, setEditingTypeId] = useState(null);
  const [typeForm, setTypeForm] = useState(EMPTY_TYPE_FORM);
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeActionId, setTypeActionId] = useState(null);

  const openNewType = () => { setEditingTypeId(null); setTypeForm(EMPTY_TYPE_FORM); setTypeModal(true); };
  const openEditType = t => {
    setEditingTypeId(t.id);
    setTypeForm({
      name: t.name,
      price: String(t.price ?? ''),
      max_quantity: t.max_quantity == null ? '' : String(t.max_quantity),
      active: t.active !== false,
      fields: (t.form_fields || []).map(f => ({ ...EMPTY_FIELD, ...f, options: f.options || [] })),
    });
    setTypeModal(true);
  };

  const saveType = async () => {
    if (!typeForm.name.trim()) return toast.error('Informe o nome do tipo de inscrição');
    const price = Number(typeForm.price);
    if (!Number.isFinite(price) || price < 0) return toast.error('Preço inválido');
    for (const f of typeForm.fields) {
      if (!f.label.trim()) return toast.error('Todo campo do formulário precisa de um rótulo');
      if (f.kind === 'select' && !(f.options || []).filter(Boolean).length) {
        return toast.error(`O campo "${f.label}" precisa de pelo menos uma opção`);
      }
    }
    const payload = {
      event_id: id,
      name: typeForm.name.trim(),
      price,
      max_quantity: typeForm.max_quantity === '' ? null : Number(typeForm.max_quantity),
      active: Boolean(typeForm.active),
      form_fields: typeForm.fields.map(f => ({
        key: f.key || fieldKeyFromLabel(f.label),
        label: f.label.trim(),
        kind: f.kind,
        required: Boolean(f.required),
        ...(f.kind === 'select' ? { options: f.options.filter(Boolean) } : {}),
      })),
      sort_order: editingTypeId ? undefined : types.length,
    };
    setTypeSaving(true);
    try {
      if (editingTypeId) await EventRegistrationType.update(editingTypeId, payload);
      else await EventRegistrationType.create(payload);
      setTypeModal(false);
      toast.success(editingTypeId ? 'Tipo atualizado' : 'Tipo de inscrição criado');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar tipo');
    } finally {
      setTypeSaving(false);
    }
  };

  const toggleTypeActive = async type => {
    setTypeActionId(type.id);
    try {
      await EventRegistrationType.update(type.id, { active: !type.active });
      toast.success(type.active ? 'Tipo desativado' : 'Tipo ativado');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao atualizar tipo');
    } finally {
      setTypeActionId(null);
    }
  };

  const deleteType = async type => {
    const used = usedByType[type.id] || 0;
    if (used > 0) {
      toast.error('Este tipo já tem inscrições. Desative para esconder do público sem perder histórico.');
      return;
    }
    if (!window.confirm(`Excluir o tipo "${type.name}"?`)) return;
    setTypeActionId(type.id);
    try {
      await EventRegistrationType.delete(type.id);
      toast.success('Tipo excluído');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao excluir tipo');
    } finally {
      setTypeActionId(null);
    }
  };

  // ----- nova inscrição -----
  const [regModal, setRegModal] = useState(false);
  const [regTypeId, setRegTypeId] = useState('');
  const [regCustomerId, setRegCustomerId] = useState('');
  const [regCustomerSearch, setRegCustomerSearch] = useState('');
  const [regAnswers, setRegAnswers] = useState({});
  const [regSaving, setRegSaving] = useState(false);

  const openNewReg = () => {
    setRegTypeId(sortedTypes.filter(t => t.active).length === 1 ? sortedTypes.find(t => t.active).id : '');
    setRegCustomerId(''); setRegCustomerSearch(''); setRegAnswers({});
    setRegModal(true);
  };

  const filteredCustomers = useMemo(() => {
    const q = regCustomerSearch.trim().toLowerCase();
    if (!q) return [];
    return customers
      .filter(c => [c.full_name, c.whatsapp, c.email].some(v => String(v || '').toLowerCase().includes(q)))
      .slice(0, 8);
  }, [customers, regCustomerSearch]);

  // ----- vínculo de cliente da inscrição -----
  const [customerLinkModal, setCustomerLinkModal] = useState(null);
  const [customerLinkSearch, setCustomerLinkSearch] = useState('');
  const [newCustomer, setNewCustomer] = useState({ full_name: '', whatsapp: '', email: '', cpf: '' });
  const [customerLinkSaving, setCustomerLinkSaving] = useState(false);

  const customerLinkMatches = useMemo(() => {
    const q = customerLinkSearch.trim().toLowerCase();
    if (!q) return [];
    return customers
      .filter(c => [c.full_name, c.whatsapp, c.email, c.cpf].some(v => String(v || '').toLowerCase().includes(q)))
      .slice(0, 12);
  }, [customers, customerLinkSearch]);

  const openCustomerLink = reg => {
    const current = customersById[reg.customer_id] || {};
    setCustomerLinkSearch('');
    setNewCustomer({
      full_name: current.full_name || '',
      whatsapp: current.whatsapp || '',
      email: current.email || '',
      cpf: current.cpf || '',
    });
    setCustomerLinkModal(reg);
  };

  const confirmCurrentCustomer = async () => {
    if (!customerLinkModal) return;
    setCustomerLinkSaving(true);
    try {
      await confirmEventRegistrationCustomer(customerLinkModal.id);
      toast.success('Cliente confirmado para a inscrição');
      setCustomerLinkModal(null);
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Não foi possível confirmar o cliente');
    } finally {
      setCustomerLinkSaving(false);
    }
  };

  const linkCustomerToRegistration = async customerId => {
    if (!customerLinkModal) return;
    setCustomerLinkSaving(true);
    try {
      await linkEventRegistrationCustomer(customerLinkModal.id, customerId);
      toast.success('Cliente vinculado à inscrição');
      setCustomerLinkModal(null);
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Não foi possível vincular o cliente');
    } finally {
      setCustomerLinkSaving(false);
    }
  };

  const createAndLinkCustomer = async () => {
    if (!customerLinkModal) return;
    const fullName = newCustomer.full_name.trim();
    if (fullName.length < 3) return toast.error('Informe o nome completo do cliente');

    setCustomerLinkSaving(true);
    try {
      const customer = await PreSaleCustomer.create({
        full_name: fullName,
        whatsapp: newCustomer.whatsapp.trim() || null,
        email: newCustomer.email.trim().toLowerCase() || null,
        cpf: newCustomer.cpf.replace(/\D/g, '') || null,
        active: true,
      });
      await linkEventRegistrationCustomer(customerLinkModal.id, customer.id);
      toast.success('Cliente criado e vinculado à inscrição');
      setCustomerLinkModal(null);
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Não foi possível criar e vincular o cliente');
    } finally {
      setCustomerLinkSaving(false);
    }
  };

  const saveRegistration = async () => {
    if (!regTypeId) return toast.error('Escolha o tipo de inscrição');
    if (!regCustomerId) return toast.error('Escolha o cliente');
    setRegSaving(true);
    try {
      await createEventRegistration({
        eventId: id, registrationTypeId: regTypeId,
        customerId: regCustomerId, formAnswers: regAnswers,
      });
      setRegModal(false);
      toast.success('Inscrição criada');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao criar inscrição');
    } finally {
      setRegSaving(false);
    }
  };

  // ----- pagamento / cancelamento -----
  const [payModal, setPayModal] = useState(null);
  const [methodGroups, setMethodGroups] = useState([]);
  const [manualPayForm, setManualPayForm] = useState({ method_id: '', date: todayLocalStr(), value: '' });
  const [paySaving, setPaySaving] = useState(false);
  const [chargeModal, setChargeModal] = useState(null);
  const [chargeForm, setChargeForm] = useState({
    billing_type: 'PIX',
    due_date: defaultPaymentDueDate(),
    installments: 1,
    cpf: '',
  });
  const [externalChargeModal, setExternalChargeModal] = useState(null);
  const [externalChargeForm, setExternalChargeForm] = useState({
    link: '',
    due_date: defaultPaymentDueDate(),
    payment_method: 'pix',
    invoice_number: '',
  });
  const [chargeSaving, setChargeSaving] = useState(false);
  const [chargeRemoving, setChargeRemoving] = useState(false);
  const [messageTask, setMessageTask] = useState(null);
  const [cancelModal, setCancelModal] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSaving, setCancelSaving] = useState(false);

  // ----- despesas do evento -----
  const [expenseModal, setExpenseModal] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [expenseForm, setExpenseForm] = useState(EMPTY_EXPENSE_FORM);
  const [expenseSaving, setExpenseSaving] = useState(false);
  const [expenseActionId, setExpenseActionId] = useState(null);

  const openNewExpense = () => {
    setEditingExpenseId(null);
    setExpenseForm({ ...EMPTY_EXPENSE_FORM, expense_date: todayLocalStr() });
    setExpenseModal(true);
  };

  const openEditExpense = expense => {
    setEditingExpenseId(expense.id);
    setExpenseForm({
      description: expense.description || '',
      category: expense.category || '',
      amount: String(expense.amount ?? ''),
      expense_date: expense.expense_date || todayLocalStr(),
      notes: expense.notes || '',
    });
    setExpenseModal(true);
  };

  const saveExpense = async () => {
    if (!expenseForm.description.trim()) return toast.error('Informe a descrição da despesa');
    const amount = Number(expenseForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Valor da despesa inválido');
    if (!expenseForm.expense_date) return toast.error('Informe a data da despesa');

    const payload = {
      event_id: id,
      description: expenseForm.description.trim(),
      category: expenseForm.category.trim() || null,
      amount,
      expense_date: expenseForm.expense_date,
      notes: expenseForm.notes.trim() || null,
    };

    setExpenseSaving(true);
    try {
      if (editingExpenseId) await EventExpense.update(editingExpenseId, payload);
      else await EventExpense.create(payload);
      setExpenseModal(false);
      toast.success(editingExpenseId ? 'Despesa atualizada' : 'Despesa adicionada');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar despesa');
    } finally {
      setExpenseSaving(false);
    }
  };

  const deleteExpense = async expense => {
    if (!window.confirm(`Excluir a despesa "${expense.description}"?`)) return;
    setExpenseActionId(expense.id);
    try {
      await EventExpense.delete(expense.id);
      toast.success('Despesa excluída');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao excluir despesa');
    } finally {
      setExpenseActionId(null);
    }
  };

  const openManualPayment = async reg => {
    if (!hasConfirmedCustomerLink(reg)) {
      toast.error('Confirme o cliente da inscrição antes de registrar pagamento');
      openCustomerLink(reg);
      return;
    }
    const value = Number(typesById[reg.registration_type_id]?.price || 0);
    try {
      const groups = await loadActivePaymentMethods();
      const preferred = findPreferredPaymentMethod(groups, 'pix_manual');
      setMethodGroups(groups);
      setManualPayForm({
        method_id: preferred?.id || '',
        date: todayLocalStr(),
        value: value ? value.toFixed(2) : '',
      });
      setPayModal(reg);
    } catch (e) {
      toast.error(e.message || 'Erro ao carregar métodos de pagamento');
    }
  };

  const confirmPayment = async () => {
    if (!payModal) return;
    if (!manualPayForm.method_id) return toast.error('Selecione um método');
    if (!manualPayForm.date) return toast.error('Informe a data do pagamento');
    if (!manualPayForm.value || isNaN(Number(manualPayForm.value))) return toast.error('Informe o valor recebido');
    const method = methodGroups.flatMap(([, list]) => list).find(m => m.id === manualPayForm.method_id);
    if (!method) return toast.error('Método inválido');
    if (payModal.asaas_charge_id) return toast.error('Cancele a cobrança Asaas antes de registrar pagamento por fora');

    setPaySaving(true);
    try {
      const totalValue = Number(manualPayForm.value);
      const expected = Number(typesById[payModal.registration_type_id]?.price || 0);
      if (Math.abs(totalValue - expected) > 0.009) {
        throw new Error('Pagamento parcial ainda não está habilitado. Informe o valor integral da inscrição.');
      }
      const result = await createManualInstallments(
        method,
        manualPayForm.date,
        { order_id: payModal.id, order_type: 'event', external_reference: payModal.registration_number },
        totalValue,
      );
      setPayModal(null);
      toast.success(`Pagamento registrado!${result.installments > 1 ? ` ${result.installments} parcelas projetadas no fluxo de caixa.` : ''}`);
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar pagamento');
    } finally {
      setPaySaving(false);
    }
  };

  const openExternalCharge = (reg, dueDate = '') => {
    if (!hasConfirmedCustomerLink(reg)) {
      toast.error('Confirme o cliente da inscrição antes de cadastrar cobrança');
      openCustomerLink(reg);
      return;
    }
    const defaultExternalMethod = normalizeExternalChargeMethod(reg.payment_method, 1);
    setExternalChargeForm({
      link: reg.external_payment_link || '',
      due_date: dueDate || reg.due_date || defaultPaymentDueDate(),
      payment_method: defaultExternalMethod,
      invoice_number: reg.external_invoice_number || '',
    });
    setExternalChargeModal(reg);
  };

  const openCharge = reg => {
    if (!hasConfirmedCustomerLink(reg)) {
      toast.error('Confirme o cliente da inscrição antes de cadastrar cobrança');
      openCustomerLink(reg);
      return;
    }
    const customer = customersById[reg.customer_id] || {};
    if (reg.external_payment_link || !customer.cpf) {
      openExternalCharge(reg);
      return;
    }
    setChargeForm({
      billing_type: 'PIX',
      due_date: reg.due_date || defaultPaymentDueDate(),
      installments: 1,
      cpf: String(customer.cpf || '').replace(/\D/g, ''),
    });
    setChargeModal(reg);
  };

  const openMessageForRegistration = reg => {
    if (!hasConfirmedCustomerLink(reg)) {
      toast.error('Confirme o cliente da inscrição antes de enviar cobrança');
      openCustomerLink(reg);
      return;
    }
    if (!hasRegistrationChargeInfo(reg)) {
      toast.error('Gere ou cadastre a cobrança antes de preparar o envio');
      return;
    }
    setMessageTask(buildEventChargeTask(reg, {
      customer: customersById[reg.customer_id],
      type: typesById[reg.registration_type_id],
      event,
    }));
  };

  const generateCharge = async () => {
    if (!chargeModal) return;
    if (!hasConfirmedCustomerLink(chargeModal)) {
      toast.error('Confirme o cliente da inscrição antes de criar cobrança');
      openCustomerLink(chargeModal);
      return;
    }
    const cpf = String(chargeForm.cpf || '').replace(/\D/g, '');
    if (!/^\d{11}$/.test(cpf)) return toast.error('Informe o CPF do cliente para gerar cobrança Asaas');
    if (!chargeForm.due_date) return toast.error('Informe o vencimento');
    const installments = Number(chargeForm.installments) || 1;
    if (chargeForm.billing_type !== 'CREDIT_CARD' && installments !== 1) {
      return toast.error('PIX e boleto precisam ser em 1x');
    }

    setChargeSaving(true);
    try {
      await createOrderCharge('event', chargeModal.id, {
        billingType: chargeForm.billing_type,
        dueDate: chargeForm.due_date,
        installments,
        cpf,
      });
      setChargeModal(null);
      toast.success('Cobrança Asaas criada. Envie a mensagem quando estiver pronto.');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao gerar cobrança');
    } finally {
      setChargeSaving(false);
    }
  };

  const saveExternalCharge = async () => {
    if (!externalChargeModal) return;
    if (!hasConfirmedCustomerLink(externalChargeModal)) {
      toast.error('Confirme o cliente da inscrição antes de cadastrar cobrança');
      openCustomerLink(externalChargeModal);
      return;
    }
    const link = externalChargeForm.link.trim();
    if (!link) return toast.error('Informe o link da cobrança externa');
    if (!/^https:\/\//i.test(link)) return toast.error('O link da cobrança externa precisa começar com https://');
    if (isEventRegistrationUrl(link)) {
      return toast.error('Esse é o link de inscrição do evento. Cole aqui o link da cobrança criada no Asaas.');
    }
    if (!externalChargeForm.due_date) return toast.error('Informe o vencimento');

    setChargeSaving(true);
    try {
      const hadExternalLink = Boolean(externalChargeModal.external_payment_link);
      await saveEventExternalCharge(externalChargeModal.id, {
        externalLink: link,
        dueDate: externalChargeForm.due_date,
        paymentMethod: normalizeExternalChargeMethod(externalChargeForm.payment_method, 1),
        invoiceNumber: externalChargeForm.invoice_number.trim() || null,
        expectedUpdatedAt: externalChargeModal.updated_at,
      });
      setExternalChargeModal(null);
      toast.success(hadExternalLink ? 'Cobrança externa atualizada.' : 'Cobrança externa cadastrada.');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar cobrança externa');
    } finally {
      setChargeSaving(false);
    }
  };

  const removeExternalCharge = async reg => {
    if (!window.confirm('Remover a cobrança externa? O histórico de pagamentos não será alterado.')) return;

    setChargeRemoving(true);
    try {
      await removeEventExternalCharge(reg.id, reg.updated_at);
      toast.success('Cobrança externa removida.');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao remover cobrança externa');
    } finally {
      setChargeRemoving(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelReason.trim()) return toast.error('Informe o motivo');
    setCancelSaving(true);
    try {
      await cancelEventRegistration(cancelModal.id, cancelReason.trim());
      setCancelModal(null); setCancelReason('');
      toast.success('Inscrição cancelada');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao cancelar');
    } finally {
      setCancelSaving(false);
    }
  };

  const changeEventStatus = async status => {
    try {
      await EventRecord.update(id, { status });
      toast.success('Status do evento atualizado');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao atualizar status');
    }
  };

  if (loading && !event) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Carregando evento...</p>;
  }
  if (!event) {
    return (
      <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
        Evento não encontrado.
        <div className="mt-3"><Button variant="outline" onClick={() => navigate('/eventos')}>Voltar para eventos</Button></div>
      </CardContent></Card>
    );
  }

  const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
  const eventTime = timeSummary(event);
  const mapUrl = eventMapUrl(event);
  const priceOf = reg => Number(typesById[reg.registration_type_id]?.price || 0);
  const eventRegistrationIds = new Set(registrations.map(registration => registration.id));
  const eventFinancialMovements = financialMovements.filter(movement =>
    eventRegistrationIds.has(movement.order_id) || movement.metadata?.event_id === id
  );
  const eventFinance = summarizeFinancialMovements(eventFinancialMovements);
  const confirmedGross = eventFinance.grossReceipts;
  const confirmedNet = eventFinance.netReceipts;
  // Esperado = tudo que não foi cancelado, incluindo o que ainda não foi pago.
  // É o número que responde "quanto esse evento vale se todo mundo pagar".
  const expectedTotal = activeRegs.reduce((acc, r) => acc + priceOf(r), 0);
  const pendingTotal = Math.max(0, expectedTotal - confirmedGross);
  const expenseTotal = eventFinance.expenses;
  const confirmedResult = eventFinance.operatingResult;
  const expectedResult = expectedTotal - expenseTotal;
  const confirmedMargin = confirmedNet > 0 ? (confirmedResult / confirmedNet) * 100 : null;

  const publicUrl = `${window.location.origin}/inscricao/${event.slug}`;
  const copyPublicLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Link copiado! É só enviar para os inscritos.');
    } catch {
      toast.error('Não foi possível copiar. Selecione o link manualmente.');
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/eventos')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold">{event.name}</h2>
          <p className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="w-3.5 h-3.5" /> {dateSummary(event)}
            </span>
            {eventTime && (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> {eventTime}
              </span>
            )}
            {event.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" /> {event.location}
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={openEditEvent}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Editar
          </Button>
          <Badge variant={status.variant}>{status.label}</Badge>
          <Select value={event.status} onValueChange={changeEventStatus}>
            <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(EVENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold inline-flex items-center gap-1.5">
                <Info className="w-4 h-4" /> Informações do evento
              </p>
              <p className="text-xs text-muted-foreground">
                Dados que organizam a operação e aparecem no link público quando fizer sentido.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={openEditEvent}>
              <Pencil className="w-3.5 h-3.5 mr-1" /> Editar
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Data</p>
              <p className="text-sm inline-flex items-center gap-1.5">
                <CalendarDays className="w-4 h-4 text-muted-foreground" /> {dateSummary(event)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Horário</p>
              <p className="text-sm inline-flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-muted-foreground" /> {eventTime || 'A definir'}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Local</p>
              <p className="text-sm inline-flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-muted-foreground" /> {event.location || 'A definir'}
              </p>
              {event.address && <p className="text-xs text-muted-foreground">{event.address}</p>}
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Mapa</p>
              {mapUrl ? (
                <a className="text-sm text-blue-700 hover:underline inline-flex items-center gap-1.5"
                  href={mapUrl} target="_blank" rel="noreferrer">
                  <Navigation className="w-4 h-4" /> Abrir localização
                </a>
              ) : (
                <p className="text-sm text-muted-foreground">Não informado</p>
              )}
            </div>
          </div>

          {event.description ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" /> Descrição pública
              </p>
              <p className="text-sm whitespace-pre-wrap">{event.description}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Sem descrição pública cadastrada.</p>
          )}

          {(event.public_notes || event.internal_notes) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {event.public_notes && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Informações para inscritos</p>
                  <p className="text-sm whitespace-pre-wrap">{event.public_notes}</p>
                </div>
              )}
              {event.internal_notes && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Notas internas</p>
                  <p className="text-sm whitespace-pre-wrap">{event.internal_notes}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Inscritos ativos</p>
          <p className="text-2xl font-bold">{activeRegs.length}</p>
          {registrations.length !== activeRegs.length && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {registrations.length - activeRegs.length} cancelada{registrations.length - activeRegs.length === 1 ? '' : 's'}
            </p>
          )}
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Pagos</p>
          <p className="text-2xl font-bold">{registrations.filter(r => r.payment_status === 'paid').length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">de {activeRegs.length} ativo{activeRegs.length === 1 ? '' : 's'}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Recebido líquido</p>
          <p className="text-2xl font-bold text-emerald-700">{formatCurrency(confirmedNet)}</p>
          {eventFinance.fees > 0 && <p className="text-xs text-muted-foreground mt-0.5">{formatCurrency(eventFinance.fees)} em taxas</p>}
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total esperado</p>
          <p className="text-2xl font-bold">{formatCurrency(expectedTotal)}</p>
          {pendingTotal > 0 && (
            <p className="text-xs text-amber-700 mt-0.5">{formatCurrency(pendingTotal)} a receber</p>
          )}
        </CardContent></Card>
      </div>

      {/* Financeiro do evento */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold inline-flex items-center gap-1.5">
                <ReceiptText className="w-4 h-4" /> Financeiro do evento
              </p>
              <p className="text-xs text-muted-foreground">
                Recebimentos, gastos operacionais e resultado de caixa deste evento.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={openNewExpense}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Despesa
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Recebido líquido</p>
              <p className="text-lg font-bold text-emerald-700">{formatCurrency(confirmedNet)}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Receita esperada</p>
              <p className="text-lg font-bold">{formatCurrency(expectedTotal)}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Taxas de pagamento</p>
              <p className="text-lg font-bold text-amber-700">{formatCurrency(eventFinance.fees)}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Gastos lançados</p>
              <p className="text-lg font-bold text-red-600">{formatCurrency(expenseTotal)}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Resultado confirmado</p>
              <p className={`text-lg font-bold ${confirmedResult >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                {formatCurrency(confirmedResult)}
              </p>
              <p className="text-xs text-muted-foreground">
                Esperado: {formatCurrency(expectedResult)}
                {confirmedMargin !== null && ` · ${confirmedMargin.toFixed(1)}%`}
              </p>
            </div>
          </div>

          {expenses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma despesa lançada ainda. Use isso para registrar sala, brindes, material, coffee, equipe, taxas e qualquer custo do briefing.
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {expenses.map(expense => (
                <div key={expense.id} className="flex items-start gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{expense.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(expense.expense_date)}
                      {expense.category && ` · ${expense.category}`}
                      {expense.notes && ` · ${expense.notes}`}
                    </p>
                  </div>
                  <p className="text-sm font-bold text-red-600">{formatCurrency(Number(expense.amount || 0))}</p>
                  <Button size="sm" variant="ghost" onClick={() => openEditExpense(expense)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-500 hover:text-red-700"
                    disabled={expenseActionId === expense.id}
                    onClick={() => deleteExpense(expense)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Link publico de inscricao */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <p className="font-semibold inline-flex items-center gap-1.5"><Link2 className="w-4 h-4" /> Link de inscrição</p>
          {event.status === 'open' ? (
            <>
              <div className="flex items-center gap-2">
                <input readOnly value={publicUrl}
                  className="flex-1 text-xs font-mono bg-gray-50 border rounded-lg px-3 py-2 truncate" />
                <Button size="sm" variant="outline" onClick={copyPublicLink}>
                  <Copy className="w-3.5 h-3.5 mr-1" /> Copiar
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={publicUrl} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" /></a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Envie para quem vai se inscrever. A pessoa escolhe o tipo, preenche o formulário e entra na lista abaixo.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              O link só funciona com o evento em <strong>Inscrições abertas</strong>. Enquanto estiver em rascunho, quem abrir vê
              &quot;inscrições indisponíveis&quot; — útil para montar o evento antes de divulgar.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Tipos de inscrição */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold inline-flex items-center gap-1.5"><Layers className="w-4 h-4" /> Tipos de inscrição</p>
            <Button size="sm" variant="outline" onClick={openNewType}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Novo tipo
            </Button>
          </div>
          {sortedTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum tipo ainda. Um evento simples (só nome e pagamento) precisa de um único tipo, sem campos extras.
            </p>
          ) : (
            <div className="divide-y">
              {sortedTypes.map(t => {
                const used = activeRegs.filter(r => r.registration_type_id === t.id).length;
                const totalUsed = usedByType[t.id] || 0;
                return (
                  <div key={t.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex-1">
                      <p className="font-medium text-sm">
                        {t.name}
                        {!t.active && <Badge variant="secondary" className="ml-2">inativo</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(Number(t.price))}
                        {' · '}{(t.form_fields || []).length} campo{(t.form_fields || []).length === 1 ? '' : 's'} no formulário
                        {t.max_quantity != null && ` · ${used}/${t.max_quantity} vagas`}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => openEditType(t)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={typeActionId === t.id}
                      onClick={() => toggleTypeActive(t)}
                    >
                      {t.active ? 'Desativar' : 'Ativar'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-500 hover:text-red-700"
                      title={totalUsed > 0 ? 'Tipos com inscrições devem ser desativados para manter o histórico' : 'Excluir tipo'}
                      disabled={typeActionId === t.id || totalUsed > 0}
                      onClick={() => deleteType(t)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inscritos */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Inscritos</p>
            <Button size="sm" onClick={openNewReg} disabled={!sortedTypes.some(t => t.active)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Nova inscrição
            </Button>
          </div>
          {registrations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma inscrição ainda.</p>
          ) : (
            <div className="divide-y">
              {registrations.map(reg => {
                const customer = customersById[reg.customer_id];
                const coach = coachesById[reg.coach_id] || coachesById[customer?.coach_id];
                const type = typesById[reg.registration_type_id];
                const pay = REG_PAYMENT[reg.payment_status] || REG_PAYMENT.pending;
                const customerConfirmed = hasConfirmedCustomerLink(reg);
                const hasCharge = hasRegistrationChargeInfo(reg);
                const canManagePayment = ['pending', 'awaiting_charge', 'charge_sent', 'overdue'].includes(reg.payment_status);
                const answersEntries = Object.entries(reg.form_answers || {});
                return (
                  <div key={reg.id} className="py-2.5 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-blue-700">{reg.registration_number}</span>
                        <button className="font-medium text-sm hover:underline"
                          onClick={() => customer && navigate(studentProfilePath(customer.id))}>
                          {customer?.full_name || 'Cliente removido'}
                        </button>
                        {customerConfirmed ? (
                          <Badge variant="success" className="gap-1">
                            <CheckCircle2 className="w-3 h-3" /> cliente confirmado
                          </Badge>
                        ) : (
                          <Badge variant="warning" className="gap-1">
                            <AlertTriangle className="w-3 h-3" /> cliente a confirmar
                          </Badge>
                        )}
                        <Badge variant={pay.variant}>{pay.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {type?.name || 'Tipo removido'} · {formatCurrency(Number(type?.price || 0))}
                        {coach && ` · ${coach.name}`}
                        {reg.payment_method && ` · ${reg.payment_method}`}
                        {reg.payment_date && ` em ${formatDate(reg.payment_date)}`}
                      </p>
                      {reg.external_payment_link && (
                        <div className="mt-2">
                          <ExternalChargeSummary
                            externalLink={reg.external_payment_link}
                            paymentMethod={reg.payment_method}
                            invoiceNumber={reg.external_invoice_number}
                            dueDateLabel={reg.due_date ? formatDate(reg.due_date) : null}
                            messageSentLabel={reg.payment_message_sent_at ? `em ${formatDate(reg.payment_message_sent_at)}` : null}
                            onCopy={() => { navigator.clipboard.writeText(reg.external_payment_link); toast.success('Link copiado!'); }}
                            onMessage={customerConfirmed && canManagePayment ? () => openMessageForRegistration(reg) : undefined}
                            onEdit={customerConfirmed && canManagePayment ? () => openExternalCharge(reg) : undefined}
                            onRemove={customerConfirmed && canManagePayment ? () => removeExternalCharge(reg) : undefined}
                            onRecordPayment={customerConfirmed && canManagePayment ? () => openManualPayment(reg) : undefined}
                            removing={chargeRemoving}
                          />
                        </div>
                      )}
                      {answersEntries.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {answersEntries.map(([k, v]) => {
                            const fieldLabel = (type?.form_fields || []).find(f => f.key === k)?.label || k;
                            return `${fieldLabel}: ${v === true ? 'Sim' : v === false ? 'Não' : v}`;
                          }).join(' · ')}
                        </p>
                      )}
                      {reg.cancellation_reason && (
                        <p className="text-xs text-red-600 mt-0.5">Motivo: {reg.cancellation_reason}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {canManagePayment && (
                        <>
                          <Button size="sm" variant={customerConfirmed ? 'ghost' : 'outline'}
                            className={customerConfirmed ? '' : 'text-amber-700 hover:bg-amber-50'}
                            onClick={() => openCustomerLink(reg)}>
                            <Search className="w-3.5 h-3.5 mr-1" />
                            {customerConfirmed ? 'Trocar cliente' : 'Vincular cliente'}
                          </Button>
                          {customerConfirmed && !reg.external_payment_link && !reg.asaas_charge_id && !reg.asaas_payment_link && !reg.asaas_pix_copy && Number(type?.price || 0) > 0 && (
                            <Button size="sm" variant="outline" className="text-blue-700 hover:bg-blue-50"
                              onClick={() => openCharge(reg)}>
                              <ReceiptText className="w-3.5 h-3.5 mr-1" /> Gerar cobrança
                            </Button>
                          )}
                          {customerConfirmed && hasCharge && !reg.external_payment_link && (
                            <Button size="sm" variant="outline" className="text-green-700 hover:bg-green-50"
                              onClick={() => openMessageForRegistration(reg)}>
                              <MessageCircle className="w-3.5 h-3.5 mr-1" /> Mensagem
                            </Button>
                          )}
                          {!reg.external_payment_link && (
                            <Button size="sm" variant="outline" className="text-emerald-700 hover:bg-emerald-50"
                              disabled={!customerConfirmed}
                              title={!customerConfirmed ? 'Confirme o cliente antes de registrar pagamento' : 'Registrar pagamento recebido'}
                              onClick={() => openManualPayment(reg)}>
                              <HandCoins className="w-3.5 h-3.5 mr-1" /> Registrar pagamento
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-700"
                            title="Cancelar inscrição"
                            onClick={() => { setCancelReason(''); setCancelModal(reg); }}>
                            <X className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal: informações do evento */}
      <Dialog open={eventModal} onOpenChange={open => !eventSaving && setEventModal(open)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar evento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome do evento</Label>
              <Input className="mt-1" value={eventForm.name}
                onChange={e => setEventForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label>Link público</Label>
              <Input className="mt-1 font-mono text-sm" value={eventForm.slug}
                onChange={e => setEventForm(f => ({ ...f, slug: slugify(e.target.value) }))} />
              <p className="mt-1 text-xs text-muted-foreground">
                Se alterar, o link de inscrição também muda.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Data inicial</Label>
                <Input className="mt-1" type="date" value={eventForm.event_date}
                  onChange={e => setEventForm(f => ({ ...f, event_date: e.target.value }))} />
              </div>
              <div>
                <Label>Data final</Label>
                <Input className="mt-1" type="date" value={eventForm.end_date}
                  onChange={e => setEventForm(f => ({ ...f, end_date: e.target.value }))} />
              </div>
              <div>
                <Label>Horário inicial</Label>
                <Input className="mt-1" type="time" value={eventForm.start_time}
                  onChange={e => setEventForm(f => ({ ...f, start_time: e.target.value }))} />
              </div>
              <div>
                <Label>Horário final</Label>
                <Input className="mt-1" type="time" value={eventForm.end_time}
                  onChange={e => setEventForm(f => ({ ...f, end_time: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Local</Label>
                <Input className="mt-1" value={eventForm.location}
                  onChange={e => setEventForm(f => ({ ...f, location: e.target.value }))} />
              </div>
              <div>
                <Label>Link do mapa/Waze</Label>
                <Input className="mt-1" value={eventForm.map_url}
                  placeholder="maps.app.goo.gl/... ou waze.com/ul?..."
                  onChange={e => setEventForm(f => ({ ...f, map_url: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>Endereço</Label>
              <Input className="mt-1" value={eventForm.address} placeholder="Endereço para o inscrito encontrar o local"
                onChange={e => setEventForm(f => ({ ...f, address: e.target.value }))} />
            </div>
            <div>
              <Label>Descrição pública</Label>
              <Textarea className="mt-1" rows={3} value={eventForm.description}
                onChange={e => setEventForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div>
              <Label>Informações para inscritos</Label>
              <Textarea className="mt-1" rows={3} value={eventForm.public_notes}
                placeholder="Ex.: chegue 15 minutos antes, leve documento, estacionamento..."
                onChange={e => setEventForm(f => ({ ...f, public_notes: e.target.value }))} />
            </div>
            <div>
              <Label>Notas internas</Label>
              <Textarea className="mt-1" rows={3} value={eventForm.internal_notes}
                onChange={e => setEventForm(f => ({ ...f, internal_notes: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setEventModal(false)} disabled={eventSaving}>Cancelar</Button>
              <Button className="flex-1" onClick={saveEvent} disabled={eventSaving}>
                {eventSaving ? 'Salvando...' : 'Salvar evento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal: tipo de inscrição */}
      <Dialog open={typeModal} onOpenChange={open => !typeSaving && setTypeModal(open)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTypeId ? 'Editar tipo de inscrição' : 'Novo tipo de inscrição'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Nome</Label>
                <Input className="mt-1" value={typeForm.name} placeholder="Ex.: Inscrição + 2 camisetas"
                  onChange={e => setTypeForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <Label>Preço (R$)</Label>
                <Input className="mt-1" type="number" min="0" step="0.01" value={typeForm.price}
                  onChange={e => setTypeForm(f => ({ ...f, price: e.target.value }))} />
              </div>
              <div>
                <Label>Limite de vagas (vazio = sem limite)</Label>
                <Input className="mt-1" type="number" min="1" value={typeForm.max_quantity}
                  onChange={e => setTypeForm(f => ({ ...f, max_quantity: e.target.value }))} />
              </div>
            </div>

            <label className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={typeForm.active}
                className="mt-1"
                onChange={e => setTypeForm(f => ({ ...f, active: e.target.checked }))}
              />
              <span>
                <span className="font-medium">Tipo ativo</span>
                <span className="block text-xs text-muted-foreground">
                  Tipos inativos não aparecem no formulário público e não entram em novas inscrições manuais.
                </span>
              </span>
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Campos do formulário</Label>
                <Button size="sm" variant="outline"
                  onClick={() => setTypeForm(f => ({ ...f, fields: [...f.fields, { ...EMPTY_FIELD }] }))}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Campo
                </Button>
              </div>
              {typeForm.fields.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Sem campos extras: a inscrição pede só o cliente e o pagamento — suficiente para um briefing simples.
                </p>
              )}
              {typeForm.fields.map((field, idx) => (
                <div key={idx} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input className="flex-1" placeholder="Rótulo — ex.: Tamanho da camiseta de ciclismo"
                      value={field.label}
                      onChange={e => setTypeForm(f => {
                        const fields = [...f.fields];
                        fields[idx] = { ...fields[idx], label: e.target.value, key: fieldKeyFromLabel(e.target.value) };
                        return { ...f, fields };
                      })} />
                    <Button size="sm" variant="ghost" className="text-red-500"
                      onClick={() => setTypeForm(f => ({ ...f, fields: f.fields.filter((_, i) => i !== idx) }))}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select value={field.kind}
                      onValueChange={v => setTypeForm(f => {
                        const fields = [...f.fields];
                        fields[idx] = { ...fields[idx], kind: v };
                        return { ...f, fields };
                      })}>
                      <SelectTrigger className="w-44 h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FIELD_KINDS.map(k => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={field.required}
                        onChange={e => setTypeForm(f => {
                          const fields = [...f.fields];
                          fields[idx] = { ...fields[idx], required: e.target.checked };
                          return { ...f, fields };
                        })} />
                      Obrigatório
                    </label>
                  </div>
                  {field.kind === 'select' && (
                    <div>
                      <Label className="text-xs">Opções (separadas por vírgula)</Label>
                      <Input className="mt-1" placeholder="P, M, G, GG"
                        value={(field.options || []).join(', ')}
                        onChange={e => setTypeForm(f => {
                          const fields = [...f.fields];
                          fields[idx] = { ...fields[idx], options: e.target.value.split(',').map(o => o.trim()) };
                          return { ...f, fields };
                        })} />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setTypeModal(false)} disabled={typeSaving}>Cancelar</Button>
              <Button className="flex-1" onClick={saveType} disabled={typeSaving}>
                {typeSaving ? 'Salvando...' : 'Salvar tipo'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal: vínculo do cliente da inscrição */}
      <Dialog open={Boolean(customerLinkModal)} onOpenChange={open => !customerLinkSaving && !open && setCustomerLinkModal(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Vincular cliente da inscrição</DialogTitle>
          </DialogHeader>
          {customerLinkModal && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3 text-sm">
                <p className="font-mono text-xs font-semibold text-blue-700">{customerLinkModal.registration_number}</p>
                <p className="font-semibold">
                  {typesById[customerLinkModal.registration_type_id]?.name || 'Inscrição'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Antes da cobrança, confirme qual cadastro de cliente representa esta pessoa.
                </p>
              </div>

              <div className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Cliente atual</p>
                    <p className="text-sm font-semibold">
                      {customersById[customerLinkModal.customer_id]?.full_name || 'Cliente não encontrado'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        customersById[customerLinkModal.customer_id]?.whatsapp,
                        customersById[customerLinkModal.customer_id]?.email,
                        customersById[customerLinkModal.customer_id]?.cpf,
                      ].filter(Boolean).join(' · ') || 'Sem contato cadastrado'}
                    </p>
                  </div>
                  {hasConfirmedCustomerLink(customerLinkModal) ? (
                    <Badge variant="success">confirmado</Badge>
                  ) : (
                    <Badge variant="warning">a confirmar</Badge>
                  )}
                </div>
                <Button
                  className="mt-3 w-full"
                  variant={hasConfirmedCustomerLink(customerLinkModal) ? 'outline' : 'default'}
                  disabled={customerLinkSaving || !customerLinkModal.customer_id}
                  onClick={confirmCurrentCustomer}
                >
                  <CheckCircle2 className="w-4 h-4 mr-1.5" />
                  Confirmar cliente atual
                </Button>
              </div>

              <div>
                <Label>Buscar cliente existente</Label>
                <div className="relative mt-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Nome, WhatsApp, e-mail ou CPF..."
                    value={customerLinkSearch}
                    onChange={e => setCustomerLinkSearch(e.target.value)}
                    disabled={customerLinkSaving}
                  />
                </div>
                {customerLinkMatches.length > 0 && (
                  <div className="mt-2 rounded-lg border divide-y">
                    {customerLinkMatches.map(customer => (
                      <button
                        key={customer.id}
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-3"
                        disabled={customerLinkSaving}
                        onClick={() => linkCustomerToRegistration(customer.id)}
                      >
                        <span className="min-w-0">
                          <span className="block font-medium truncate">{customer.full_name}</span>
                          <span className="block text-xs text-muted-foreground truncate">
                            {[customer.whatsapp, customer.email, customer.cpf].filter(Boolean).join(' · ') || 'Sem contato'}
                          </span>
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-blue-600" />
                  <p className="text-sm font-semibold">Criar novo cliente e vincular</p>
                </div>
                <div>
                  <Label>Nome completo</Label>
                  <Input className="mt-1" value={newCustomer.full_name}
                    onChange={e => setNewCustomer(f => ({ ...f, full_name: e.target.value }))} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>WhatsApp</Label>
                    <Input className="mt-1" value={newCustomer.whatsapp}
                      onChange={e => setNewCustomer(f => ({ ...f, whatsapp: e.target.value }))} />
                  </div>
                  <div>
                    <Label>CPF</Label>
                    <Input className="mt-1" inputMode="numeric" value={newCustomer.cpf}
                      onChange={e => setNewCustomer(f => ({ ...f, cpf: e.target.value.replace(/\D/g, '').slice(0, 11) }))} />
                  </div>
                </div>
                <div>
                  <Label>E-mail</Label>
                  <Input className="mt-1" value={newCustomer.email}
                    onChange={e => setNewCustomer(f => ({ ...f, email: e.target.value }))} />
                </div>
                <Button className="w-full" variant="outline" disabled={customerLinkSaving} onClick={createAndLinkCustomer}>
                  {customerLinkSaving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <UserPlus className="w-4 h-4 mr-1.5" />}
                  Criar e vincular
                </Button>
              </div>

              <div className="flex justify-end">
                <Button variant="outline" disabled={customerLinkSaving} onClick={() => setCustomerLinkModal(null)}>
                  Fechar
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal: despesa do evento */}
      <Dialog open={expenseModal} onOpenChange={open => !expenseSaving && setExpenseModal(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingExpenseId ? 'Editar despesa' : 'Nova despesa'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Descrição</Label>
              <Input
                className="mt-1"
                value={expenseForm.description}
                placeholder="Ex.: Aluguel da sala"
                onChange={e => setExpenseForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Valor (R$)</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={expenseForm.amount}
                  onChange={e => setExpenseForm(f => ({ ...f, amount: e.target.value }))}
                />
              </div>
              <div>
                <Label>Data</Label>
                <Input
                  className="mt-1"
                  type="date"
                  value={expenseForm.expense_date}
                  onChange={e => setExpenseForm(f => ({ ...f, expense_date: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Categoria</Label>
              <Input
                className="mt-1"
                value={expenseForm.category}
                placeholder="Ex.: Estrutura, brinde, mídia"
                onChange={e => setExpenseForm(f => ({ ...f, category: e.target.value }))}
              />
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea
                className="mt-1"
                rows={2}
                value={expenseForm.notes}
                onChange={e => setExpenseForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setExpenseModal(false)} disabled={expenseSaving}>Cancelar</Button>
              <Button className="flex-1" onClick={saveExpense} disabled={expenseSaving}>
                {expenseSaving ? 'Salvando...' : 'Salvar despesa'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal: nova inscrição */}
      <Dialog open={regModal} onOpenChange={open => !regSaving && setRegModal(open)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova inscrição</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tipo de inscrição</Label>
              <Select value={regTypeId || undefined} onValueChange={v => { setRegTypeId(v); setRegAnswers({}); }}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {sortedTypes.filter(t => t.active).map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name} — {formatCurrency(Number(t.price))}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Cliente</Label>
              {regCustomerId ? (
                <div className="mt-1 flex items-center justify-between rounded-lg border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{customersById[regCustomerId]?.full_name}</p>
                    <p className="text-xs text-muted-foreground">{customersById[regCustomerId]?.whatsapp || customersById[regCustomerId]?.email}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setRegCustomerId('')}><X className="w-4 h-4" /></Button>
                </div>
              ) : (
                <>
                  <div className="relative mt-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input className="pl-9" placeholder="Nome, WhatsApp ou e-mail..."
                      value={regCustomerSearch} onChange={e => setRegCustomerSearch(e.target.value)} />
                  </div>
                  {filteredCustomers.length > 0 && (
                    <div className="mt-1 rounded-lg border divide-y">
                      {filteredCustomers.map(c => (
                        <button key={c.id} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between"
                          onClick={() => setRegCustomerId(c.id)}>
                          <span>
                            <span className="font-medium">{c.full_name}</span>
                            <span className="text-xs text-muted-foreground ml-2">{c.whatsapp || c.email}</span>
                          </span>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Não achou? Cadastre o cliente na tela <button className="underline" onClick={() => navigate('/clientes')}>Clientes</button> e volte aqui.
                  </p>
                </>
              )}
            </div>

            {regTypeId && (
              <DynamicForm
                fields={typesById[regTypeId]?.form_fields || []}
                answers={regAnswers}
                onChange={setRegAnswers}
              />
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setRegModal(false)} disabled={regSaving}>Cancelar</Button>
              <Button className="flex-1" onClick={saveRegistration} disabled={regSaving || !regTypeId || !regCustomerId}>
                {regSaving ? 'Criando...' : 'Criar inscrição'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal: registrar pagamento */}
      <Dialog open={Boolean(payModal)} onOpenChange={open => !paySaving && !open && setPayModal(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-700"><Check className="w-5 h-5" /> Registrar pagamento</DialogTitle>
          </DialogHeader>
          <ManualPaymentForm
            form={manualPayForm}
            setForm={setManualPayForm}
            methodGroups={methodGroups}
            saving={paySaving}
            onSave={confirmPayment}
            onCancel={() => setPayModal(null)}
          />
        </DialogContent>
      </Dialog>

      <ExternalChargeDialog
        open={Boolean(externalChargeModal)}
        onCancel={() => setExternalChargeModal(null)}
        hasCharge={Boolean(externalChargeModal?.external_payment_link)}
        form={externalChargeForm}
        setForm={setExternalChargeForm}
        saving={chargeSaving}
        onSave={saveExternalCharge}
      />

      {/* Modal: gerar cobrança Asaas */}
      <Dialog open={Boolean(chargeModal)} onOpenChange={open => !chargeSaving && !open && setChargeModal(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blue-700">
              <ReceiptText className="w-5 h-5" /> Gerar cobrança via Asaas
            </DialogTitle>
          </DialogHeader>
          {chargeModal && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-gray-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-semibold text-blue-700">{chargeModal.registration_number}</p>
                    <p className="text-sm font-semibold truncate">{customersById[chargeModal.customer_id]?.full_name || 'Cliente'}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {typesById[chargeModal.registration_type_id]?.name || 'Inscrição'}
                    </p>
                  </div>
                  <p className="text-sm font-bold shrink-0">
                    {formatCurrency(Number(typesById[chargeModal.registration_type_id]?.price || 0))}
                  </p>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Cliente confirmado
                </div>
              </div>

              <div>
                <Label>Forma de cobrança</Label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {[
                    { value: 'PIX', label: 'PIX' },
                    { value: 'BOLETO', label: 'Boleto' },
                    { value: 'CREDIT_CARD', label: 'Cartão' },
                  ].map(method => (
                    <Button
                      key={method.value}
                      type="button"
                      variant={chargeForm.billing_type === method.value ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setChargeForm(form => ({
                        ...form,
                        billing_type: method.value,
                        installments: method.value === 'CREDIT_CARD' ? form.installments : 1,
                      }))}
                      disabled={chargeSaving}
                    >
                      {method.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Vencimento</Label>
                  <Input className="mt-1" type="date" value={chargeForm.due_date}
                    onChange={e => setChargeForm(form => ({ ...form, due_date: e.target.value }))}
                    disabled={chargeSaving} />
                </div>
                <div>
                  <Label>Parcelas</Label>
                  <Input className="mt-1" type="number" min="1" max="12"
                    disabled={chargeSaving || chargeForm.billing_type !== 'CREDIT_CARD'}
                    value={chargeForm.installments}
                    onChange={e => setChargeForm(form => ({ ...form, installments: e.target.value }))} />
                </div>
              </div>
              <div>
                <Label>CPF do cliente</Label>
                <Input className="mt-1" inputMode="numeric" value={chargeForm.cpf}
                  onChange={e => setChargeForm(form => ({ ...form, cpf: e.target.value.replace(/\D/g, '').slice(0, 11) }))}
                  placeholder="Somente números"
                  disabled={chargeSaving} />
                <p className="mt-1 text-xs text-muted-foreground">
                  Necessário para criar ou localizar o cliente no Asaas via API.
                </p>
              </div>

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => setChargeModal(null)} disabled={chargeSaving}>Cancelar</Button>
                <Button className="flex-1" onClick={generateCharge} disabled={chargeSaving || !chargeForm.due_date}>
                  {chargeSaving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Zap className="w-4 h-4 mr-1.5" />}
                  {chargeSaving ? 'Salvando...' : 'Gerar cobrança'}
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full text-amber-700 border-amber-300 hover:bg-amber-50"
                disabled={chargeSaving}
                onClick={() => {
                  const registration = chargeModal;
                  setChargeModal(null);
                  if (registration) openExternalCharge(registration, chargeForm.due_date);
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
            refresh({ force: true });
          }}
        />
      )}

      {/* Modal: cancelar inscrição */}
      <Dialog open={Boolean(cancelModal)} onOpenChange={open => !cancelSaving && !open && setCancelModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600"><X className="w-5 h-5" /> Cancelar inscrição</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              A inscrição é cancelada e a vaga volta a ficar disponível.
            </p>
            <Textarea placeholder="Motivo do cancelamento..." rows={2}
              value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setCancelModal(null)} disabled={cancelSaving}>Voltar</Button>
              <Button className="flex-1 bg-red-500 hover:bg-red-600 text-white" onClick={confirmCancel} disabled={cancelSaving || !cancelReason.trim()}>
                {cancelSaving ? 'Cancelando...' : 'Cancelar inscrição'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
