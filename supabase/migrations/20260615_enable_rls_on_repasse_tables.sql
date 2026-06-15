-- Habilita RLS nas tabelas de repasse/tiers que estavam expostas ao anon.
-- Replica o padrão das tabelas payout_* (permissive auth_full + restrictive app_admin_only):
-- acesso liberado apenas para administradores na allowlist (eon_private.is_app_admin()).

ALTER TABLE public.assessment_coach_repasse ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_growth_tiers  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_full ON public.assessment_coach_repasse;
CREATE POLICY auth_full ON public.assessment_coach_repasse
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS app_admin_only ON public.assessment_coach_repasse;
CREATE POLICY app_admin_only ON public.assessment_coach_repasse
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

DROP POLICY IF EXISTS auth_full ON public.assessment_growth_tiers;
CREATE POLICY auth_full ON public.assessment_growth_tiers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS app_admin_only ON public.assessment_growth_tiers;
CREATE POLICY app_admin_only ON public.assessment_growth_tiers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());
