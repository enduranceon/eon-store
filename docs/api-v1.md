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

### Cadastros administrativos

Os recursos abaixo usam o mesmo contrato CRUD e aceitam apenas campos
explicitamente permitidos pelo backend:

- `categories`: categorias e subcategorias;
- `suppliers`: fornecedores;
- `trainers`: treinadores;
- `revenue-centers`: centros de receita.

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
`NULL` por `ON DELETE SET NULL`.

## Próximos módulos

As próximas rotas devem cobrir criação, consulta e reabertura de cobranças,
pagamentos manuais, demais escritas de vendas e os cadastros ainda atendidos
pelo proxy legado em `src/api/db.js`. O acesso direto às tabelas só deve ser
revogado depois que todos os consumidores daquele domínio estiverem usando a
API.

## Ordem de publicação

Para não interromper o login em produção:

1. aplicar as migrations necessárias para as rotas da versão;
2. publicar a Edge Function `api-v1`;
3. confirmar que uma chamada sem JWT recebe `401`;
4. confirmar as rotas com uma conta administrativa;
5. publicar o frontend;
6. acompanhar erros `401`, `403`, `409` e `5xx` nos logs.
