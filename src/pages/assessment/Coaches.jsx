import { useState } from 'react';
import { Plus, Pencil, Search, UserCheck, Phone, Mail } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AssessmentCoach, AssessmentCoachSitePlan, AssessmentContract, AssessmentModality, AssessmentPlan } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { buildContractLifecycleRows } from '@/lib/assessment-contract-lifecycle';
import { diffSitePlans, sitePlanForm, sitePlanKey, sitePlanOptions } from '@/lib/coach-site-plans';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';
import ContextTabs from '@/components/layout/ContextTabs';

const ROLE_LABEL = { junior: 'Junior', pleno: 'Pleno', senior: 'Senior' };
const ROLE_COLOR = {
  junior: 'bg-gray-100 text-gray-700',
  pleno:  'bg-blue-100 text-blue-700',
  senior: 'bg-amber-100 text-amber-700',
};

const emptyForm = {
  name: '', email: '', phone: '', role: 'junior', leader_id: null,
  co_leader_ids: [], active: true, public_visible: false, modality_ids: [],
  site_plans: {},
};

async function loadCoachesPage() {
  const [coaches, contracts, modalities, plans, sitePlans] = await Promise.all([
    AssessmentCoach.list('name').catch(() => []),
    AssessmentContract.list('-created_at').catch(() => []),
    AssessmentModality.filter({ active: true }, 'name').catch(() => []),
    AssessmentPlan.list('name').catch(() => []),
    AssessmentCoachSitePlan.list().catch(() => []),
  ]);
  const counts = {};
  buildContractLifecycleRows(contracts)
    .filter(contract => contract.lifecycle?.counts?.active && contract.coach_id)
    .forEach(contract => {
      counts[contract.coach_id] = (counts[contract.coach_id] || 0) + 1;
    });
  return { coaches, counts, modalities, plans, sitePlans };
}

