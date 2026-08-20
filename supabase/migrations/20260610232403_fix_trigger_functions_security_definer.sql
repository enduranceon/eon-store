
-- Recria sync_coach_history como SECURITY DEFINER
CREATE OR REPLACE FUNCTION sync_coach_history()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, NEW.start_date);
  ELSIF TG_OP = 'UPDATE' AND NEW.coach_id IS DISTINCT FROM OLD.coach_id THEN
    UPDATE assessment_contract_coach_history
       SET ended_at = CURRENT_DATE
     WHERE contract_id = NEW.id AND ended_at IS NULL;
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$$;

-- Recria generate_assessment_contract_number como SECURITY DEFINER
CREATE OR REPLACE FUNCTION generate_assessment_contract_number()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contract_number IS NULL THEN
    NEW.contract_number := 'ASS-' || LPAD(nextval('assessment_contract_number_seq')::text, 6, '0');
  END IF;
  IF NEW.original_end_date IS NULL THEN
    NEW.original_end_date := NEW.end_date;
  END IF;
  RETURN NEW;
END;
$$;
;
