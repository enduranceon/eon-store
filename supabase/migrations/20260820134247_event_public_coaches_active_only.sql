-- Event public registration links should offer every internally active coach.
-- The public_visible flag is reserved for public assessment plan pages.
DO $$
DECLARE
  v_definition TEXT;
  v_updated_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('eon_private.create_public_event_registration(jsonb)'::regprocedure)
  INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Function eon_private.create_public_event_registration(jsonb) not found';
  END IF;

  v_updated_definition := replace(
    v_definition,
    E'\n      AND public_visible IS TRUE',
    ''
  );

  IF v_updated_definition = v_definition THEN
    RAISE EXCEPTION 'Expected public_visible filter was not found in eon_private.create_public_event_registration(jsonb)';
  END IF;

  EXECUTE v_updated_definition;
END $$;

REVOKE ALL ON FUNCTION eon_private.create_public_event_registration(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.create_public_event_registration(JSONB)
  TO service_role;
