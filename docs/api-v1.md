# API v1

A API administrativa do EON Store roda em uma Supabase Edge Function e exige
um JWT de usuário válido em todas as rotas.

## Base URL

```text
https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/api-v1
```

O frontend envia em cada chamada:

```http
apikey: <chave pública do projeto>
Authorization: Bearer <access token da sessão>
```

A chave pública identifica o projeto. O JWT identifica o usuário. A API ainda
verifica se o usuário pertence à allowlist administrativa antes de executar a
rota.

## Resposta de erro

```json
{
  "error": "Descrição legível",
  "code": "codigo_estavel"
}
```

## Rotas implementadas

### `GET /session`

Valida o JWT e o acesso administrativo do usuário atual.

Resposta `200`:

```json
{
  "data": {
    "user_id": "uuid",
    "role": "admin"
  }
}
```

Erros esperados:

- `401`: token ausente, inválido ou expirado;
- `403`: usuário autenticado sem acesso administrativo.

### `GET /returns`

Lista as devoluções em ordem decrescente de criação. Aceita opcionalmente
`?status=pending_return`, `received` ou `completed`.

### `POST /returns/:id/receive`

Marca uma devolução pendente como fisicamente recebida.

### `POST /returns/:id/complete`

Conclui uma devolução recebida. Quando há `product_id`, a reposição do estoque e
a conclusão acontecem na mesma transação no Postgres. Chamadas repetidas são
idempotentes e não repõem o estoque duas vezes.

### `POST /orders/:type/:id/cancel`

Cancela integralmente um pedido ainda não pago. `:type` aceita `presale` ou
`stock` e o corpo deve conter um motivo:

```json
{
  "reason": "Desistência do cliente"
}
```

Quando existe uma cobrança Asaas, a API consulta o estado atual e só solicita a
exclusão para cobranças `PENDING` ou `OVERDUE`. Estados pagos, estornados ou não
reconhecidos retornam `409` para evitar que o pedido local seja cancelado sem a
conferência financeira necessária.

Depois da etapa externa, uma única transação no Postgres:

- muda o pedido para `cancelled` e remove os dados da cobrança;
- exclui parcelas manuais ainda associadas ao pedido;
- devolve o uso do cupom;
- registra o evento em `sales_status_events` com o operador autenticado;
- no pedido de estoque, aciona a reposição já garantida pelo trigger existente.

A tabela server-only `order_operations` torna a operação idempotente. Repetir a
mesma chamada devolve o resultado já concluído, sem duplicar evento, devolução de
cupom ou reposição. Se o pedido ou a cobrança vinculada mudar entre a preparação
e a conclusão, a operação passa para `reconciliation_required` e a API retorna
`409`, sem forçar uma atualização local possivelmente incorreta.

### `POST /orders/:type/:id/refund`

Estorna integralmente um pedido pago no Asaas. O corpo contém `reason`. A API
registra primeiro uma operação, consulta os estornos já existentes na cobrança
e envia ao Asaas um marcador único no formato `EON refund <operation_id>`.
Assim, uma repetição após timeout reconhece o estorno anterior antes de decidir
se deve fazer um novo `POST`.

Depois da confirmação externa, uma transação altera o pedido para `refunded`,
devolve o cupom, cria as devoluções dos itens e registra o evento de auditoria.
Pedido de estoque ainda não entregue é reposto imediatamente. Quando já foi
entregue, a reposição só acontece depois da conclusão na Central de Devoluções.

### `POST /orders/:type/:id/items/:index/cancel`

Cancela um item usando o corpo:

```json
{
  "reason": "Produto indisponível",
  "was_delivered": false
}
```

O backend recalcula de forma autoritativa o subtotal, o desconto proporcional
do cupom, o desconto manual, o custo e o valor de estorno. Para pagamentos
manuais, as parcelas são redistribuídas em centavos e continuam somando
exatamente o novo total. Para pagamentos Asaas, a mesma estratégia de marcador
idempotente é usada no estorno parcial.

A rota rejeita a alteração quando existe cobrança não paga ativa: o operador
deve cancelar/reabrir a cobrança e gerar outra com o valor correto. Mudanças
concorrentes no pedido após um estorno externo levam a operação para
`reconciliation_required`.

