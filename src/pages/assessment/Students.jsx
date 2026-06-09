import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pencil, Users, Phone, Mail, ChevronRight, Filter } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PreSaleCustomer, AssessmentContract } from '@/api/entities';
import { normalizePhone } from '@/api/db';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const empty = { full_name: '', email: '', whatsapp: '', cpf: '', active: true };

async function loadStudentsPage() {
  const [customers, contracts] = await Promise.all([
    PreSaleCustomer.list('full_name').catch(() => []),
    AssessmentContract.list('-created_at').catch(() => []),
  ]);
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
  const [onlyStudents, setOnlyStudents] = useState(false); // padrão: mostra toda a base
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);

  const open = (s) => {
    if (s) { setEditing(s); setForm({ ...s, active: s.active ?? true }); }
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

  const activeContractsByCustomer = (id) =>
    contracts.filter(c => c.customer_id === id && ['active', 'overdue', 'on_leave'].includes(c.status));

  const totalContractsByCustomer = (id) =>
    contracts.filter(c => c.customer_id === id);

  const filtered = customers.filter(c => {
    if (onlyStudents && totalContractsByCustomer(c.id).length === 0) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return c.full_name?.toLowerCase().includes(q) ||
           c.email?.toLowerCase().includes(q) ||
           c.whatsapp?.includes(search.replace(/\D/g, '')) ||
           c.cpf?.includes(search.replace(/\D/g, ''));
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Alunos</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} pessoa{filtered.length !== 1 ? 's' : ''} {onlyStudents ? '(com contratos)' : '(base completa)'}</p>
        </div>
        <Button onClick={() => open(null)}><Plus className="w-4 h-4 mr-2" /> Nova pessoa</Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar por nome, telefone, CPF, email..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button
          onClick={() => setOnlyStudents(s => !s)}
          className={`text-xs font-medium px-3 py-2 rounded-lg border flex items-center gap-1.5 ${onlyStudents ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-600'}`}
        >
          <Filter className="w-3.5 h-3.5" />
          {onlyStudents ? 'Apenas alunos' : 'Toda a base'}
        </button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
        💡 A base de pessoas é unificada com <strong>Clientes</strong>. Quem é cliente da loja já aparece aqui.
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <Users className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            {onlyStudents ? 'Nenhuma pessoa com contrato de assessoria' : 'Nenhuma pessoa cadastrada'}
          </p>
          {onlyStudents && (
            <button onClick={() => setOnlyStudents(false)} className="text-sm text-blue-600 hover:underline mt-2">
              Ver toda a base de clientes
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
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(s => {
                const activeC = activeContractsByCustomer(s.id);
                const totalC = totalContractsByCustomer(s.id);
                return (
                  <tr key={s.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/alunos/${s.id}`)}>
                    <td className="px-4 py-3 font-semibold">{s.full_name}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground space-y-0.5">
                      {s.whatsapp && <p className="flex items-center gap-1"><Phone className="w-3 h-3" /> {s.whatsapp}</p>}
                      {s.email && <p className="flex items-center gap-1"><Mail className="w-3 h-3" /> {s.email}</p>}
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-blue-700">{activeC.length}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{totalC.length}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.active !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {s.active !== false ? 'Ativo' : 'Inativo'}
                      </span>
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
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? 'Editar pessoa' : 'Nova pessoa'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Nome completo *</Label><Input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>WhatsApp</Label><Input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} placeholder="(11) 99999-9999" /></div>
              <div><Label>CPF</Label><Input value={form.cpf || ''} onChange={e => setForm(f => ({ ...f, cpf: e.target.value }))} placeholder="000.000.000-00" /></div>
            </div>
            <div><Label>Email</Label><Input type="email" value={form.email || ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
            <p className="text-xs text-muted-foreground">CPF é necessário para gerar cobranças no Asaas</p>
            <label className="flex items-center gap-2 pt-2">
              <input type="checkbox" checked={form.active !== false} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="w-4 h-4 accent-blue-600" />
              <span className="text-sm">Pessoa ativa</span>
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
