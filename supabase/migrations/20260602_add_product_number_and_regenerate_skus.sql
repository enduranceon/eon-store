-- Novo padrão de SKU: NNNN-SIZE-GENDER (ex: 0042-M-F)
-- - NNNN: product_number sequencial auto-incremental único (4 dígitos)
-- - SIZE: PP/P/M/G/GG/XG ou 34..48 (opcional)
-- - GENDER: M=Masculino, F=Feminino, U=Unissex (opcional)
--
-- Substitui o padrão antigo EON-CAT-ABBR-G-T que tinha problemas de:
-- colisão por nome similar, ausência de unicidade no banco, e tamanho
-- excessivo (16+ chars).

-- 1. Adiciona coluna product_number (auto-incremental único)
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_number INTEGER;

-- 2. Cria sequence
CREATE SEQUENCE IF NOT EXISTS products_number_seq START 1;

-- 3. Backfill: atribui números a produtos existentes em ordem de created_date
UPDATE products
SET product_number = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_date) AS rn
  FROM products
  WHERE product_number IS NULL
) sub
WHERE products.id = sub.id;

-- 4. Avança sequence pro próximo valor após o maior usado
SELECT setval('products_number_seq', GREATEST(COALESCE((SELECT MAX(product_number) FROM products), 0), 1));

-- 5. Define default + NOT NULL + UNIQUE
ALTER TABLE products ALTER COLUMN product_number SET DEFAULT nextval('products_number_seq');
ALTER TABLE products ALTER COLUMN product_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'products_product_number_key'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_product_number_key UNIQUE (product_number);
  END IF;
END $$;

-- 6. Reescreve SKUs nas variations no novo padrão: NNNN-SIZE-GENDER
-- Preserva o SKU antigo em old_sku para histórico/auditoria
UPDATE products p
SET variations = updated.new_variations
FROM (
  SELECT
    p2.id,
    jsonb_agg(
      jsonb_set(
        CASE
          WHEN elem ? 'sku' AND elem->>'sku' IS NOT NULL AND elem->>'sku' != ''
            THEN jsonb_set(elem, '{old_sku}', to_jsonb(elem->>'sku'))
          ELSE elem
        END,
        '{sku}', to_jsonb(
          LPAD(p2.product_number::text, 4, '0') ||
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
  FROM products p2,
       jsonb_array_elements(p2.variations) WITH ORDINALITY AS t(elem, ord)
  WHERE p2.variations IS NOT NULL AND jsonb_array_length(p2.variations) > 0
  GROUP BY p2.id, p2.product_number
) updated
WHERE p.id = updated.id;

COMMENT ON COLUMN products.product_number IS
  'Número sequencial único do produto (auto-incremental). Base para o novo padrão de SKU: NNNN-SIZE-GENDER (ex: 0042-M-F).';
