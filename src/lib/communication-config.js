import { supabase } from '@/api/db';

export const DEFAULT_COMMUNITY_LINK = 'https://chat.whatsapp.com/Eow2KTzNHwr0Q5n5XrTow3';

export const DEFAULT_COMMUNICATION_RULES = [
  {
    slug: 'billing-charge-send',
    name: 'Enviar cobranca',
    journey: 'billing',
    trigger_event: 'charge_created',
    task_kind: 'charge_send',
    days_offset: 0,
    channel: 'whatsapp',
    active: true,
    order_index: 10,
    message_template: `Ola, {nome}! Tudo bem?

Segue a cobranca do seu {tipo} *{numero}*, no valor de *{valor}*{vencimento_texto}.

{itens_bloco}{pix_bloco}{link_bloco}Se o pagamento ja foi realizado, pode desconsiderar esta mensagem. Qualquer duvida, estou por aqui.`,
  },
  {
    slug: 'billing-charge-overdue',
    name: 'Cobranca vencida - 3 dias',
    journey: 'billing',
    trigger_event: 'charge_due_date',
    task_kind: 'charge_overdue',
    days_offset: 3,
    channel: 'whatsapp',
    active: true,
    order_index: 20,
    message_template: `Ola, {nome}! Tudo bem?

Estou passando porque a cobranca do seu {tipo} *{numero}*, no valor de *{valor}*, venceu{vencimento_atraso}.

{itens_bloco}{pix_bloco}{link_bloco}Se o pagamento ja foi realizado, pode desconsiderar esta mensagem. Qualquer duvida, estou por aqui.`,
  },
  {
    slug: 'billing-charge-overdue-7d',
    name: 'Cobranca vencida - 7 dias',
    journey: 'billing',
    trigger_event: 'charge_due_date',
    task_kind: 'charge_overdue',
    days_offset: 7,
    channel: 'whatsapp',
    active: true,
    order_index: 21,
    message_template: `Ola, {nome}! Tudo bem?

Passando novamente sobre a cobranca do seu {tipo} *{numero}*, no valor de *{valor}*, que venceu{vencimento_atraso}.

{itens_bloco}{pix_bloco}{link_bloco}Se voce precisar de algum ajuste ou quiser combinar outra forma de pagamento, me responde por aqui.`,
  },
  {
    slug: 'billing-charge-overdue-10d',
    name: 'Cobranca vencida - 10 dias',
    journey: 'billing',
    trigger_event: 'charge_due_date',
    task_kind: 'charge_overdue',
    days_offset: 10,
    channel: 'whatsapp',
    active: true,
    order_index: 22,
    message_template: `Ola, {nome}! Tudo bem?

A cobranca do seu {tipo} *{numero}*, no valor de *{valor}*, segue em aberto desde {vencimento_atraso}.

{itens_bloco}{pix_bloco}{link_bloco}Consegue me dar um retorno sobre a previsao de pagamento? Assim eu mantenho tudo organizado por aqui.`,
  },
  {
    slug: 'billing-charge-overdue-return-11d',
    name: 'Retorno sobre cobranca vencida',
    journey: 'billing',
    trigger_event: 'charge_due_date',
    task_kind: 'charge_overdue',
    days_offset: 11,
    channel: 'whatsapp',
    active: true,
    order_index: 23,
    message_template: `Ola, {nome}! Tudo bem?

Estou te chamando para entender como podemos resolver a cobranca em aberto do seu {tipo} *{numero}*.

{itens_bloco}Voce consegue me dar um retorno hoje? Pode ser para confirmar o pagamento, pedir um novo link ou combinar a melhor forma de regularizar.`,
  },
  {
    slug: 'onboarding-welcome',
    name: 'Boas-vindas pos-pagamento',
    journey: 'onboarding',
    trigger_event: 'payment_confirmed',
    task_kind: 'onboarding_welcome',
    days_offset: 0,
    channel: 'whatsapp',
    active: true,
    order_index: 30,
    message_template: `Ola, {nome}! Tudo certo?

Pagamento confirmado. Seja bem-vindo(a) a Assessoria Esportiva Endurance ON.

Modalidade: *{modalidade}*
Plano: *{plano}*
Coach: *{coach}*

Comunidade Endurance ON:
{comunidade}

Nos proximos passos, o time vai alinhar seu inicio e acompanhar sua adaptacao. Qualquer duvida, me chama por aqui.`,
  },
  {
    slug: 'onboarding-checkin-5d',
    name: 'Check-in inicial',
    journey: 'onboarding',
    trigger_event: 'onboarding_welcome_sent',
    task_kind: 'onboarding_checkin',
    days_offset: 5,
    channel: 'whatsapp',
    active: true,
    order_index: 40,
    message_template: `Ola, {nome}! Tudo bem?

Passando para saber se deu tudo certo nesses primeiros dias e se o treinador ja entrou em contato com voce.

Se ficou alguma duvida para comecar ou se precisar de qualquer ajuste, me chama por aqui.`,
  },
  {
    slug: 'renewal-reminder-14d',
    name: 'Renovacao proxima',
    journey: 'renewal',
    trigger_event: 'contract_end_date',
    task_kind: 'renewal_reminder',
    days_offset: -14,
    channel: 'whatsapp',
    active: true,
    order_index: 50,
    message_template: `Ola, {nome}! Tudo bem?

Seu acompanhamento na Endurance ON pelo plano *{plano}* esta chegando perto do vencimento em *{data_fim}*.

Quero deixar sua continuidade organizada para voce nao interromper o acompanhamento. Posso te enviar as opcoes de renovacao?`,
  },
];

