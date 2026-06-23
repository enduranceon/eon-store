-- Central de Comunicacao: permite incluir itens/plano nas mensagens de cobranca.
-- O codigo passa a renderizar {item}, {itens} e {itens_bloco}; esta migration
-- atualiza os templates padrao existentes sem sobrescrever personalizacoes que
-- ja tenham adicionado {itens_bloco}.

UPDATE public.communication_rules
SET message_template = CASE
    WHEN position('{pix_bloco}{link_bloco}' in message_template) > 0 THEN
      replace(message_template, '{pix_bloco}{link_bloco}', '{itens_bloco}{pix_bloco}{link_bloco}')
    WHEN position('{link_bloco}' in message_template) > 0 THEN
      replace(message_template, '{link_bloco}', '{itens_bloco}{link_bloco}')
    ELSE
      message_template || E'\n\n{itens_bloco}'
  END,
  updated_at = now()
WHERE slug IN ('billing-charge-send', 'billing-charge-overdue')
  AND message_template NOT LIKE '%{itens_bloco}%';
