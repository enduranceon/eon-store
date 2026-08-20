-- ════════════════════════════════════════════════════════════════════════════
-- FIX 3a: assessment_contracts ganha due_date (não existia!)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE assessment_contracts ADD COLUMN IF NOT EXISTS due_date date;

-- ════════════════════════════════════════════════════════════════════════════
-- FIX 3b: backfill com end_date pros contratos existentes
-- ════════════════════════════════════════════════════════════════════════════
UPDATE assessment_contracts
SET due_date = end_date
WHERE due_date IS NULL AND end_date IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- FIX 1 + 2: substitui os 2 triggers de estoque por UM mais robusto
-- ════════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_decrement_stock_on_insert ON stock_orders;
DROP TRIGGER IF EXISTS trg_return_stock_on_cancel    ON stock_orders;
DROP FUNCTION IF EXISTS decrement_stock_on_order_insert() CASCADE;
DROP FUNCTION IF EXISTS return_stock_on_order_cancel()    CASCADE;

CREATE OR REPLACE FUNCTION sync_stock_on_order_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item JSONB;
  prod_id UUID;
  required_qty INT;
  current_qty INT;
  is_old_active BOOLEAN;
  is_new_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    is_old_active := FALSE;
    is_new_active := NEW.payment_status IS NULL
                     OR NEW.payment_status NOT IN ('cancelled', 'refunded');
  ELSIF TG_OP = 'UPDATE' THEN
    is_old_active := OLD.payment_status IS NULL
                     OR OLD.payment_status NOT IN ('cancelled', 'refunded');
    is_new_active := NEW.payment_status IS NULL
                     OR NEW.payment_status NOT IN ('cancelled', 'refunded');
  ELSE
    RETURN NEW;
  END IF;

  IF is_old_active = is_new_active THEN
    RETURN NEW;
  END IF;

  IF NEW.items IS NULL THEN
    RETURN NEW;
  END IF;

  -- Inativo → Ativo: decrementa estoque (com validação)
  IF is_new_active AND NOT is_old_active THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      prod_id := (item->>'product_id')::UUID;
      required_qty := (item->>'quantity')::INT;
      IF prod_id IS NOT NULL
         AND required_qty > 0
         AND COALESCE((item->>'cancelled')::BOOLEAN, FALSE) = FALSE THEN

        SELECT quantity INTO current_qty FROM stock_products WHERE id = prod_id;
        IF current_qty IS NULL THEN
          CONTINUE;
        END IF;
        IF current_qty < required_qty THEN
          RAISE EXCEPTION 'Estoque insuficiente para "%": disponível %, requerido %',
            COALESCE(item->>'product_name', prod_id::text), current_qty, required_qty;
        END IF;

        UPDATE stock_products
          SET quantity = quantity - required_qty
          WHERE id = prod_id;
      END IF;
    END LOOP;

  -- Ativo → Inativo: devolve estoque
  ELSIF is_old_active AND NOT is_new_active THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      prod_id := (item->>'product_id')::UUID;
      required_qty := (item->>'quantity')::INT;
      IF prod_id IS NOT NULL
         AND required_qty > 0
         AND COALESCE((item->>'cancelled')::BOOLEAN, FALSE) = FALSE THEN
        UPDATE stock_products
          SET quantity = quantity + required_qty
          WHERE id = prod_id;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_stock_on_order_change
  AFTER INSERT OR UPDATE OF payment_status ON stock_orders
  FOR EACH ROW EXECUTE FUNCTION sync_stock_on_order_change();

-- Verificação
DO $$
DECLARE
  trigger_exists BOOLEAN;
  due_date_exists BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_stock_on_order_change' AND NOT tgisinternal) INTO trigger_exists;
  SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'assessment_contracts' AND column_name = 'due_date') INTO due_date_exists;

  IF NOT trigger_exists THEN RAISE EXCEPTION 'Trigger NÃO foi criado!'; END IF;
  IF NOT due_date_exists THEN RAISE EXCEPTION 'Coluna due_date NÃO foi criada!'; END IF;
  RAISE NOTICE 'Migration OK: trigger ativo, due_date adicionada.';
END;
$$;;
