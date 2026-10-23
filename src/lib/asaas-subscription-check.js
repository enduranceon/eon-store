// "Conferir assinaturas no Asaas" (quadro de Renovações): resultado da
// consulta dos planos mensais com a renovação automática desligada.

export const SUBSCRIPTION_CHECK_GROUPS = [
  {
    key: 'found',
    title: 'Com assinatura mensal ativa no Asaas',
    statuses: ['subscription'],
  },
  {
    key: 'review',
    title: 'Conferir no Asaas',
    statuses: ['multiple', 'asaas_error', 'no_document'],
  },
  {
    key: 'none',
    title: 'Sem assinatura no Asaas',
    statuses: ['no_subscription', 'no_customer'],
  },
];

const STATUS_NOTES = {
  multiple: 'Mais de uma assinatura mensal ativa no Asaas. Confira lá qual é a do plano e ligue pela ficha do contrato.',
  asaas_error: 'Não foi possível consultar o Asaas agora. Consulte de novo.',
  no_document: 'Sem CPF/CNPJ no cadastro para procurar no Asaas.',
  no_subscription: 'Cliente no Asaas sem assinatura mensal ativa.',
  no_customer: 'Nenhum cliente com este CPF/CNPJ no Asaas.',
};

const BILLING_TYPES = {
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão',
  UNDEFINED: 'Pessoa escolhe',
};

export function subscriptionCheckNote(result) {
  return STATUS_NOTES[result?.status] || null;
}

export function billingTypeLabel(billingType) {
  return BILLING_TYPES[billingType] || billingType || null;
}

export function subscriptionValueDiffers(result) {
  const value = Number(result?.subscription?.value);
  const expected = Number(result?.expected_value);
  return Number.isFinite(value) && Number.isFinite(expected) && Math.abs(value - expected) >= 0.01;
}

// Grupos na ordem da tela, cada um por data de fim do plano.
export function groupSubscriptionCheck(results = []) {
  return SUBSCRIPTION_CHECK_GROUPS.map(group => ({
    ...group,
    items: results
      .filter(result => group.statuses.includes(result.status))
      .sort((a, b) =>
        String(a.end_date || '').localeCompare(String(b.end_date || '')) ||
        String(a.customer_name || '').localeCompare(String(b.customer_name || ''), 'pt-BR')),
  })).filter(group => group.items.length > 0);
}
