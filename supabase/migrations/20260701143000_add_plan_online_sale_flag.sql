ALTER TABLE public.assessment_plans
  ADD COLUMN IF NOT EXISTS available_online BOOLEAN NOT NULL DEFAULT false;

UPDATE public.assessment_plans
SET available_online = true
WHERE active = true
  AND available_online = false;

DROP POLICY IF EXISTS "anon_read_active_plans" ON public.assessment_plans;
DROP POLICY IF EXISTS "anon_read_online_plans" ON public.assessment_plans;
CREATE POLICY "anon_read_online_plans"
  ON public.assessment_plans FOR SELECT TO anon
  USING (active = true AND available_online = true);

DROP POLICY IF EXISTS "anon_insert_draft_contracts" ON public.assessment_contracts;
CREATE POLICY "anon_insert_draft_contracts"
  ON public.assessment_contracts FOR INSERT TO anon
  WITH CHECK (
    status = 'draft'
    AND EXISTS (
      SELECT 1
      FROM public.assessment_plans p
      WHERE p.id = assessment_contracts.plan_id
        AND p.active = true
        AND p.available_online = true
    )
  );
