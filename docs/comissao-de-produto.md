# Comissão de produto para o coach

Desde 2026-10-16. Um produto pode pagar comissão ao coach de quem compra.

## Regra no produto

Em Produtos > produto > "Comissão do coach" (`products.commission_type` e
`commission_value`):

- **Sem comissão** (padrão);
- **% do valor pago**: porcentagem (até 100) sobre o que a pessoa pagou pelo
  item: preço + adicionais × quantidade, com o desconto do pedido distribuído
  na proporção dos itens, sem frete;
- **R$ por unidade**: valor fixo por unidade, com ou sem desconto.

A regra fica no produto principal; o item da loja (estoque) e o da pré-venda
seguem o produto ao qual estão ligados.

## Coach do pedido

`stock_orders.coach_id` e `presale_orders.coach_id`. Quando o pedido nasce (ou
quando o cliente é ligado a ele) sem coach, recebe o coach do contrato ativo da
pessoa (`active`, `overdue` ou `on_leave`; o contrato já começado vem antes de
uma renovação futura). Dá para trocar ou tirar no cartão "Coach e comissão" do
pedido (`PATCH /orders/:type/:id/coach`). Comprador sem coach não gera comissão:
a venda fica com a assessoria.

## Quando a comissão nasce

- Quando o pedido passa a **pago**, a regra de cada item é registrada no pedido
  (`commission_snapshot`). Mudar o produto depois não muda vendas já pagas.
- Pedidos pagos antes de 2026-10-16 não têm registro e nunca geram comissão.
- O livro `product_commissions` só recebe lançamentos novos (não se apaga nem se
  reescreve). Um gatilho compara, item a item e por coach, o que o pedido deve
  hoje com o que já foi lançado e lança a diferença:
  - **comissão** (primeiro lançamento): competência = mês do pagamento;
  - **ajuste**: estorno, cancelamento, item cancelado, desconto depois do
    pagamento, troca ou remoção do coach; competência = mês em que mudou.
- Pagamento parcial não gera comissão.

## Repasse

O fechamento do mês (`generate-monthly-closing`) leva os lançamentos ainda sem
fechamento com competência até o mês fechado, como itens `product_commission`
do extrato (`product_commission_id` aponta para o lançamento). Lançamento que
chega depois de um fechamento aprovado entra no próximo, com a referência do
mês original. Recalcular um fechamento em revisão devolve os lançamentos dele
para "em aberto" e refaz. O extrato do coach (tela e PDF) mostra a seção
"Comissões de produtos"; o perfil do coach, na aba Recebimentos, lista as
comissões e o que ainda aguarda fechamento.

## Mês do repasse

Hoje a comissão entra pelo mês do **pagamento** do pedido. Se for preciso usar o
mês da compra, a troca é só na competência do primeiro lançamento
(`eon_private.reconcile_product_commissions`).
