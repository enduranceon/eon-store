import { useState } from 'react';
import { Plus, Pencil, Check, BadgeDollarSign, Clock, Palette, Link2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AssessmentModality, AssessmentPlan, RevenueCenter } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

function getPlanMonths(plan) {
  return plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
}

function periodLabel(months) {
  const n = Number(months);
  if (n === 1)  return '1 mês';
  if (n === 12) return '12 meses (Anual)';
  return `${n} meses`;
}

function autoPlanName(plan, modalities) {
  if (plan?.name?.trim()) return plan.name;
  const mod = modalities.find(m => m.id === plan?.modality_id);
  return `${mod?.name || 'Plano'} · ${periodLabel(getPlanMonths(plan))}`;
}

async function loadPlansPage() {
  const [modalities, plans, centers] = await Promise.all([
    AssessmentModality.list('name').catch(error => {
      console.error('modalities:', error);
      return [];
    }),
    AssessmentPlan.list().catch(error => {
      console.error('plans:', error);
      return [];
    }),
    RevenueCenter.list('name').catch(error => {
      console.error('centers:', error);
      return [];
    }),
  ]);
  return { modalities, plans, centers };
}

// ─── Card visual de plano ─────────────────────────────────────────────────────
function PlanCard({ plan, modality, center, modalities, onEdit, onToggle }) {
  const months = getPlanMonths(plan);
  return (
    <div className={`relative rounded-2xl border-2 p-4 transition-all ${
      plan.active
        ? 'border-blue-200 bg-white shadow-sm hover:shadow-md hover:border-blue-300'
        : 'border-gray-100 bg-gray-50 opacity-60'
    }`}>
      <button
        onClick={() => onToggle(plan)}
        className={`absolute top-3 right-3 text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
          plan.active
            ? 'bg-green-100 text-green-700 hover:bg-green-200'
            : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
        }`}
      >
        {plan.active ? 'Ativo' : 'Inativo'}
      </button>

      <div className="pr-14">
        <p className="text-xs font-bold uppercase tracking-wide text-blue-600 mb-0.5 capitalize">
          {modality?.name || '—'}
        </p>
        <p className="text-base font-bold text-gray-900 leading-tight">
          {autoPlanName(plan, modalities)}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
          <Clock className="w-3 h-3" /> {periodLabel(months)}
        </p>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Mensalidade</span>
          <span className="text-sm font-bold text-blue-700">
            {formatCurrency(plan.price_monthly)}<span className="font-normal text-muted-foreground">/mês</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Total</span>
          <span className="text-sm font-semibold">{formatCurrency(plan.price_total)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Parcelas</span>
          <span className="text-sm text-gray-700">até {plan.max_installments}x</span>
        </div>
        {Number(plan.enrollment_fee) > 0 && (
          <div className="flex items-center justify-between pt-1 border-t">
            <span className="text-xs text-amber-700 flex items-center gap-1">
              <BadgeDollarSign className="w-3.5 h-3.5" /> Matrícula
            </span>
            <span className="text-xs font-semibold text-amber-700">{formatCurrency(plan.enrollment_fee)}</span>
          </div>
        )}
        {center && (
          <div className="flex items-center gap-1.5 pt-1 border-t">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: center.color }} />
            <span className="text-[11px] text-muted-foreground">{center.name}</span>
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onEdit(plan)}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg py-1.5 transition-colors border border-transparent hover:border-blue-100"
        >
          <Pencil className="w-3 h-3" /> Editar
        </button>
        <button
          onClick={() => {
            const url = `${window.location.origin}/assinar/${plan.id}`;
            navigator.clipboard.writeText(url).then(() => toast.success('Link copiado!')).catch(() => {
              prompt('Copie o link:', url);
            });
          }}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-green-600 hover:bg-green-50 rounded-lg py-1.5 transition-colors border border-transparent hover:border-green-100"
        >
          <Link2 className="w-3 h-3" /> Copiar link
        </button>
      </div>
    </div>
  );
}

