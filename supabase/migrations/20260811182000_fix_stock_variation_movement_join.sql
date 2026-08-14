-- PostgreSQL does not accept IS NOT DISTINCT FROM as a FULL JOIN condition.
-- Variation names are normalized before this trigger runs, so an equality join
-- preserves one ledger row for each changed size.

CREATE OR REPLACE FUNCTION eon_private.record_stock_product_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous_variations JSONB;
  v_current_variations JSONB;
  v_movement RECORD;
  v_delta INTEGER;
  v_movement_type TEXT;
  v_reason TEXT;
  v_actor_id UUID;
  v_context_movement_type TEXT;
  v_context_reason TEXT;
  v_context_actor_id TEXT;
BEGIN
  v_previous_variations := CASE
    WHEN TG_OP = 'INSERT' THEN '[]'::jsonb
    WHEN jsonb_typeof(COALESCE(OLD.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(OLD.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;
  v_current_variations := CASE
    WHEN jsonb_typeof(COALESCE(NEW.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(NEW.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  v_context_movement_type := NULLIF(
    current_setting('eon.stock_movement_type', TRUE),
    ''
  );
  IF v_context_movement_type NOT IN (
    'stock_entry',
    'stock_withdrawal',
    'inventory_adjustment',
    'order_reserved',
    'order_cancelled',
    'order_refunded',
    'order_item_cancelled',
    'order_returned'
  ) THEN
    v_context_movement_type := NULL;
  END IF;
  v_context_reason := NULLIF(
    current_setting('eon.stock_movement_reason', TRUE),
    ''
  );
  v_context_actor_id := NULLIF(
    current_setting('eon.stock_movement_actor_id', TRUE),
    ''
  );

  IF v_context_actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_actor_id := v_context_actor_id::UUID;
  ELSE
    BEGIN
      v_actor_id := auth.uid();
    EXCEPTION WHEN OTHERS THEN
      v_actor_id := NULL;
    END;
  END IF;

  IF jsonb_array_length(v_previous_variations) > 0
     OR jsonb_array_length(v_current_variations) > 0 THEN
    FOR v_movement IN
      WITH previous_variations AS (
        SELECT
          eon_private.stock_variation_name(value) AS variation,
          sum(eon_private.stock_variation_quantity(value))::INTEGER AS quantity
        FROM jsonb_array_elements(v_previous_variations)
        GROUP BY eon_private.stock_variation_name(value)
      ), current_variations AS (
        SELECT
          eon_private.stock_variation_name(value) AS variation,
          sum(eon_private.stock_variation_quantity(value))::INTEGER AS quantity
        FROM jsonb_array_elements(v_current_variations)
        GROUP BY eon_private.stock_variation_name(value)
      )
      SELECT
        COALESCE(current_variations.variation, previous_variations.variation) AS variation,
        COALESCE(previous_variations.quantity, 0) AS quantity_before,
        COALESCE(current_variations.quantity, 0) AS quantity_after
      FROM previous_variations
      FULL JOIN current_variations
        ON current_variations.variation = previous_variations.variation
    LOOP
      v_delta := v_movement.quantity_after - v_movement.quantity_before;
      IF v_delta = 0 THEN
        CONTINUE;
      END IF;

      v_movement_type := COALESCE(
        v_context_movement_type,
        CASE WHEN v_delta > 0 THEN 'stock_entry' ELSE 'inventory_adjustment' END
      );
      v_reason := COALESCE(
        v_context_reason,
        CASE
          WHEN v_delta > 0 THEN 'Entrada ou ajuste de estoque'
          ELSE 'Ajuste de estoque'
        END
      );

      INSERT INTO public.stock_movements (
        stock_product_id, product_id, variation, movement_type,
        quantity_delta, quantity_before, quantity_after, reason, actor_id, metadata
      )
      VALUES (
        NEW.id, NEW.product_id, v_movement.variation, v_movement_type,
        v_delta, v_movement.quantity_before, v_movement.quantity_after,
        v_reason, v_actor_id,
        jsonb_build_object('source', 'stock_product_trigger', 'transaction_id', txid_current()::TEXT)
      );
    END LOOP;
  ELSE
    v_delta := COALESCE(NEW.quantity, 0) - CASE
      WHEN TG_OP = 'INSERT' THEN 0
      ELSE COALESCE(OLD.quantity, 0)
    END;

    IF v_delta <> 0 THEN
      INSERT INTO public.stock_movements (
        stock_product_id, product_id, movement_type,
        quantity_delta, quantity_before, quantity_after, reason, actor_id, metadata
      )
      VALUES (
        NEW.id, NEW.product_id,
        COALESCE(
          v_context_movement_type,
          CASE WHEN v_delta > 0 THEN 'stock_entry' ELSE 'inventory_adjustment' END
        ),
        v_delta,
        CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.quantity, 0) END,
        COALESCE(NEW.quantity, 0),
        COALESCE(
          v_context_reason,
          CASE
            WHEN v_delta > 0 THEN 'Entrada ou ajuste de estoque'
            ELSE 'Ajuste de estoque'
          END
        ),
        v_actor_id,
        jsonb_build_object('source', 'stock_product_trigger', 'transaction_id', txid_current()::TEXT)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
