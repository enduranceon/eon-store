-- Capa da página de inscrição do evento (faixa 4:1 no topo, como no Google
-- Forms). A imagem fica no bucket público event-covers; o evento guarda só o
-- caminho do arquivo. O envio passa por URL assinada da api-v1, o navegador
-- não tem escrita própria no bucket.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS cover_image_path text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_cover_image_path_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_cover_image_path_check CHECK (
    cover_image_path IS NULL
    OR cover_image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
  );

COMMENT ON COLUMN public.events.cover_image_path IS
  'Capa da página de inscrição: <event_id>/<arquivo> no bucket event-covers.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'event-covers',
  'event-covers',
  true,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Troca (ou remove, com NULL) a capa e devolve a anterior, para a API apagar o
-- arquivo antigo do bucket.
CREATE OR REPLACE FUNCTION public.set_event_cover_image(
  p_event_id uuid,
  p_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_path text := NULLIF(btrim(p_path), '');
  v_previous text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Evento inválido';
  END IF;
  IF v_path IS NOT NULL
     AND v_path !~ ('^' || p_event_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Arquivo da capa inválido';
  END IF;

  SELECT cover_image_path INTO v_previous
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Evento não encontrado';
  END IF;

  UPDATE public.events
  SET cover_image_path = v_path,
      updated_at = now()
  WHERE id = p_event_id;

  RETURN jsonb_build_object('cover_image_path', v_path, 'previous_path', v_previous);
END;
$$;

REVOKE ALL ON FUNCTION public.set_event_cover_image(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_event_cover_image(uuid, text) TO service_role;

-- A página pública recebe o caminho da capa.
DO $do$
DECLARE
  v_def text;
  v_anchor constant text := $a$    'public_notes', v_event.public_notes,
$a$;
BEGIN
  v_def := pg_get_functiondef('eon_private.get_public_event(text)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'get_public_event: public_notes não encontrado uma única vez';
  END IF;
  v_def := replace(v_def, v_anchor, $a$    'public_notes', v_event.public_notes,
    'cover_image_path', v_event.cover_image_path,
$a$);
  EXECUTE v_def;
END
$do$;
