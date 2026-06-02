-- Add cancellation_date column to assessment_contracts
-- This field stores when the cancellation was requested (allowing retroactive cancellation dates)
-- Used for accurate financial reporting and coach compensation calculation

ALTER TABLE assessment_contracts
ADD COLUMN cancellation_date DATE DEFAULT NULL;

-- Create index for efficient querying by status and cancellation_date
CREATE INDEX idx_assessment_contracts_status_cancellation_date
ON assessment_contracts(status, cancellation_date);

-- Add check constraint: cancellation_date must be >= start_date when status = 'cancelled'
ALTER TABLE assessment_contracts
ADD CONSTRAINT chk_cancellation_date_after_start
CHECK (status != 'cancelled' OR cancellation_date IS NULL OR cancellation_date >= start_date);

-- Backfill existing cancelled contracts: set cancellation_date = updated_at
UPDATE assessment_contracts
SET cancellation_date = updated_at::date
WHERE status = 'cancelled' AND cancellation_date IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN assessment_contracts.cancellation_date IS 'Date when cancellation was requested (allows retroactive dates). Used for accurate financial reporting. Must be >= start_date when status is cancelled.';
