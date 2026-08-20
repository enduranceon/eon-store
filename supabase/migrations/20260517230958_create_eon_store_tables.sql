
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
;
