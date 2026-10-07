import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Check, Copy, History, Loader2, MessageCircle, Plus, Save, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  getCommunicationModels,
  listCommunicationModelVersions,
  publishCommunicationDraft,
  saveCommunicationDraft,
  simulateCommunicationDraft,
} from '@/api/client';
import { DEFAULT_COMMUNITY_LINK, loadCommunicationConfig, saveCommunityLink } from '@/lib/communication-config';
import { communicationBlockReasonLabel } from '@/lib/communication-case';
import { formatDateTime } from '@/lib/utils';

const JOURNEY_LABEL = {
  billing: 'Cobranças',
  onboarding: 'Boas-vindas',
  renewal: 'Renovações',
  reactivation: 'Reativação',
};
const JOURNEY_ORDER = ['billing', 'onboarding', 'renewal'];
const TASK_KIND_LABEL = {
  charge_send: 'Preparar cobrança',
  charge_overdue: 'Acompanhar saldo pendente',
  onboarding_welcome: 'Boas-vindas após pagamento',
  onboarding_checkin: 'Check-in inicial',
  onboarding_feedback: 'Feedback de 20 dias',
  renewal_reminder: 'Conversar sobre renovação',
};

const MODEL_STAGES = {
  billing: [
    { key: 'initial', label: 'Cobrança inicial', trigger_event: 'charge_created', task_kind: 'charge_send', offsets: [[0, 'Ao cadastrar cobrança']] },
    { key: 'pre_due', label: 'Lembrete antes ou no vencimento', trigger_event: 'charge_due_date', task_kind: 'charge_send', offsets: [[-1, 'D−1 · véspera'], [0, 'D0 · vencimento']] },
    { key: 'overdue', label: 'Saldo em atraso', trigger_event: 'charge_due_date', task_kind: 'charge_overdue', offsets: [[3, 'D+3'], [5, 'D+5'], [7, 'D+7'], [8, 'D+8 em diante · revisão diária']] },
  ],
  onboarding: [
    { key: 'welcome', label: 'Boas-vindas após pagamento', trigger_event: 'payment_confirmed', task_kind: 'onboarding_welcome', offsets: [[0, 'Após pagamento']] },
    { key: 'checkin', label: 'Check-in inicial', trigger_event: 'onboarding_welcome_sent', task_kind: 'onboarding_checkin', offsets: [[5, 'D+5 após boas-vindas']] },
    { key: 'feedback', label: 'Feedback de 20 dias', trigger_event: 'onboarding_welcome_sent', task_kind: 'onboarding_feedback', offsets: [[20, 'D+20 após boas-vindas']] },
  ],
  renewal: [
    { key: 'renewal', label: 'Contato de renovação', trigger_event: 'contract_end_date', task_kind: 'renewal_reminder', offsets: [[-10, 'D−10 antes do fim']] },
  ],
};

function modelStage(rule) {
  return (MODEL_STAGES[rule.journey] || []).find(stage => (
    stage.trigger_event === rule.trigger_event && stage.task_kind === rule.task_kind
  ));
}

function isCurrentStage(rule) {
  const stage = modelStage(rule);
  return Boolean(stage && stage.offsets.some(([offset]) => offset === Number(rule.days_offset)));
}

function copyRule(rule) {
  return {
    slug: rule.slug || '',
    name: rule.name || '',
    journey: rule.journey || 'billing',
    trigger_event: rule.trigger_event || 'manual',
    task_kind: rule.task_kind || 'charge_send',
    channel: rule.channel || 'whatsapp',
    active: rule.active !== false,
    days_offset: Number(rule.days_offset) || 0,
    order_index: Number(rule.order_index) || 0,
    message_template: rule.message_template || '',
  };
}

function newSlug(base) {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10);
  return `${base}-${suffix}`;
}

function savedDraftRecord(value) {
  return value?.draft || value || {};
}

function initialDraftRule(savedDraft, rule) {
  return copyRule(savedDraft?.rule || savedDraft?.proposed_rule || savedDraft?.payload?.rule || rule);
}

