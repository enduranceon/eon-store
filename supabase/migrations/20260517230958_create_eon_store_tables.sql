
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
  payment_method  text,
  delivery_method text,
  delivery_city   text,
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

-- Calendar helpers were also created before migrations were tracked.
CREATE OR REPLACE FUNCTION public.br_easter_date(year_in integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a int; b int; c int; d int; e int; f int; g int; h int;
  i int; k int; l int; m int; mo int; dy int;
BEGIN
  a := year_in % 19;
  b := year_in / 100;
  c := year_in % 100;
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  mo := (h + l - 7 * m + 114) / 31;
  dy := ((h + l - 7 * m + 114) % 31) + 1;
  RETURN make_date(year_in, mo, dy);
END;
$$;

CREATE OR REPLACE FUNCTION public.br_is_holiday(d date)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  yr int := EXTRACT(YEAR FROM d);
  easter date := br_easter_date(yr);
  mmdd text := to_char(d, 'MM-DD');
BEGIN
  IF mmdd IN ('01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25') THEN
    RETURN true;
  END IF;
  IF d = easter - 48 THEN RETURN true; END IF;
  IF d = easter - 47 THEN RETURN true; END IF;
  IF d = easter - 2 THEN RETURN true; END IF;
  IF d = easter + 60 THEN RETURN true; END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.br_next_business_day(d date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_day date := d;
  i int := 0;
BEGIN
  WHILE i < 30 LOOP
    IF EXTRACT(DOW FROM current_day) NOT IN (0, 6) AND NOT br_is_holiday(current_day) THEN
      RETURN current_day;
    END IF;
    current_day := current_day + 1;
    i := i + 1;
  END LOOP;
  RETURN current_day;
END;
$$;

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
