ALTER TABLE presale_campaigns ADD COLUMN IF NOT EXISTS receipts jsonb DEFAULT '{}'::jsonb;;
