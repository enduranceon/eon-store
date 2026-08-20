
-- Remove legacy text trainer columns
ALTER TABLE presale_customers DROP COLUMN IF EXISTS trainer;
ALTER TABLE presale_orders DROP COLUMN trainer;
ALTER TABLE presale_orders DROP COLUMN checkout_trainer;
;
