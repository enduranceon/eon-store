-- Add cancellation_date column to assessment_contracts
ALTER TABLE public.assessment_contracts
ADD COLUMN cancellation_date DATE;

-- Add comment for clarity
COMMENT ON COLUMN public.assessment_contracts.cancellation_date IS 'Date when cancellation was requested (may be retroactive). Used for accurate financial calculations and reporting.';

-- Create index for reporting queries that filter by cancellation date
CREATE INDEX idx_assessment_contracts_status_cancellation_date 
ON public.assessment_contracts(status, cancellation_date)
WHERE status = 'cancelled';

-- Backfill: Set cancellation_date = updated_at::date for existing cancelled contracts
UPDATE public.assessment_contracts
SET cancellation_date = updated_at::date
WHERE status = 'cancelled' AND cancellation_date IS NULL;

-- Add check constraint (cancellation_date must be >= start_date if present)
ALTER TABLE public.assessment_contracts
ADD CONSTRAINT check_cancellation_date_after_start
CHECK (cancellation_date IS NULL OR cancellation_date >= start_date);;
