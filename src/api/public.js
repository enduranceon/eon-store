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
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !publishableKey) {
    return Promise.reject(new Error('Loja não está configurada corretamente'));
  }

  return fetch(`${supabaseUrl}/functions/v1/public-store-checkout`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload }),
  }).then(async (response) => {
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || 'Não foi possível concluir o pedido');
    }
    return result.data;
  });
}
