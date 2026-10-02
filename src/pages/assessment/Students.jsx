import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Search, Pencil, Users, Phone, Mail, ChevronRight, Filter,
  UserCheck, Clock, UserX, Database, Loader2, MapPin,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PreSaleCustomer, AssessmentContract, PreSaleOrder, StockOrder, EventRegistration } from '@/api/entities';
import { normalizePhone } from '@/api/db';
import { usePageData } from '@/hooks/usePageData';
import { buildContractLifecycleRows } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { formatCep, lookupCepAddress, normalizeCep } from '@/lib/br-address';
import { toast } from 'sonner';
import { studentProfilePath } from '@/lib/customer-profile';

const empty = {
  full_name: '',
  email: '',
  whatsapp: '',
  cpf: '',
  birth_date: '',
  address_zip: '',
  address_street: '',
  address_number: '',
  address_complement: '',
  address_neighborhood: '',
  address_city: '',
  address_state: '',
  active: true,
};

const SITUATION = {
  active:    { label: 'Aluno ativo',       cls: 'bg-green-100 text-green-700' },
  scheduled: { label: 'Agendado',          cls: 'bg-blue-100 text-blue-700' },
  former:    { label: 'Ex-aluno',          cls: 'bg-gray-100 text-gray-600' },
  prospect:  { label: 'Prospect',          cls: 'bg-amber-100 text-amber-700' },
  base:      { label: 'Base sem contrato', cls: 'bg-slate-100 text-slate-600' },
};

function classifyStudent(customer, lifecycleRows, storeOrdersCount = 0, eventRegistrationsCount = 0) {
  const rows = lifecycleRows.filter(c => c.customer_id === customer.id);
  const activeContracts = rows.filter(c => c.lifecycle?.counts?.active);
  const scheduledContracts = rows.filter(c => c.lifecycle?.type === 'scheduled');
  const effectiveContracts = rows.filter(c =>
    !['pending_sale', 'renewal', 'voided_sale'].includes(c.lifecycle?.type)
  );
  const prospectContracts = rows.filter(c =>
    ['pending_sale', 'renewal'].includes(c.lifecycle?.type)
  );

  const key = activeContracts.length > 0 ? 'active'
    : scheduledContracts.length > 0 ? 'scheduled'
    : effectiveContracts.length > 0 ? 'former'
    : prospectContracts.length > 0 ? 'prospect'
    : 'base';

  return {
    customer,
    activeContracts,
    scheduledContracts,
    effectiveContracts,
    prospectContracts,
    allContracts: rows,
    situation: SITUATION[key],
    situationKey: key,
    storeOrdersCount,
    eventRegistrationsCount,
  };
}

async function loadStudentsPage() {
  const [customers, contracts, presaleOrders, stockOrders, eventRegistrations] = await Promise.all([
    PreSaleCustomer.list('full_name'),
    AssessmentContract.list('-created_at'),
    PreSaleOrder.list(),
    StockOrder.list(),
    EventRegistration.list(),
  ]);
  await applyAssessmentContractTransitions(contracts);
  return { customers, contracts, presaleOrders, stockOrders, eventRegistrations };
}

