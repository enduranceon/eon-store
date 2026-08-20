
-- Trigger: ao cancelar contrato, normaliza payment_status para um estado coerente.
-- Regra:
--  • Se já existe refund_status='pending'/'done' → não sobrescreve (admin já configurou)
--  • Se payment_status era 'paid' e está sendo cancelado → mantém 'paid' (cliente já tinha pago)
--  • Se payment_status estava em transição (charge_sent, message_sent, partially_paid, pending, awaiting_charge) → vira 'cancelled'

CREATE OR REPLACE FUNCTION normalize_contract_on_cancel()
RETURNS TRIGGER AS $$
BEGIN
  -- Só age quando status acabou de mudar para 'cancelled'
  IF NEW.status = 'cancelled' AND (OLD.status IS DISTINCT FROM 'cancelled') THEN
    -- Se a cobrança ainda estava em transição, marca como cancelled
    IF NEW.payment_status IN ('pending','awaiting_charge','message_sent','charge_sent','partially_paid','overdue') THEN
      NEW.payment_status := 'cancelled';
    END IF;
    -- 'paid' e 'refunded' são preservados
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_contract_on_cancel ON assessment_contracts;
CREATE TRIGGER trg_normalize_contract_on_cancel
  BEFORE UPDATE ON assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION normalize_contract_on_cancel();

-- Limpa o caso bagunçado existente (status=cancelled + payment_status=charge_sent)
UPDATE assessment_contracts
SET payment_status = 'cancelled'
WHERE status = 'cancelled'
  AND payment_status IN ('pending','awaiting_charge','message_sent','charge_sent','partially_paid','overdue');
;
