BEGIN;

-- Keep a durable, append-only record for every stock balance change.
-- Stock reservations already happen atomically in the order RPCs. The legacy
-- trigger below performed the same subtraction a second time after insert.
DROP TRIGGER IF EXISTS trg_sync_stock_on_order_change ON public.stock_orders;

CREATE SCHEMA IF NOT EXISTS eon_private;

CREATE OR REPLACE FUNCTION eon_private.stock_json_numeric(p_payload jsonb, p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN trim(COALESCE(p_payload->>p_key, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (p_payload->>p_key)::numeric
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION eon_private.stock_variation_name(p_variation jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    NULLIF(trim(COALESCE(p_variation->>'name', '')), ''),
    NULLIF(array_to_string(ARRAY[
      NULLIF(trim(COALESCE(p_variation->>'gender', '')), ''),
      NULLIF(trim(COALESCE(p_variation->>'size', '')), '')
    ], ' - '), ''),
    NULLIF(trim(COALESCE(p_variation->>'sku', '')), '')
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.stock_variation_quantity(p_variation jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT GREATEST(
    0,
    COALESCE(floor(eon_private.stock_json_numeric(p_variation, 'quantity'))::integer, 0)
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.stock_variations_total_quantity(p_variations jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(sum(eon_private.stock_variation_quantity(value)), 0)::integer
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(COALESCE(p_variations, '[]'::jsonb)) = 'array'
        THEN COALESCE(p_variations, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.reserve_stock_product(
  p_product_id uuid,
  p_quantity integer,
  p_variation text DEFAULT NULL::text,
  p_require_visible boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product public.stock_products%ROWTYPE;
  v_variations jsonb;
  v_updated_variations jsonb;
  v_variation jsonb;
  v_variation_name text := NULLIF(trim(COALESCE(p_variation, '')), '');
  v_variation_index integer;
  v_available integer;
  v_total_quantity integer;
  v_sale_price numeric;
  v_regular_price numeric;
  v_cost_price numeric;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade invalida';
  END IF;

  SELECT *
  INTO v_product
  FROM public.stock_products
  WHERE id = p_product_id
    AND status = 'active'
    AND (NOT p_require_visible OR COALESCE(show_in_store, TRUE) = TRUE)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto indisponivel';
  END IF;

  v_variations := CASE
    WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  IF jsonb_array_length(v_variations) > 0 THEN
    IF v_variation_name IS NULL THEN
      RAISE EXCEPTION 'Selecione o tamanho para %', v_product.name;
    END IF;

    SELECT (ordinality - 1)::integer, value
      INTO v_variation_index, v_variation
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY
    WHERE eon_private.stock_variation_name(value) = v_variation_name
       OR NULLIF(trim(COALESCE(value->>'sku', '')), '') = v_variation_name
    ORDER BY ordinality
    LIMIT 1;

    IF v_variation IS NULL THEN
      RAISE EXCEPTION 'Tamanho indisponivel para %', v_product.name;
    END IF;

    v_variation_name := eon_private.stock_variation_name(v_variation);
    v_available := eon_private.stock_variation_quantity(v_variation);
    IF v_available < p_quantity THEN
      RAISE EXCEPTION 'Estoque insuficiente para % - %', v_product.name, v_variation_name;
    END IF;

    v_sale_price := COALESCE(
      eon_private.stock_json_numeric(v_variation, 'sale_price'),
      v_product.sale_price,
      0
    );
    v_regular_price := COALESCE(
      eon_private.stock_json_numeric(v_variation, 'regular_price'),
      v_product.regular_price
    );
    v_cost_price := COALESCE(
      eon_private.stock_json_numeric(v_variation, 'cost_price'),
      v_product.cost_price,
      0
    );

    v_variation := jsonb_set(v_variation, '{name}', to_jsonb(v_variation_name), TRUE);
    v_variation := jsonb_set(v_variation, '{quantity}', to_jsonb(v_available - p_quantity), TRUE);

    SELECT COALESCE(
      jsonb_agg(
        CASE WHEN (ordinality - 1)::integer = v_variation_index
          THEN v_variation
          ELSE value
        END
        ORDER BY ordinality
      ),
      '[]'::jsonb
    )
    INTO v_updated_variations
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY;

    v_total_quantity := eon_private.stock_variations_total_quantity(v_updated_variations);

    UPDATE public.stock_products
    SET variations = v_updated_variations,
        quantity = v_total_quantity,
        updated_date = now()
    WHERE id = v_product.id
    RETURNING * INTO v_product;
  ELSE
    IF COALESCE(v_product.quantity, 0) < p_quantity THEN
      RAISE EXCEPTION 'Estoque insuficiente para %', v_product.name;
    END IF;

    UPDATE public.stock_products
    SET quantity = COALESCE(quantity, 0) - p_quantity,
        updated_date = now()
    WHERE id = v_product.id
      AND status = 'active'
      AND COALESCE(quantity, 0) >= p_quantity
    RETURNING * INTO v_product;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Estoque insuficiente para %', v_product.name;
    END IF;

    v_sale_price := COALESCE(v_product.sale_price, 0);
    v_regular_price := v_product.regular_price;
    v_cost_price := COALESCE(v_product.cost_price, 0);
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'product_id', v_product.id,
    'product_name', v_product.name,
    'variation', v_variation_name,
    'quantity', p_quantity,
    'sale_price', round(v_sale_price, 2),
    'regular_price', CASE WHEN v_regular_price IS NULL THEN NULL ELSE round(v_regular_price, 2) END,
    'cost_price', round(v_cost_price, 2),
    'stock_reserved', TRUE,
    'stock_reserved_at', now()
  ));
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.restock_stock_product(
  p_product_id uuid,
  p_quantity integer,
  p_variation text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product public.stock_products%ROWTYPE;
  v_variations jsonb;
  v_updated_variations jsonb;
  v_variation jsonb;
  v_variation_name text := NULLIF(trim(COALESCE(p_variation, '')), '');
  v_variation_index integer;
  v_available integer;
  v_total_quantity integer;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN;
  END IF;

  SELECT *
  INTO v_product
  FROM public.stock_products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Produto de estoque nao encontrado';
  END IF;

  v_variations := CASE
    WHEN jsonb_typeof(COALESCE(v_product.variations, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_product.variations, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  IF jsonb_array_length(v_variations) > 0 AND v_variation_name IS NOT NULL THEN
    SELECT (ordinality - 1)::integer, value
      INTO v_variation_index, v_variation
    FROM jsonb_array_elements(v_variations) WITH ORDINALITY
    WHERE eon_private.stock_variation_name(value) = v_variation_name
       OR NULLIF(trim(COALESCE(value->>'sku', '')), '') = v_variation_name
    ORDER BY ordinality
    LIMIT 1;

    IF v_variation IS NOT NULL THEN
      v_variation_name := eon_private.stock_variation_name(v_variation);
      v_available := eon_private.stock_variation_quantity(v_variation);
      v_variation := jsonb_set(v_variation, '{name}', to_jsonb(v_variation_name), TRUE);
      v_variation := jsonb_set(v_variation, '{quantity}', to_jsonb(v_available + p_quantity), TRUE);

      SELECT COALESCE(
        jsonb_agg(
          CASE WHEN (ordinality - 1)::integer = v_variation_index
            THEN v_variation
            ELSE value
          END
          ORDER BY ordinality
        ),
        '[]'::jsonb
      )
      INTO v_updated_variations
      FROM jsonb_array_elements(v_variations) WITH ORDINALITY;

      v_total_quantity := eon_private.stock_variations_total_quantity(v_updated_variations);

      UPDATE public.stock_products
      SET variations = v_updated_variations,
          quantity = v_total_quantity,
          updated_date = now()
      WHERE id = v_product.id;

      RETURN;
    END IF;
  END IF;

  UPDATE public.stock_products
  SET quantity = COALESCE(quantity, 0) + p_quantity,
      updated_date = now()
  WHERE id = v_product.id;
END;
$$;

CREATE TABLE public.stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_product_id UUID NOT NULL REFERENCES public.stock_products(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  order_id UUID REFERENCES public.stock_orders(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  variation TEXT,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'opening_balance',
    'stock_entry',
    'inventory_adjustment',
    'order_reserved',
    'order_cancelled',
    'order_refunded',
    'order_item_cancelled',
    'order_returned'
  )),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  quantity_before INTEGER NOT NULL CHECK (quantity_before >= 0),
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  reason TEXT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_product_created_at_idx
  ON public.stock_movements (stock_product_id, created_at DESC);
CREATE INDEX stock_movements_variation_created_at_idx
  ON public.stock_movements (variation, created_at DESC);
CREATE INDEX stock_movements_order_created_at_idx
  ON public.stock_movements (order_id, created_at DESC)
  WHERE order_id IS NOT NULL;
CREATE INDEX stock_movements_type_created_at_idx
  ON public.stock_movements (movement_type, created_at DESC);

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_movements_admin_read
  ON public.stock_movements
  FOR SELECT
  TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON TABLE public.stock_movements FROM anon, authenticated;
GRANT SELECT ON TABLE public.stock_movements TO authenticated;

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

  BEGIN
    v_actor_id := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_actor_id := NULL;
  END;

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

      v_movement_type := CASE
        WHEN v_delta > 0 THEN 'stock_entry'
        ELSE 'inventory_adjustment'
      END;
      v_reason := CASE
        WHEN v_delta > 0 THEN 'Entrada ou ajuste de estoque'
        ELSE 'Ajuste de estoque'
      END;

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
        CASE WHEN v_delta > 0 THEN 'stock_entry' ELSE 'inventory_adjustment' END,
        v_delta,
        CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.quantity, 0) END,
        COALESCE(NEW.quantity, 0),
        CASE
          WHEN v_delta > 0 THEN 'Entrada ou ajuste de estoque'
          ELSE 'Ajuste de estoque'
        END,
        v_actor_id,
        jsonb_build_object('source', 'stock_product_trigger', 'transaction_id', txid_current()::TEXT)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.link_stock_movements_to_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_movement_type TEXT;
  v_reason TEXT;
  v_delta_sign INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_movement_type := 'order_reserved';
    v_reason := 'Estoque reservado para pedido';
    v_delta_sign := -1;
  ELSIF OLD.payment_status IS DISTINCT FROM NEW.payment_status
        AND NEW.payment_status = 'cancelled' THEN
    v_movement_type := 'order_cancelled';
    v_reason := 'Estoque devolvido por cancelamento';
    v_delta_sign := 1;
  ELSIF OLD.payment_status IS DISTINCT FROM NEW.payment_status
        AND NEW.payment_status = 'refunded' THEN
    v_movement_type := 'order_refunded';
    v_reason := 'Estoque devolvido por estorno';
    v_delta_sign := 1;
  ELSIF OLD.items IS DISTINCT FROM NEW.items THEN
    v_movement_type := 'order_item_cancelled';
    v_reason := 'Estoque devolvido por cancelamento de item';
    v_delta_sign := 1;
  ELSE
    RETURN NEW;
  END IF;

  UPDATE public.stock_movements
  SET order_id = NEW.id,
      movement_type = v_movement_type,
      reason = v_reason,
      metadata = metadata || jsonb_build_object(
        'source', 'stock_order',
        'order_number', NEW.order_number
      )
  WHERE order_id IS NULL
    AND (metadata->>'transaction_id') = txid_current()::TEXT
    AND quantity_delta * v_delta_sign > 0;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.link_stock_movements_to_return()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.order_type <> 'stock'
     OR OLD.status IS NOT DISTINCT FROM NEW.status
     OR NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  UPDATE public.stock_movements
  SET order_id = NEW.order_id,
      movement_type = 'order_returned',
      reason = 'Estoque devolvido após retorno físico',
      metadata = metadata || jsonb_build_object(
        'source', 'order_return',
        'return_id', NEW.id
      )
  WHERE order_id IS NULL
    AND (metadata->>'transaction_id') = txid_current()::TEXT
    AND quantity_delta > 0;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_record_stock_product_movement
  AFTER INSERT OR UPDATE OF quantity, variations
  ON public.stock_products
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.record_stock_product_movement();

CREATE CONSTRAINT TRIGGER trg_link_stock_movements_to_order
  AFTER INSERT OR UPDATE
  ON public.stock_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.link_stock_movements_to_order();

CREATE CONSTRAINT TRIGGER trg_link_stock_movements_to_return
  AFTER UPDATE
  ON public.order_returns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.link_stock_movements_to_return();

-- Record the current balance as the history starting point. Products with a
-- size grid receive one opening line per variation; accessories remain one line.
INSERT INTO public.stock_movements (
  stock_product_id, product_id, variation, movement_type,
  quantity_delta, quantity_before, quantity_after, reason, metadata
)
SELECT
  source.stock_product_id,
  source.product_id,
  source.variation,
  'opening_balance',
  source.quantity,
  0,
  source.quantity,
  'Saldo inicial registrado ao ativar histórico',
  jsonb_build_object('source', 'stock_movement_migration')
FROM (
  SELECT
    stock_product.id AS stock_product_id,
    stock_product.product_id,
    eon_private.stock_variation_name(variation.value) AS variation,
    eon_private.stock_variation_quantity(variation.value) AS quantity
  FROM public.stock_products AS stock_product
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(COALESCE(stock_product.variations, '[]'::jsonb)) = 'array'
        THEN COALESCE(stock_product.variations, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) AS variation(value)
  WHERE jsonb_array_length(
    CASE
      WHEN jsonb_typeof(COALESCE(stock_product.variations, '[]'::jsonb)) = 'array'
        THEN COALESCE(stock_product.variations, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) > 0

  UNION ALL

  SELECT
    stock_product.id,
    stock_product.product_id,
    NULL,
    COALESCE(stock_product.quantity, 0)
  FROM public.stock_products AS stock_product
  WHERE jsonb_array_length(
    CASE
      WHEN jsonb_typeof(COALESCE(stock_product.variations, '[]'::jsonb)) = 'array'
        THEN COALESCE(stock_product.variations, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) = 0
) AS source
WHERE source.quantity > 0;

REVOKE ALL ON FUNCTION eon_private.record_stock_product_movement() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.link_stock_movements_to_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.link_stock_movements_to_return() FROM PUBLIC;

COMMENT ON TABLE public.stock_movements IS
  'Append-only inventory ledger. Rows are generated from stock changes and linked to stock orders when applicable.';

COMMIT;
;
