ALTER TABLE presale_products ADD COLUMN IF NOT EXISTS extras JSONB DEFAULT '[]'::jsonb;;
