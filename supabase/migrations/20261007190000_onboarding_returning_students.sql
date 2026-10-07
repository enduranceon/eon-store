-- Returning students get the same onboarding as new students.
--
-- An earlier membership keeps the contract out of onboarding only when it
-- reached the new start date or ended at most 30 days before it: that is a
-- renewal, even if late. After a longer break the person is a returning
-- student and enters onboarding again. A prospect marked as former student no
-- longer needs a recorded membership to enter.
--
-- Unchanged from 20261007170000: memberships are ordered by contract dates,
-- not by registration time; system renewals, students marked as active and
-- payments older than 30 days stay out.
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
     OR v_contract.prospect_customer_relationship='active_student'
     OR EXISTS (SELECT 1 FROM public.assessment_contract_event e
       WHERE e.contract_id=p_contract_id AND e.event_type='onboarding_checkin_sent') THEN
    RETURN false;
  END IF;

  IF COALESCE(v_contract.payment_date, v_contract.start_date)
     < (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30 THEN
    RETURN false;
  END IF;

  -- end_date is exclusive and a cancellation date still counts as an active
  -- day, so coverage ends on cancellation_date + 1 for cancelled contracts.
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
      AND (
        CASE
          WHEN old.status='cancelled' AND old.cancellation_date IS NOT NULL
            THEN old.cancellation_date + 1
          ELSE old.end_date
        END >= v_contract.start_date - 30
      ) IS NOT FALSE
  );
END;
$$;
REVOKE ALL ON FUNCTION eon_private.communication_onboarding_eligible(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_onboarding_eligible(uuid)
  TO service_role;