export default function Students() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: { customers, contracts, presaleOrders, stockOrders, eventRegistrations },
    loading, error,
    refresh,
  } = usePageData({
    key: 'people:list',
    loader: loadStudentsPage,
    initialData: { customers: [], contracts: [], presaleOrders: [], stockOrders: [], eventRegistrations: [] },
    tags: ['presale_customers', 'assessment_contracts', 'presale_orders', 'stock_orders', 'event_registrations'],
    onError: cause => console.error('Erro ao carregar pessoas:', cause),
  });
  const search = searchParams.get('busca') || searchParams.get('q') || '';
  const requestedFilter = searchParams.get('vinculo') || searchParams.get('tipo') || (searchParams.get('filtro') === 'sem-cpf' ? 'missing_cpf' : 'all');
  const viewFilter = requestedFilter === 'store-only' ? 'store'
    : requestedFilter === 'history' ? 'assessment'
    : requestedFilter;
  const updateQuery = (field, value) => {
    const next = new URLSearchParams(searchParams);
    if (field === 'busca') next.delete('q');
    if (field === 'vinculo') { next.delete('tipo'); next.delete('filtro'); }
    if (!value || value === 'all') next.delete(field);
    else next.set(field, value);
    setSearchParams(next, { replace: true });
  };
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const lifecycleRows = useMemo(
    () => buildContractLifecycleRows(contracts),
    [contracts]
  );
  const storeOrdersByCustomer = useMemo(() => {
    const counts = new Map();
    for (const order of [...presaleOrders, ...stockOrders]) {
      if (!order.customer_id || ['cancelled', 'voided', 'refunded'].includes(order.payment_status)) continue;
      counts.set(order.customer_id, (counts.get(order.customer_id) || 0) + 1);
    }
    return counts;
  }, [presaleOrders, stockOrders]);
  const eventsByCustomer = useMemo(() => {
    const counts = new Map();
    for (const registration of eventRegistrations) {
      if (!registration.customer_id || registration.payment_status === 'cancelled') continue;
      counts.set(registration.customer_id, (counts.get(registration.customer_id) || 0) + 1);
    }
    return counts;
  }, [eventRegistrations]);
  const studentRows = useMemo(
    () => customers.map(customer => classifyStudent(
      customer, lifecycleRows,
      storeOrdersByCustomer.get(customer.id) || 0,
      eventsByCustomer.get(customer.id) || 0,
    )),
    [customers, lifecycleRows, storeOrdersByCustomer, eventsByCustomer]
  );

  const summary = useMemo(() => ({
    total: studentRows.length,
    active: studentRows.filter(row => row.situationKey === 'active').length,
    scheduled: studentRows.filter(row => row.situationKey === 'scheduled').length,
    former: studentRows.filter(row => row.situationKey === 'former').length,
    prospects: studentRows.filter(row => row.situationKey === 'prospect').length,
    base: studentRows.filter(row => row.situationKey === 'base').length,
    withHistory: studentRows.filter(row => ['active', 'scheduled', 'former'].includes(row.situationKey)).length,
    store: studentRows.filter(row => row.storeOrdersCount > 0).length,
    events: studentRows.filter(row => row.eventRegistrationsCount > 0).length,
    missingCpf: studentRows.filter(row => !row.customer.cpf).length,
  }), [studentRows]);

  const viewFilters = [
    { key: 'all', label: 'Todas', count: summary.total },
    { key: 'active', label: 'Alunos ativos', count: summary.active },
    { key: 'assessment', label: 'Assessoria', count: summary.withHistory },
    { key: 'former', label: 'Ex-alunos', count: summary.former },
    { key: 'store', label: 'Loja', count: summary.store },
    { key: 'events', label: 'Eventos', count: summary.events },
    { key: 'base', label: 'Sem contrato', count: summary.base },
    ...(summary.prospects > 0 ? [{ key: 'prospect', label: 'Prospects', count: summary.prospects }] : []),
    ...(summary.missingCpf > 0 ? [{ key: 'missing_cpf', label: 'Sem CPF', count: summary.missingCpf }] : []),
  ];

  const open = (s) => {
    setCepLoading(false);
    if (s) { setEditing(s); setForm({ ...empty, ...s, active: s.active ?? true }); }
    else   { setEditing(null); setForm(empty); }
    setModal(true);
  };

  const save = async () => {
    if (!form.full_name?.trim()) return toast.error('Nome obrigatório');
    setSaving(true);
    try {
      const payload = {
        full_name: form.full_name.trim(),
        email: form.email?.trim().toLowerCase() || null,
        whatsapp: form.whatsapp ? normalizePhone(form.whatsapp) : null,
        cpf: form.cpf?.replace(/\D/g, '') || null,
        birth_date: form.birth_date || null,
        address_zip: normalizeCep(form.address_zip) || null,
        address_street: form.address_street?.trim() || null,
        address_number: form.address_number?.trim() || null,
        address_complement: form.address_complement?.trim() || null,
        address_neighborhood: form.address_neighborhood?.trim() || null,
        address_city: form.address_city?.trim() || null,
        address_state: form.address_state?.trim().toUpperCase() || null,
        active: !!form.active,
      };
      if (editing) await PreSaleCustomer.update(editing.id, payload);
      else await PreSaleCustomer.create(payload);
      toast.success('Salvo!');
      setModal(false);
      await refresh({ force: true });
    } catch (e) { toast.error(e.message || 'Erro'); }
    finally { setSaving(false); }
  };

  const fillAddressByCep = async () => {
    const cep = normalizeCep(form.address_zip);
    if (!cep) return;
    if (cep.length !== 8) return toast.error('Informe um CEP com 8 dígitos');

    setCepLoading(true);
    try {
      const address = await lookupCepAddress(cep);
      setForm(f => ({
        ...f,
        address_zip: formatCep(address.zip),
        address_street: address.street || f.address_street,
        address_complement: f.address_complement || address.complement || '',
        address_neighborhood: address.neighborhood || f.address_neighborhood,
        address_city: address.city || f.address_city,
        address_state: address.state || f.address_state,
      }));
      toast.success('Endereço preenchido pelo CEP');
    } catch (e) {
      toast.error(e.message || 'Não foi possível buscar o CEP');
    } finally {
      setCepLoading(false);
    }
  };

  const filtered = studentRows.filter(row => {
    const c = row.customer;
    if (viewFilter === 'active' && row.situationKey !== 'active') return false;
    if (['history', 'assessment'].includes(viewFilter) && !['active', 'scheduled', 'former'].includes(row.situationKey)) return false;
    if (viewFilter === 'former' && row.situationKey !== 'former') return false;
    if (viewFilter === 'store' && row.storeOrdersCount === 0) return false;
    if (viewFilter === 'events' && row.eventRegistrationsCount === 0) return false;
    if (viewFilter === 'base' && row.situationKey !== 'base') return false;
    if (viewFilter === 'prospect' && row.situationKey !== 'prospect') return false;
    if (viewFilter === 'missing_cpf' && c.cpf) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    // Só compara telefone/CPF quando o termo tem dígitos: includes('') é sempre
    // true, e sem essa guarda a busca por nome casa com a base inteira.
    const digits = search.replace(/\D/g, '');
    return c.full_name?.toLowerCase().includes(q) ||
           c.customer_code?.toLowerCase().includes(q) ||
           c.email?.toLowerCase().includes(q) ||
           (digits && c.whatsapp?.includes(digits)) ||
           (digits && c.cpf?.includes(digits));
  });

  const reload = async () => {
    try { await refresh({ force: true }); }
    catch { /* usePageData reports the error above. */ }
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando pessoas...</div>;
  if (error) return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
      Não foi possível carregar a base de pessoas. <Button variant="outline" className="ml-2" onClick={reload}>Tentar novamente</Button>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Pessoas</h2>
          <p className="text-sm text-muted-foreground">Uma busca para alunos, ex-alunos, compradores e participantes · {filtered.length} na visão selecionada</p>
        </div>
        <Button onClick={() => open(null)}><Plus className="w-4 h-4 mr-2" /> Nova pessoa</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-green-50"><UserCheck className="w-4 h-4 text-green-600" /></div>
            <div><p className="text-xs text-muted-foreground">Alunos ativos</p><p className="text-xl font-bold text-green-700">{summary.active}</p></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-blue-50"><Clock className="w-4 h-4 text-blue-600" /></div>
            <div><p className="text-xs text-muted-foreground">Agendados</p><p className="text-xl font-bold text-blue-700">{summary.scheduled}</p></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-gray-50"><UserX className="w-4 h-4 text-gray-600" /></div>
            <div><p className="text-xs text-muted-foreground">Ex-alunos</p><p className="text-xl font-bold text-gray-700">{summary.former}</p></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-slate-50"><Database className="w-4 h-4 text-slate-600" /></div>
            <div><p className="text-xs text-muted-foreground">Base sem contrato</p><p className="text-xl font-bold text-slate-700">{summary.base}</p></div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar por nome, código, telefone, CPF ou e-mail" className="pl-9" value={search} onChange={e => updateQuery('busca', e.target.value)} />
        </div>
        {viewFilters.map(filter => (
          <button
            key={filter.key}
            onClick={() => updateQuery('vinculo', filter.key)}
            className={`text-xs font-medium px-3 py-2 rounded-lg border flex items-center gap-1.5 ${viewFilter === filter.key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-600'}`}
          >
            <Filter className="w-3.5 h-3.5" />
            {filter.label} <span className="font-bold">{filter.count}</span>
          </button>
        ))}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
        Cada pessoa mantém seu ID. Os vínculos com assessoria, loja e eventos vêm dos registros existentes; nenhuma ficha é mesclada automaticamente.
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <Users className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            {viewFilter === 'active' ? 'Nenhum aluno ativo'
              : viewFilter === 'base' ? 'Nenhuma pessoa sem contrato'
              : 'Nenhuma pessoa nesta visão'}
          </p>
          {viewFilter !== 'all' && (
            <button onClick={() => updateQuery('vinculo', 'all')} className="text-sm text-blue-600 hover:underline mt-2">
              Ver toda a base
            </button>
          )}
        </CardContent></Card>
      ) : (
        <>
          <div className="grid gap-3 md:hidden">
            {filtered.map(row => {
              const person = row.customer;
              return (
                <div key={person.id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => navigate(studentProfilePath(person.id), { state: { returnTo: `${location.pathname}${location.search}${location.hash}` } })}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{person.full_name}</span>
                        {person.customer_code && <span className="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-blue-700">{person.customer_code}</span>}
                      </span>
                      <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${row.situation.cls}`}>{row.situation.label}</span>
                    </button>
                    <button type="button" onClick={() => open(person)} aria-label={`Editar ${person.full_name}`} className="rounded p-2 text-slate-500 hover:bg-slate-100">
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                    {row.situationKey !== 'base' && <span className="rounded bg-blue-50 px-2 py-1 text-blue-700">Assessoria</span>}
                    {row.storeOrdersCount > 0 && <span className="rounded bg-amber-50 px-2 py-1 text-amber-700">Loja</span>}
                    {row.eventRegistrationsCount > 0 && <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-700">Eventos</span>}
                    {row.situationKey === 'base' && row.storeOrdersCount === 0 && row.eventRegistrationsCount === 0 && <span className="text-slate-500">Sem vínculo registrado</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-slate-600">
                    <span>{person.whatsapp || person.email || 'Sem contato cadastrado'}</span>
                    <span>{row.activeContracts.length} ativo(s) · {row.effectiveContracts.length} contrato(s)</span>
                  </div>
                  <button type="button" onClick={() => navigate(studentProfilePath(person.id), { state: { returnTo: `${location.pathname}${location.search}${location.hash}` } })} className="mt-3 flex items-center gap-1 text-sm font-semibold text-blue-700">
                    Abrir ficha <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border bg-white md:block">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nome</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contato</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Vínculos</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Contratos ativos</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Total contratos</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Situação assessoria</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(row => {
                const s = row.customer;
                const activeC = row.activeContracts;
                const totalC = row.effectiveContracts;
                return (
                  <tr key={s.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(studentProfilePath(s.id), { state: { returnTo: `${location.pathname}${location.search}${location.hash}` } })}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {s.customer_code && (
                          <span className="font-mono text-[11px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded">
                            {s.customer_code}
                          </span>
                        )}
                        <span className="font-semibold">{s.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground space-y-0.5">
                      {s.whatsapp && <p className="flex items-center gap-1"><Phone className="w-3 h-3" /> {s.whatsapp}</p>}
                      {s.email && <p className="flex items-center gap-1"><Mail className="w-3 h-3" /> {s.email}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.situationKey !== 'base' && <span className="mr-1 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">Assessoria</span>}
                      {row.storeOrdersCount > 0 && <span className="mr-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">Loja</span>}
                      {row.eventRegistrationsCount > 0 && <span className="inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">Eventos</span>}
                      {row.situationKey === 'base' && row.storeOrdersCount === 0 && row.eventRegistrationsCount === 0 && 'Sem vínculo registrado'}
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-blue-700">{activeC.length}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{totalC.length}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${row.situation.cls}`}>
                        {row.situation.label}
                      </span>
                      {s.active === false && <p className="text-[10px] text-gray-500 mt-1">cadastro inativo</p>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={(e) => { e.stopPropagation(); open(s); }} className="p-1.5 hover:bg-gray-100 rounded text-gray-500 mr-1"><Pencil className="w-3.5 h-3.5" /></button>
                      <ChevronRight className="w-4 h-4 text-muted-foreground inline" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}

      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? 'Editar pessoa' : 'Nova pessoa'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {editing?.customer_code && (
              <div>
                <Label>Código</Label>
                <Input className="mt-1 font-mono" value={editing.customer_code} disabled />
              </div>
            )}
            <div><Label>Nome completo *</Label><Input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>WhatsApp</Label><Input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} placeholder="(11) 99999-9999" /></div>
              <div><Label>CPF</Label><Input value={form.cpf || ''} onChange={e => setForm(f => ({ ...f, cpf: e.target.value }))} placeholder="000.000.000-00" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Email</Label><Input type="email" value={form.email || ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
              <div><Label>Nascimento</Label><Input type="date" value={form.birth_date || ''} onChange={e => setForm(f => ({ ...f, birth_date: e.target.value }))} /></div>
            </div>
            <p className="text-xs text-muted-foreground">CPF é necessário para gerar cobranças no Asaas</p>
            <div className="border-t pt-3 space-y-3">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" /> Endereço
              </p>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div>
                  <Label>CEP</Label>
                  <Input
                    className="mt-1"
                    value={form.address_zip || ''}
                    onChange={e => setForm(f => ({ ...f, address_zip: formatCep(e.target.value) }))}
                    onBlur={fillAddressByCep}
                    placeholder="00000-000"
                  />
                </div>
                <Button type="button" variant="outline" className="self-end" onClick={fillAddressByCep} disabled={cepLoading || normalizeCep(form.address_zip).length !== 8}>
                  {cepLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
                </Button>
              </div>
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <div><Label>Rua</Label><Input className="mt-1" value={form.address_street || ''} onChange={e => setForm(f => ({ ...f, address_street: e.target.value }))} /></div>
                <div><Label>Número</Label><Input className="mt-1" value={form.address_number || ''} onChange={e => setForm(f => ({ ...f, address_number: e.target.value }))} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Complemento</Label><Input className="mt-1" value={form.address_complement || ''} onChange={e => setForm(f => ({ ...f, address_complement: e.target.value }))} /></div>
                <div><Label>Bairro</Label><Input className="mt-1" value={form.address_neighborhood || ''} onChange={e => setForm(f => ({ ...f, address_neighborhood: e.target.value }))} /></div>
              </div>
              <div className="grid grid-cols-[1fr_80px] gap-3">
                <div><Label>Cidade</Label><Input className="mt-1" value={form.address_city || ''} onChange={e => setForm(f => ({ ...f, address_city: e.target.value }))} /></div>
                <div><Label>UF</Label><Input className="mt-1 uppercase" maxLength={2} value={form.address_state || ''} onChange={e => setForm(f => ({ ...f, address_state: e.target.value.toUpperCase() }))} /></div>
              </div>
            </div>
            <label className="flex items-center gap-2 pt-2">
              <input type="checkbox" checked={form.active !== false} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="w-4 h-4 accent-blue-600" />
              <span className="text-sm">Cadastro ativo</span>
            </label>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={save} disabled={saving}>{saving ? 'Salvando...' : 'Salvar'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