function isMissingTable(error) {
  return error?.code === '42P01' || /does not exist/i.test(error?.message || '');
}

function normalizedRule(rule) {
  return {
    ...rule,
    days_offset: Number(rule.days_offset) || 0,
    order_index: Number(rule.order_index) || 0,
    active: rule.active !== false,
  };
}

export function communityLinkFromSettings(settings = []) {
  const row = settings.find(s => s.key === 'community_link');
  return row?.value?.url || DEFAULT_COMMUNITY_LINK;
}

export async function loadCommunicationConfig() {
  const [settingsRes, rulesRes] = await Promise.all([
    supabase.from('communication_settings').select('*').order('key', { ascending: true }),
    supabase.from('communication_rules').select('*').order('order_index', { ascending: true }),
  ]);

  if (isMissingTable(settingsRes.error) || isMissingTable(rulesRes.error)) {
    return {
      available: false,
      settings: [{ key: 'community_link', value: { url: DEFAULT_COMMUNITY_LINK } }],
      communityLink: DEFAULT_COMMUNITY_LINK,
      rules: DEFAULT_COMMUNICATION_RULES.map(normalizedRule),
    };
  }
  if (settingsRes.error) throw settingsRes.error;
  if (rulesRes.error) throw rulesRes.error;

  const settings = settingsRes.data || [];
  const dbRules = rulesRes.data?.length ? rulesRes.data : DEFAULT_COMMUNICATION_RULES;
  return {
    available: true,
    settings,
    communityLink: communityLinkFromSettings(settings),
    rules: dbRules.map(normalizedRule),
  };
}

export async function saveCommunityLink(url) {
  const payload = {
    key: 'community_link',
    value: { url: String(url || '').trim() },
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from('communication_settings')
    .upsert(payload, { onConflict: 'key' });
  if (error) throw error;
}

export async function saveCommunicationRule(rule) {
  const payload = {
    slug: rule.slug,
    name: String(rule.name || '').trim(),
    journey: rule.journey,
    trigger_event: rule.trigger_event,
    task_kind: rule.task_kind,
    days_offset: Number(rule.days_offset) || 0,
    channel: rule.channel || 'whatsapp',
    message_template: String(rule.message_template || '').trim(),
    active: !!rule.active,
    order_index: Number(rule.order_index) || 0,
    updated_at: new Date().toISOString(),
  };
  if (!payload.name) throw new Error('Nome obrigatorio');
  if (!payload.message_template) throw new Error('Template obrigatorio');

  const { error } = await supabase
    .from('communication_rules')
    .upsert(payload, { onConflict: 'slug' });
  if (error) throw error;
}

// trigger_event + task_kind são fixados pelo banco (CHECK), então ao criar uma
// regra nova derivamos esses campos da jornada escolhida.
const NEW_RULE_DEFAULTS = {
  billing:      { task_kind: 'charge_send',        trigger_event: 'charge_created' },
  onboarding:   { task_kind: 'onboarding_welcome', trigger_event: 'payment_confirmed' },
  renewal:      { task_kind: 'renewal_reminder',   trigger_event: 'contract_end_date' },
  reactivation: { task_kind: 'reactivation',       trigger_event: 'manual' },
};

function newRuleSlug(taskKind) {
  return `${taskKind}-${Math.random().toString(36).slice(2, 8)}`;
}

// Regras novas/duplicadas começam inativas para não disparar tarefas antes de
// serem revisadas.
export async function createCommunicationRule(journey) {
  const base = NEW_RULE_DEFAULTS[journey] || NEW_RULE_DEFAULTS.billing;
  await saveCommunicationRule({
    slug: newRuleSlug(base.task_kind),
    name: 'Nova mensagem',
    journey,
    trigger_event: base.trigger_event,
    task_kind: base.task_kind,
    days_offset: 0,
    channel: 'whatsapp',
    message_template: 'Olá, {nome}! Tudo bem?\n\n',
    active: false,
    order_index: 99,
  });
}

export async function duplicateCommunicationRule(rule) {
  await saveCommunicationRule({
    ...rule,
    slug: newRuleSlug(rule.task_kind),
    name: `Cópia de ${rule.name || 'mensagem'}`,
    active: false,
    order_index: (Number(rule.order_index) || 0) + 1,
  });
}

export async function deleteCommunicationRule(id) {
  if (!id) throw new Error('Regra sem id');
  const { error } = await supabase.from('communication_rules').delete().eq('id', id);
  if (error) throw error;
}
