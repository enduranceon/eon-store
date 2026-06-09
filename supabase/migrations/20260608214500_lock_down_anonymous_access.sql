-- Run only after the frontend has switched to the public RPC functions created
-- in 20260608213000_secure_public_checkout_and_sale_state.sql.

DROP POLICY IF EXISTS anon_read_campaigns ON public.presale_campaigns;
DROP POLICY IF EXISTS anon_read_categories ON public.presale_categories;
DROP POLICY IF EXISTS anon_insert_customers ON public.presale_customers;
DROP POLICY IF EXISTS anon_select_customers ON public.presale_customers;
DROP POLICY IF EXISTS anon_update_customers ON public.presale_customers;
DROP POLICY IF EXISTS anon_insert_orders ON public.presale_orders;
DROP POLICY IF EXISTS anon_select_recent_orders ON public.presale_orders;
DROP POLICY IF EXISTS anon_read_active_products ON public.presale_products;
DROP POLICY IF EXISTS anon_read_trainers ON public.presale_trainers;
DROP POLICY IF EXISTS anon_read_products ON public.products;
DROP POLICY IF EXISTS anon_insert_stock_orders ON public.stock_orders;
DROP POLICY IF EXISTS anon_select_recent_stock_orders ON public.stock_orders;
DROP POLICY IF EXISTS anon_read_stock_products ON public.stock_products;
DROP POLICY IF EXISTS anon_insert_uses ON public.coupon_uses;
