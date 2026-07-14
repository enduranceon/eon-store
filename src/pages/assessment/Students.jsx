import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, Pencil, Users, Phone, Mail, ChevronRight, Filter,
  UserCheck, Clock, UserX, Database, Loader2, MapPin,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PreSaleCustomer, AssessmentContract } from '@/api/entities';
import { normalizePhone } from '@/api/db';
import { usePageData } from '@/hooks/usePageData';
import { buildContractLifecycleRows } from '@/lib/assessment-contract-lifecycle';
import { applyAssessmentContractTransitions } from '@/lib/assessment-contract-transitions';
import { formatCep, lookupCepAddress, normalizeCep } from '@/lib/br-address';
import { toast } from 'sonner';

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

function classifyStudent(customer, lifecycleRows) {
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
  };
}

async function loadStudentsPage() {
  const [customers, contracts] = await Promise.all([
    PreSaleCustomer.list('full_name').catch(() => []),
    AssessmentContract.list('-created_at').catch(() => []),
  ]);
  await applyAssessmentContractTransitions(contracts);
  return { customers, contracts };
}

export default function Students() {
  const navigate = useNavigate();
  const {
    data: { customers, contracts },
    refresh,
  } = usePageData({
    key: 'assessment-students:list',
    loader: loadStudentsPage,
    initialData: { customers: [], contracts: [] },
    tags: ['presale_customers', 'assessment_contracts'],
    onError: error => console.error('Erro ao carregar alunos:', error),
  });
  const [search, setSearch] = useState('');
  const [viewFilter, setViewFilter] = useState('all');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const lifecycleRows = useMemo(
    () => buildContractLifecycleRows(contracts),
    [contracts]
  );
  const studentRows = useMemo(
    () => customers.map(customer => classifyStudent(customer, lifecycleRows)),
    [customers, lifecycleRows]
  );

  const summary = useMemo(() => ({
    total: studentRows.length,
    active: studentRows.filter(row => row.situationKey === 'active').length,
    scheduled: studentRows.filter(row => row.situationKey === 'scheduled').length,
    former: studentRows.filter(row => row.situationKey === 'former').length,
    prospects: studentRows.filter(row => row.situationKey === 'prospect').length,
    base: studentRows.filter(row => row.situationKey === 'base').length,
    withHistory: studentRows.filter(row => ['active', 'scheduled', 'former'].includes(row.situationKey)).length,
  }), [studentRows]);

  const viewFilters = [
    { key: 'all', label: 'Toda base', count: summary.total },
    { key: 'active', label: 'Ativos', count: summary.active },
    { key: 'history', label: 'Com histórico', count: summary.withHistory },
    { key: 'base', label: 'Sem contrato', count: summary.base },
    ...(summary.prospects > 0 ? [{ key: 'prospect', label: 'Prospects', count: summary.prospects }] : []),
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
    if (viewFilter === 'history' && !['active', 'scheduled', 'former'].includes(row.situationKey)) return false;
    if (viewFilter === 'base' && row.situationKey !== 'base') return false;
    if (viewFilter === 'prospect' && row.situationKey !== 'prospect') return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return c.full_name?.toLowerCase().includes(q) ||
           c.customer_code?.toLowerCase().includes(q) ||
           c.email?.toLowerCase().includes(q) ||
           c.whatsapp?.includes(search.replace(/\D/g, '')) ||
           c.cpf?.includes(search.replace(/\D/g, ''));
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Alunos</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} pessoa{filtered.length !== 1 ? 's' : ''} na visão selecionada</p>
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
          <Input placeholder="Buscar por nome, telefone, CPF, email..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {viewFilters.map(filter => (
          <button
            key={filter.key}
            onClick={() => setViewFilter(filter.key)}
            className={`text-xs font-medium px-3 py-2 rounded-lg border flex items-center gap-1.5 ${viewFilter === filter.key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-600'}`}
          >
            <Filter className="w-3.5 h-3.5" />
            {filter.label} <span className="font-bold">{filter.count}</span>
          </button>
        ))}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
        A base de pessoas é unificada com <strong>Clientes</strong>. A situação de assessoria abaixo vem dos contratos, não do cadastro da pessoa.
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
            <button onClick={() => setViewFilter('all')} className="text-sm text-blue-600 hover:underline mt-2">
              Ver toda a base
            </button>
          )}
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nome</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contato</th>
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
                  <tr key={s.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/alunos/${s.id}`)}>
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
