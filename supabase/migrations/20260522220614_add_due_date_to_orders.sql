
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS due_date date;
;
