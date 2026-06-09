import { supabase } from '@/api/db';

async function callPublicRpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || 'Não foi possível concluir a operação');
  return data;
}

export function listPublicCampaigns() {
  return callPublicRpc('list_public_campaigns');
}

export function getPublicPresaleCatalog(campaignReference) {
  return callPublicRpc('get_public_presale_catalog', {
    p_campaign_reference: campaignReference,
  });
}

export function getPublicStockCatalog() {
  return callPublicRpc('get_public_stock_catalog');
}

export function createPublicPresaleOrder(payload) {
  return callPublicRpc('create_public_presale_order', { p_payload: payload });
}

export function createPublicStockOrder(payload) {
  return callPublicRpc('create_public_stock_order', { p_payload: payload });
}
