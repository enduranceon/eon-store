
-- presale_orders: campos que o frontend usa
ALTER TABLE presale_orders
  ADD COLUMN IF NOT EXISTS checkout_name       text,
  ADD COLUMN IF NOT EXISTS checkout_whatsapp   text,
  ADD COLUMN IF NOT EXISTS checkout_email      text,
  ADD COLUMN IF NOT EXISTS checkout_trainer    text,
  ADD COLUMN IF NOT EXISTS total_value         numeric(10,2),
  ADD COLUMN IF NOT EXISTS total_cost          numeric(10,2),
  ADD COLUMN IF NOT EXISTS payment_status      text,
  ADD COLUMN IF NOT EXISTS delivery_status     text,
  ADD COLUMN IF NOT EXISTS payment_date        date,
  ADD COLUMN IF NOT EXISTS delivery_date       date,
  ADD COLUMN IF NOT EXISTS internal_notes      text;

-- presale_products: campos extras
ALTER TABLE presale_products
  ADD COLUMN IF NOT EXISTS notes                    text,
  ADD COLUMN IF NOT EXISTS extra_cost               numeric(10,2),
  ADD COLUMN IF NOT EXISTS extra_cost_description   text,
  ADD COLUMN IF NOT EXISTS total_cost               numeric(10,2),
  ADD COLUMN IF NOT EXISTS profit_per_unit          numeric(10,2),
  ADD COLUMN IF NOT EXISTS margin_percent           numeric(6,2),
  ADD COLUMN IF NOT EXISTS discount_percent         numeric(6,2);

-- presale_customers: notas internas
ALTER TABLE presale_customers
  ADD COLUMN IF NOT EXISTS internal_notes text;
;
