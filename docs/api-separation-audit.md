# Auditoria da separação entre frontend e backend

Atualizada em 2026-07-26. O objetivo é remover gradualmente as gravações
diretas do navegador no Data API, mantendo cada rollout compatível e
reversível.

## Já atendido pela API autenticada

- validação da sessão administrativa (`GET /session`);
- recebimento e conclusão de devoluções;
- cancelamento, estorno e cancelamento parcial de itens;
- registro, ajuste e reabertura de pagamentos manuais;
- categorias, fornecedores, treinadores e centros de receita;
- configuração administrativa de métodos de pagamento (etapa atual).

## Escritas diretas restantes

### 1. Vendas e cobranças — risco alto

Ainda existem atualizações diretas em `presale_orders`, `stock_orders`,
`asaas_payments`, `sales_status_events` e `coupon_uses`. Elas aparecem
principalmente em `OrderDetail.jsx`, `StockOrderDetail.jsx`, `Financial.jsx`,
`Orders.jsx`, `StockOrders.jsx` e nas bibliotecas de cupom e comunicação.

Esse bloco mistura estado da venda, vencimento, cobrança externa e histórico.
Deve ser migrado por comandos explícitos, com idempotência e transações no
Postgres quando mais de uma tabela for afetada.

### 2. Contratos e renovações — risco alto

`assessment_contracts`, `assessment_contract_event`,
`assessment_contract_coach_history` e `assessment_leaves` ainda recebem
gravações do frontend. Os fluxos incluem criação, ativação, troca de plano ou
coach, pausa, encerramento e renovação.

Cada transição deve ter uma rota própria e preservar a distinção entre contrato,
cobrança, pagamento, estorno e churn.

### 3. Produtos, campanhas, clientes e cupons — risco médio

O proxy legado ainda grava em `presale_campaigns`, `presale_products`,
`presale_customers`, `stock_products`, `products`, `coupons` e `discount_log`.
Há operações compostas, como mesclar clientes e reordenar produtos de uma
campanha, que não devem virar CRUD genérico sem validação adicional.

### 4. Comunicação — risco médio

Configurações, regras e marcações de envio ainda usam
`communication_settings`, `communication_rules`, `assessment_contract_event`
e `sales_status_events` diretamente. A API deverá diferenciar configuração de
regra, disparo e registro de entrega.

### 5. Assessoria, fechamento e repasse — risco alto

Planos, modalidades, coaches, regras de renovação, faixas de crescimento,
taxas, fechamentos e itens de demonstrativo ainda passam pelo proxy legado.
Fechamentos e repasses exigem comandos imutáveis ou versionados para evitar
recalcular períodos já aprovados.

### 6. Entradas públicas — superfície especial

Os fluxos públicos de inscrição em planos ainda chamam RPCs e inserções pelo
cliente anônimo. Eles precisam de endpoints públicos separados da API
administrativa, com validação estrita, proteção contra abuso e sem reutilizar a
credencial privilegiada do painel.

## Ordem recomendada

1. concluir a configuração de métodos de pagamento e revogar suas escritas
   diretas;
2. migrar o ciclo de cobranças Asaas e as alterações de vencimento;
3. migrar as demais escritas de pedidos e estoque;
4. migrar transições de contratos e renovações;
5. migrar produtos, campanhas, clientes e cupons;
6. migrar comunicação, configurações de assessoria, fechamento e repasse;
7. criar a API pública dedicada e, por tabela, revogar os grants que deixaram
   de ser necessários.

## Critério de conclusão por domínio

Um domínio só é considerado separado quando todas as telas consumidoras usam a
API, os campos aceitos estão em allowlist, as regras críticas são autoritativas
no backend, há teste automatizado, o smoke test autenticado passa e os grants de
gravação do navegador foram revogados sem quebrar consumidores remanescentes.
