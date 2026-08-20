
ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS payment_date date,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS manual_payment boolean NOT NULL DEFAULT false;
;
