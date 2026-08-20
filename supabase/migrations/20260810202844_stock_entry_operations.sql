BEGIN;

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
        ON current_variations.variation IS NOT DISTINCT FROM previous_variations.variation
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

CREATE OR REPLACE FUNCTION public.apply_stock_entry(
  p_stock_product_id UUID,
  p_quantity INTEGER,
  p_variation TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product public.stock_products%ROWTYPE;
  v_variations JSONB;
  v_updated_variations JSONB;
  v_variation JSONB;
  v_variation_index INTEGER;
  v_variation_name TEXT := NULLIF(trim(COALESCE(p_variation, '')), '');
  v_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_current_quantity INTEGER;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 10000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade de entrada inválida';
  END IF;
  IF length(COALESCE(p_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo da entrada é muito longo';
  END IF;

  SELECT *
  INTO v_product
  FROM public.stock_products
  WHERE id = p_stock_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto de estoque não encontrado';
  END IF;

  v_variations := CASE
    WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  PERFORM set_config('eon.stock_movement_type', 'stock_entry', TRUE);
  PERFORM set_config(
    'eon.stock_movement_reason',
    COALESCE(v_reason, 'Entrada de estoque'),
    TRUE
  );
  PERFORM set_config('eon.stock_movement_actor_id', COALESCE(p_actor_id::TEXT, ''), TRUE);

  IF jsonb_array_length(v_variations) > 0 THEN
    IF v_variation_name IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione o tamanho para registrar a entrada';
    END IF;

    SELECT (ordinality - 1)::INTEGER, value
    INTO v_variation_index, v_variation
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY
    WHERE eon_private.stock_variation_name(value) = v_variation_name
       OR NULLIF(trim(COALESCE(value->>'sku', '')), '') = v_variation_name
    ORDER BY ordinality
    LIMIT 1;

    IF v_variation IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Tamanho não encontrado para este produto';
    END IF;

    v_variation_name := eon_private.stock_variation_name(v_variation);
    v_current_quantity := eon_private.stock_variation_quantity(v_variation);
    v_variation := jsonb_set(v_variation, '{name}', to_jsonb(v_variation_name), TRUE);
    v_variation := jsonb_set(
      v_variation,
      '{quantity}',
      to_jsonb(v_current_quantity + p_quantity),
      TRUE
    );

    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN (ordinality - 1)::INTEGER = v_variation_index THEN v_variation
          ELSE value
        END
        ORDER BY ordinality
      ),
      '[]'::jsonb
    )
    INTO v_updated_variations
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY;

    UPDATE public.stock_products
    SET variations = v_updated_variations,
        quantity = eon_private.stock_variations_total_quantity(v_updated_variations),
        updated_date = now()
    WHERE id = v_product.id
    RETURNING * INTO v_product;
  ELSE
    IF v_variation_name IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Este produto não possui grade de tamanhos';
    END IF;

    UPDATE public.stock_products
    SET quantity = COALESCE(quantity, 0) + p_quantity,
        updated_date = now()
    WHERE id = v_product.id
    RETURNING * INTO v_product;
  END IF;

  RETURN to_jsonb(v_product);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stock_entry(UUID, INTEGER, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_stock_entry(UUID, INTEGER, TEXT, TEXT, UUID)
  TO service_role;

COMMENT ON FUNCTION public.apply_stock_entry(UUID, INTEGER, TEXT, TEXT, UUID) IS
  'Adds stock atomically by product and optional variation, preserving the inventory ledger context.';

COMMIT;
;
