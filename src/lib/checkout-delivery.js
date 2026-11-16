// Todo treino coletivo é em Florianópolis e não há mais frete: a única forma de
// entrega nas páginas de pedido é a retirada no treino coletivo de Florianópolis.
// Pedidos antigos com frete ou retirada em São Paulo continuam existindo e
// aparecendo nas telas internas; aqui só se define o que o cliente pode escolher.
export const PICKUP_CITY = 'Florianópolis';

export function checkoutDelivery() {
  return { method: 'pickup', city: PICKUP_CITY };
}
