import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Check, Copy, Info, Loader2, MessageCircle, Plus, Save, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DEFAULT_COMMUNICATION_RULES,
  DEFAULT_COMMUNITY_LINK,
  createCommunicationRule,
  deleteCommunicationRule,
  duplicateCommunicationRule,
  loadCommunicationConfig,
  saveCommunicationRule,
  saveCommunityLink,
} from '@/lib/communication-config';

const JOURNEY_LABEL = {
  billing: 'Cobrança',
  onboarding: 'Onboarding',
  renewal: 'Renovação',
  reactivation: 'Reativação',
};

const JOURNEY_ORDER = ['billing', 'onboarding', 'renewal', 'reactivation'];

const TRIGGER_LABEL = {
  charge_created: 'cobrança criada / venda aguardando cobrança',
  charge_due_date: 'vencimento da cobrança',
  payment_confirmed: 'pagamento confirmado',
  onboarding_welcome_sent: 'boas-vindas enviada',
  contract_end_date: 'fim do contrato',
  manual: 'manual',
};

const VARIABLES = [
  ['{nome}', 'Primeiro nome'],
  ['{nome_completo}', 'Nome completo'],
  ['{tipo}', 'pedido ou contrato'],
  ['{numero}', 'número da venda/contrato'],
  ['{valor}', 'valor da cobrança'],
  ['{item}', 'primeiro item/plano'],
  ['{itens}', 'lista de itens sem título'],
  ['{itens_bloco}', 'bloco "Itens" formatado'],
  ['{vencimento}', 'data de vencimento'],
  ['{vencimento_texto}', '", com vencimento em..."'],
  ['{vencimento_atraso}', '" em DD/MM/AAAA"'],
  ['{pix_bloco}', 'PIX copia e cola formatado'],
  ['{link_bloco}', 'link de pagamento formatado'],
  ['{plano}', 'plano contratado'],
  ['{modalidade}', 'modalidade'],
  ['{coach}', 'coach'],
  ['{comunidade}', 'link da comunidade'],
  ['{data_fim}', 'fim do contrato'],
  ['{dias}', 'dias até o fim'],
];

function timingLabel(rule) {
  const days = Number(rule.days_offset) || 0;
  if (rule.trigger_event === 'contract_end_date') {
    if (days < 0) return `${Math.abs(days)} dia${Math.abs(days) === 1 ? '' : 's'} antes`;
    if (days === 0) return 'no dia';
    return `${days} dia${days === 1 ? '' : 's'} depois`;
  }
  if (days === 0) return 'no mesmo dia';
  if (days > 0) return `${days} dia${days === 1 ? '' : 's'} depois`;
  return `${Math.abs(days)} dia${Math.abs(days) === 1 ? '' : 's'} antes`;
}

