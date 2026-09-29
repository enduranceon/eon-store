import { useEffect, useState } from 'react';
import { Plus, Pencil, Save, X, Tag, DollarSign, TrendingUp, Trash2, ArrowLeftRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AssessmentModality, AssessmentPlan, AssessmentPlanTransition, PayoutRoleModalityRate, PayoutGrowthTier } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

const ROLES = ['junior', 'pleno', 'senior'];

// ─── Modalidades ─────────────────────────────────────────────────────────────
function ModalitiesCard({ modalities, plans, refresh }) {
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');

  const open = (m) => { setEditing(m); setName(m?.name || ''); setModal(true); };

  const save = async () => {
    if (!name.trim()) return toast.error('Nome obrigatório');
    try {
      if (editing) await AssessmentModality.update(editing.id, { name: name.trim() });
      else         await AssessmentModality.create({ name: name.trim(), active: true });
      toast.success('Salvo!');
      setModal(false); refresh();
    } catch (e) { toast.error(e.message); }
  };

  const toggle = async (m) => {
    try { await AssessmentModality.update(m.id, { active: !m.active }); refresh(); }
    catch (e) { toast.error(e.message); }
  };

  const remove = async (m) => {
    // Bloqueia se houver planos vinculados (constraint RESTRICT no banco)
    const linkedPlans = plans.filter(p => p.modality_id === m.id);
    if (linkedPlans.length > 0) {
      return toast.error(
        `Impossível excluir: ${linkedPlans.length} plano${linkedPlans.length !== 1 ? 's vinculados' : ' vinculado'}. ` +
        `Exclua ou troque os planos antes (ou apenas desative a modalidade).`
      );
    }
    if (!confirm(`Excluir modalidade "${m.name}"?\n\nAs regras de repasse vinculadas também serão removidas.`)) return;
    try {
      await AssessmentModality.delete(m.id);
      toast.success('Modalidade excluída');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Tag className="w-4 h-4 text-blue-600" /> Modalidades
          </CardTitle>
          <Button size="sm" onClick={() => open(null)}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Nova
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="divide-y">
          {modalities.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">Nenhuma modalidade</p>
          )}
          {modalities.map(m => {
            const planCount = plans.filter(p => p.modality_id === m.id).length;
            return (
              <div key={m.id} className="flex items-center justify-between py-2.5">
                <div className="flex-1 min-w-0">
                  <span className={`text-sm font-medium capitalize ${!m.active ? 'text-muted-foreground line-through' : ''}`}>
                    {m.name}
                  </span>
                  {planCount > 0 && (
                    <span className="ml-2 text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full font-medium">
                      {planCount} plano{planCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => toggle(m)}
                    className={`text-xs px-2 py-0.5 rounded-full ${m.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                  >
                    {m.active ? 'Ativo' : 'Inativo'}
                  </button>
                  <button onClick={() => open(m)} className="p-1 hover:bg-gray-100 rounded text-gray-500" title="Editar">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => remove(m)}
                    className="p-1 hover:bg-red-50 rounded text-gray-400 hover:text-red-600"
                    title={planCount > 0 ? `${planCount} plano(s) vinculado(s) — desative em vez de excluir` : 'Excluir'}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{editing ? 'Editar modalidade' : 'Nova modalidade'}</DialogTitle></DialogHeader>
          <Label>Nome</Label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="ex: ciclismo" autoFocus />
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setModal(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={save}>Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Repasse base (papel × modalidade) ───────────────────────────────────────
function RatesCard({ rates, modalities, refresh }) {
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState('');

  const save = async (r) => {
    try {
      await PayoutRoleModalityRate.update(r.id, { rate: Number(value) });
      toast.success('Atualizado'); setEditing(null); refresh();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-green-600" /> Repasse base — papel × modalidade
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="text-left py-2">Papel</th>
              {modalities.filter(m => m.active !== false).map(m => (
                <th key={m.id} className="text-right py-2 capitalize">{m.name}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {ROLES.map(role => (
              <tr key={role}>
                <td className="py-2 font-semibold capitalize">{role}</td>
                {modalities.filter(m => m.active !== false).map(m => {
                  const r = rates.find(rt => rt.role === role && rt.modality_id === m.id);
                  if (!r) return <td key={m.id} className="text-right text-muted-foreground">—</td>;
                  const isEd = editing === r.id;
                  return (
                    <td key={m.id} className="text-right">
                      {isEd ? (
                        <div className="flex gap-1 justify-end">
                          <Input className="h-7 w-20 text-right" value={value} onChange={e => setValue(e.target.value)} type="number" autoFocus />
                          <button onClick={() => save(r)} className="p-1 hover:bg-green-50 rounded text-green-600"><Save className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setEditing(null)} className="p-1 hover:bg-gray-100 rounded text-gray-500"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ) : (
                        <button onClick={() => { setEditing(r.id); setValue(r.rate); }} className="hover:bg-gray-100 px-2 py-1 rounded font-mono">
                          {formatCurrency(r.rate)}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── Faixas de crescimento ────────────────────────────────────────────────────
function TiersCard({ tiers, refresh }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const open = (t) => { setEditing(t.id); setForm(t); };

  const save = async () => {
    try {
      await PayoutGrowthTier.update(editing, {
        min_athletes:          Number(form.min_athletes),
        increment_per_athlete: Number(form.increment_per_athlete),
        leadership_bonus:      Number(form.leadership_bonus),
        co_leadership_bonus:   Number(form.co_leadership_bonus),
      });
      toast.success('Atualizado'); setEditing(null); refresh();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-amber-600" /> Faixas de crescimento
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="text-left py-2">Faixa</th>
              <th className="text-right py-2">Min atletas</th>
              <th className="text-right py-2">Incremento</th>
              <th className="text-right py-2">Bônus líder</th>
              <th className="text-right py-2">Bônus co-líder</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tiers.sort((a, b) => a.min_athletes - b.min_athletes).map(t => {
              const isEd = editing === t.id;
              return (
                <tr key={t.id}>
                  <td className="py-2 font-semibold">{t.name}</td>
                  {isEd ? (
                    <>
                      <td className="text-right"><Input className="h-7 w-20 text-right" type="number" value={form.min_athletes} onChange={e => setForm(f => ({ ...f, min_athletes: e.target.value }))} /></td>
                      <td className="text-right"><Input className="h-7 w-20 text-right" type="number" step="0.01" value={form.increment_per_athlete} onChange={e => setForm(f => ({ ...f, increment_per_athlete: e.target.value }))} /></td>
                      <td className="text-right"><Input className="h-7 w-20 text-right" type="number" step="0.01" value={form.leadership_bonus} onChange={e => setForm(f => ({ ...f, leadership_bonus: e.target.value }))} /></td>
                      <td className="text-right"><Input className="h-7 w-20 text-right" type="number" step="0.01" value={form.co_leadership_bonus} onChange={e => setForm(f => ({ ...f, co_leadership_bonus: e.target.value }))} /></td>
                      <td className="text-right">
                        <button onClick={save} className="p-1 hover:bg-green-50 rounded text-green-600"><Save className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setEditing(null)} className="p-1 hover:bg-gray-100 rounded text-gray-500"><X className="w-3.5 h-3.5" /></button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="text-right">{t.min_athletes}</td>
                      <td className="text-right">{formatCurrency(t.increment_per_athlete)}</td>
                      <td className="text-right">{formatCurrency(t.leadership_bonus)}</td>
                      <td className="text-right">{formatCurrency(t.co_leadership_bonus)}</td>
                      <td className="text-right">
                        <button onClick={() => open(t)} className="p-1 hover:bg-gray-100 rounded text-gray-500">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── Trocas de plano no meio do ciclo ────────────────────────────────────────
const TRANSITION_TYPES = [
  { value: 'upgrade', label: 'Upgrade', className: 'bg-green-100 text-green-700' },
  { value: 'lateral', label: 'Lateral', className: 'bg-blue-100 text-blue-700' },
  { value: 'downgrade', label: 'Downgrade', className: 'bg-amber-100 text-amber-700' },
  { value: 'not_allowed', label: 'Não permitida', className: 'bg-gray-100 text-gray-600' },
];

const PERIOD_LABELS = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral' };

function periodLabel(months) {
  return PERIOD_LABELS[months] || `${months} meses`;
}

function planLabel(plan) {
  return `${plan.name || 'Plano sem nome'} · ${formatCurrency(plan.price_total)}${plan.active === false ? ' (inativo)' : ''}`;
}

function PlanTransitionsCard({ plans, transitions, refresh }) {
  const [fromPlanId, setFromPlanId] = useState('');
  const [saving, setSaving] = useState(null);

  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR') || Number(a.price_total) - Number(b.price_total);
  const periods = [...new Set(plans.map(p => p.period_months).filter(Boolean))].sort((a, b) => a - b);
  const origin = plans.find(p => p.id === fromPlanId) || null;
  const rows = origin
    ? transitions
      .filter(t => t.from_plan_id === origin.id)
      .map(t => ({ transition: t, target: plans.find(p => p.id === t.to_plan_id) }))
      .filter(row => row.target && row.target.period_months === origin.period_months)
      .sort((a, b) => Number(a.target.price_total) - Number(b.target.price_total) || byName(a.target, b.target))
    : [];

  const changeType = async (transition, value) => {
    setSaving(transition.id);
    try {
      await AssessmentPlanTransition.update(transition.id, { transition_type: value });
      toast.success('Tipo da troca atualizado');
      await refresh();
    } catch (e) { toast.error(e.message); }
    setSaving(null);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-violet-600" /> Trocas de plano no meio do ciclo
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Upgrade e lateral valem a partir da data escolhida; downgrade fica para a renovação; não permitida bloqueia a troca.
          O tipo começou pelo preço de hoje e o preço só define quanto cobrar.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="space-y-1">
          <Label>Plano atual do aluno</Label>
          <Select value={fromPlanId} onValueChange={setFromPlanId}>
            <SelectTrigger className="w-full sm:w-96"><SelectValue placeholder="Escolha o plano de origem" /></SelectTrigger>
            <SelectContent>
              {periods.map(months => (
                <SelectGroup key={months}>
                  <SelectLabel>{periodLabel(months)}</SelectLabel>
                  {plans.filter(p => p.period_months === months).sort(byName).map(p => (
                    <SelectItem key={p.id} value={p.id}>{planLabel(p)}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        {origin && rows.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">Nenhum outro plano no ciclo {periodLabel(origin.period_months).toLowerCase()}.</p>
        )}
        {rows.length > 0 && (
          <div className="divide-y text-sm">
            <div className="hidden sm:grid grid-cols-[1fr_auto_9rem] gap-3 pb-2 text-xs font-medium text-muted-foreground">
              <span>Para</span>
              <span className="text-right">Diferença no ciclo</span>
              <span className="text-right">Tipo</span>
            </div>
            {rows.map(({ transition, target }) => {
              const diff = Number(target.price_total) - Number(origin.price_total);
              const type = TRANSITION_TYPES.find(tp => tp.value === transition.transition_type);
              return (
                <div key={transition.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_9rem] items-center gap-x-3 gap-y-1 py-2">
                  <span className="col-span-2 sm:col-span-1">{planLabel(target)}</span>
                  <span className="font-mono whitespace-nowrap sm:text-right">
                    {diff > 0 ? '+ ' : diff < 0 ? '− ' : ''}{formatCurrency(Math.abs(diff))}
                  </span>
                  <Select
                    value={transition.transition_type}
                    onValueChange={value => changeType(transition, value)}
                    disabled={saving === transition.id}
                  >
                    <SelectTrigger className={`h-7 w-36 justify-self-end text-xs ${type?.className || ''}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRANSITION_TYPES.map(tp => (
                        <SelectItem key={tp.value} value={tp.value}>{tp.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────────
export default function Configuracoes() {
  const [modalities, setModalities] = useState([]);
  const [plans, setPlans]           = useState([]);
  const [rates, setRates]           = useState([]);
  const [tiers, setTiers]           = useState([]);
  const [transitions, setTransitions] = useState([]);

  const load = async () => {
    try {
      const [m, p, r, t, tr] = await Promise.all([
        AssessmentModality.list('name').catch(() => []),
        AssessmentPlan.list().catch(() => []),
        PayoutRoleModalityRate.list('role').catch(() => []),
        PayoutGrowthTier.list('min_athletes').catch(() => []),
        AssessmentPlanTransition.list('from_plan_id').catch(() => []),
      ]);
      setModalities(m); setPlans(p); setRates(r); setTiers(t); setTransitions(tr);
    } catch (e) {
      console.error('Erro ao carregar configurações:', e);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Configurações — Assessoria</h2>
        <p className="text-sm text-muted-foreground">Modalidades, repasses, faixas de crescimento e trocas de plano.</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ModalitiesCard modalities={modalities} plans={plans} refresh={load} />
        <RatesCard rates={rates} modalities={modalities} refresh={load} />
      </div>
      <TiersCard tiers={tiers} refresh={load} />
      <PlanTransitionsCard plans={plans} transitions={transitions} refresh={load} />
    </div>
  );
}
