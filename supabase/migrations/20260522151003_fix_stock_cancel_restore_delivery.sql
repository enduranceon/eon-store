
-- Corrige o trigger para restaurar estoque também quando delivery_status muda para 'cancelled'
CREATE OR REPLACE FUNCTION public.handle_stock_order_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item jsonb;
  pid  uuid;
  qty  integer;
BEGIN
  -- Restaura estoque se payment_status OU delivery_status foi para 'cancelled'
  -- mas garante que só restaura uma vez (evita dupla restauração)
  IF (NEW.payment_status = 'cancelled' AND OLD.payment_status <> 'cancelled')
  OR (NEW.delivery_status = 'cancelled' AND OLD.delivery_status <> 'cancelled'
      AND NEW.payment_status <> 'cancelled') THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      pid := (item->>'product_id')::uuid;
      qty := (item->>'quantity')::integer;
      UPDATE stock_products SET quantity = quantity + qty WHERE id = pid;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
;
