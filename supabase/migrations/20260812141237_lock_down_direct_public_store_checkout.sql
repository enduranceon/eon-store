-- Deploy this only after the Edge Function and browser checkout have switched
-- to public-store-checkout. It closes the old browser-callable RPC route.

REVOKE ALL ON FUNCTION public.create_public_stock_order(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.create_public_stock_order(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.create_rate_limited_public_stock_order(jsonb, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION eon_private.create_public_stock_order(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.create_rate_limited_public_stock_order(jsonb, text, text) TO service_role;
