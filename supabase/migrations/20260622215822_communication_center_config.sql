-- Central de Comunicacao: configuracoes globais e regras/templates editaveis.
-- Fase 2 mantem envio manual; as regras apenas geram tarefas e mensagens prontas.

CREATE TABLE IF NOT EXISTS public.communication_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.communication_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  journey TEXT NOT NULL CHECK (journey IN ('billing', 'onboarding', 'renewal', 'reactivation')),
  trigger_event TEXT NOT NULL CHECK (trigger_event IN (
    'charge_created',
    'charge_due_date',
    'payment_confirmed',
    'onboarding_welcome_sent',
    'contract_end_date',
    'manual'
  )),
  task_kind TEXT NOT NULL CHECK (task_kind IN (
    'charge_send',
    'charge_overdue',
    'onboarding_welcome',
    'onboarding_checkin',
    'renewal_reminder',
    'reactivation'
  )),
  days_offset INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  message_template TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS communication_rules_active_idx
  ON public.communication_rules(active, journey, order_index);

ALTER TABLE public.communication_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_full ON public.communication_settings;
CREATE POLICY auth_full ON public.communication_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS app_admin_only ON public.communication_settings;
CREATE POLICY app_admin_only ON public.communication_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

DROP POLICY IF EXISTS auth_full ON public.communication_rules;
CREATE POLICY auth_full ON public.communication_rules
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS app_admin_only ON public.communication_rules;
CREATE POLICY app_admin_only ON public.communication_rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.communication_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.communication_rules TO authenticated;

INSERT INTO public.communication_settings(key, value)
VALUES (
  'community_link',
  jsonb_build_object('url', 'https://chat.whatsapp.com/Eow2KTzNHwr0Q5n5XrTow3')
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();

INSERT INTO public.communication_rules (
  slug, name, journey, trigger_event, task_kind, days_offset, channel, message_template, active, order_index
)
VALUES
(
  'billing-charge-send',
  'Enviar cobranca',
  'billing',
  'charge_created',
  'charge_send',
  0,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

Segue a cobranca do seu {tipo} *{numero}*, no valor de *{valor}*{vencimento_texto}.

{pix_bloco}{link_bloco}Se o pagamento ja foi realizado, pode desconsiderar esta mensagem. Qualquer duvida, estou por aqui.',
  true,
  10
),
(
  'billing-charge-overdue',
  'Reenviar cobranca vencida',
  'billing',
  'charge_due_date',
  'charge_overdue',
  1,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

Estou passando porque a cobranca do seu {tipo} *{numero}*, no valor de *{valor}*, venceu{vencimento_atraso}.

{pix_bloco}{link_bloco}Se o pagamento ja foi realizado, pode desconsiderar esta mensagem. Qualquer duvida, estou por aqui.',
  true,
  20
),
(
  'onboarding-welcome',
  'Boas-vindas pos-pagamento',
  'onboarding',
  'payment_confirmed',
  'onboarding_welcome',
  0,
  'whatsapp',
  'Ola, {nome}! Tudo certo?

Pagamento confirmado. Seja bem-vindo(a) a Assessoria Esportiva Endurance ON.

Modalidade: *{modalidade}*
Plano: *{plano}*
Coach: *{coach}*

Comunidade Endurance ON:
{comunidade}

Nos proximos passos, o time vai alinhar seu inicio e acompanhar sua adaptacao. Qualquer duvida, me chama por aqui.',
  true,
  30
),
(
  'onboarding-checkin-5d',
  'Check-in inicial',
  'onboarding',
  'onboarding_welcome_sent',
  'onboarding_checkin',
  5,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

Passando para saber se deu tudo certo nesses primeiros dias e se o treinador ja entrou em contato com voce.

Se ficou alguma duvida para comecar ou se precisar de qualquer ajuste, me chama por aqui.',
  true,
  40
),
(
  'renewal-reminder-14d',
  'Renovacao proxima',
  'renewal',
  'contract_end_date',
  'renewal_reminder',
  -14,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

Seu acompanhamento na Endurance ON pelo plano *{plano}* esta chegando perto do vencimento em *{data_fim}*.

Quero deixar sua continuidade organizada para voce nao interromper o acompanhamento. Posso te enviar as opcoes de renovacao?',
  true,
  50
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    journey = EXCLUDED.journey,
    trigger_event = EXCLUDED.trigger_event,
    task_kind = EXCLUDED.task_kind,
    days_offset = EXCLUDED.days_offset,
    channel = EXCLUDED.channel,
    message_template = EXCLUDED.message_template,
    active = EXCLUDED.active,
    order_index = EXCLUDED.order_index,
    updated_at = now();