function RuleEditor({ rule, disabled, onSaved, onDeleted }) {
  const [draft, setDraft] = useState(rule);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await saveCommunicationRule(draft);
      toast.success('Regra salva');
      onSaved?.();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar regra');
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    setSaving(true);
    try {
      await duplicateCommunicationRule(draft);
      toast.success('Regra duplicada (inativa)');
      onSaved?.();
    } catch (e) {
      toast.error(e.message || 'Erro ao duplicar regra');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Excluir a regra "${draft.name}"? Esta ação não pode ser desfeita.`)) return;
    setSaving(true);
    try {
      await deleteCommunicationRule(draft.id);
      toast.success('Regra excluída');
      onDeleted?.();
    } catch (e) {
      toast.error(e.message || 'Erro ao excluir regra');
    } finally {
      setSaving(false);
    }
  };

  const set = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-blue-600" />
              {draft.name}
            </CardTitle>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant={draft.journey === 'onboarding' ? 'success' : draft.journey === 'renewal' ? 'purple' : 'info'}>
                {JOURNEY_LABEL[draft.journey] || draft.journey}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {timingLabel(draft)} de {TRIGGER_LABEL[draft.trigger_event] || draft.trigger_event}
              </span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!draft.active}
              onChange={e => set('active', e.target.checked)}
              disabled={disabled || saving}
              className="w-4 h-4 accent-blue-600"
            />
            Ativa
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_120px_120px]">
          <div>
            <Label className="text-xs">Nome</Label>
            <Input
              className="mt-1"
              value={draft.name || ''}
              onChange={e => set('name', e.target.value)}
              disabled={disabled || saving}
            />
          </div>
          <div>
            <Label className="text-xs">Dias</Label>
            <Input
              type="number"
              className="mt-1"
              value={draft.days_offset ?? 0}
              onChange={e => set('days_offset', e.target.value)}
              disabled={disabled || saving}
            />
          </div>
          <div>
            <Label className="text-xs">Ordem</Label>
            <Input
              type="number"
              className="mt-1"
              value={draft.order_index ?? 0}
              onChange={e => set('order_index', e.target.value)}
              disabled={disabled || saving}
            />
          </div>
        </div>

        <div>
          <Label className="text-xs">Template</Label>
          <Textarea
            rows={8}
            className="mt-1 font-mono text-xs leading-relaxed"
            value={draft.message_template || ''}
            onChange={e => set('message_template', e.target.value)}
            disabled={disabled || saving}
          />
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={duplicate} disabled={disabled || saving} className="gap-1.5">
              <Copy className="w-3.5 h-3.5" /> Duplicar
            </Button>
            {draft.id && (
              <Button variant="ghost" size="sm" onClick={remove} disabled={disabled || saving} className="gap-1.5 text-red-600 hover:text-red-700">
                <Trash2 className="w-3.5 h-3.5" /> Excluir
              </Button>
            )}
          </div>
          <Button onClick={save} disabled={disabled || saving} className="gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar regra
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CommunicationSettings() {
  const [loading, setLoading] = useState(true);
  const [savingLink, setSavingLink] = useState(false);
  const [creatingJourney, setCreatingJourney] = useState(null);
  const [config, setConfig] = useState({
    available: true,
    communityLink: DEFAULT_COMMUNITY_LINK,
    rules: DEFAULT_COMMUNICATION_RULES,
  });
  const [communityLink, setCommunityLink] = useState(DEFAULT_COMMUNITY_LINK);

  const load = async () => {
    setLoading(true);
    try {
      const next = await loadCommunicationConfig();
      setConfig(next);
      setCommunityLink(next.communityLink || DEFAULT_COMMUNITY_LINK);
    } catch (e) {
      toast.error(e.message || 'Erro ao carregar configurações');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (journey) => {
    setCreatingJourney(journey);
    try {
      await createCommunicationRule(journey);
      toast.success('Regra criada (inativa). Edite e ative quando estiver pronta.');
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao criar regra');
    } finally {
      setCreatingJourney(null);
    }
  };

  useEffect(() => {
    let active = true;
    loadCommunicationConfig()
      .then(next => {
        if (!active) return;
        setConfig(next);
        setCommunityLink(next.communityLink || DEFAULT_COMMUNITY_LINK);
      })
      .catch(e => {
        if (active) toast.error(e.message || 'Erro ao carregar configurações');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const groupedRules = useMemo(() => {
    return [...(config.rules || [])]
      .sort((a, b) => (Number(a.order_index) || 0) - (Number(b.order_index) || 0))
      .reduce((acc, rule) => {
        const journey = rule.journey || 'billing';
        if (!acc[journey]) acc[journey] = [];
        acc[journey].push(rule);
        return acc;
      }, {});
  }, [config.rules]);

  const saveLink = async () => {
    setSavingLink(true);
    try {
      await saveCommunityLink(communityLink);
      toast.success('Link da comunidade salvo');
      await load();
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar link');
    } finally {
      setSavingLink(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Carregando configurações...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link to="/comunicacao" className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1 mb-2">
            <ArrowLeft className="w-3.5 h-3.5" />
            Voltar para comunicação
          </Link>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-600" />
            Configurações de Comunicação
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure jornadas, prazos e mensagens usadas pela central.
          </p>
        </div>
      </div>

      {!config.available && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex gap-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            A migração de comunicação ainda não está disponível no banco. A tela mostra os padrões,
            mas para salvar é preciso aplicar a migration da Fase 2.
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-green-600" />
            Link da comunidade
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Comunidade Endurance ON</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={communityLink}
              onChange={e => setCommunityLink(e.target.value)}
              disabled={!config.available || savingLink}
              placeholder="https://chat.whatsapp.com/..."
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={saveLink} disabled={!config.available || savingLink} className="gap-1.5">
              {savingLink ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Salvar link
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-purple-600" />
            Variáveis disponíveis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {VARIABLES.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(key);
                  toast.success(`${key} copiado`);
                }}
                className="rounded-full border bg-white px-2.5 py-1 text-xs hover:bg-gray-50"
                title={label}
              >
                <span className="font-mono">{key}</span>
                <span className="text-muted-foreground ml-1">{label}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {JOURNEY_ORDER.map(journey => {
        const rules = groupedRules[journey] || [];
        return (
          <div key={journey} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
                {JOURNEY_LABEL[journey] || journey}
              </h3>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!config.available || creatingJourney === journey}
                onClick={() => handleCreate(journey)}
              >
                {creatingJourney === journey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Nova regra
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground px-1 py-2">Nenhuma regra nesta jornada ainda.</p>
            ) : rules.map(rule => (
              <RuleEditor
                key={`${rule.slug}:${rule.updated_at || ''}:${rule.active}`}
                rule={rule}
                disabled={!config.available}
                onSaved={load}
                onDeleted={load}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
