# Lista de espera por coach

Quando um coach está cheio ou não quer novos alunos agora, o site troca o
cadastro dele por um formulário curto de lista de espera. A equipe vê a fila no
painel, conversa com a pessoa, consulta o coach, oferece outro coach ou cria o
prospect. Nada aqui cria contrato, cobrança ou mensagem automática.

## No painel (EON Store)

- **Abrir ou fechar a lista de um coach:** Equipe > editar o coach > "Recebe
  novos alunos". Desmarcado, o coach fica em lista de espera no site. A venda
  interna (Prospects, contrato, renovação) continua liberada para ele.
- **Fila:** Assessoria > Lista de espera (`/assessoria/lista-de-espera`), e a aba
  "Lista de espera" no perfil do coach (`/assessoria/coaches/:id`).
- **Situações:** Aguardando, Em contato, Consultando o coach, Virou prospect,
  Encerrado (com motivo). A posição na fila é por ordem de chegada, por coach.
- **Criar prospect:** abre o "Novo prospect" já com nome, WhatsApp, e-mail,
  coach e uma observação de onde a pessoa veio. Dá para trocar o coach ali
  (oferecer outro coach). Ao criar, a pessoa vira "Virou prospect" com o link
  para o prospect.
- **Remover:** apaga os dados (pedido da pessoa ou cadastro errado). Para quem
  só desistiu, use Encerrar, que guarda o histórico.
- Uma pessoa (mesmo WhatsApp) fica uma vez só na fila aberta de cada coach.

Banco: `assessment_coaches.accepting_new_students` e a tabela
`assessment_coach_waitlist` (só o painel admin lê; escrita pelo backend).

## O que o site recebe

`GET https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/public-assessment-prospect`
continua igual; cada coach ganhou `accepting_new_students`:

```json
{ "id": "…", "name": "…", "modality_ids": ["…"], "accepting_new_students": false, "site_plans": [] }
```

Regra no site: com `accepting_new_students: false`, mostrar o coach com o selo
"Lista de espera" e, no lugar de "Quero treinar", o formulário da lista. O
cadastro (`POST` do mesmo endereço) recusa esse coach com `422`,
`code: "INVALID_SELECTION"` e `field_errors: [{ "field": "coach_id", "code": "COACH_WAITLIST" }]`.
Se receber isso (o coach fechou a lista depois que a página carregou), oferecer o
formulário da lista de espera.

## Entrar na lista: `public-coach-waitlist`

`POST https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/public-coach-waitlist`

Mesmas proteções do cadastro: só as origens `https://www.enduranceon.com.br`,
`https://enduranceon.com.br` e `localhost:8080`, Turnstile obrigatório (ação
`waitlist_submit`; `prospect_submit` também é aceita), campo isca `website`
vazio e o mesmo limite de tentativas por IP e por telefone.

```json
{
  "request_id": "uuid v4 gerado no navegador e reaproveitado nas novas tentativas",
  "coach_id": "uuid do coach",
  "modality_id": "uuid da modalidade (opcional; precisa ser uma do coach)",
  "full_name": "Nome Sobrenome",
  "whatsapp": "(48) 99999-0000",
  "email": "opcional@exemplo.com",
  "region": "florianopolis | online (opcional)",
  "notes": "opcional, até 500 caracteres",
  "turnstile_token": "…",
  "website": "",
  "landing_page": "https://www.enduranceon.com.br/…",
  "utm": { "utm_source": "…" }
}
```

Respostas:

| Status | Corpo | Quando |
| --- | --- | --- |
| 201 | `{ "ok": true, "status": "created", "request_id", "submitted_at" }` | Entrou na fila. |
| 200 | `{ "ok": true, "status": "duplicate", … }` | Mesmo envio repetido, ou a pessoa já está na fila deste coach. Mostrar a mesma confirmação. |
| 400 | `VALIDATION_ERROR` com `field_errors` (`INVALID_NAME`, `INVALID_PHONE`, `INVALID_EMAIL`, `INVALID_REGION`, `INVALID_COACH`, `INVALID_MODALITY`, `TURNSTILE_REQUIRED`) | Campos inválidos. |
| 403 | `TURNSTILE_INVALID` / `ORIGIN_NOT_ALLOWED` | Refazer a verificação. |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Mesmo `request_id` com outros dados: gerar outro. |
| 422 | `INVALID_SELECTION` (`coach_id`/`INVALID_COACH`) | Coach fora do site. |
| 429 | `RATE_LIMITED` | Muitas tentativas. |
| 503/500 | `TURNSTILE_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `SUBMISSION_FAILED` | Tentar de novo com o mesmo `request_id`. |

Todo erro tem `{ "ok": false, "code", "error", "request_id" }`; `error` é uma
frase pronta para a tela. A fila aceita qualquer coach visível no site, mas o
site só deve mostrar o formulário para quem está com `accepting_new_students: false`.

Texto sugerido de confirmação: "Pronto! Você está na lista de espera do
{coach}. Nossa equipe vai falar com você pelo WhatsApp."
