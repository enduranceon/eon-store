const BLOCK_REASON_LABELS = {
  review_requested: 'Aguardando conferência',
  payment_review: 'Pagamento informado; conferir no Financeiro',
  dispute: 'Cobrança contestada; conferir',
  needs_agent: 'Atendimento humano necessário',
  renewal_review: 'Renovação em revisão',
  source_reopened_review: 'Origem alterada; conferir novamente',
  source_missing: 'Registro de origem indisponível',
  case_resolved: 'Acompanhamento encerrado',
  source_resolved: 'Pagamento ou encerramento já registrado na origem',
  source_closed_review: 'Venda encerrada; conferir a cobrança no Financeiro',
  balance_review: 'Saldo parcial sem confirmação; conferir no Financeiro',
  rule_unavailable: 'Etapa sem modelo ativo; conferir Modelos e regras',
  missing_due_date: 'Data de vencimento ausente',
  missing_payment_link: 'Falta cadastrar a cobrança (link de pagamento)',
  missing_contact_phone: 'WhatsApp ausente ou inválido',
  not_due_yet: 'Aguardar a data do próximo contato',
  already_contacted_today: 'Contato já registrado hoje',
  skipped_today: 'Mensagem desconsiderada hoje; a próxima vem na data seguinte',
  renewal_stage_changed: 'Etapa da renovação mudou; confira o quadro',
  renewal_close_pending: 'Encerramento enviado; falta encerrar a renovação como “Não renovou”',
  payment_changed: 'Situação de pagamento mudou; confira o Financeiro',
  onboarding_not_eligible: 'Onboarding não se aplica a esta adesão; confira o histórico do aluno',
  community_link_missing: 'Link da comunidade ausente',
  already_completed: 'Etapa de contato já concluída',
  invalid_payment_link: 'Link de pagamento inválido',
};

export function communicationBlockReasonLabel(reason) {
  if (!reason) return '';
  return BLOCK_REASON_LABELS[reason] || (String(reason).includes('_') ? 'Informações da origem precisam de revisão' : String(reason));
}

export function canCompleteCommunicationReview(reason) {
  return ['review_requested', 'payment_review', 'dispute', 'needs_agent', 'renewal_review', 'source_reopened_review'].includes(reason);
}

// O envio é manual: o painel só impede registrar o que o servidor recusaria.
// No onboarding, telefone ausente ou um passo antes da data não travam; só
// impedem etapa já concluída, contrato fora do onboarding ou modelo ausente.
export function communicationSendState({
  purpose,
  caseBlock = null,
  suggestionBlock = null,
  hasPhone = false,
  isFuture = false,
  ruleVersion = null,
  hasPaymentLink = false,
  canSendWithoutLink = false,
} = {}) {
  const hasRule = Number.isInteger(Number(ruleVersion)) && Number(ruleVersion) > 0;
  if (purpose === 'onboarding') {
    const block = suggestionBlock
      || (caseBlock === 'source_reopened_review' ? null : caseBlock)
      || null;
    return { canRegister: hasRule && !block, block, early: Boolean(isFuture) };
  }
  const block = suggestionBlock || caseBlock || null;
  return {
    canRegister: hasPhone && !block && !isFuture && hasRule
      && (purpose !== 'billing' || hasPaymentLink || canSendWithoutLink),
    block,
    early: false,
  };
}
