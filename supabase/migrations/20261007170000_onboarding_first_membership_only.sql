-- Onboarding is only for a person's first membership, paid recently.
--
-- The previous rule looked for an earlier contract only among rows registered
-- before the current one. History imported later (Tecnofit) and contracts of
-- migrated students were therefore invisible, and continuing students entered
-- the welcome queue as if they were new. Returns after a gap also received the
-- full new-student onboarding, and the first sync opened welcomes for payments
-- made months earlier.
--
-- Now any earlier real membership, ordered by the contract dates rather than by
-- registration time, keeps the contract out of onboarding, as does a payment
-- older than 30 days. Existing open cases are re-evaluated by the explicit
-- sync path, not by this migration.
CREATE OR REPLACE FUNCTION eon_private.communication_onboarding_eligible(
  p_contract_id uuid
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id=p_contract_id;
  IF NOT FOUND OR v_contract.parent_contract_id IS NOT NULL
     OR v_contract.customer_id IS NULL OR v_contract.start_date IS NULL
     OR v_contract.created_at IS NULL
     OR v_contract.payment_status<>'paid'
     OR v_contract.status NOT IN ('active','scheduled','on_leave')
     OR v_contract.prospect_customer_relationship IN ('active_student','former_student')
     OR EXISTS (SELECT 1 FROM public.assessment_contract_event e
       WHERE e.contract_id=p_contract_id AND e.event_type='onboarding_checkin_sent') THEN
    RETURN false;
  END IF;

  IF COALESCE(v_contract.payment_date, v_contract.start_date)
     < (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30 THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM public.assessment_contracts old
    WHERE old.customer_id=v_contract.customer_id AND old.id<>v_contract.id
      AND (
        old.start_date<v_contract.start_date
        OR old.id=v_contract.prospect_previous_contract_id
        OR (old.start_date=v_contract.start_date AND (
          old.created_at<v_contract.created_at
          OR (old.created_at=v_contract.created_at
            AND CASE
              WHEN old.contract_number ~ '^ASS-[0-9]+$'
                AND v_contract.contract_number ~ '^ASS-[0-9]+$'
              THEN substring(old.contract_number FROM 5)::numeric
                < substring(v_contract.contract_number FROM 5)::numeric
              ELSE false END)))
      )
      AND (
        old.status IN ('active','overdue','on_leave','finished')
        OR (old.status IN ('cancelled','scheduled') AND (
          old.payment_status='paid' OR old.payment_date IS NOT NULL
          OR COALESCE(old.manual_payment,false)))
      )
  );
END;
$$;
REVOKE ALL ON FUNCTION eon_private.communication_onboarding_eligible(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_onboarding_eligible(uuid)
  TO service_role;
