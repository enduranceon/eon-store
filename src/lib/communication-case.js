const BLOCK_REASON_LABELS = {
  review_requested: 'Aguardando conferência',
  payment_review: 'Pagamento informado; conferir no Financeiro',
  dispute: 'Cobrança contestada; conferir',
  needs_agent: 'Atendimento humano necessário',
  renewal_review: 'Renovação em revisão',
  source_reopened_review: 'Origem alterada; conferir novamente',
  source_missing: 'Registro de origem indisponível',
  missing_due_date: 'Data de vencimento ausente',
  missing_payment_link: 'Link da cobrança ausente',
  missing_contact_phone: 'WhatsApp ausente ou inválido',
  not_due_yet: 'Aguardar a data do próximo contato',
};

export function communicationBlockReasonLabel(reason) {
  if (!reason) return '';
  return BLOCK_REASON_LABELS[reason] || (String(reason).includes('_') ? 'Informações da origem precisam de revisão' : String(reason));
}

export function canCompleteCommunicationReview(reason) {
  return ['review_requested', 'payment_review', 'dispute', 'needs_agent', 'renewal_review', 'source_reopened_review'].includes(reason);
}
