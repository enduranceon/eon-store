-- Função e triggers: quando um pedido/contrato é cancelado ou reembolsado,
-- marca as linhas correspondentes em asaas_payments como CANCELLED/REFUNDED.
-- Resolve o bug de "fantasmas no fluxo de caixa": parcelas que continuavam
-- contando como receita mesmo após o pedido ser cancelado.

CREATE OR REPLACE FUNCTION cleanup_asaas_payments_on_order_cancel()
RETURNS TRIGGER AS $$
DECLARE
  new_payment_status TEXT;
BEGIN
  IF OLD.payment_status IS NOT DISTINCT FROM NEW.payment_status THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_status = 'cancelled' THEN
    new_payment_status := 'CANCELLED';
  ELSIF NEW.payment_status = 'refunded' THEN
    new_payment_status := 'REFUNDED';
  ELSE
    RETURN NEW;
  END IF;

  UPDATE asaas_payments
  SET status     = new_payment_status,
      updated_at = NOW()
  WHERE order_id = NEW.id
    AND order_type = TG_ARGV[0]
    AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para presale_orders
DROP TRIGGER IF EXISTS trg_cleanup_asaas_payments_presale ON presale_orders;
CREATE TRIGGER trg_cleanup_asaas_payments_presale
  AFTER UPDATE OF payment_status ON presale_orders
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_asaas_payments_on_order_cancel('presale');

-- Trigger para stock_orders
DROP TRIGGER IF EXISTS trg_cleanup_asaas_payments_stock ON stock_orders;
CREATE TRIGGER trg_cleanup_asaas_payments_stock
  AFTER UPDATE OF payment_status ON stock_orders
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_asaas_payments_on_order_cancel('stock');

-- Trigger para assessment_contracts (payment_status)
DROP TRIGGER IF EXISTS trg_cleanup_asaas_payments_contract ON assessment_contracts;
CREATE TRIGGER trg_cleanup_asaas_payments_contract
  AFTER UPDATE OF payment_status ON assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_asaas_payments_on_order_cancel('contract');

-- Função extra para contratos: também limpa quando status (não payment_status) é cancelled
CREATE OR REPLACE FUNCTION cleanup_asaas_payments_on_contract_status_cancel()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN
    UPDATE asaas_payments
    SET status     = 'CANCELLED',
        updated_at = NOW()
    WHERE order_id = NEW.id
      AND order_type = 'contract'
      AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_asaas_payments_contract_status ON assessment_contracts;
CREATE TRIGGER trg_cleanup_asaas_payments_contract_status
  AFTER UPDATE OF status ON assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_asaas_payments_on_contract_status_cancel();

-- ────────────────────────────────────────────────────────────────────
-- BACKFILL: corrige linhas órfãs já existentes no banco
-- ────────────────────────────────────────────────────────────────────

UPDATE asaas_payments ap
SET status = CASE WHEN po.payment_status = 'refunded' THEN 'REFUNDED' ELSE 'CANCELLED' END,
    updated_at = NOW()
FROM presale_orders po
WHERE ap.order_id = po.id
  AND ap.order_type = 'presale'
  AND po.payment_status IN ('cancelled', 'refunded')
  AND ap.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

UPDATE asaas_payments ap
SET status = CASE WHEN so.payment_status = 'refunded' THEN 'REFUNDED' ELSE 'CANCELLED' END,
    updated_at = NOW()
FROM stock_orders so
WHERE ap.order_id = so.id
  AND ap.order_type = 'stock'
  AND so.payment_status IN ('cancelled', 'refunded')
  AND ap.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

UPDATE asaas_payments ap
SET status = CASE WHEN ac.payment_status = 'refunded' THEN 'REFUNDED' ELSE 'CANCELLED' END,
    updated_at = NOW()
FROM assessment_contracts ac
WHERE ap.order_id = ac.id
  AND ap.order_type = 'contract'
  AND (ac.payment_status IN ('cancelled', 'refunded') OR ac.status = 'cancelled')
  AND ap.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

COMMENT ON FUNCTION cleanup_asaas_payments_on_order_cancel IS
  'Marca linhas em asaas_payments como CANCELLED/REFUNDED quando o pedido associado é cancelado/reembolsado. Evita fantasmas no fluxo de caixa.';
