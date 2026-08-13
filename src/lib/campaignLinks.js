export function getProductCampaignIds(product) {
  const ids = Array.isArray(product?.campaign_ids) ? product.campaign_ids : [];
  return [...new Set([...ids, product?.campaign_id].filter(Boolean))];
}

export function getPrimaryProductCampaignIds(product) {
  const ids = Array.isArray(product?.campaign_ids) ? product.campaign_ids : [];
  return [...new Set(ids.filter(Boolean))];
}

export function isProductLinkedToCampaign(product, campaignId) {
  return getProductCampaignIds(product).includes(campaignId);
}

export function getCampaignLinkStatus(product, campaignId) {
  const primary = getPrimaryProductCampaignIds(product).includes(campaignId);
  const legacy = product?.campaign_id === campaignId;
  return {
    linked: primary || legacy,
    primary,
    legacy,
    legacyOnly: legacy && !primary,
    dual: legacy && primary,
  };
}

export function addCampaignLink(product, campaignId) {
  return [...new Set([...getPrimaryProductCampaignIds(product), campaignId].filter(Boolean))];
}

export function removeCampaignLink(product, campaignId) {
  return getPrimaryProductCampaignIds(product).filter(id => id !== campaignId);
}

export function normalizeCampaignSelection(product) {
  return getProductCampaignIds(product);
}

export function orderCampaignProducts(campaign, products) {
  const savedOrder = Array.isArray(campaign?.product_order) ? campaign.product_order : [];
  const productIds = new Set(products.map(product => product.id));
  const seen = new Set();
  const ordered = [];

  savedOrder.forEach(productId => {
    if (productIds.has(productId) && !seen.has(productId)) {
      ordered.push(productId);
      seen.add(productId);
    }
  });

  products.forEach(product => {
    if (!seen.has(product.id)) {
      ordered.push(product.id);
      seen.add(product.id);
    }
  });

  return ordered;
}

export function getCampaignLinkHealth(campaign, products) {
  const campaignId = campaign?.id;
  const productOrder = Array.isArray(campaign?.product_order) ? campaign.product_order : [];
  const productIds = new Set(products.map(product => product.id));
  const legacyOnly = [];
  const dualLinked = [];

  products.forEach(product => {
    const status = getCampaignLinkStatus(product, campaignId);
    if (status.legacyOnly) legacyOnly.push(product);
    if (status.dual) dualLinked.push(product);
  });

  const orphanOrderIds = productOrder.filter(productId => !productIds.has(productId));
  return {
    legacyOnly,
    dualLinked,
    orphanOrderIds,
    hasIssues: legacyOnly.length > 0 || dualLinked.length > 0 || orphanOrderIds.length > 0,
  };
}
