-- Reset prospect commercial state when an unpaid prospect changes plan.
-- The previous payment link/proposal belongs to the old price and must not stay
-- marked as sent after the plan is adjusted.

CREATE OR REPLACE FUNCTION eon_private.reset_prospect_pipeline_on_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.prospect_stage IN ('proposal_ready', 'payment_link_sent')
     AND NEW.prospect_stage = OLD.prospect_stage
     AND NEW.plan_id IS DISTINCT FROM OLD.plan_id
     AND NEW.payment_status IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
     AND NEW.payment_date IS NULL
     AND COALESCE(NEW.manual_payment, false) IS FALSE THEN
    NEW.prospect_stage := 'new';
    NEW.prospect_proposal_ready_at := NULL;
    NEW.prospect_message_sent_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reset_prospect_pipeline_on_plan_change
  ON public.assessment_contracts;
CREATE TRIGGER reset_prospect_pipeline_on_plan_change
  BEFORE UPDATE OF plan_id ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.reset_prospect_pipeline_on_plan_change();

REVOKE ALL ON FUNCTION eon_private.reset_prospect_pipeline_on_plan_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.reset_prospect_pipeline_on_plan_change()
  TO service_role;
