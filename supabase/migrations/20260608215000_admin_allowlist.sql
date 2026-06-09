CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID DEFAULT auth.uid()
);

ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

-- The project currently has a single trusted administrator. Existing users are
-- allowlisted during rollout; future users must be added deliberately.
INSERT INTO public.app_admins(user_id, created_by)
SELECT id, NULL
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION eon_private.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_admins
    WHERE user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT eon_private.is_app_admin();
$$;

REVOKE ALL ON FUNCTION eon_private.is_app_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_app_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION eon_private.is_app_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated;

-- A restrictive policy is combined with every existing permissive policy.
-- This preserves the current admin behavior while denying newly created,
-- non-allowlisted accounts across the whole public schema.
DO $$
DECLARE
  v_table RECORD;
BEGIN
  FOR v_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_admin_only ON public.%I', v_table.relname);
    EXECUTE format(
      'CREATE POLICY app_admin_only ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin())',
      v_table.relname
    );
  END LOOP;
END;
$$;
