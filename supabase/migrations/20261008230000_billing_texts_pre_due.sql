BEGIN;
SET LOCAL lock_timeout = '5s';

-- Cobrança (docs/fluxos-de-mensagens.md, seção 3):
-- 1. Textos antigos com acentos e no tom das mensagens novas: a primeira
--    cobrança e os lembretes de véspera e de vencimento dizem a que se refere
--    a cobrança ({referente}).
-- 2. Lembrete na véspera do vencimento ligado (trimestral e semestral), como
--    decidido em 08/10/2026. Continua editável em Modelos e regras.

UPDATE public.communication_rules
SET message_template = $tpl$Olá, {nome}! Tudo bem?

Segue a cobrança {referente}, no valor de *{valor}*{vencimento_texto}.

{itens_bloco}{pix_bloco}{link_bloco}Se o pagamento já foi feito, é só desconsiderar esta mensagem. Qualquer dúvida, estou por aqui!$tpl$,
    name = 'Cobrança · primeira mensagem com o link',
    updated_at = now()
WHERE slug = 'billing-charge-send';

UPDATE public.communication_rules
SET message_template = $tpl$Oi, {nome}! Tudo bem?

Passando pra lembrar que a cobrança de *{valor}* {referente} vence amanhã ({vencimento}).

{link_bloco}Se já pagou, é só desconsiderar. Qualquer dúvida, me chama aqui!$tpl$,
    name = 'Cobrança · lembrete na véspera do vencimento',
    updated_at = now()
WHERE slug = 'billing-pre-due-1d';

UPDATE public.communication_rules
SET message_template = $tpl$Oi, {nome}! Tudo bem?

Passando pra lembrar que a cobrança de *{valor}* {referente} vence hoje ({vencimento}).

{link_bloco}Se já pagou, é só desconsiderar. Qualquer dúvida, me chama aqui!$tpl$,
    name = 'Cobrança · lembrete no dia do vencimento',
    updated_at = now()
WHERE slug = 'billing-pre-due-0d';

UPDATE public.communication_cadence_policies
SET pre_due_enabled = true, version = version + 1, updated_at = now()
WHERE slug = 'billing_overdue' AND NOT pre_due_enabled;

COMMIT;
