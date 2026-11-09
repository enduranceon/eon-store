# Coach nos eventos: responsáveis, grupo do WhatsApp e login do coach

Decisões do usuário (2026-11-09) para os coaches passarem a cuidar de eventos.

## O que o coach vai ver

- **Só os eventos em que é responsável.** Um evento pode ter **mais de um** coach
  responsável.
- **Só olhar.** Lista dos inscritos e quem está pago e quem não pagou.
- **Sem valores.** Nada de preço, valor recebido, taxa, despesa, centro de receita, link
  de cobrança nem observação interna; o coach não tem noção de ganhos do evento.
- **Operação do grupo do WhatsApp.** Se a pessoa já está no grupo ou não.

## Grupo do WhatsApp (feito)

- Ao criar/editar o evento, a equipe marca "Este evento tem grupo no WhatsApp"
  (`events.whatsapp_group_enabled`).
- Em evento com grupo, cada inscrição **paga** mostra uma lista com "Falta adicionar",
  "No grupo" e "Não quer entrar" (`event_registrations.whatsapp_group_status`:
  `pending`, `added`, `declined`). Inscrição ainda não paga mostra "depois que pagar";
  cancelada/reembolsada não entra.
- O topo da lista de inscritos resume ("2 de 5 pagos já estão no grupo · 2 faltam
  adicionar") e tem o filtro "Mostrar só quem falta".
- Hoje só a equipe (painel) muda a situação. **Pergunta aberta:** o coach responsável
  também deve poder marcar? Enquanto não for decidido, o coach só vê.

## Coaches responsáveis (feito)

- `event_coaches (event_id, coach_id)`; a equipe escolhe ao criar ou editar o evento
  (vários). A tabela só é lida por administrador e escrita por `set_event_coaches`
  (via `PUT /events/:id/coaches`). **Ainda não dá acesso a ninguém.**

## Login do coach (próxima etapa, não feito)

Estado de hoje: só administrador entra (`app_admins`; `GET /session` recusa os demais),
todas as tabelas têm RLS restritiva a administrador e a `api-v1` exige administrador.
Os cadastros dos coaches têm e-mail e `assessment_coaches.auth_user_id` (sem uso).

Desenho proposto:

1. Conta de coach criada pela equipe a partir do cadastro do coach, ligada por
   `auth_user_id`. Papel separado de administrador (nunca entra em `app_admins`).
2. Mesmo `/login`: administrador vai para `/admin`, coach para uma área própria e
   enxuta, sem o menu do painel.
3. Os dados do coach só saem por endpoints novos do servidor, com lista fixa de campos
   (nome, tipo de inscrição, pago/não pago/cancelado, situação do grupo); as tabelas
   continuam fechadas ao navegador. Cada consulta confere que o evento é um dos eventos em
   que o coach é responsável.
4. Testes provando que coach não alcança nada do administrador.
