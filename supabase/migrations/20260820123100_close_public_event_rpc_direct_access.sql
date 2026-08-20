-- A leitura pública de eventos passou para a api-v1, que chama esta função
-- com service_role. Mantemos o wrapper fora do acesso anon direto para evitar
-- SECURITY DEFINER exposto via PostgREST.
CREATE OR REPLACE FUNCTION public.get_public_event(p_slug TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT eon_private.get_public_event(p_slug);
$$;

REVOKE ALL ON FUNCTION public.get_public_event(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_event(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_event(TEXT) TO service_role;
