
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
;