// ─── Modal criar/editar plano ─────────────────────────────────────────────────
function PlanModal({ open, onOpenChange, editing, modalities, centers, onSaved }) {
  const blank = {
    name: '', modality_id: '', period_months: 1, price_monthly: '',
    price_total: '', max_installments: 1, enrollment_fee: 0,
    revenue_center_id: centers.find(c => c.name?.includes('Mensalidades'))?.id || '',
    active: true,
  };
  const [form, setForm] = useState(() => {
    if (editing?.id) return { ...editing, period_months: getPlanMonths(editing) };
    if (editing?.modality_id) return { ...blank, modality_id: editing.modality_id };
    return blank;
  });

  // Auto-cálculo do total: mensalidade × duração (só preenche se total estiver vazio ou batendo)
  const recalcTotal = (prev, newMonthly, newMonths) => {
    const monthly = Number(newMonthly) || 0;
    const months  = Number(newMonths)  || 1;
    const previousTotal   = Number(prev.price_total)   || 0;
    const previousMonthly = Number(prev.price_monthly) || 0;
    const previousMonths  = Number(prev.period_months) || 1;
    // Se o total atual ainda bate com mensal × meses anterior → atualiza automaticamente
    // Senão preserva o que o usuário digitou
    const wasAutoCalculated = previousTotal === previousMonthly * previousMonths || previousTotal === 0;
    return wasAutoCalculated ? (monthly * months).toFixed(2) : prev.price_total;
  };

  const setMonthly = (val) => {
    setForm(prev => ({
      ...prev,
      price_monthly: val,
      price_total:   recalcTotal(prev, val, prev.period_months),
    }));
  };

  const setMonths = (val) => {
    const m = Math.min(Math.max(Number(val) || 1, 1), 12);
    setForm(prev => ({
      ...prev,
      period_months: val,
      // Auto-default: parcelamento = duração (se ainda no padrão)
      max_installments: (Number(prev.max_installments) === getPlanMonths(prev) || !prev.max_installments)
        ? m
        : prev.max_installments,
      // Auto-recalcula total
      price_total: recalcTotal(prev, prev.price_monthly, val),
    }));
  };

  const save = async () => {
    const months = Math.min(Math.max(Number(form.period_months) || 1, 1), 12);
    // Mapeia para o nome legado (backward compat — algumas telas ainda leem plan.period)
    const legacyPeriod = { 1: 'mensal', 3: 'trimestral', 6: 'semestral', 12: 'anual' }[months] || `${months}m`;
    const payload = {
      name:              form.name?.trim() || null,
      modality_id:       form.modality_id,
      period:            legacyPeriod,
      period_months:     months,
      price_monthly:     Number(form.price_monthly),
      price_total:       Number(form.price_total),
      max_installments:  Number(form.max_installments) || 1,
      enrollment_fee:    Number(form.enrollment_fee) || 0,
      revenue_center_id: form.revenue_center_id || null,
      active:            !!form.active,
    };
    if (!payload.modality_id)                                   return toast.error('Selecione a modalidade');
    if (payload.price_monthly <= 0 || payload.price_total <= 0) return toast.error('Preencha mensalidade e total');
    try {
      if (editing?.id) await AssessmentPlan.update(editing.id, payload);
      else             await AssessmentPlan.create(payload);
      toast.success('Plano salvo!');
      onOpenChange(false);
      onSaved();
    } catch (e) { toast.error(e.message); }
  };

  const f = (key, val) => setForm(prev => ({ ...prev, [key]: val }));
  const months = Number(form.period_months) || 1;
  const selectedMod = modalities.find(m => m.id === form.modality_id);
  const autoNameSuggestion = selectedMod ? `${selectedMod.name} · ${periodLabel(months)}` : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing?.id ? 'Editar plano' : 'Novo plano'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">

          {/* Modalidade */}
          <div>
            <Label>Modalidade *</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {modalities.filter(m => m.active !== false).map(m => (
                <button key={m.id} type="button" onClick={() => f('modality_id', m.id)}
                  className={`px-3 py-1.5 rounded-lg border-2 text-sm font-medium capitalize transition-all ${
                    form.modality_id === m.id
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-blue-300 text-gray-600'
                  }`}>
                  {form.modality_id === m.id && <Check className="w-3 h-3 inline mr-1" />}
                  {m.name}
                </button>
              ))}
              {modalities.filter(m => m.active !== false).length === 0 && (
                <p className="text-sm text-muted-foreground">Nenhuma modalidade. Crie em Configurações → Assessoria.</p>
              )}
            </div>
          </div>

          {/* Nome */}
          <div>
            <Label>Nome do plano</Label>
            <Input value={form.name || ''} onChange={e => f('name', e.target.value)}
              placeholder={autoNameSuggestion || 'ex: Plano Trail Runner'} className="mt-1" />
            <p className="text-xs text-muted-foreground mt-1">
              Deixe em branco para gerar automaticamente: <strong>{autoNameSuggestion || '—'}</strong>
            </p>
          </div>

          {/* Duração + Parcelas (lado a lado) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Duração (meses) *</Label>
              <Input type="number" min="1" max="12" className="mt-1"
                value={form.period_months ?? 1} onChange={e => setMonths(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">{periodLabel(months)}</p>
            </div>
            <div>
              <Label>Parcelas máx (até Nx)</Label>
              <Input type="number" min="1" className="mt-1"
                value={form.max_installments || 1} onChange={e => f('max_installments', e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">
                Sugestão: <strong>{months}x</strong>
              </p>
            </div>
          </div>

          {/* Preços */}
          <div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Mensalidade (R$) *</Label>
                <Input type="number" step="0.01" min="0" className="mt-1"
                  value={form.price_monthly || ''} onChange={e => setMonthly(e.target.value)} />
                <p className="text-[11px] text-muted-foreground mt-1">Valor "vitrine" exibido por mês</p>
              </div>
              <div>
                <Label>Total (R$) *</Label>
                <Input type="number" step="0.01" min="0" className="mt-1"
                  value={form.price_total || ''} onChange={e => f('price_total', e.target.value)} />
                {Number(form.price_monthly) > 0 && Number(form.period_months) > 0 && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Sugestão: <strong>{formatCurrency(Number(form.price_monthly) * Number(form.period_months))}</strong>
                    {Number(form.price_total) !== Number(form.price_monthly) * Number(form.period_months) && (
                      <button type="button"
                        onClick={() => f('price_total', (Number(form.price_monthly) * Number(form.period_months)).toFixed(2))}
                        className="ml-1.5 text-blue-600 hover:underline">
                        usar
                      </button>
                    )}
                  </p>
                )}
              </div>
            </div>
            {/* Aviso de desconto */}
            {Number(form.price_monthly) > 0 && Number(form.period_months) > 0 && Number(form.price_total) > 0 && (() => {
              const sugerido = Number(form.price_monthly) * Number(form.period_months);
              const diff = sugerido - Number(form.price_total);
              if (Math.abs(diff) < 0.01) return null;
              if (diff > 0) return (
                <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-2.5 py-1.5 mt-2">
                  💚 Desconto de <strong>{formatCurrency(diff)}</strong> ({((diff / sugerido) * 100).toFixed(1)}%) no plano completo
                </p>
              );
              return (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
                  ⚠ Total ({formatCurrency(form.price_total)}) é maior que mensalidade × duração ({formatCurrency(sugerido)}). Verifique se está correto.
                </p>
              );
            })()}
          </div>

          {/* Matrícula */}
          <div>
            <Label>Taxa de matrícula (R$)</Label>
            <Input type="number" step="0.01" min="0" className="mt-1" placeholder="0,00"
              value={form.enrollment_fee ?? 0} onChange={e => f('enrollment_fee', e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">
              Cobrada apenas em novos contratos. Renovações automáticas não cobram.
            </p>
          </div>

          {/* Centro de receita */}
          <div>
            <Label className="flex items-center gap-1.5">
              <Palette className="w-3.5 h-3.5" /> Centro de receita
            </Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {centers.filter(c => c.active !== false).map(c => (
                <button key={c.id} type="button" onClick={() => f('revenue_center_id', c.id)}
                  className={`px-3 py-1.5 rounded-lg border-2 text-xs font-medium transition-all flex items-center gap-1.5 ${
                    form.revenue_center_id === c.id
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-blue-300 text-gray-600'
                  }`}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
                  {c.name}
                </button>
              ))}
              {centers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nenhum centro cadastrado. Crie em Configurações → Centros de receita.
                </p>
              )}
            </div>
          </div>

          {/* Ativo */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!form.active}
              onChange={e => f('active', e.target.checked)}
              className="w-4 h-4 accent-blue-600" />
            <span className="text-sm">Plano ativo (disponível para venda)</span>
          </label>

          {/* Ações */}
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={save}>
              <Check className="w-3.5 h-3.5 mr-1.5" /> Salvar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────────
export default function Planos() {
  const {
    data: { modalities, plans, centers },
    loading,
    refresh,
  } = usePageData({
    key: 'assessment-plans:list',
    loader: loadPlansPage,
    initialData: { modalities: [], plans: [], centers: [] },
    tags: ['assessment_modalities', 'assessment_plans', 'revenue_centers'],
    onError: error => toast.error('Erro ao carregar dados: ' + (error.message || 'desconhecido')),
  });
  const [showInactive, setShowInactive] = useState(false);
  const [modal, setModal]           = useState(false);
  const [editing, setEditing]       = useState(null);

  const openCreate = (preModalityId) => {
    setEditing(preModalityId ? { modality_id: preModalityId } : null);
    setModal(true);
  };
  const openEdit = (plan) => { setEditing(plan); setModal(true); };

  const toggle = async (plan) => {
    try {
      await AssessmentPlan.update(plan.id, { active: !plan.active });
      await refresh({ force: true });
    }
    catch (e) { toast.error(e.message); }
  };

  const plansByModality = modalities
    .filter(m => m.active !== false)
    .map(m => ({
      modality: m,
      plans: plans.filter(p => p.modality_id === m.id && (showInactive || p.active)),
    }));

  const totalActive   = plans.filter(p => p.active).length;
  const totalInactive = plans.filter(p => !p.active).length;

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Planos</h2>
          <p className="text-sm text-muted-foreground">
            {totalActive} plano{totalActive !== 1 ? 's' : ''} ativo{totalActive !== 1 ? 's' : ''}
            {totalInactive > 0 && ` · ${totalInactive} inativo${totalInactive !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {totalInactive > 0 && (
            <button onClick={() => setShowInactive(v => !v)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                showInactive ? 'bg-gray-100 border-gray-300 text-gray-700' : 'border-gray-200 text-muted-foreground hover:bg-gray-50'
              }`}>
              {showInactive ? 'Ocultar inativos' : 'Mostrar inativos'}
            </button>
          )}
          <Button onClick={() => openCreate(null)}>
            <Plus className="w-4 h-4 mr-1.5" /> Novo plano
          </Button>
        </div>
      </div>

      {plansByModality.map(({ modality, plans: mPlans }) => (
        <div key={modality.id}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground capitalize">
              {modality.name}
            </h3>
            <button onClick={() => openCreate(modality.id)}
              className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              <Plus className="w-3 h-3" /> Adicionar plano
            </button>
          </div>

          {mPlans.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 py-8 text-center">
              <p className="text-sm text-muted-foreground">Nenhum plano ativo nessa modalidade.</p>
              <button onClick={() => openCreate(modality.id)} className="mt-2 text-sm text-blue-600 hover:underline">
                + Criar primeiro plano
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {mPlans
                .sort((a, b) => getPlanMonths(a) - getPlanMonths(b))
                .map(p => (
                  <PlanCard key={p.id} plan={p} modality={modality}
                    center={centers.find(c => c.id === p.revenue_center_id)}
                    modalities={modalities}
                    onEdit={openEdit} onToggle={toggle} />
                ))}
            </div>
          )}
        </div>
      ))}

      {plansByModality.length === 0 && (
        <Card>
          <CardContent className="py-16 text-center">
            <Clock className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">Nenhuma modalidade ativa.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Crie modalidades em <strong>Configurações → Assessoria</strong> primeiro.
            </p>
          </CardContent>
        </Card>
      )}

      <PlanModal
        key={`${modal ? 'open' : 'closed'}:${editing?.id || editing?.modality_id || 'new'}`}
        open={modal}
        onOpenChange={setModal}
        editing={editing}
        modalities={modalities}
        centers={centers}
        onSaved={() => refresh({ force: true })}
      />
    </div>
  );
}
