# Contatos do site

O formulário de contato do site da EON (`/contato`) envia a mensagem para cá. A
equipe vê o contato no painel, responde pelo WhatsApp e, se a pessoa quiser
treinar, cria o prospect a partir do contato. Nada aqui cria contrato, cobrança
ou mensagem automática, e o texto que a pessoa escreveu não muda.

Quem já sabe o plano e o coach faz a pré-matrícula direto
(`public-assessment-prospect`) e cai no quadro de Prospects. O contato é para
quem ainda tem dúvida: um prospect exige plano e coach, e uma mensagem solta
não tem nenhum dos dois.

## No painel (EON Store)

- **Tela:** Assessoria > Contatos do site (`/assessoria/contatos-do-site`).
- **Situações:** Novo, Em contato, Virou prospect, Encerrado (com motivo).
  "Esperando resposta" mostra Novo e Em contato, do mais antigo ao mais novo,
  para ninguém ficar esquecido.
- **Criar prospect:** abre o "Novo prospect" já com nome, WhatsApp, e-mail e uma
  observação com a data, o assunto e a mensagem. A equipe escolhe plano e coach
  ali. Ao criar, o contato vira "Virou prospect" com o link para o prospect.
- **Reabrir:** encerrado ou "Virou prospect" volta para Novo.
- **Remover:** apaga os dados (pedido da pessoa ou spam). Para um contato já
  respondido, use Encerrar, que guarda o histórico.
- A mesma pessoa (mesmo WhatsApp) mandando **a mesma mensagem** de novo, com o
  primeiro contato ainda aberto, não cria outro: o site mostra a mesma
  confirmação. Depois de encerrado, a mesma mensagem entra como novo contato.

Banco: tabela `assessment_contact_requests` (só o painel admin lê; a escrita é
do backend). O envio do site passa pela função SQL
`submit_public_contact_request`, só para `service_role`.

## Entrar: `public-contact-request`

`POST https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/public-contact-request`

Mesmas proteções da lista de espera e do cadastro: só as origens
`https://www.enduranceon.com.br`, `https://enduranceon.com.br` e
`localhost:8080` (a prévia `eon-novo.netlify.app` **não** tem acesso à produção),
Turnstile obrigatório (ação `contact_submit`; `prospect_submit` também é
aceita), campo isca `website` vazio e o mesmo limite de tentativas por IP e por
telefone (10 por hora por IP, 4 por dia por telefone).

```json
{
  "request_id": "uuid v4 gerado no navegador e reaproveitado nas novas tentativas",
  "full_name": "Nome Sobrenome",
  "whatsapp": "(48) 99999-0000",
  "email": "opcional@exemplo.com",
  "subject": "Dúvida sobre planos",
  "message": "Texto da mensagem, de 10 a 1500 caracteres.",
  "turnstile_token": "…",
  "website": "",
  "landing_page": "https://www.enduranceon.com.br/contato",
  "utm": { "utm_source": "instagram" }
}
```

Regras: nome com pelo menos 3 caracteres; WhatsApp brasileiro com DDD; e-mail
opcional; assunto de 3 a 120 caracteres (numa linha); mensagem de 10 a 1500
caracteres (as quebras de linha ficam). O nome é gravado com iniciais
maiúsculas, como nos demais cadastros.

Respostas:

| Status | Corpo | Quando |
| --- | --- | --- |
| 201 | `{ "ok": true, "status": "created", "request_id", "submitted_at" }` | Mensagem recebida. |
| 200 | `{ "ok": true, "status": "duplicate", … }` | Mesmo envio repetido, ou a mesma mensagem ainda aberta. Mostrar a mesma confirmação. |
| 400 | `VALIDATION_ERROR` com `field_errors` (`INVALID_NAME`, `INVALID_PHONE`, `INVALID_EMAIL`, `INVALID_SUBJECT`, `INVALID_MESSAGE`, `INVALID_REQUEST_ID`, `TURNSTILE_REQUIRED`) | Campos inválidos. |
| 403 | `TURNSTILE_INVALID` / `ORIGIN_NOT_ALLOWED` | Refazer a verificação. |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Mesmo `request_id` com outros dados: gerar outro. |
| 429 | `RATE_LIMITED` | Muitas tentativas. |
| 503/500 | `TURNSTILE_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `SUBMISSION_FAILED` | Tentar de novo com o mesmo `request_id`. |

Todo erro tem `{ "ok": false, "code", "error", "request_id" }`; `error` é uma
frase pronta para a tela.

Texto sugerido de confirmação: "Mensagem enviada! Nossa equipe vai falar com
você pelo WhatsApp."

## Publicação

Pela ordem do fluxo do GitHub: migração, depois `api-v1` (nova entidade
`contact-requests` do painel), depois a função `public-contact-request` e o
frontend. O site só deve ligar o modo real do formulário (`"mode":"live"` no
`contato.html`) depois que a função estiver no ar e o Turnstile do site tiver a
ação `contact_submit`.
