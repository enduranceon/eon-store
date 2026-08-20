-- TRIGGER 1: ao inserir pedido, decrementa estoque dos produtos
CREATE OR REPLACE FUNCTION decrement_stock_on_order_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item JSONB;
BEGIN
  -- Pedido que já nasce cancelado/reembolsado não decrementa
  IF NEW.payment_status IN ('cancelled', 'refunded') THEN
    RETURN NEW;
  END IF;
  IF NEW.items IS NOT NULL THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      IF (item->>'product_id') IS NOT NULL
         AND (item->>'quantity')::INT > 0
         AND COALESCE((item->>'cancelled')::BOOLEAN, FALSE) = FALSE THEN
        UPDATE stock_products
          SET quantity = GREATEST(0, quantity - (item->>'quantity')::INT)
          WHERE id = (item->>'product_id')::UUID;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_decrement_stock_on_insert ON stock_orders;
CREATE TRIGGER trg_decrement_stock_on_insert
  AFTER INSERT ON stock_orders
  FOR EACH ROW EXECUTE FUNCTION decrement_stock_on_order_insert();

-- TRIGGER 2: ao mudar para cancelled/refunded, devolve estoque
CREATE OR REPLACE FUNCTION return_stock_on_order_cancel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item JSONB;
BEGIN
  -- Só age na transição (de algo diferente PARA cancelled/refunded)
  IF NEW.payment_status NOT IN ('cancelled', 'refunded') THEN
    RETURN NEW;
  END IF;
  IF OLD.payment_status IN ('cancelled', 'refunded') THEN
    RETURN NEW; -- já estava cancelado
  END IF;
  IF NEW.items IS NOT NULL THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      -- Só devolve itens que NÃO estão marcados como cancelled (esses já foram tratados)
      IF (item->>'product_id') IS NOT NULL
         AND (item->>'quantity')::INT > 0
         AND COALESCE((item->>'cancelled')::BOOLEAN, FALSE) = FALSE THEN
        UPDATE stock_products
          SET quantity = quantity + (item->>'quantity')::INT
          WHERE id = (item->>'product_id')::UUID;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_return_stock_on_cancel ON stock_orders;
CREATE TRIGGER trg_return_stock_on_cancel
  AFTER UPDATE OF payment_status ON stock_orders
  FOR EACH ROW EXECUTE FUNCTION return_stock_on_order_cancel();;
