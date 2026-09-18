BEGIN;

-- These ledgers are intentionally server-only. Browser roles already have
-- their table grants revoked; explicit restrictive policies make that
-- boundary auditable and keep future permissive policies from opening them.
CREATE POLICY backend_only_deny_browser_access
  ON public.assessment_contract_creation_operations
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY backend_only_deny_browser_access
  ON public.order_operations
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY backend_only_deny_browser_access
  ON public.stock_order_creation_operations
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY backend_only_deny_browser_access
  ON eon_private.public_store_checkout_rate_limits
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY backend_only_deny_browser_access
  ON public.assessment_contract_creation_operations IS
  'Explicitly denies browser roles; this idempotency ledger is service-only.';
COMMENT ON POLICY backend_only_deny_browser_access
  ON public.order_operations IS
  'Explicitly denies browser roles; this operation ledger is service-only.';
COMMENT ON POLICY backend_only_deny_browser_access
  ON public.stock_order_creation_operations IS
  'Explicitly denies browser roles; this idempotency ledger is service-only.';
COMMENT ON POLICY backend_only_deny_browser_access
  ON eon_private.public_store_checkout_rate_limits IS
  'Explicitly denies browser roles; rate limiting is enforced by the private backend transaction.';

CREATE SCHEMA IF NOT EXISTS extensions;

-- plpgsql_check is non-relocatable. Recreate it in the conventional extension
-- schema only when necessary, and fail before dropping it if an application
-- object has acquired a dependency that would make the move unsafe.
DO $migration$
DECLARE
  v_current_schema text;
  v_external_dependency text;
BEGIN
  SELECT namespace.nspname
  INTO v_current_schema
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'plpgsql_check';

  IF v_current_schema = 'public' THEN
    WITH extension_members AS (
      SELECT dependency.classid, dependency.objid, dependency.objsubid
      FROM pg_catalog.pg_depend AS dependency
      JOIN pg_catalog.pg_extension AS extension
        ON dependency.refclassid = 'pg_catalog.pg_extension'::regclass
       AND dependency.refobjid = extension.oid
      WHERE extension.extname = 'plpgsql_check'
        AND dependency.deptype = 'e'
    )
    SELECT pg_catalog.pg_describe_object(
      dependency.classid,
      dependency.objid,
      dependency.objsubid
    )
    INTO v_external_dependency
    FROM pg_catalog.pg_depend AS dependency
    JOIN extension_members AS member
      ON dependency.refclassid = member.classid
     AND dependency.refobjid = member.objid
     AND dependency.refobjsubid = member.objsubid
    WHERE NOT EXISTS (
      SELECT 1
      FROM extension_members AS own_member
      WHERE own_member.classid = dependency.classid
        AND own_member.objid = dependency.objid
        AND own_member.objsubid = dependency.objsubid
    )
    LIMIT 1;

    IF v_external_dependency IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '2BP01',
        MESSAGE = format(
          'plpgsql_check has an external dependency and cannot be moved safely: %s',
          v_external_dependency
        );
    END IF;

    EXECUTE 'DROP EXTENSION plpgsql_check';
    EXECUTE 'CREATE EXTENSION plpgsql_check WITH SCHEMA extensions';
  ELSIF v_current_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION plpgsql_check WITH SCHEMA extensions';
  ELSIF v_current_schema <> 'extensions' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'plpgsql_check is installed in unexpected schema %I',
        v_current_schema
      );
  END IF;
END;
$migration$;

COMMIT;
