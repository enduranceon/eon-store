-- Vincula stock_orders à base de clientes (presale_customers)
ALTER TABLE stock_orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES presale_customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_orders_customer_id ON stock_orders(customer_id);;
