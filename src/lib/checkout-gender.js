// Gêneros que o cliente pode escolher na página de pedido, na ordem em que aparecem
// nas variações do produto.
export function listGenders(variations) {
  return [...new Set((variations || []).map(variation => variation?.gender).filter(Boolean))];
}

// Se o produto só tem um gênero (ex.: cropped feminino), ele já vem escolhido:
// o cliente vai direto para o tamanho. Com mais de um, ou nenhum, não escolhe por ele.
export function defaultGender(genders) {
  return Array.isArray(genders) && genders.length === 1 ? genders[0] : null;
}
