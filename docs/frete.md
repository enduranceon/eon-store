# Frete cobrado depois do envio

Desde 2026-10-21. Vale para todo pedido com frete (`delivery_method = 'shipping'`),
da loja e da pré-venda. O frete não é cobrado na compra: depois de enviar, a
pessoa recebe uma cobrança à parte com o valor do frete.

## Etapa Enviado

Pedido com frete passa por **Enviado** entre "Separado para entrega" e
"Entregue" (`delivery_status = 'shipped'`). Pedido de retirada continua indo de
Separado direto para Entregue.

Marcar como enviado pede (janela "Marcar como enviado", no quadro de Pedidos ou
no cartão "Envio e frete" do pedido):

- **Código de rastreio** (opcional) → `tracking_code`;
- **Quanto paguei** → `shipping_cost`, o que a loja pagou no envio;
- **Quanto vou cobrar** → valor da cobrança do frete. Começa igual ao que foi
  pago e pode ser maior (por exemplo, por causa do imposto). Zero = frete grátis.

`shipped_at` guarda a hora do envio. Quem grava é `public.mark_order_shipped`
(rota `POST /orders/:type/:id/ship`), só a partir de Separado. A troca de etapa
comum (`update_order_fulfillment`) também aceita Enviado, mas só em pedido com
frete; na tela, Enviado sai sempre pela janela do envio.

## Cobrança do frete

Com valor a cobrar maior que zero, nasce um pedido da loja só com o item
"Frete" (`kind = 'shipping'`, sem produto, sem estoque e sem comissão), para a
mesma pessoa, aguardando cobrança, ligado ao pedido de origem por
`shipping_parent_type` e `shipping_parent_id`. Ele segue o caminho de qualquer
pedido: Cobranças, Central (régua de cobrança), "Conferir pagamentos no Asaas",
"Receber" e Financeiro (receita da loja).

- Uma cobrança aberta por pedido (índice único; cancelada ou estornada não
  conta). Marcar de novo só corrige rastreio e custo.
- Sem cobrança (frete grátis, ou a anterior foi cancelada), "Cobrar frete" no
  cartão do pedido cria uma.
- A cobrança do frete não tem etapa de entrega, não entra no quadro de Pedidos e
  não deixa ajustar itens. No card do pedido de origem aparece o selo "Frete a
  cobrar", "Frete cobrado" ou "Frete pago".
- A mensagem de cobrança diz "do frete do seu pedido" no `{referente}`.

## Financeiro

O que foi pago no envio (`shipping_cost`) entra em `financial_movements` como
despesa da loja (`source = 'shipping_cost'`, categoria `frete`), na data do
envio. O que a pessoa paga entra como receita da loja pela cobrança do frete.
Não entra no `total_cost` dos pedidos.

## Enviado já saiu da loja

Para estoque e devolução, Enviado vale como Entregue: cancelar ou estornar um
pedido enviado não repõe o estoque na hora (o item espera a devolução), e os
itens de um pedido enviado não podem mais ser trocados.

## Fora daqui

- Nada é cobrado no provedor automaticamente: a cobrança do frete segue a
  operação atual (link externo e registro manual do pagamento).
- O acompanhamento público do pedido mostra "Enviado", sem o rastreio.
