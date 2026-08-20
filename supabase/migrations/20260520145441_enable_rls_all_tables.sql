
-- Enable RLS on all tables
ALTER TABLE presale_campaigns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE presale_products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE presale_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE presale_customers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE presale_trainers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE presale_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE presale_suppliers  ENABLE ROW LEVEL SECURITY;

-- ── presale_campaigns ────────────────────────────────────────────────────────
-- Anon: read only (needed for public store and checkout)
-- Authenticated: full access
CREATE POLICY "anon_read_campaigns"  ON presale_campaigns FOR SELECT TO anon        USING (true);
CREATE POLICY "auth_all_campaigns"   ON presale_campaigns FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── presale_products ─────────────────────────────────────────────────────────
-- Anon: read active products only
-- Authenticated: full access
CREATE POLICY "anon_read_active_products" ON presale_products FOR SELECT TO anon        USING (status = 'active');
CREATE POLICY "auth_all_products"         ON presale_products FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── presale_trainers ─────────────────────────────────────────────────────────
CREATE POLICY "anon_read_trainers" ON presale_trainers FOR SELECT TO anon        USING (true);
CREATE POLICY "auth_all_trainers"  ON presale_trainers FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── presale_categories ───────────────────────────────────────────────────────
CREATE POLICY "anon_read_categories" ON presale_categories FOR SELECT TO anon        USING (true);
CREATE POLICY "auth_all_categories"  ON presale_categories FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── presale_customers ────────────────────────────────────────────────────────
-- Anon: insert + select + update (needed for findOrCreateCustomer in public checkout)
-- Authenticated: full access
CREATE POLICY "anon_select_customers" ON presale_customers FOR SELECT TO anon        USING (true);
CREATE POLICY "anon_insert_customers" ON presale_customers FOR INSERT TO anon        WITH CHECK (true);
CREATE POLICY "anon_update_customers" ON presale_customers FOR UPDATE TO anon        USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_customers"    ON presale_customers FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── presale_orders ───────────────────────────────────────────────────────────
-- Anon: insert + select by UUID (for order confirmation page)
-- No anon UPDATE or DELETE (students can't modify orders)
-- Authenticated: full access
CREATE POLICY "anon_insert_orders" ON presale_orders FOR INSERT TO anon        WITH CHECK (true);
CREATE POLICY "anon_select_orders" ON presale_orders FOR SELECT TO anon        USING (true);
CREATE POLICY "auth_all_orders"    ON presale_orders FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── presale_suppliers ────────────────────────────────────────────────────────
-- No anon access (internal supplier data)
-- Authenticated: full access
CREATE POLICY "auth_all_suppliers" ON presale_suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);
;
