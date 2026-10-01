-- Lançamentos manuais do fechamento: repasse extra, desconto e gasto/reembolso.
--
-- O tipo fica em expense_category ('repasse_extra', 'desconto' ou a categoria
-- do gasto) e o valor já vem com sinal: o desconto tira do repasse do coach
-- (negativo) e o resto soma (positivo). A API confere antes de gravar; aqui o
-- banco garante o mesmo para qualquer caminho. Os itens automáticos não mudam.

ALTER TABLE public.payout_monthly_statement_items
  ADD CONSTRAINT payout_statement_items_manual_entry_sign CHECK (
    source_type <> 'manual_adjustment'
    OR (expense_category = 'desconto' AND amount < 0)
    OR (expense_category IS DISTINCT FROM 'desconto' AND amount > 0)
  );

COMMENT ON COLUMN public.payout_monthly_statement_items.expense_category IS
  'Tipo do lançamento manual: repasse_extra, desconto ou a categoria do gasto/reembolso (reembolso_combustivel, insumos_treino, escala_evento, outros).';