function SimulationResults({ simulation }) {
  if (!simulation) return null;
  return (
    <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
      <div>
        <p className="font-semibold text-blue-900">Simulação com dados fictícios</p>
        <p className="text-xs text-blue-800">
          {simulation.affected_open_cases == null
            ? 'Impacto em casos abertos não informado.'
            : `Casos abertos dessa finalidade: ${simulation.affected_open_cases}.`}
          {' '}Nenhuma mensagem foi enviada.
        </p>
        {simulation.scope_note && <p className="mt-1 text-xs text-blue-800">{simulation.scope_note}</p>}
      </div>
      {Array.isArray(simulation.warnings) && simulation.warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
          <p className="font-semibold">Avisos</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {simulation.warnings.map((warning, index) => <li key={index}>{typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)}</li>)}
          </ul>
        </div>
      )}
      {Array.isArray(simulation.scenarios) && simulation.scenarios.map((scenario, index) => (
        <div key={index} className="rounded-md border bg-white p-2">
          <p className="font-semibold">{scenario.label || `Cenário ${index + 1}`}</p>
          {(scenario.blocked_reason || scenario.expected_action) && (
            <p className="mt-1 text-xs text-muted-foreground">
              Ação: {scenario.blocked_reason
                ? `Contato bloqueado: ${communicationBlockReasonLabel(scenario.blocked_reason)}`
                : scenario.expected_action}
            </p>
          )}
          {scenario.message && <p className="mt-2 whitespace-pre-wrap text-xs text-gray-800">{scenario.message}</p>}
        </div>
      ))}
      <p className={simulation.can_publish ? 'font-medium text-green-800' : 'font-medium text-amber-900'}>
        {simulation.can_publish ? 'Pronto para publicação após sua revisão.' : 'Publicação bloqueada; revise os avisos e simule novamente.'}
      </p>
    </div>
  );
}

