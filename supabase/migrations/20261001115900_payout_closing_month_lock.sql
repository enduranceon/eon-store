-- Fechamento de repasse só para mês encerrado.
--
-- A tela de fechamento vinha com o mês atual preenchido e, em 01/10/2026, um
-- fechamento de outubro foi gerado sem querer: contou o mês inteiro antes de
-- ele acontecer e levou para outubro pendências que eram de setembro.
--
-- A regra fica no banco: uma competência só pode ser criada, ter a data
-- trocada ou mudar de situação (aprovar, pagar, reabrir) a partir do 1º dia do
-- mês seguinte, pela data de Brasília. A função generate-monthly-closing faz a
-- mesma checagem antes de calcular, com a mesma mensagem. Apagar um fechamento
-- em revisão continua possível.

CREATE OR REPLACE FUNCTION eon_private.guard_payout_closing_month()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_current_month date := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_month date := date_trunc('month', NEW.competence)::date;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.competence IS NOT DISTINCT FROM OLD.competence
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF v_month >= v_current_month THEN
    RAISE EXCEPTION '% de % ainda não terminou. O fechamento fica disponível a partir de %.',
      (ARRAY['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho',
             'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'])[extract(month FROM v_month)::int],
      extract(year FROM v_month)::int,
      to_char(v_month + interval '1 month', 'DD/MM/YYYY')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_payout_closing_month ON public.payout_monthly_closings;
CREATE TRIGGER guard_payout_closing_month
  BEFORE INSERT OR UPDATE OF competence, status ON public.payout_monthly_closings
  FOR EACH ROW EXECUTE FUNCTION eon_private.guard_payout_closing_month();

REVOKE ALL ON FUNCTION eon_private.guard_payout_closing_month() FROM PUBLIC, anon, authenticated;
