-- A função de escrita vive em eon_private, mas o PostgREST só enxerga o schema
-- public — sem este invólucro a api-v1 recebia erro genérico em vez da mensagem
-- real (evento fechado virava 500 em vez de 404). Mesmo padrão do
-- public.create_rate_limited_public_stock_order que protege a loja.
--
-- Continua exclusivo do service_role: anon não ganha caminho de escrita.
CREATE OR REPLACE FUNCTION public.create_rate_limited_public_event_registration(
  p_ip_hash TEXT,
  p_phone_hash TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT eon_private.create_rate_limited_public_event_registration(
    p_ip_hash,
    p_phone_hash,
    p_payload
  );
$$;

REVOKE ALL ON FUNCTION public.create_rate_limited_public_event_registration(TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_rate_limited_public_event_registration(TEXT, TEXT, JSONB)
  TO service_role;;
