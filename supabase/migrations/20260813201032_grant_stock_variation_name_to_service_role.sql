-- `replace_stock_order_items_from_api` runs as SECURITY INVOKER through the
-- admin Edge Function. The function validates stock variations with this
-- private helper, so its server-only caller needs explicit EXECUTE access.
-- Do not grant this to PUBLIC, anon, or authenticated roles.
GRANT EXECUTE ON FUNCTION eon_private.stock_variation_name(JSONB)
  TO service_role;