export default function Coaches() {
  const {
    data: { coaches, counts, modalities, plans, sitePlans },
    refresh,
  } = usePageData({
    key: 'assessment-coaches:list',
    loader: loadCoachesPage,
    initialData: { coaches: [], counts: {}, modalities: [], plans: [], sitePlans: [] },
    tags: ['assessment_coaches', 'assessment_contracts', 'assessment_modalities', 'assessment_plans', 'assessment_coach_site_plans'],
    onError: error => console.error('Erro ao carregar coaches:', error),
  });
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const open = (c) => {
    if (c) {
      setEditing(c);
      setForm({
        ...c,
        co_leader_ids: c.co_leader_ids || [],
        modality_ids: c.modality_ids || [],
        public_visible: !!c.public_visible,
        site_plans: sitePlanForm(sitePlans, c.id),
      });
    }
    else   { setEditing(null); setForm(emptyForm); }
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) return toast.error('Nome obrigatório');
    if (!form.email.trim()) return toast.error('Email obrigatório');
    if (!form.role) return toast.error('Papel obrigatório');
    if (form.active && form.modality_ids.length === 0) return toast.error('Selecione ao menos uma modalidade');
    if (form.public_visible && !form.active) return toast.error('Para aparecer no site, o coach precisa estar ativo internamente');
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
        public_visible: !!form.active && !!form.public_visible,
        modality_ids: form.modality_ids || [],
      };
      const saved = editing
        ? await AssessmentCoach.update(editing.id, payload)
        : await AssessmentCoach.create(payload);
      const coachId = editing?.id || saved?.id;
      // Planos do site: só mexe quando o coach aparece no site.
      if (coachId && payload.public_visible) {
        const { creates, updates, deletes } = diffSitePlans(sitePlans, coachId, form.site_plans, payload.modality_ids);
        for (const id of deletes) await AssessmentCoachSitePlan.delete(id);
        for (const row of updates) await AssessmentCoachSitePlan.update(row.id, { plan_id: row.plan_id });
        for (const row of creates) await AssessmentCoachSitePlan.create(row);
      }
      toast.success('Salvo!');
      setModal(false);
      await refresh({ force: true });
    } catch (e) {
      toast.error(e.message?.includes('duplicate') ? 'Email já cadastrado' : (e.message || 'Erro'));
    } finally { setSaving(false); }
  };

  const toggle = async (c) => {
    try {
      await AssessmentCoach.update(c.id, {
        active: !c.active,
        ...(!c.active ? {} : { public_visible: false }),
      });
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
  const hasSitePlans = id => sitePlans.some(row => row.coach_id === id);
  const setSitePlan = (key, planId) => setForm(f => ({ ...f, site_plans: { ...f.site_plans, [key]: planId } }));
  const planLabel = plan => `${plan.name || 'Plano'} · ${formatCurrency(Number(plan.price_monthly))}/mês${Number(plan.period_months) > 1 ? ` (${formatCurrency(Number(plan.price_total))})` : ''}`;
  const modalityName = id => modalities.find(m => m.id === id)?.name;
  const toggleModality = id => setForm(f => ({
    ...f,
    modality_ids: f.modality_ids.includes(id)
      ? f.modality_ids.filter(item => item !== id)
      : [...f.modality_ids, id],
  }));

  return (
    <div className="space-y-5">
      <ContextTabs group="team" current="/assessoria/coaches" />
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Modalidades</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Atletas</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Interno</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Site</th>
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
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(c.modality_ids || []).map(id => (
                          <span key={id} className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 capitalize">
                            {modalityName(id) || 'Modalidade'}
                          </span>
                        ))}
                        {(c.modality_ids || []).length === 0 && <span className="text-xs text-amber-600">Não definido</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center font-bold">{counts[c.id] || 0}</td>
                    <td className="px-4 py-3 text-center">
                      <button onClick={() => toggle(c)} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {c.active ? 'Disponível' : 'Inativo'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c.active && c.public_visible ? 'bg-violet-100 text-violet-700' : 'bg-gray-100 text-gray-500'}`}>
                        {c.active && c.public_visible ? 'Visível' : 'Oculto'}
                      </span>
                      {c.active && c.public_visible && hasSitePlans(c.id) && (
                        <p className="text-[11px] text-violet-700 mt-1">planos próprios</p>
                      )}
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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
            <div>
              <Label>Modalidades atendidas *</Label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {modalities.map(modality => (
                  <label key={modality.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer ${form.modality_ids.includes(modality.id) ? 'border-blue-300 bg-blue-50' : 'border-gray-200'}`}>
                    <input type="checkbox" checked={form.modality_ids.includes(modality.id)} onChange={() => toggleModality(modality.id)} className="w-4 h-4 accent-blue-600" />
                    <span className="text-sm font-medium capitalize">{modality.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2 rounded-lg border bg-gray-50 p-3">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked, public_visible: e.target.checked ? f.public_visible : false }))} className="w-4 h-4 mt-0.5 accent-blue-600" />
                <span className="text-sm"><strong>Disponível internamente</strong><br /><span className="text-xs text-muted-foreground">Pode ser escolhido ao criar ou trocar contratos na EON Store.</span></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={form.public_visible} disabled={!form.active} onChange={e => setForm(f => ({ ...f, public_visible: e.target.checked }))} className="w-4 h-4 mt-0.5 accent-violet-600 disabled:opacity-50" />
                <span className="text-sm"><strong>Exibir no site</strong><br /><span className="text-xs text-muted-foreground">Aparece no formulário público somente nos planos das modalidades marcadas.</span></span>
              </label>
            </div>
            {form.active && form.public_visible && form.modality_ids.length > 0 && (
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-semibold">Planos que vende no site</p>
                  <p className="text-xs text-muted-foreground">
                    Escolha o plano de cada duração. Vale só para o site: na venda interna você pode usar qualquer plano.
                    Sem nenhum plano escolhido na modalidade, o site mostra os planos gerais; escolhendo algum, mostra só os escolhidos.
                  </p>
                </div>
                {form.modality_ids.map(modalityId => {
                  const options = sitePlanOptions(plans, modalityId);
                  // Com algum plano escolhido, duração vazia fica fora do site.
                  const ownPlans = options.some(option => form.site_plans[sitePlanKey(modalityId, option.months)]);
                  return (
                    <div key={modalityId} className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 capitalize">{modalityName(modalityId) || 'Modalidade'}</p>
                      {options.length === 0 && <p className="text-xs text-amber-600">Nenhum plano ativo nesta modalidade.</p>}
                      {options.map(option => {
                        const key = sitePlanKey(modalityId, option.months);
                        return (
                          <div key={key} className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
                            <Label className="text-sm">{option.label}</Label>
                            <Select value={form.site_plans[key] || 'default'} onValueChange={v => setSitePlan(key, v === 'default' ? '' : v)}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">{ownPlans ? 'Não vende esta duração no site' : 'Planos gerais do site'}</SelectItem>
                                {option.plans.map(plan => <SelectItem key={plan.id} value={plan.id}>{planLabel(plan)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
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
