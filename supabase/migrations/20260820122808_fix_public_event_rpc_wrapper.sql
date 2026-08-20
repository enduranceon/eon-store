-- O wrapper publico precisa executar com o owner para conseguir chamar a
-- funcao privada. A funcao privada continua sem EXECUTE para anon/authenticated
-- e esta chamada expõe somente o JSON público do evento.
CREATE OR REPLACE FUNCTION public.get_public_event(p_slug TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT eon_private.get_public_event(p_slug);
$$;

REVOKE ALL ON FUNCTION public.get_public_event(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_event(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_event(TEXT) TO service_role;
