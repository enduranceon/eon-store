
-- Coluna pra rastrear quando o status REALMENTE mudou (não toda atualização)
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE stock_orders   ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

-- Backfill: usa updated_date ou created_date
UPDATE presale_orders
SET status_changed_at = COALESCE(updated_date, created_date)
WHERE status_changed_at IS NULL;

UPDATE stock_orders
SET status_changed_at = COALESCE(updated_date, created_date)
WHERE status_changed_at IS NULL;

-- Trigger: atualiza status_changed_at quando payment_status ou delivery_status muda
CREATE OR REPLACE FUNCTION sync_status_changed_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     OR NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS presale_orders_status_changed ON presale_orders;
CREATE TRIGGER presale_orders_status_changed
BEFORE UPDATE ON presale_orders
FOR EACH ROW EXECUTE FUNCTION sync_status_changed_at();

DROP TRIGGER IF EXISTS stock_orders_status_changed ON stock_orders;
CREATE TRIGGER stock_orders_status_changed
BEFORE UPDATE ON stock_orders
FOR EACH ROW EXECUTE FUNCTION sync_status_changed_at();
;
