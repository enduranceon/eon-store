// Igual à rotina diária (supabase/functions/prepare-renewals/policy.ts): a
// renovação manual entra no quadro 10 dias antes do fim do contrato.
export const RENEWAL_ATTENTION_WINDOW_DAYS = 10;
export const RENEWAL_ATTENTION_WINDOW_OFFSET = -RENEWAL_ATTENTION_WINDOW_DAYS;
