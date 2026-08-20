
-- Remove enumeração pública de cupons (anon). Agora só via edge function validate-coupon.
DROP POLICY IF EXISTS "anon_read_active" ON coupons;
;
