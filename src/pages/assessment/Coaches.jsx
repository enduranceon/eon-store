import { useState } from 'react';
import { Plus, Pencil, Search, UserCheck, Phone, Mail } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AssessmentCoach, AssessmentContract } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { buildContractLifecycleRows } from '@/lib/assessment-contract-lifecycle';
import { toast } from 'sonner';

const ROLE_LABEL = { junior: 'Junior', pleno: 'Pleno', senior: 'Senior' };
const ROLE_COLOR = {
  junior: 'bg-gray-100 text-gray-700',
  pleno:  'bg-blue-100 text-blue-700',
  senior: 'bg-amber-100 text-amber-700',
};

const emptyForm = { name: '', email: '', phone: '', role: 'junior', leader_id: null, co_leader_ids: [], active: true };

async function loadCoachesPage() {
  const [coaches, contracts] = await Promise.all([
    AssessmentCoach.list('name').catch(() => []),
    AssessmentContract.list('-created_at').catch(() => []),
  ]);
  const counts = {};
  buildContractLifecycleRows(contracts)
    .filter(contract => contract.lifecycle?.counts?.active && contract.coach_id)
    .forEach(contract => {
      counts[contract.coach_id] = (counts[contract.coach_id] || 0) + 1;
    });
  return { coaches, counts };
}

export default function Coaches() {
  const {
    data: { coaches, counts },
    refresh,
  } = usePageData({
    key: 'assessment-coaches:list',
    loader: loadCoachesPage,
    initialData: { coaches: [], counts: {} },
    tags: ['assessment_coaches', 'assessment_contracts'],
    onError: error => console.error('Erro ao carregar coaches:', error),
  });
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const open = (c) => {
    if (c) { setEditing(c); setForm({ ...c, co_leader_ids: c.co_leader_ids || [] }); }
    else   { setEditing(null); setForm(emptyForm); }
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) return toast.error('Nome obrigatório');
    if (!form.email.trim()) return toast.error('Email obrigatório');
    if (!form.role) return toast.error('Papel obrigatório');
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone || null,
        role: form.role,
        leader_id: form.leader_id || null,
        co_leader_ids: form.co_leader_ids || [],
        active: !!form.active,
      };
      if (editing) await AssessmentCoach.update(editing.id, payload);
      else await AssessmentCoach.create(payload);
      toast.success('Salvo!');
      setModal(false);
      await refresh({ force: true });
    } catch (e) {
      toast.error(e.message?.includes('duplicate') ? 'Email já cadastrado' : (e.message || 'Erro'));
    } finally { setSaving(false); }
  };

  const toggle = async (c) => {
    try {
      await AssessmentCoach.update(c.id, { active: !c.active });
      await refresh({ force: true });
    }
    catch (e) { toast.error(e.message); }
  };

  const filtered = coaches.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q);
  });

  const possibleLeaders = coaches.filter(c => c.id !== editing?.id && c.active);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Coaches</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} coach{filtered.length !== 1 ? 'es' : ''}</p>
        </div>
        <Button onClick={() => open(null)}><Plus className="w-4 h-4 mr-2" /> Novo coach</Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar por nome ou email..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <UserCheck className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">Nenhum coach cadastrado</p>
          <Button className="mt-4" onClick={() => open(null)}>Cadastrar primeiro coach</Button>
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nome</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Papel</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Líder</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Atletas</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(c => {
                const leader = coaches.find(x => x.id === c.leader_id);
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-semibold">{c.name}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-2">
                        <Mail className="w-3 h-3" /> {c.email}
                        {c.phone && <><span>·</span><Phone className="w-3 h-3" /> {c.phone}</>}
                      </p>
                    </td>
                    <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ROLE_COLOR[c.role]}`}>{ROLE_LABEL[c.role]}</span></td>
                    <td className="px-4 py-3 text-muted-foreground text-sm">{leader?.name || '—'}</td>
                    <td className="px-4 py-3 text-center font-bold">{counts[c.id] || 0}</td>
                    <td className="px-4 py-3 text-center">
                      <button onClick={() => toggle(c)} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {c.active ? 'Ativo' : 'Inativo'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => open(c)} className="p-1.5 hover:bg-gray-100 rounded text-gray-500"><Pencil className="w-3.5 h-3.5" /></button>
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
          <DialogHeader><DialogTitle>{editing ? 'Editar coach' : 'Novo coach'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Nome *</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Email *</Label><Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
              <div><Label>Telefone</Label><Input value={form.phone || ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
            </div>
            <div>
              <Label>Papel *</Label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="junior">Junior</SelectItem>
                  <SelectItem value="pleno">Pleno</SelectItem>
                  <SelectItem value="senior">Senior</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Líder direto</Label>
              <Select value={form.leader_id || 'none'} onValueChange={v => setForm(f => ({ ...f, leader_id: v === 'none' ? null : v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem líder</SelectItem>
                  {possibleLeaders.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 pt-2">
              <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="w-4 h-4 accent-blue-600" />
              <span className="text-sm">Coach ativo</span>
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
