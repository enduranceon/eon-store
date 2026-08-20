
-- Trigger antigo restaurava TODOS os items quando status virava 'cancelled',
-- incluindo items que já foram cancelados individualmente (e já restaurados manualmente).
-- Resultado: dupla reposição de estoque.
-- Fix: pula items com cancelled=true no JSONB.

CREATE OR REPLACE FUNCTION public.handle_stock_order_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  item jsonb;
  pid  uuid;
  qty  integer;
BEGIN
  IF (NEW.payment_status = 'cancelled' AND OLD.payment_status <> 'cancelled')
  OR (NEW.delivery_status = 'cancelled' AND OLD.delivery_status <> 'cancelled'
      AND NEW.payment_status <> 'cancelled') THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      -- Pula items já marcados como cancelled (já restaurados individualmente)
      IF COALESCE((item->>'cancelled')::boolean, false) = true THEN
        CONTINUE;
      END IF;
      pid := (item->>'product_id')::uuid;
      qty := (item->>'quantity')::integer;
      IF pid IS NOT NULL AND qty IS NOT NULL THEN
        UPDATE stock_products SET quantity = quantity + qty WHERE id = pid;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
;
