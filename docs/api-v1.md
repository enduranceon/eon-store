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

## Próximos módulos

As próximas rotas devem cobrir estorno integral de pagamentos e cancelamento
parcial de itens. Esses fluxos precisam de identificação idempotente do estorno
e reconciliação explícita com o Asaas antes que as escritas diretas restantes do
frontend sejam removidas. O acesso direto às tabelas só deve ser revogado depois
que todos os consumidores daquele domínio estiverem usando a API.

## Ordem de publicação

Para não interromper o login em produção:

1. aplicar as migrations necessárias para as rotas da versão;
2. publicar a Edge Function `api-v1`;
3. confirmar que uma chamada sem JWT recebe `401`;
4. confirmar as rotas com uma conta administrativa;
5. publicar o frontend;
6. acompanhar erros `401`, `403`, `409` e `5xx` nos logs.