### Pagamentos manuais

`GET /payments/methods` lista apenas os métodos ativos e os campos necessários
para o formulário administrativo.

`POST /orders/:type/:id/manual-payment` registra um pagamento manual. `:type`
aceita `presale`, `stock` ou `contract` e o corpo usa:

```json
{
  "payment_method_id": "uuid",
  "payment_date": "2026-07-26",
  "total": 350
}
```

O backend busca a configuração ativa do método e calcula as datas de crédito,
incluindo fins de semana e feriados nacionais. Uma única transação confere o
valor autoritativo da venda, impede conflito com cobrança Asaas, substitui as
parcelas manuais, marca a venda como paga e registra os eventos com o operador
do JWT. Em contratos ainda em rascunho, a mesma transação ativa ou agenda o
contrato. Repetir exatamente a mesma chamada não recria parcelas nem eventos.

`PATCH /orders/:type/:id/manual-payment` altera o desconto de uma venda já paga
manualmente:

```json
{
  "total": 300,
  "manual_discount": 50,
  "discount_reason": "Fidelidade",
  "discount_recurring": false
}
```

O Postgres recalcula o total a partir dos itens ou do snapshot do plano, rejeita
um total divergente e, na mesma transação, atualiza o desconto, o histórico e as
parcelas. A última parcela absorve a diferença de centavos para que a soma seja
sempre exata.

`DELETE /orders/:type/:id/manual-payment` reabre exclusivamente um pagamento
manual confirmado. A remoção das parcelas, a volta para `awaiting_charge` (ou
`pending` em contrato) e os eventos de auditoria são atômicos e idempotentes.
Pagamentos Asaas são rejeitados por essa rota.

### Cadastros administrativos

Os recursos abaixo usam o mesmo contrato CRUD e aceitam apenas campos
explicitamente permitidos pelo backend:

- `categories`: categorias e subcategorias;
- `suppliers`: fornecedores;
- `trainers`: treinadores;
- `revenue-centers`: centros de receita;
- `payment-methods`: configuração administrativa de formas, prazos e parcelas.

Rotas:

```text
GET    /catalog/:resource?sort=-created_date
GET    /catalog/:resource/:id
POST   /catalog/:resource
PATCH  /catalog/:resource/:id
DELETE /catalog/:resource/:id
```

Os identificadores devem ser UUIDs. Campos de sistema como `id`, datas de
criação e datas de atualização são rejeitados no corpo. A ordenação também é
restrita por recurso. O backend normaliza nomes e e-mails, valida subcategorias,
cores e tipos de centro de receita e limita o tamanho dos textos.

Fornecedores com produtos vinculados não podem ser excluídos. Centros de
receita preservam o comportamento do schema: referências existentes passam a
`NULL` por `ON DELETE SET NULL`. Métodos de pagamento marcados como `system`
nunca podem ser excluídos; métodos já usados por cobranças também permanecem
protegidos pela chave estrangeira. O endpoint operacional
`GET /payments/methods` continua retornando somente métodos ativos, enquanto
`/catalog/payment-methods` atende a tela administrativa completa.

## Próximos módulos

As próximas rotas devem cobrir criação, consulta, cancelamento e reconciliação
de cobranças Asaas, demais escritas de vendas e os cadastros ainda atendidos
pelo proxy legado em `src/api/db.js`. O acesso direto às tabelas só deve ser
revogado depois que todos os consumidores daquele domínio estiverem usando a
API. Para `payment_methods`, as gravações diretas de `anon` e `authenticated`
já podem ser revogadas; a leitura autenticada permanece temporariamente para o
diagnóstico administrativo legado.

O RPC antigo `record_manual_payment` permanece temporariamente como fallback de
rollout, restrito à mesma allowlist administrativa. O frontend novo não o usa;
o acesso pode ser removido depois da confirmação da versão em produção.

## Ordem de publicação

Para não interromper o login em produção:

1. aplicar as migrations necessárias para as rotas da versão;
2. publicar a Edge Function `api-v1`;
3. confirmar que uma chamada sem JWT recebe `401`;
4. confirmar as rotas com uma conta administrativa;
5. publicar o frontend;
6. acompanhar erros `401`, `403`, `409` e `5xx` nos logs.
