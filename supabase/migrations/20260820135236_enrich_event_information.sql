-- Enrich event records so an event can be planned before every detail exists
-- and then published with enough public/internal operational context.
ALTER TABLE public.events
  ALTER COLUMN event_date DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time TIME,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS online_url TEXT,
  ADD COLUMN IF NOT EXISTS public_notes TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'events_date_range_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_date_range_check
      CHECK (end_date IS NULL OR (event_date IS NOT NULL AND end_date >= event_date));
  END IF;
END $$;

-- Keep the public event RPC as the only public shape. It exposes public-safe
-- fields and keeps internal notes private.
CREATE OR REPLACE FUNCTION eon_private.get_public_event(p_slug TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_types JSONB;
BEGIN
  SELECT * INTO v_event
  FROM public.events
  WHERE slug = NULLIF(trim(p_slug), '') AND status = 'open';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(t ORDER BY t_sort, t_name), '[]'::jsonb) INTO v_types
  FROM (
    SELECT
      jsonb_build_object(
        'id', rt.id,
        'name', rt.name,
        'price', rt.price,
        'form_fields', rt.form_fields,
        'spots_left', CASE
          WHEN rt.max_quantity IS NULL THEN NULL
          ELSE GREATEST(rt.max_quantity - (
            SELECT count(*) FROM public.event_registrations r
            WHERE r.registration_type_id = rt.id AND r.payment_status <> 'cancelled'
          ), 0)
        END
      ) AS t,
      rt.sort_order AS t_sort,
      rt.name AS t_name
    FROM public.event_registration_types rt
    WHERE rt.event_id = v_event.id AND rt.active = true
  ) sub;

  RETURN jsonb_build_object(
    'id', v_event.id,
    'name', v_event.name,
    'slug', v_event.slug,
    'description', v_event.description,
    'event_date', v_event.event_date,
    'end_date', v_event.end_date,
    'start_time', CASE WHEN v_event.start_time IS NULL THEN NULL ELSE to_char(v_event.start_time, 'HH24:MI') END,
    'end_time', CASE WHEN v_event.end_time IS NULL THEN NULL ELSE to_char(v_event.end_time, 'HH24:MI') END,
    'location', v_event.location,
    'address', v_event.address,
    'online_url', v_event.online_url,
    'public_notes', v_event.public_notes,
    'registration_types', v_types
  );
END;
$$;

REVOKE ALL ON FUNCTION eon_private.get_public_event(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.get_public_event(TEXT)
  TO service_role;
