-- Central de Comunicacao: transforma cobranca vencida em regua de 3, 7,
-- 10 e mais de 10 dias. O envio continua manual; estas regras apenas
-- alimentam a fila e os templates da mensagem pronta.

UPDATE public.communication_rules
SET name = 'Cobranca vencida - 3 dias',
    days_offset = 3,
    order_index = 20,
    active = true,
    updated_at = now()
WHERE slug = 'billing-charge-overdue';

INSERT INTO public.communication_rules (
  slug, name, journey, trigger_event, task_kind, days_offset, channel, message_template, active, order_index
)
VALUES
(
  'billing-charge-overdue-7d',
  'Cobranca vencida - 7 dias',
  'billing',
  'charge_due_date',
  'charge_overdue',
  7,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

Passando novamente sobre a cobranca do seu {tipo} *{numero}*, no valor de *{valor}*, que venceu{vencimento_atraso}.

{itens_bloco}{pix_bloco}{link_bloco}Se voce precisar de algum ajuste ou quiser combinar outra forma de pagamento, me responde por aqui.',
  true,
  21
),
(
  'billing-charge-overdue-10d',
  'Cobranca vencida - 10 dias',
  'billing',
  'charge_due_date',
  'charge_overdue',
  10,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

A cobranca do seu {tipo} *{numero}*, no valor de *{valor}*, segue em aberto desde {vencimento_atraso}.

{itens_bloco}{pix_bloco}{link_bloco}Consegue me dar um retorno sobre a previsao de pagamento? Assim eu mantenho tudo organizado por aqui.',
  true,
  22
),
(
  'billing-charge-overdue-return-11d',
  'Retorno sobre cobranca vencida',
  'billing',
  'charge_due_date',
  'charge_overdue',
  11,
  'whatsapp',
  'Ola, {nome}! Tudo bem?

Estou te chamando para entender como podemos resolver a cobranca em aberto do seu {tipo} *{numero}*.

{itens_bloco}Voce consegue me dar um retorno hoje? Pode ser para confirmar o pagamento, pedir um novo link ou combinar a melhor forma de regularizar.',
  true,
  23
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    journey = EXCLUDED.journey,
    trigger_event = EXCLUDED.trigger_event,
    task_kind = EXCLUDED.task_kind,
    days_offset = EXCLUDED.days_offset,
    channel = EXCLUDED.channel,
    active = EXCLUDED.active,
    order_index = EXCLUDED.order_index,
    updated_at = now();
