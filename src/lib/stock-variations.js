export function stockVariationLabel(variation) {
  if (!variation) return '';
  if (variation.name) return String(variation.name);
  const parts = [variation.gender, variation.size].filter(Boolean);
  if (parts.length) return parts.join(' - ');
  return variation.sku ? String(variation.sku) : '';
}

export function stockVariationQuantity(variation) {
  const quantity = Number(variation?.quantity);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
}

export function stockProductVariations(product) {
  return Array.isArray(product?.variations)
    ? product.variations.filter(variation => stockVariationLabel(variation))
    : [];
}

export function hasStockVariations(product) {
  return stockProductVariations(product).length > 0;
}

export function stockProductQuantity(product) {
  const variations = stockProductVariations(product);
  if (variations.length > 0) {
    return variations.reduce((sum, variation) => sum + stockVariationQuantity(variation), 0);
  }
  const quantity = Number(product?.quantity);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
}

export function findStockVariation(product, variationName) {
  const name = variationName ? String(variationName) : '';
  return stockProductVariations(product).find(variation =>
    stockVariationLabel(variation) === name || variation.sku === name
  ) || null;
}

export function stockItemQuantity(product, variationName = null) {
  const variation = variationName ? findStockVariation(product, variationName) : null;
  if (variation) return stockVariationQuantity(variation);
  if (hasStockVariations(product)) return 0;
  return stockProductQuantity(product);
}

export function stockItemSalePrice(product, variation = null) {
  const value = Number(variation?.sale_price ?? product?.sale_price);
  return Number.isFinite(value) ? value : 0;
}

export function stockItemCostPrice(product, variation = null) {
  const value = Number(variation?.cost_price ?? product?.cost_price);
  return Number.isFinite(value) ? value : 0;
}

export function stockCartKey(productId, variationName = null) {
  return variationName ? `${productId}::${variationName}` : String(productId);
}

export function normalizeStockVariations(variations) {
  return (Array.isArray(variations) ? variations : [])
    .filter(variation => stockVariationLabel(variation))
    .map(variation => ({
      ...variation,
      name: stockVariationLabel(variation),
      quantity: stockVariationQuantity(variation),
    }));
}
