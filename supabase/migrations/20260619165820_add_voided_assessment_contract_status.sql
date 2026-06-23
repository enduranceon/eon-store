-- Separate sales that never became real contracts from actual cancellations.
-- `voided` means the sale was annulled before payment, so it should not count as churn.

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
        'voided'::text
      ]
    )
  );

COMMENT ON CONSTRAINT assessment_contracts_status_check ON assessment_contracts IS
  'Allowed assessment contract lifecycle statuses. voided = sale annulled before payment; not a real cancellation/churn.';

UPDATE assessment_contracts
SET status = 'voided',
    updated_at = NOW()
WHERE status = 'cancelled'
  AND payment_status = 'cancelled'
  AND payment_date IS NULL
  AND refund_amount IS NULL
  AND COALESCE(cancellation_fee, 0) = 0
  AND (
    LOWER(COALESCE(cancellation_reason, '')) LIKE '%venda não concretizada%'
    OR LOWER(COALESCE(cancellation_reason, '')) LIKE '%venda nao concretizada%'
    OR LOWER(COALESCE(cancellation_reason, '')) LIKE '%venda substituída%'
    OR LOWER(COALESCE(cancellation_reason, '')) LIKE '%venda substituida%'
    OR LOWER(COALESCE(cancellation_reason, '')) LIKE '%cliente nunca pagou%'
  );
