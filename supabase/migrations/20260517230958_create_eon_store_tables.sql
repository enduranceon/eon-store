
-- Suppliers
CREATE TABLE IF NOT EXISTS presale_suppliers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  contact_name  text,
  whatsapp      text,
  email         text,
  website       text,
  notes         text,
  created_date  timestamptz DEFAULT now(),
  updated_date  timestamptz
);

-- Categories
CREATE TABLE IF NOT EXISTS presale_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  subcategories   text[] DEFAULT '{}',
  created_date    timestamptz DEFAULT now(),
  updated_date    timestamptz
);

-- Trainers
CREATE TABLE IF NOT EXISTS presale_trainers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  whatsapp      text,
  email         text,
  created_date  timestamptz DEFAULT now(),
  updated_date  timestamptz
);

-- Campaigns
CREATE TABLE IF NOT EXISTS presale_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  description     text,
  status          text DEFAULT 'draft',
  start_date      date,
  end_date        date,
  goal_amount     numeric(10,2),
  product_order   text[],
  created_date    timestamptz DEFAULT now(),
  updated_date    timestamptz
);

-- Products
CREATE TABLE IF NOT EXISTS presale_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid REFERENCES presale_campaigns(id) ON DELETE SET NULL,
  name            text NOT NULL,
  description     text,
  status          text DEFAULT 'active',
  sale_price      numeric(10,2),
  regular_price   numeric(10,2),
  cost_price      numeric(10,2),
  supplier_id     uuid REFERENCES presale_suppliers(id) ON DELETE SET NULL,
  supplier        text,
  category        text,
  subcategory     text,
  variations      jsonb DEFAULT '[]',
  images          text[] DEFAULT '{}',
  created_date    timestamptz DEFAULT now(),
  updated_date    timestamptz
);

-- Customers
CREATE TABLE IF NOT EXISTS presale_customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text NOT NULL,
  whatsapp      text,
  email         text,
  trainer       text,
  created_date  timestamptz DEFAULT now(),
  updated_date  timestamptz
);

-- Orders
CREATE TABLE IF NOT EXISTS presale_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number    text UNIQUE,
  campaign_id     uuid REFERENCES presale_campaigns(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES presale_customers(id) ON DELETE SET NULL,
  customer_name   text,
  customer_whatsapp text,
  customer_email  text,
  trainer         text,
  status          text DEFAULT 'pending',
  items           jsonb DEFAULT '[]',
  total_amount    numeric(10,2),
  notes           text,
  created_date    timestamptz DEFAULT now(),
  updated_date    timestamptz
);

-- Legacy store tables were created before migrations were tracked. Keep this
-- baseline here so a clean database can replay the complete application schema.
CREATE TABLE IF NOT EXISTS products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_date  timestamptz DEFAULT now(),
  updated_date  timestamptz DEFAULT now(),
  name          text NOT NULL,
  description   text,
  category      text,
  subcategory   text,
  images        jsonb DEFAULT '[]'::jsonb,
  sale_price    numeric DEFAULT 0,
  regular_price numeric DEFAULT 0,
  cost_price    numeric DEFAULT 0,
  extra_cost    numeric DEFAULT 0,
  supplier      text,
  supplier_id   uuid,
  notes         text,
  status        text DEFAULT 'active',
  variations    jsonb DEFAULT '[]'::jsonb,
  extras        jsonb DEFAULT '[]'::jsonb
);

ALTER TABLE presale_products
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id);

CREATE TABLE IF NOT EXISTS stock_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_date    timestamptz DEFAULT now(),
  updated_date    timestamptz DEFAULT now(),
  name            text NOT NULL,
  description     text,
  category        text,
  subcategory     text,
  images          jsonb DEFAULT '[]'::jsonb,
  sale_price      numeric DEFAULT 0,
  regular_price   numeric DEFAULT 0,
  cost_price      numeric DEFAULT 0,
  quantity        integer DEFAULT 0,
  status          text DEFAULT 'active',
  notes           text,
  product_id      uuid REFERENCES products(id),
  supplier        text,
  supplier_id     uuid,
  product_number  integer,
  variations      jsonb NOT NULL DEFAULT '[]'::jsonb,
  extras          jsonb NOT NULL DEFAULT '[]'::jsonb,
  show_in_store   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS stock_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        text UNIQUE,
  created_date        timestamptz DEFAULT now(),
  updated_date        timestamptz DEFAULT now(),
  customer_name       text,
  customer_whatsapp   text,
  customer_email      text,
  items               jsonb DEFAULT '[]'::jsonb,
  total_value         numeric DEFAULT 0,
  payment_method      text,
  payment_status      text DEFAULT 'awaiting_charge',
  delivery_status     text DEFAULT 'awaiting_delivery',
  delivery_method     text,
  delivery_city       text,
  internal_notes      text,
  payment_date        date,
  delivery_date       date
);

CREATE SEQUENCE IF NOT EXISTS stock_order_number_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_stock_order_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.order_number := 'EST-' || LPAD(nextval('stock_order_number_seq')::text, 6, '0');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_stock_order_number ON stock_orders;
CREATE TRIGGER set_stock_order_number
  BEFORE INSERT ON stock_orders
  FOR EACH ROW
  WHEN (NEW.order_number IS NULL)
  EXECUTE FUNCTION public.generate_stock_order_number();

-- Sequence for order numbers
CREATE SEQUENCE IF NOT EXISTS presale_order_seq START 1;

-- Function to auto-generate order numbers
CREATE OR REPLACE FUNCTION set_order_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.order_number IS NULL THEN
    NEW.order_number := 'PED-' || LPAD(nextval('presale_order_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_number
  BEFORE INSERT ON presale_orders
  FOR EACH ROW EXECUTE FUNCTION set_order_number();

-- Seed default trainers
INSERT INTO presale_trainers (name) VALUES
  ('Bruno Jeremias'),
  ('Elinai Freitas'),
  ('Guto Fernandes'),
  ('Thais Prando'),
  ('Denis Santana'),
  ('Jéssica Vieira')
ON CONFLICT DO NOTHING;

-- Disable RLS for admin-only app (all access via service key)
ALTER TABLE presale_suppliers  DISABLE ROW LEVEL SECURITY;
ALTER TABLE presale_categories DISABLE ROW LEVEL SECURITY;
ALTER TABLE presale_trainers   DISABLE ROW LEVEL SECURITY;
ALTER TABLE presale_campaigns  DISABLE ROW LEVEL SECURITY;
ALTER TABLE presale_products   DISABLE ROW LEVEL SECURITY;
ALTER TABLE presale_customers  DISABLE ROW LEVEL SECURITY;
ALTER TABLE presale_orders     DISABLE ROW LEVEL SECURITY;
ALTER TABLE products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_orders       ENABLE ROW LEVEL SECURITY;
;
