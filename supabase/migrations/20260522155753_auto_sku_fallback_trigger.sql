
-- Função de fallback: gera SKU sequencial se não for fornecido
CREATE OR REPLACE FUNCTION public.auto_sku_presale()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cat_prefix TEXT;
  seq_num    INTEGER;
BEGIN
  IF NEW.sku IS NULL OR trim(NEW.sku) = '' THEN
    -- Prefixo de categoria: primeiras 3 letras, sem acentos, maiúsculas
    cat_prefix := UPPER(LEFT(
      regexp_replace(
        translate(
          COALESCE(NEW.category, 'GER'),
          'áéíóúàèìòùâêîôûãõçÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÇ',
          'aeiouaeiouaeiouaocAEIOUAEIOUAEIOUAOC'
        ),
        '[^a-zA-Z]', '', 'g'
      ),
    3));
    IF cat_prefix IS NULL OR cat_prefix = '' THEN cat_prefix := 'GER'; END IF;

    -- Próximo número sequencial para esse prefixo
    SELECT COALESCE(MAX(
      CAST(NULLIF(
        regexp_replace(sku, '^EON-' || cat_prefix || '-(\d+)$', '\1'),
        sku
      ) AS INTEGER)
    ), 0) + 1
    INTO seq_num
    FROM presale_products
    WHERE sku ~ ('^EON-' || cat_prefix || '-\d+$');

    NEW.sku := 'EON-' || cat_prefix || '-' || LPAD(seq_num::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger no INSERT
DROP TRIGGER IF EXISTS trg_auto_sku_presale ON presale_products;
CREATE TRIGGER trg_auto_sku_presale
  BEFORE INSERT ON presale_products
  FOR EACH ROW EXECUTE FUNCTION auto_sku_presale();
;
