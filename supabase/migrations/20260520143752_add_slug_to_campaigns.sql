
ALTER TABLE presale_campaigns ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

-- Generate slugs for existing campaigns
UPDATE presale_campaigns
SET slug = lower(
  regexp_replace(
    regexp_replace(
      translate(name,
        'áàãâäéèêëíìîïóòõôöúùûüçñÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇÑ',
        'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'
      ),
      '[^a-zA-Z0-9\s-]', '', 'g'
    ),
    '\s+', '-', 'g'
  )
)
WHERE slug IS NULL;
;
