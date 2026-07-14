-- Allow approved contracts/renewals whose operational start date is in the future.
-- scheduled = sale/renewal approved and billable, but not active for MRR/headcount yet.

ALTER TABLE assessment_contracts
  DROP CONSTRAINT IF EXISTS assessment_contracts_status_check;

ALTER TABLE assessment_contracts
  ADD CONSTRAINT assessment_contracts_status_check
  CHECK (
    status = ANY (
      ARRAY[
        'active'::text,
        'overdue'::text,
        'cancelled'::text,
        'finished'::text,
        'on_leave'::text,
        'draft'::text,
        'voided'::text,
        'scheduled'::text
      ]
    )
  );

COMMENT ON CONSTRAINT assessment_contracts_status_check ON assessment_contracts IS
  'Allowed assessment contract lifecycle statuses. scheduled = approved/billable future-start contract; not active/MRR until start_date.';
