
ALTER TABLE presale_products ADD COLUMN IF NOT EXISTS campaign_ids uuid[] DEFAULT '{}';

-- Migrar campaign_id existente para campaign_ids
UPDATE presale_products
SET campaign_ids = ARRAY[campaign_id]
WHERE campaign_id IS NOT NULL AND (campaign_ids IS NULL OR campaign_ids = '{}');
;
