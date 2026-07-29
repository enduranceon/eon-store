-- Separate internal coach availability from public-site visibility and define
-- which assessment modalities each coach can serve.

ALTER TABLE public.assessment_coaches
  ADD COLUMN IF NOT EXISTS public_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS modality_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- Preserve the previous catalog behaviour for existing active coaches, then
-- apply the two business rules confirmed for the current team.
UPDATE public.assessment_coaches
SET public_visible = active;

UPDATE public.assessment_coaches
SET modality_ids = ARRAY(
  SELECT id
  FROM public.assessment_modalities
  WHERE active IS TRUE
  ORDER BY name
)
WHERE cardinality(modality_ids) = 0;

UPDATE public.assessment_coaches
SET modality_ids = ARRAY(
  SELECT id
  FROM public.assessment_modalities
  WHERE lower(name) = 'corrida'
)
WHERE lower(name) = 'bruno jeremias';

UPDATE public.assessment_coaches
SET public_visible = false
WHERE lower(name) = 'guto fernandes';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'assessment_coaches_public_requires_active'
      AND conrelid = 'public.assessment_coaches'::regclass
  ) THEN
    ALTER TABLE public.assessment_coaches
      ADD CONSTRAINT assessment_coaches_public_requires_active
      CHECK (NOT public_visible OR active);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assessment_coaches_modality_ids_idx
  ON public.assessment_coaches USING gin (modality_ids);

DROP POLICY IF EXISTS anon_read_active_coaches ON public.assessment_coaches;
CREATE POLICY anon_read_active_coaches ON public.assessment_coaches
  FOR SELECT TO anon
  USING (active IS TRUE AND public_visible IS TRUE);

CREATE OR REPLACE FUNCTION eon_private.enforce_contract_coach_modality()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_coach_active boolean;
  v_coach_modalities uuid[];
  v_plan_modality_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.coach_id IS NOT DISTINCT FROM OLD.coach_id
     AND NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id THEN
    RETURN NEW;
  END IF;

  SELECT active, modality_ids
  INTO v_coach_active, v_coach_modalities
  FROM public.assessment_coaches
  WHERE id = NEW.coach_id;

  SELECT modality_id
  INTO v_plan_modality_id
  FROM public.assessment_plans
  WHERE id = NEW.plan_id;

  IF v_coach_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador interno indisponível';
  END IF;
  IF v_plan_modality_id IS NULL OR NOT (v_plan_modality_id = ANY(v_coach_modalities)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador não atende a modalidade deste plano';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_contract_coach_modality
  ON public.assessment_contracts;
CREATE TRIGGER enforce_contract_coach_modality
  BEFORE INSERT OR UPDATE OF coach_id, plan_id
  ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.enforce_contract_coach_modality();

CREATE OR REPLACE FUNCTION eon_private.enforce_public_submission_coach()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  SELECT c.active IS TRUE
     AND c.public_visible IS TRUE
     AND p.modality_id = ANY(c.modality_ids)
  INTO v_allowed
  FROM public.assessment_coaches c
  JOIN public.assessment_plans p ON p.id = NEW.plan_id
  WHERE c.id = NEW.coach_id;

  IF v_allowed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador indisponível para este plano no site';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_public_submission_coach
  ON public.assessment_prospect_submissions;
CREATE TRIGGER enforce_public_submission_coach
  BEFORE INSERT
  ON public.assessment_prospect_submissions
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.enforce_public_submission_coach();

REVOKE ALL ON FUNCTION eon_private.enforce_contract_coach_modality() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.enforce_public_submission_coach() FROM PUBLIC;
