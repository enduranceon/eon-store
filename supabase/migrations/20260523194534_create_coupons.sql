
CREATE TABLE IF NOT EXISTS coupons (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text        NOT NULL,
  description              text,
  discount_type            text        NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value           numeric     NOT NULL CHECK (discount_value > 0),
  min_purchase             numeric     DEFAULT 0,
  max_discount             numeric,                  -- cap quando for %
  valid_from               date,
  valid_until              date,
  usage_limit_total        integer,                  -- NULL = ilimitado
  usage_limit_per_customer integer     DEFAULT 1,
  active                   boolean     NOT NULL DEFAULT true,
  uses_count               integer     NOT NULL DEFAULT 0,
  created_date             timestamptz DEFAULT now(),
  updated_date             timestamptz
);

-- Code case-insensitive
CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_lower_unique ON coupons (lower(code));

ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_full_access" ON coupons
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_read_active" ON coupons
  FOR SELECT TO anon USING (active = true);

-- Trilha de uso (audit + per-customer limit)
CREATE TABLE IF NOT EXISTS coupon_uses (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id           uuid        REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_code         text        NOT NULL,
  order_id            uuid        NOT NULL,
  order_type          text        NOT NULL CHECK (order_type IN ('presale', 'stock')),
  order_number        text,
  customer_identifier text,        -- whatsapp ou email (normalizado)
  customer_name       text,
  discount_applied    numeric     NOT NULL,
  used_at             timestamptz DEFAULT now(),
  cancelled           boolean     DEFAULT false
);

ALTER TABLE coupon_uses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_full_access_uses" ON coupon_uses
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_insert_uses" ON coupon_uses
  FOR INSERT TO anon WITH CHECK (true);

CREATE INDEX IF NOT EXISTS coupon_uses_lookup_idx
  ON coupon_uses(coupon_id, customer_identifier) WHERE cancelled = false;

-- Colunas nas tabelas de pedidos
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS coupon_code    text;
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS discount_value numeric DEFAULT 0;
ALTER TABLE stock_orders   ADD COLUMN IF NOT EXISTS coupon_code    text;
ALTER TABLE stock_orders   ADD COLUMN IF NOT EXISTS discount_value numeric DEFAULT 0;
;
