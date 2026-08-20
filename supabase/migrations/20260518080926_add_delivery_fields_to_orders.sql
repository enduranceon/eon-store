
ALTER TABLE presale_orders
  ADD COLUMN IF NOT EXISTS delivery_method text,
  ADD COLUMN IF NOT EXISTS delivery_city   text;
;
