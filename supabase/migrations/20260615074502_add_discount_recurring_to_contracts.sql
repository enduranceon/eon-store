
ALTER TABLE assessment_contracts
ADD COLUMN IF NOT EXISTS discount_recurring BOOLEAN NOT NULL DEFAULT false;
;
