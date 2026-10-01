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

-- A consulta feita pela API antes de gravar não basta sozinha: a aprovação pode
-- acontecer entre a leitura do status e o INSERT/UPDATE/DELETE do item. Trave a
-- linha do fechamento dentro da mesma transação da escrita. Assim, a escrita
-- termina antes da aprovação ou, se a aprovação venceu a corrida, relê o status
-- já aprovado e é recusada. O trigger também passa a cobrir INSERTs, inclusive
-- os feitos por outros caminhos internos.
CREATE OR REPLACE FUNCTION public.block_modifications_on_closed_closing()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  closing_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT closing.status
    INTO closing_status
    FROM public.payout_monthly_closings AS closing
    WHERE closing.id = OLD.closing_id
    FOR UPDATE;
  ELSE
    SELECT closing.status
    INTO closing_status
    FROM public.payout_monthly_closings AS closing
    WHERE closing.id = NEW.closing_id
    FOR UPDATE;
  END IF;

  IF closing_status IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Fechamento já foi aprovado/pago. Não é possível alterar itens.'
      USING HINT = 'Para fazer ajustes, crie um novo item de ajuste manual em outro fechamento ou reverta a aprovação primeiro.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_modifications_on_closed_items
  ON public.payout_monthly_statement_items;
CREATE TRIGGER trg_block_modifications_on_closed_items
  BEFORE INSERT OR UPDATE OR DELETE ON public.payout_monthly_statement_items
  FOR EACH ROW
  EXECUTE FUNCTION public.block_modifications_on_closed_closing();

COMMENT ON COLUMN public.payout_monthly_statement_items.expense_category IS
  'Tipo do lançamento manual: repasse_extra, desconto ou a categoria do gasto/reembolso (reembolso_combustivel, insumos_treino, escala_evento, outros).';
