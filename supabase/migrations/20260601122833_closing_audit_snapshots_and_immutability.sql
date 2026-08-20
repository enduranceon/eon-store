
-- 1) Snapshots de cálculo nos itens do fechamento
ALTER TABLE payout_monthly_statement_items
  ADD COLUMN IF NOT EXISTS rate_applied      numeric,
  ADD COLUMN IF NOT EXISTS tier_applied      jsonb,
  ADD COLUMN IF NOT EXISTS leadership_bonus  numeric,
  ADD COLUMN IF NOT EXISTS base_value        numeric,
  ADD COLUMN IF NOT EXISTS adjustment_reason text;

COMMENT ON COLUMN payout_monthly_statement_items.rate_applied IS
  'Taxa role+modality usada no cálculo (snapshot).';
COMMENT ON COLUMN payout_monthly_statement_items.tier_applied IS
  'Snapshot completo do tier de crescimento aplicado: {name, min_athletes, increment_per_athlete, leadership_bonus, co_leadership_bonus}.';
COMMENT ON COLUMN payout_monthly_statement_items.leadership_bonus IS
  'Bônus de liderança aplicado (se source_type=direct_leadership ou co_leadership).';
COMMENT ON COLUMN payout_monthly_statement_items.base_value IS
  'Valor base antes da multiplicação pelo prorata_factor.';
COMMENT ON COLUMN payout_monthly_statement_items.adjustment_reason IS
  'Motivo do ajuste (obrigatório quando source_type=manual_adjustment).';

-- 2) Trigger de imutabilidade nos itens
CREATE OR REPLACE FUNCTION block_modifications_on_closed_closing()
RETURNS TRIGGER AS $$
DECLARE
  closing_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO closing_status FROM payout_monthly_closings WHERE id = OLD.closing_id;
  ELSE
    SELECT status INTO closing_status FROM payout_monthly_closings WHERE id = NEW.closing_id;
  END IF;

  IF closing_status IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Fechamento já foi aprovado/pago. Não é possível alterar itens.'
      USING HINT = 'Para fazer ajustes, crie um novo item de ajuste manual em outro fechamento ou reverta a aprovação primeiro.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_modifications_on_closed_items ON payout_monthly_statement_items;
CREATE TRIGGER trg_block_modifications_on_closed_items
  BEFORE UPDATE OR DELETE ON payout_monthly_statement_items
  FOR EACH ROW
  EXECUTE FUNCTION block_modifications_on_closed_closing();

-- 3) Trigger de imutabilidade no próprio closing: status só pode avançar
--    pending_approval → approved → paid. Outras mudanças são bloqueadas.
CREATE OR REPLACE FUNCTION enforce_closing_status_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Mantém os mesmos status: livre
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Transições permitidas
  IF OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'pending_approval') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status IN ('paid', 'pending_approval') THEN
    -- Permite voltar a pending_approval (caso admin precise re-editar). Quando voltar, items voltam a poder ser editados.
    RETURN NEW;
  END IF;
  IF OLD.status = 'paid' AND NEW.status = 'paid' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transição de status inválida: % → %', OLD.status, NEW.status
    USING HINT = 'Fluxo permitido: pending_approval → approved → paid (ou approved → pending_approval).';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_closing_status_transitions ON payout_monthly_closings;
CREATE TRIGGER trg_enforce_closing_status_transitions
  BEFORE UPDATE OF status ON payout_monthly_closings
  FOR EACH ROW
  EXECUTE FUNCTION enforce_closing_status_transitions();

-- 4) Bloquear DELETE de fechamento aprovado ou pago
CREATE OR REPLACE FUNCTION block_delete_approved_closing()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Não é possível excluir um fechamento aprovado ou pago.'
      USING HINT = 'Reverta o status para pending_approval primeiro, se necessário.';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_delete_approved_closing ON payout_monthly_closings;
CREATE TRIGGER trg_block_delete_approved_closing
  BEFORE DELETE ON payout_monthly_closings
  FOR EACH ROW
  EXECUTE FUNCTION block_delete_approved_closing();

-- 5) Adicionar coluna paid_at
ALTER TABLE payout_monthly_closings
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_by uuid;
;
