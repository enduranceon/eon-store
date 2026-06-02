-- Espelha product_number em presale_products (evita JOIN toda vez)
-- e re-escreve os SKUs das variations no padrão novo (NNNN-SIZE-GENDER).
-- Mantém old_sku para histórico.

ALTER TABLE presale_products ADD COLUMN IF NOT EXISTS product_number INTEGER;

-- Backfill via product_id
UPDATE presale_products pp
SET product_number = p.product_number
FROM products p
WHERE pp.product_id = p.id
  AND pp.product_number IS NULL;

-- Reescreve SKUs nas variations
UPDATE presale_products pp
SET variations = updated.new_variations
FROM (
  SELECT
    pp2.id,
    jsonb_agg(
      jsonb_set(
        CASE
          WHEN elem ? 'sku' AND elem->>'sku' IS NOT NULL AND elem->>'sku' != ''
            THEN jsonb_set(elem, '{old_sku}', to_jsonb(elem->>'sku'))
          ELSE elem
        END,
        '{sku}', to_jsonb(
          LPAD(pp2.product_number::text, 4, '0') ||
          CASE WHEN elem->>'size' != '' AND elem->>'size' IS NOT NULL THEN '-' || (elem->>'size') ELSE '' END ||
          CASE
            WHEN elem->>'gender' = 'Masculino' THEN '-M'
            WHEN elem->>'gender' = 'Feminino' THEN '-F'
            WHEN elem->>'gender' = 'Unissex'   THEN '-U'
            ELSE ''
          END
        )
      )
      ORDER BY ord
    ) AS new_variations
  FROM presale_products pp2,
       jsonb_array_elements(pp2.variations) WITH ORDINALITY AS t(elem, ord)
  WHERE pp2.product_number IS NOT NULL
    AND pp2.variations IS NOT NULL
    AND jsonb_array_length(pp2.variations) > 0
  GROUP BY pp2.id, pp2.product_number
) updated
WHERE pp.id = updated.id;

COMMENT ON COLUMN presale_products.product_number IS
  'Espelho do product_number da biblioteca central (products). Atualizado em sincronia.';
