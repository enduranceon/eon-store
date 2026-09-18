BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(23);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_extension
    WHERE extname = 'plpgsql_check'
  ),
  'plpgsql_check remains installed'
);

SELECT is(
  (
    SELECT namespace.nspname
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'plpgsql_check'
  ),
  'extensions',
  'plpgsql_check is outside the public schema'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_catalog.pg_policies
    WHERE policyname = 'backend_only_deny_browser_access'
      AND (schemaname, tablename) IN (
        ('public', 'assessment_contract_creation_operations'),
        ('public', 'order_operations'),
        ('public', 'stock_order_creation_operations'),
        ('eon_private', 'public_store_checkout_rate_limits')
      )
  ),
  4,
  'all server-only ledgers have an explicit browser-deny policy'
);

SELECT ok(
  relation.relrowsecurity,
  format('%I.%I keeps RLS enabled', namespace.nspname, relation.relname)
)
FROM (
  VALUES
    ('public', 'assessment_contract_creation_operations'),
    ('public', 'order_operations'),
    ('public', 'stock_order_creation_operations'),
    ('eon_private', 'public_store_checkout_rate_limits')
) AS expected(schema_name, table_name)
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.nspname = expected.schema_name
JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = namespace.oid
 AND relation.relname = expected.table_name;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies AS policy
    WHERE policy.schemaname = expected.schema_name
      AND policy.tablename = expected.table_name
      AND policy.policyname = 'backend_only_deny_browser_access'
      AND policy.permissive = 'RESTRICTIVE'
      AND policy.cmd = 'ALL'
      AND policy.roles @> ARRAY['anon', 'authenticated']::name[]
      AND policy.qual = 'false'
      AND policy.with_check = 'false'
  ),
  format('%I.%I explicitly denies anon and authenticated', expected.schema_name, expected.table_name)
)
FROM (
  VALUES
    ('public', 'assessment_contract_creation_operations'),
    ('public', 'order_operations'),
    ('public', 'stock_order_creation_operations'),
    ('eon_private', 'public_store_checkout_rate_limits')
) AS expected(schema_name, table_name);

SELECT ok(
  NOT has_table_privilege(
    'anon',
    format('%I.%I', expected.schema_name, expected.table_name),
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  format('anon has no DML grant on %I.%I', expected.schema_name, expected.table_name)
)
FROM (
  VALUES
    ('public', 'assessment_contract_creation_operations'),
    ('public', 'order_operations'),
    ('public', 'stock_order_creation_operations'),
    ('eon_private', 'public_store_checkout_rate_limits')
) AS expected(schema_name, table_name);

SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    format('%I.%I', expected.schema_name, expected.table_name),
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  format('authenticated has no DML grant on %I.%I', expected.schema_name, expected.table_name)
)
FROM (
  VALUES
    ('public', 'assessment_contract_creation_operations'),
    ('public', 'order_operations'),
    ('public', 'stock_order_creation_operations'),
    ('eon_private', 'public_store_checkout_rate_limits')
) AS expected(schema_name, table_name);

SELECT ok(
  has_table_privilege(
    'service_role',
    'public.assessment_contract_creation_operations',
    'SELECT,INSERT,UPDATE'
  ),
  'service_role keeps assessment contract idempotency access'
);
SELECT ok(
  has_table_privilege(
    'service_role',
    'public.order_operations',
    'SELECT,INSERT,UPDATE'
  ),
  'service_role keeps order operation access'
);
SELECT ok(
  has_table_privilege(
    'service_role',
    'public.stock_order_creation_operations',
    'SELECT,INSERT'
  ),
  'service_role keeps stock order idempotency access'
);
SELECT ok(
  has_table_privilege(
    'service_role',
    'eon_private.public_store_checkout_rate_limits',
    'SELECT,INSERT,DELETE'
  ),
  'service_role keeps public store rate-limit access'
);

SELECT * FROM finish();
ROLLBACK;
