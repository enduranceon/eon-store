-- Remove fechamentos gerados antes de o mês terminar.
--
-- Em 01/10/2026 o fechamento de outubro/2026 foi gerado por engano (ver
-- 20261001115900_payout_closing_month_lock.sql). Ele ficou em revisão,
-- resgatou para outubro 6 pendências de agosto que eram de setembro e
-- detectou pendências de um mês que mal tinha começado.
--
-- Para cada fechamento em revisão gerado antes do 1º dia do mês seguinte à
-- competência (data de Brasília), guarda uma cópia em eon_private e desfaz o
-- que ele fez:
--   - as pendências que ele resgatou voltam exatamente ao estado de antes
--     (abertas). O gatilho payout_pending_repasse_guard_inactive_contract fica
--     desligado só nessa devolução: ele cancela pendência reaberta de
--     contrato cancelado, mas aqui a pendência não está sendo reaberta, está
--     voltando a ser o que era (o fechamento seguinte paga como pagaria);
--   - as pendências que ele detectou saem, menos as que outro fechamento já
--     pagou;
--   - os itens saem com o fechamento.
-- Fechamentos aprovados ou pagos não são tocados.

CREATE TABLE IF NOT EXISTS eon_private.payout_closing_removal_backups (
  removal_key text PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);
REVOKE ALL ON TABLE eon_private.payout_closing_removal_backups FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION eon_private.remove_premature_payout_closings()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_closing public.payout_monthly_closings%ROWTYPE;
  v_removed integer := 0;
BEGIN
  FOR v_closing IN
    SELECT closing.*
    FROM public.payout_monthly_closings AS closing
    WHERE closing.status = 'pending_approval'
      AND closing.generated_at IS NOT NULL
      AND (closing.generated_at AT TIME ZONE 'America/Sao_Paulo')::date
          < (date_trunc('month', closing.competence) + interval '1 month')::date
    ORDER BY closing.competence
  LOOP
    INSERT INTO eon_private.payout_closing_removal_backups (removal_key, snapshot)
    VALUES (
      'premature-closing-' || v_closing.competence || '-' || v_closing.id,
      jsonb_build_object(
        'closing', to_jsonb(v_closing),
        'items', coalesce((
          SELECT jsonb_agg(to_jsonb(item))
          FROM public.payout_monthly_statement_items AS item
          WHERE item.closing_id = v_closing.id
        ), '[]'::jsonb),
        'detected_pendings', coalesce((
          SELECT jsonb_agg(to_jsonb(pending))
          FROM public.payout_pending_repasse AS pending
          WHERE pending.detected_in_closing_id = v_closing.id
        ), '[]'::jsonb),
        'resolved_pendings', coalesce((
          SELECT jsonb_agg(to_jsonb(pending))
          FROM public.payout_pending_repasse AS pending
          WHERE pending.resolved_in_closing_id = v_closing.id
        ), '[]'::jsonb)
      )
    )
    ON CONFLICT (removal_key) DO NOTHING;

    ALTER TABLE public.payout_pending_repasse
      DISABLE TRIGGER payout_pending_repasse_guard_inactive_contract;
    UPDATE public.payout_pending_repasse
    SET status = 'open', resolved_in_closing_id = NULL, resolved_at = NULL
    WHERE resolved_in_closing_id = v_closing.id;
    ALTER TABLE public.payout_pending_repasse
      ENABLE TRIGGER payout_pending_repasse_guard_inactive_contract;

    DELETE FROM public.payout_pending_repasse
    WHERE detected_in_closing_id = v_closing.id
      AND resolved_in_closing_id IS NULL;

    DELETE FROM public.payout_monthly_closings
    WHERE id = v_closing.id;

    v_removed := v_removed + 1;
  END LOOP;

  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.remove_premature_payout_closings() FROM PUBLIC, anon, authenticated;

SELECT eon_private.remove_premature_payout_closings();
