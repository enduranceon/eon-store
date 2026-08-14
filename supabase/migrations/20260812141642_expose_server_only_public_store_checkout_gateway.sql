-- PostgREST only exposes the public schema. This wrapper is server-only and
-- forwards the Edge Function to the private, atomic checkout operation.

CREATE OR REPLACE FUNCTION public.create_rate_limited_public_stock_order(
  p_payload jsonb,
  p_ip_hash text,
  p_phone_hash text
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT eon_private.create_rate_limited_public_stock_order(
    p_payload,
    p_ip_hash,
    p_phone_hash
  );
$$;

REVOKE ALL ON FUNCTION public.create_rate_limited_public_stock_order(jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_rate_limited_public_stock_order(jsonb, text, text)
  TO service_role;
