import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarDays, Check, ChevronRight, Copy, ExternalLink, HandCoins, Layers,
  Link2, Pencil, Plus, Search, Trash2, Users, X,
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
  EventRecord, EventRegistration, EventRegistrationType, PreSaleCustomer,
} from '@/api/entities';
import {
  cancelEventRegistration, createEventRegistration, recordEventRegistrationPayment,
} from '@/api/client';
import { studentProfilePath } from '@/lib/customer-profile';
import { formatCurrency, formatDate } from '@/lib/utils';
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

const PAYMENT_METHODS = ['PIX', 'Dinheiro', 'Cartão', 'Transferência', 'Outro'];

const EMPTY_FIELD = { key: '', label: '', kind: 'text', required: false, options: [] };
const EMPTY_TYPE_FORM = { name: '', price: '', max_quantity: '', fields: [] };

function fieldKeyFromLabel(label) {
  return label
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

async function loadEventDetail(eventId) {
  const [event, types, registrations, customers] = await Promise.all([
    EventRecord.get(eventId),
    EventRegistrationType.filter({ event_id: eventId }),
    EventRegistration.filter({ event_id: eventId }),
    PreSaleCustomer.list('full_name'),
  ]);
  return { event, types, registrations, customers };
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

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    data: { event, types, registrations, customers },
    loading, refresh,
  } = usePageData({
    key: `events:detail:${id}`,
    loader: () => loadEventDetail(id),
    initialData: { event: null, types: [], registrations: [], customers: [] },
    tags: ['events', 'event_registration_types', 'event_registrations', 'presale_customers'],
    forceOnMount: true,
    onError: () => toast.error('Erro ao carregar o evento'),
  });

  const customersById = useMemo(
    () => Object.fromEntries(customers.map(c => [c.id, c])),
    [customers],
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

  // ----- tipo de inscrição (criar/editar) -----
  const [typeModal, setTypeModal] = useState(false);
  const [editingTypeId, setEditingTypeId] = useState(null);
  const [typeForm, setTypeForm] = useState(EMPTY_TYPE_FORM);
  const [typeSaving, setTypeSaving] = useState(false);

  const openNewType = () => { setEditingTypeId(null); setTypeForm(EMPTY_TYPE_FORM); setTypeModal(true); };
  const openEditType = t => {
    setEditingTypeId(t.id);
    setTypeForm({
      name: t.name,
      price: String(t.price ?? ''),
      max_quantity: t.max_quantity == null ? '' : String(t.max_quantity),
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
  const [payMethod, setPayMethod] = useState('PIX');
  const [paySaving, setPaySaving] = useState(false);
  const [cancelModal, setCancelModal] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSaving, setCancelSaving] = useState(false);

  const confirmPayment = async () => {
    setPaySaving(true);
    try {
      await recordEventRegistrationPayment(payModal.id, { paymentMethod: payMethod });
      setPayModal(null);
      toast.success('Pagamento registrado');
      refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Erro ao registrar pagamento');
    } finally {
      setPaySaving(false);
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
  const priceOf = reg => Number(typesById[reg.registration_type_id]?.price || 0);
  const paidTotal = registrations
    .filter(r => r.payment_status === 'paid')
    .reduce((acc, r) => acc + priceOf(r), 0);
  // Esperado = tudo que não foi cancelado, incluindo o que ainda não foi pago.
  // É o número que responde "quanto esse evento vale se todo mundo pagar".
  const expectedTotal = activeRegs.reduce((acc, r) => acc + priceOf(r), 0);
  const pendingTotal = expectedTotal - paidTotal;

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
          <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5" /> {formatDate(event.event_date)}
            {event.location ? ` · ${event.location}` : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <Select value={event.status} onValueChange={changeEventStatus}>
            <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(EVENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

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
          <p className="text-xs text-muted-foreground">Receita confirmada</p>
          <p className="text-2xl font-bold text-emerald-700">{formatCurrency(paidTotal)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total esperado</p>
          <p className="text-2xl font-bold">{formatCurrency(expectedTotal)}</p>
          {pendingTotal > 0 && (
            <p className="text-xs text-amber-700 mt-0.5">{formatCurrency(pendingTotal)} a receber</p>
          )}
        </CardContent></Card>
      </div>

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
                const type = typesById[reg.registration_type_id];
                const pay = REG_PAYMENT[reg.payment_status] || REG_PAYMENT.pending;
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
                        <Badge variant={pay.variant}>{pay.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {type?.name || 'Tipo removido'} · {formatCurrency(Number(type?.price || 0))}
                        {reg.payment_method && ` · ${reg.payment_method}`}
                        {reg.payment_date && ` em ${formatDate(reg.payment_date)}`}
                      </p>
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
                      {['pending', 'awaiting_charge', 'charge_sent'].includes(reg.payment_status) && (
                        <>
                          <Button size="sm" variant="outline" className="text-emerald-700 hover:bg-emerald-50"
                            onClick={() => { setPayMethod('PIX'); setPayModal(reg); }}>
                            <HandCoins className="w-3.5 h-3.5 mr-1" /> Registrar pagamento
                          </Button>
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
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-700"><Check className="w-5 h-5" /> Registrar pagamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {payModal && `${customersById[payModal.customer_id]?.full_name || 'Cliente'} · ${formatCurrency(Number(typesById[payModal.registration_type_id]?.price || 0))}`}
            </p>
            <div className="space-y-1.5">
              {PAYMENT_METHODS.map(m => (
                <button key={m} type="button" onClick={() => setPayMethod(m)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-all ${payMethod === m ? 'border-emerald-400 bg-emerald-50 text-emerald-800 font-medium' : 'border-gray-200 hover:border-gray-300 text-gray-700'}`}>
                  {m}
                </button>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setPayModal(null)} disabled={paySaving}>Voltar</Button>
              <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={confirmPayment} disabled={paySaving}>
                {paySaving ? 'Registrando...' : 'Confirmar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
