import { useState } from 'react';
import { Check, Copy, ExternalLink, Layers, Link2, Loader2, MessageCircle, Palette } from 'lucide-react';
import { toast } from 'sonner';
import { AssessmentPlan, AssessmentPlanFamily } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { defaultRevenueCenterId } from '@/lib/revenue-centers';
import { DEFAULT_DURATIONS, durationLabel, emptyFamilyForm, planLinkUrl, prepareFamilyPlans } from '@/lib/plan-families';
import { PLAN_LINK_REGIONS } from '@/lib/plan-link-form';
import { cn, formatCurrency } from '@/lib/utils';

function copyText(text, message) {
  navigator.clipboard.writeText(text)
    .then(() => toast.success(message))
    .catch(() => { window.prompt('Copie:', text); });
}

// Novo plano com as durações de uma vez (cada duração vira um plano no grupo).
export function FamilyCreateModal({ open, onOpenChange, initialModalityId, modalities, centers, onSaved }) {
  const [form, setForm] = useState(() => emptyFamilyForm(initialModalityId, defaultRevenueCenterId(centers, 'assessoria')));
  const [saving, setSaving] = useState(false);
  const setDuration = (months, field, value) => setForm(current => ({
    ...current,
    durations: { ...current.durations, [months]: { ...current.durations[months], [field]: value } },
  }));

  const save = async () => {
    const { error, family, plans } = prepareFamilyPlans(form);
    if (error) return toast.error(error);
    setSaving(true);
    try {
      const created = await AssessmentPlanFamily.create(family);
      for (const plan of plans) await AssessmentPlan.create({ ...plan, family_id: created.id });
      toast.success('Plano criado com as durações!');
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error.message || 'Não foi possível criar o plano');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers className="w-5 h-5 text-blue-600" /> Novo plano</DialogTitle>
        </DialogHeader>
        <fieldset className="space-y-4" disabled={saving}>
          <div>
            <Label>Modalidade *</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {modalities.filter(m => m.active !== false).map(m => (
                <button key={m.id} type="button" onClick={() => setForm(current => ({ ...current, modality_id: m.id }))}
                  className={cn('px-3 py-1.5 rounded-lg border-2 text-sm font-medium capitalize transition-all',
                    form.modality_id === m.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-blue-300 text-gray-600')}>
                  {form.modality_id === m.id && <Check className="w-3 h-3 inline mr-1" />}{m.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label htmlFor="family-name">Nome do plano *</Label>
            <Input id="family-name" className="mt-1" maxLength={120} placeholder="ex.: Corrida - Essencial"
              value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} />
            <p className="text-xs text-muted-foreground mt-1">Cada duração ganha o nome com o período no fim, como “{form.name.trim() || 'Corrida - Essencial'} - Mensal”.</p>
          </div>

          <div className="space-y-2">
            <Label>Durações e valores</Label>
            {DEFAULT_DURATIONS.map(months => {
              const duration = form.durations[months];
              const total = Number(String(duration.total).replace(',', '.'));
              return (
                <div key={months} className={cn('grid grid-cols-[minmax(0,1fr)_7rem_4.5rem] items-end gap-2 rounded-xl border p-2.5', !duration.enabled && 'opacity-60')}>
                  <label className="flex items-center gap-2 self-center text-sm font-medium">
                    <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={duration.enabled}
                      onChange={event => setDuration(months, 'enabled', event.target.checked)} />
                    <span>
                      {durationLabel(months)}
                      {duration.enabled && total > 0 && months > 1 && (
                        <span className="block text-[11px] font-normal text-muted-foreground">{formatCurrency(total / months)}/mês</span>
                      )}
                    </span>
                  </label>
                  <div>
                    <Label htmlFor={`family-total-${months}`} className="text-[11px] text-muted-foreground">Total (R$)</Label>
                    <Input id={`family-total-${months}`} inputMode="decimal" disabled={!duration.enabled}
                      value={duration.total} onChange={event => setDuration(months, 'total', event.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor={`family-installments-${months}`} className="text-[11px] text-muted-foreground">Até (x)</Label>
                    <Input id={`family-installments-${months}`} type="number" min="1" max="12" disabled={!duration.enabled}
                      value={duration.installments} onChange={event => setDuration(months, 'installments', event.target.value)} />
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <Label htmlFor="family-fee">Matrícula (R$)</Label>
            <Input id="family-fee" inputMode="decimal" className="mt-1" value={form.enrollment_fee}
              onChange={event => setForm(current => ({ ...current, enrollment_fee: event.target.value }))} />
            <p className="text-xs text-muted-foreground mt-1">Vale para todas as durações. Use 0 para plano sem matrícula.</p>
          </div>

          <div>
            <Label className="flex items-center gap-1.5"><Palette className="w-3.5 h-3.5" /> Centro de receita</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {centers.filter(c => c.active !== false).map(c => (
                <button key={c.id} type="button" onClick={() => setForm(current => ({ ...current, revenue_center_id: c.id }))}
                  className={cn('px-3 py-1.5 rounded-lg border-2 text-xs font-medium transition-all flex items-center gap-1.5',
                    form.revenue_center_id === c.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-blue-300 text-gray-600')}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />{c.name}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-lg border bg-gray-50 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-green-600" checked={form.available_online}
              onChange={event => setForm(current => ({ ...current, available_online: event.target.checked }))} />
            <span><b>Aparece no site</b><br /><span className="text-xs text-muted-foreground">Sem marcar, o plano fica para venda interna e pelo link do WhatsApp.</span></span>
          </label>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={save}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Check className="w-4 h-4 mr-1.5" />} Criar plano
            </Button>
          </div>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}

// Nome do grupo, grupo ativo e link ligado ou desligado.
export function FamilyEditModal({ family, onOpenChange, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: family?.name || '', active: family?.active !== false, link_enabled: family?.link_enabled !== false,
  }));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (form.name.trim().length < 2) return toast.error('Dê um nome ao plano');
    setSaving(true);
    try {
      await AssessmentPlanFamily.update(family.id, { name: form.name.trim(), active: form.active, link_enabled: form.link_enabled });
      toast.success('Plano atualizado');
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error.message || 'Não foi possível salvar');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={Boolean(family)} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Editar plano</DialogTitle></DialogHeader>
        <fieldset className="space-y-4" disabled={saving}>
          <div>
            <Label htmlFor="family-edit-name">Nome</Label>
            <Input id="family-edit-name" className="mt-1" maxLength={120} value={form.name}
              onChange={event => setForm(current => ({ ...current, name: event.target.value }))} />
            <p className="text-xs text-muted-foreground mt-1">Muda só o nome do grupo; o nome de cada duração se edita nela.</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-green-600" checked={form.link_enabled}
              onChange={event => setForm(current => ({ ...current, link_enabled: event.target.checked }))} />
            <span><b>Link do WhatsApp ligado</b><br /><span className="text-xs text-muted-foreground">Desligado, quem abrir um link já enviado vê que ele não está mais ativo.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-blue-600" checked={form.active}
              onChange={event => setForm(current => ({ ...current, active: event.target.checked }))} />
            <span><b>Grupo ativo</b><br /><span className="text-xs text-muted-foreground">Desativar o grupo desliga o link, mas não as durações: para parar de vender, desative cada duração.</span></span>
          </label>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={save}>{saving && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />} Salvar</Button>
          </div>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}

// Link para mandar no WhatsApp, com ou sem coach escolhido.
export function PlanLinkModal({ family, coaches, hasEnrollmentFee = false, onOpenChange }) {
  const [coachId, setCoachId] = useState('');
  const [region, setRegion] = useState('');
  const [withoutFee, setWithoutFee] = useState(false);
  if (!family) return null;
  const choices = coaches.filter(coach => coach.active && (coach.modality_ids || []).includes(family.modality_id));
  const coach = choices.find(item => item.id === coachId);
  // O link sem matrícula tem outro segredo: a taxa não sai mexendo no endereço.
  const token = withoutFee && family.link_token_no_fee ? family.link_token_no_fee : family.link_token;
  const url = planLinkUrl(window.location.origin, token, { coach: coachId, region });
  const message = `Oi! Para começar no plano ${family.name}${coach ? ` com ${coach.name}` : ''}, é só escolher a duração e preencher seus dados aqui: ${url}`;
  return (
    <Dialog open={Boolean(family)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Link2 className="w-5 h-5 text-green-600" /> Link do plano para WhatsApp</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p>
            <b>{family.name}</b>: a pessoa escolhe a duração, preenche os dados e já cai no quadro de Prospects como “Novo”.
          </p>
          <div>
            <Label htmlFor="plan-link-coach-choice">Treinador</Label>
            <select id="plan-link-coach-choice" className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={coachId} onChange={event => setCoachId(event.target.value)}>
              <option value="">Sem coach: a pessoa escolhe</option>
              {choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="plan-link-region-choice">Onde vai treinar</Label>
            <select id="plan-link-region-choice" className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={region} onChange={event => setRegion(event.target.value)}>
              <option value="">A pessoa escolhe</option>
              {Object.entries(PLAN_LINK_REGIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {hasEnrollmentFee && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-green-600" checked={withoutFee}
                onChange={event => setWithoutFee(event.target.checked)} />
              <span><b>Sem taxa de matrícula</b><br /><span className="text-xs text-muted-foreground">A pessoa não vê a matrícula e o prospect chega sem ela.</span></span>
            </label>
          )}
          <Input readOnly value={url} onFocus={event => event.target.select()} aria-label="Link do plano" />
          <div className="flex flex-wrap gap-2">
            <Button className="bg-green-600 hover:bg-green-700" onClick={() => copyText(url, 'Link copiado!')}>
              <Copy className="w-4 h-4 mr-1.5" /> Copiar link
            </Button>
            <Button variant="outline" onClick={() => copyText(message, 'Mensagem com o link copiada!')}>
              <MessageCircle className="w-4 h-4 mr-1.5" /> Copiar com mensagem
            </Button>
            <Button asChild variant="ghost">
              <a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4 mr-1.5" /> Abrir</a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            O link vale enquanto o plano e o link estiverem ligados. Quem preencher entra como prospect; o pagamento continua pelo caminho de sempre (proposta e cobrança no quadro).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