function RuleEditor({ rule, savedDraft, isNew = false, onPublished, onDraftSaved, onCancelNew, onDuplicate }) {
  const [draft, setDraft] = useState(() => initialDraftRule(savedDraft, rule));
  const [dirty, setDirty] = useState(false);
  const [draftId, setDraftId] = useState(savedDraft?.id || null);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState(savedDraft?.updated_at || null);
  const [simulation, setSimulation] = useState(null);
  const [working, setWorking] = useState('');
  const [versions, setVersions] = useState(null);
  const [versionsCursor, setVersionsCursor] = useState(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [error, setError] = useState('');
  const stage = modelStage(draft);
  const stages = MODEL_STAGES[draft.journey] || [];

  const setField = (field, value) => {
    setDraft(current => ({ ...current, [field]: value }));
    setDirty(true);
    setSimulation(null);
  };

  const setStage = (key) => {
    const nextStage = stages.find(candidate => candidate.key === key);
    if (!nextStage) return;
    setDraft(current => ({
      ...current,
      trigger_event: nextStage.trigger_event,
      task_kind: nextStage.task_kind,
      days_offset: nextStage.offsets[0][0],
    }));
    setDirty(true);
    setSimulation(null);
  };

  const saveDraft = async () => {
    if (!draft.name.trim() || !draft.message_template.trim()) {
      return toast.error('Preencha nome e texto do modelo');
    }
    setWorking('save');
    setError('');
    try {
      const saved = savedDraftRecord(await saveCommunicationDraft({
        rule_id: isNew ? null : rule.id,
        base_version: isNew ? 0 : Number(rule.template_version) || 1,
        rule: {
          ...draft,
          days_offset: Number(draft.days_offset) || 0,
          order_index: Number(draft.order_index) || 0,
        },
      }));
      setDraftId(saved.id);
      setDraftUpdatedAt(saved.updated_at);
      setDirty(false);
      setSimulation(null);
      toast.success('Rascunho salvo. O modelo publicado ainda não mudou.');
      onDraftSaved?.();
    } catch (cause) {
      setError(cause?.message || 'Não foi possível salvar o rascunho.');
    } finally {
      setWorking('');
    }
  };

  const simulate = async () => {
    if (!draftId || dirty) return toast.error('Salve o rascunho antes de simular');
    setWorking('simulate');
    setError('');
    try {
      setSimulation(await simulateCommunicationDraft(draftId));
    } catch (cause) {
      setError(cause?.message || 'Não foi possível simular o rascunho.');
    } finally {
      setWorking('');
    }
  };

  const publish = async () => {
    if (!draftId || dirty || !simulation?.can_publish || !simulation?.simulation_fingerprint) {
      return toast.error('Salve e simule a versão atual antes de publicar');
    }
    setWorking('publish');
    setError('');
    try {
      await publishCommunicationDraft(draftId, {
        expected_updated_at: draftUpdatedAt,
        simulation_fingerprint: simulation.simulation_fingerprint,
      });
      toast.success('Modelo publicado com versão registrada.');
      onPublished?.();
    } catch (cause) {
      setError(cause?.message || 'Não foi possível publicar. Recarregue e simule novamente.');
      setSimulation(null);
    } finally {
      setWorking('');
    }
  };

  const loadVersions = async ({ cursor = null, append = false } = {}) => {
    if (!rule.id) return;
    setVersionsLoading(true);
    try {
      const page = await listCommunicationModelVersions(rule.id, { cursor: cursor || undefined, limit: 20 });
      setVersions(current => append ? [...(current || []), ...(page.items || [])] : (page.items || []));
      setVersionsCursor(page.next_cursor || null);
    } catch (cause) {
      setError(cause?.message || 'Não foi possível carregar as versões.');
    } finally {
      setVersionsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{isNew ? 'Novo modelo em rascunho' : rule.name}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {JOURNEY_LABEL[draft.journey] || draft.journey} · {stage?.label || TASK_KIND_LABEL[draft.task_kind] || 'Modelo de contato'}
              {!isNew && ` · versão publicada ${rule.template_version || 1}`}
            </p>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={event => setField('active', event.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
            Modelo ativo
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {draftId && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            Rascunho {dirty ? 'com mudanças ainda não salvas' : 'salvo'}. Salvar não publica; é preciso simular e confirmar a publicação.
          </p>
        )}
        {isNew && (
          <div>
            <Label htmlFor={`model-stage-${draft.slug}`}>Etapa deste texto</Label>
            <select
              id={`model-stage-${draft.slug}`}
              value={stage?.key || ''}
              onChange={event => setStage(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-md border bg-white px-3 text-sm"
            >
              {stages.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(210px,0.8fr)_110px]">
          <div>
            <Label htmlFor={`model-name-${draft.slug}`}>Nome</Label>
            <Input id={`model-name-${draft.slug}`} value={draft.name} onChange={event => setField('name', event.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor={`model-days-${draft.slug}`}>Quando usar</Label>
            <select
              id={`model-days-${draft.slug}`}
              value={draft.days_offset}
              onChange={event => setField('days_offset', Number(event.target.value))}
              className="mt-1 min-h-11 w-full rounded-md border bg-white px-2 text-sm"
            >
              {stage?.offsets.map(([offset, label]) => <option key={offset} value={offset}>{label}</option>)}
              {!stage?.offsets.some(([offset]) => offset === Number(draft.days_offset)) && (
                <option value={draft.days_offset} disabled>Fora da régua ({draft.days_offset})</option>
              )}
            </select>
          </div>
          <div>
            <Label htmlFor={`model-order-${draft.slug}`}>Ordem</Label>
            <Input id={`model-order-${draft.slug}`} type="number" value={draft.order_index} onChange={event => setField('order_index', event.target.value)} className="mt-1" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          O texto é escolhido pela etapa e pelo marco. Entre modelos ativos da mesma etapa, a menor ordem tem prioridade.
          {draft.journey === 'billing' && ' A cadência de D+3, D+5, D+7 e revisão diária permanece fixa.'}
        </p>
        <div>
          <Label htmlFor={`model-template-${draft.slug}`}>Texto sugerido</Label>
          <Textarea
            id={`model-template-${draft.slug}`}
            rows={8}
            value={draft.message_template}
            onChange={event => setField('message_template', event.target.value)}
            className="mt-1 font-mono text-xs leading-relaxed"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={saveDraft} disabled={Boolean(working)} className="min-h-11 gap-2">
            {working === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvar rascunho
          </Button>
          <Button type="button" variant="outline" onClick={simulate} disabled={Boolean(working) || !draftId || dirty} className="min-h-11">
            {working === 'simulate' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Simular
          </Button>
          <Button type="button" onClick={publish} disabled={Boolean(working) || dirty || !simulation?.can_publish} className="min-h-11">
            {working === 'publish' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Publicar versão
          </Button>
          {!isNew && (
            <>
              <Button type="button" variant="ghost" onClick={() => onDuplicate?.(rule)} className="min-h-11 gap-2">
                <Copy className="h-4 w-4" /> Duplicar
              </Button>
              <Button type="button" variant="ghost" onClick={() => versions === null ? loadVersions() : setVersions(null)} className="min-h-11 gap-2">
                <History className="h-4 w-4" /> Versões
              </Button>
            </>
          )}
          {isNew && <Button type="button" variant="ghost" onClick={onCancelNew} className="min-h-11">Cancelar</Button>}
        </div>
        <SimulationResults simulation={simulation} />
        {versions !== null && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="font-semibold">Histórico de versões do modelo</p>
            {versions.length === 0 && !versionsLoading && <p className="text-muted-foreground">Nenhuma versão encontrada.</p>}
            {versions.map((version, index) => (
              <details key={version.id || index} className="rounded border p-2">
                <summary className="cursor-pointer">
                  Versão {version.version || version.template_version || '?'}
                  {version.created_at && ` · ${formatDateTime(version.created_at)}`}
                </summary>
                {version.snapshot?.message_template && <p className="mt-2 whitespace-pre-wrap text-xs">{version.snapshot.message_template}</p>}
              </details>
            ))}
            {versionsLoading && <p className="text-muted-foreground">Carregando...</p>}
            {versionsCursor && <Button variant="outline" onClick={() => loadVersions({ cursor: versionsCursor, append: true })} disabled={versionsLoading} className="min-h-11">Carregar versões anteriores</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PolicyEditor({ policy, savedDraft, onPublished }) {
  const [preDueEnabled, setPreDueEnabled] = useState(Boolean(savedDraft?.policy?.pre_due_enabled ?? policy.pre_due_enabled));
  const [preDueOffset, setPreDueOffset] = useState(Number(savedDraft?.policy?.pre_due_offset ?? policy.pre_due_offset ?? -1));
  const [draftId, setDraftId] = useState(savedDraft?.id || null);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState(savedDraft?.updated_at || null);
  const [dirty, setDirty] = useState(false);
  const [simulation, setSimulation] = useState(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  const saveDraft = async () => {
    setWorking('save');
    setError('');
    try {
      const saved = savedDraftRecord(await saveCommunicationDraft({
        rule_id: null,
        base_version: 0,
        rule: null,
        policy: { pre_due_enabled: preDueEnabled, pre_due_offset: preDueOffset },
        base_policy_version: Number(policy.version) || 1,
      }));
      setDraftId(saved.id);
      setDraftUpdatedAt(saved.updated_at);
      setDirty(false);
      setSimulation(null);
      toast.success('Rascunho da política salvo. Nada foi ativado.');
    } catch (cause) {
      setError(cause?.message || 'Não foi possível salvar o rascunho da política.');
    } finally {
      setWorking('');
    }
  };

  const simulate = async () => {
    if (!draftId || dirty) return toast.error('Salve o rascunho antes de simular');
    setWorking('simulate');
    setError('');
    try {
      setSimulation(await simulateCommunicationDraft(draftId));
    } catch (cause) {
      setError(cause?.message || 'Não foi possível simular.');
    } finally {
      setWorking('');
    }
  };

  const publish = async () => {
    if (!draftId || dirty || !simulation?.can_publish || !simulation?.simulation_fingerprint) {
      return toast.error('Salve e simule a versão atual antes de publicar');
    }
    setWorking('publish');
    setError('');
    try {
      await publishCommunicationDraft(draftId, {
        expected_updated_at: draftUpdatedAt,
        simulation_fingerprint: simulation.simulation_fingerprint,
      });
      toast.success('Política de pré-vencimento publicada.');
      onPublished?.();
    } catch (cause) {
      setError(cause?.message || 'Não foi possível publicar. Recarregue e simule novamente.');
      setSimulation(null);
    } finally {
      setWorking('');
    }
  };

  const edit = (enabled, offset) => {
    setPreDueEnabled(enabled);
    setPreDueOffset(offset);
    setDirty(true);
    setSimulation(null);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="h-4 w-4 text-blue-600" /> Cadência operacional</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          Cobranças em atraso: D+3, D+5, D+7 e revisão diária depois disso enquanto houver saldo aberto.
          Promessas, contestação, pagamento e revisão prevalecem. O EON Store sugere tarefas; mensagens são enviadas manualmente.
        </p>
        <div className="rounded-md border bg-gray-50 p-3">
          <p className="font-semibold">Lembrete antes do vencimento para contratos trimestrais e semestrais</p>
          <p className="mt-1 text-xs text-muted-foreground">Desativado por padrão. Não se aplica à renovação mensal automática.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={preDueEnabled} onChange={event => edit(event.target.checked, preDueOffset)} className="h-4 w-4 accent-blue-600" />
              Ativar lembrete pré-vencimento
            </label>
            <div>
              <Label htmlFor="predue-offset">Quando sugerir</Label>
              <select
                id="predue-offset"
                value={preDueOffset}
                disabled={!preDueEnabled}
                onChange={event => edit(preDueEnabled, Number(event.target.value))}
                className="mt-1 min-h-11 w-full rounded-md border bg-white px-3"
              >
                <option value={-1}>D−1 · um dia antes</option>
                <option value={0}>D0 · no vencimento</option>
              </select>
            </div>
          </div>
        </div>
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>}
        {draftId && <p className="text-xs text-muted-foreground">Rascunho {dirty ? 'com alterações não salvas' : 'salvo'}; a política publicada só muda após simulação e confirmação.</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={saveDraft} disabled={Boolean(working)} className="min-h-11">
            {working === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar rascunho
          </Button>
          <Button variant="outline" onClick={simulate} disabled={Boolean(working) || !draftId || dirty} className="min-h-11">
            {working === 'simulate' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Simular
          </Button>
          <Button onClick={publish} disabled={Boolean(working) || dirty || !simulation?.can_publish} className="min-h-11">
            {working === 'publish' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Publicar política
          </Button>
        </div>
        <SimulationResults simulation={simulation} />
      </CardContent>
    </Card>
  );
}

export default function CommunicationSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [models, setModels] = useState({ rules: [], policy: {}, drafts: [] });
  const [communityLink, setCommunityLink] = useState(DEFAULT_COMMUNITY_LINK);
  const [savingLink, setSavingLink] = useState(false);
  const [newRule, setNewRule] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [modelData, settings] = await Promise.all([getCommunicationModels(), loadCommunicationConfig()]);
      setModels({
        rules: modelData.rules || [],
        policy: Array.isArray(modelData.policy)
          ? (modelData.policy.find(item => item.purpose === 'billing') || modelData.policy[0] || {})
          : (modelData.policy || {}),
        drafts: modelData.drafts || [],
      });
      setCommunityLink(settings.communityLink || DEFAULT_COMMUNITY_LINK);
    } catch (cause) {
      setError(cause?.message || 'Não foi possível carregar modelos e regras.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rulesByJourney = useMemo(() => (
    models.rules.reduce((groups, rule) => {
      const journey = rule.journey || 'billing';
      if (!groups[journey]) groups[journey] = [];
      groups[journey].push(rule);
      return groups;
    }, {})
  ), [models.rules]);

  const draftForRule = rule => models.drafts.find(draft => draft.rule_id === rule.id) || null;
  const policyDraft = models.drafts.find(draft => !draft.rule_id && draft.policy) || null;
  const newRuleDrafts = models.drafts.filter((draft, index, all) => (
    !draft.rule_id && draft.rule?.slug
    && all.findIndex(other => !other.rule_id && other.rule?.slug === draft.rule.slug) === index
  ));

  const createRule = journey => {
    const base = MODEL_STAGES[journey][0];
    setNewRule({
      slug: newSlug(base.task_kind),
      name: 'Novo modelo',
      journey,
      trigger_event: base.trigger_event,
      task_kind: base.task_kind,
      channel: 'whatsapp',
      active: false,
      days_offset: base.offsets[0][0],
      order_index: 99,
      message_template: 'Oi, {nome}!\n\n',
    });
  };

  const duplicateRule = rule => {
    setNewRule({
      ...copyRule(rule),
      slug: newSlug(rule.task_kind),
      name: `Cópia de ${rule.name}`,
      active: false,
      order_index: (Number(rule.order_index) || 0) + 1,
    });
  };

  const saveLink = async () => {
    setSavingLink(true);
    try {
      await saveCommunityLink(communityLink);
      toast.success('Link da comunidade salvo');
    } catch (cause) {
      toast.error(cause?.message || 'Não foi possível salvar o link');
    } finally {
      setSavingLink(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <Link to="/comunicacao" className="mb-2 inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">
          <ArrowLeft className="h-4 w-4" /> Voltar para Comunicação
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
          <Settings className="h-5 w-5 text-blue-600" /> Modelos e regras
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edite rascunhos, simule com dados fictícios e publique versões explicitamente.
        </p>
      </header>

      {loading && <div role="status" className="rounded-lg border bg-white p-8 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Carregando modelos...</div>}
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
          <Button variant="outline" onClick={load} className="mt-2 min-h-11">Tentar novamente</Button>
        </div>
      )}

      {!loading && !error && (
        <>
          <PolicyEditor
            key={`policy:${models.policy.version || 0}:${policyDraft?.id || ''}`}
            policy={models.policy}
            savedDraft={policyDraft}
            onPublished={load}
          />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageCircle className="h-4 w-4 text-green-600" /> Link da comunidade
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row">
              <div className="flex-1">
                <Label htmlFor="community-link">Comunidade Endurance ON</Label>
                <Input id="community-link" value={communityLink} onChange={event => setCommunityLink(event.target.value)} className="mt-1 min-h-11" />
              </div>
              <Button onClick={saveLink} disabled={savingLink} className="min-h-11 self-end">
                {savingLink ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                Salvar link
              </Button>
            </CardContent>
          </Card>

          {JOURNEY_ORDER.map(journey => (
            <section key={journey} className="space-y-3" aria-label={JOURNEY_LABEL[journey]}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-bold text-gray-900">{JOURNEY_LABEL[journey]}</h2>
                <Button variant="outline" onClick={() => createRule(journey)} className="min-h-11 gap-2">
                  <Plus className="h-4 w-4" /> Novo modelo
                </Button>
              </div>
              {(rulesByJourney[journey] || []).filter(isCurrentStage).length === 0 && <p className="text-sm text-muted-foreground">Nenhum modelo vigente nesta finalidade.</p>}
              {(rulesByJourney[journey] || []).filter(isCurrentStage).map(rule => {
                const savedDraft = draftForRule(rule);
                return (
                  <RuleEditor
                    key={`${rule.id}:${rule.template_version || 0}:${savedDraft?.id || ''}`}
                    rule={rule}
                    savedDraft={savedDraft}
                    onPublished={load}
                    onDuplicate={duplicateRule}
                  />
                );
              })}
              {(rulesByJourney[journey] || []).some(rule => !isCurrentStage(rule)) && (
                <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
                  <h3 className="font-semibold">Modelos antigos fora da régua atual</h3>
                  <p className="text-xs text-muted-foreground">Esses textos permanecem para consulta, mas seus marcos não são usados para sugerir mensagens na régua vigente.</p>
                  {(rulesByJourney[journey] || []).filter(rule => !isCurrentStage(rule)).map(rule => (
                    <details key={rule.id} className="rounded-md border bg-white p-3">
                      <summary className="cursor-pointer font-medium">{rule.name} · marco {rule.days_offset} · versão {rule.template_version || 1}</summary>
                      <p className="mt-2 whitespace-pre-wrap text-xs text-gray-700">{rule.message_template}</p>
                    </details>
                  ))}
                </div>
              )}
              {newRuleDrafts.filter(savedDraft => savedDraft.rule?.journey === journey).map(savedDraft => (
                <RuleEditor
                  key={savedDraft.id}
                  rule={savedDraft.rule}
                  savedDraft={savedDraft}
                  isNew
                  onPublished={load}
                />
              ))}
              {newRule?.journey === journey && (
                <RuleEditor
                  key={newRule.slug}
                  rule={newRule}
                  isNew
                  onPublished={() => { setNewRule(null); load(); }}
                  onDraftSaved={() => { setNewRule(null); load(); }}
                  onCancelNew={() => setNewRule(null)}
                />
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
