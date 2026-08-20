-- REPARO: a versão de update_order_fulfillment que estava no banco tinha
-- `actor_id` (bare) no VALUES do INSERT em sales_status_events, em vez de
-- `p_actor_id`. Resultado: TODA mudança de etapa de entrega falhava com
-- 42703 "column actor_id does not exist", que a edge function traduzia para
-- 500 "Não foi possível processar o pedido". Zero transições foram gravadas
-- desde que a função foi criada.
--
-- O arquivo do repositório (20260813140515_enforce_order_fulfillment_transitions.sql)
-- sempre esteve correto; o banco recebeu uma variante editada à mão. Este
-- reparo reaplica o arquivo do repositório verbatim, de modo que banco e repo
-- voltem a ser a mesma coisa.

-- Delivery is operationally independent from payment. Keep both lifecycles
-- separate, but require every new delivery transition to follow its own flow.
CREATE OR REPLACE FUNCTION public.update_order_fulfillment(
  p_order_type TEXT,
  p_order_id UUID,
  p_delivery_status TEXT,
  p_delivery_date DATE,
  p_internal_notes TEXT,
  p_fulfillment_reason TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous_delivery_status TEXT;
  v_previous_delivery_date DATE;
  v_previous_internal_notes TEXT;
  v_effective_previous_status TEXT;
  v_target_delivery_status TEXT;
  v_next_delivery_date DATE;
  v_next_internal_notes TEXT;
  v_fulfillment_reason TEXT := NULLIF(trim(COALESCE(p_fulfillment_reason, '')), '');
  v_status_changed BOOLEAN;
  v_date_changed BOOLEAN;
  v_notes_changed BOOLEAN;
  v_result JSONB;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;

  IF p_delivery_status IS NOT NULL
    AND p_order_type = 'presale'
    AND p_delivery_status NOT IN (
      'awaiting_supplier', 'supplier_ordered', 'received', 'separated', 'delivered', 'cancelled'
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Status de entrega inválido';
  END IF;

  IF p_delivery_status IS NOT NULL
    AND p_order_type = 'stock'
    AND p_delivery_status NOT IN (
      'awaiting_delivery', 'separated', 'delivered', 'cancelled'
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Status de entrega inválido';
  END IF;

  IF char_length(COALESCE(p_internal_notes, '')) > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Observações muito longas';
  END IF;

  IF char_length(COALESCE(v_fulfillment_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo muito longo';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT o.delivery_status, o.delivery_date, o.internal_notes
      INTO v_previous_delivery_status, v_previous_delivery_date, v_previous_internal_notes
    FROM public.presale_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT o.delivery_status, o.delivery_date, o.internal_notes
      INTO v_previous_delivery_status, v_previous_delivery_date, v_previous_internal_notes
    FROM public.stock_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  -- A missing legacy status is only interpreted as the beginning of the flow
  -- for validation. It is never normalized by a notes-only save.
  v_effective_previous_status := COALESCE(
    v_previous_delivery_status,
    CASE WHEN p_order_type = 'presale' THEN 'awaiting_supplier' ELSE 'awaiting_delivery' END
  );
  v_target_delivery_status := COALESCE(p_delivery_status, v_previous_delivery_status);
  v_status_changed := v_target_delivery_status IS DISTINCT FROM v_previous_delivery_status;

  IF v_status_changed THEN
    IF p_order_type = 'presale' THEN
      IF NOT (
        (v_effective_previous_status = 'awaiting_supplier'
          AND v_target_delivery_status IN ('awaiting_supplier', 'supplier_ordered', 'cancelled'))
        OR (v_effective_previous_status = 'supplier_ordered'
          AND v_target_delivery_status IN ('received', 'cancelled'))
        OR (v_effective_previous_status = 'received'
          AND v_target_delivery_status IN ('separated', 'cancelled'))
        OR (v_effective_previous_status = 'separated'
          AND v_target_delivery_status IN ('delivered', 'cancelled'))
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Transição de entrega inválida para este pedido';
      END IF;
    ELSIF NOT (
      (v_effective_previous_status = 'awaiting_delivery'
        AND v_target_delivery_status IN ('awaiting_delivery', 'separated', 'cancelled'))
      OR (v_effective_previous_status = 'separated'
        AND v_target_delivery_status IN ('delivered', 'cancelled'))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Transição de entrega inválida para este pedido';
    END IF;

    IF v_target_delivery_status = 'cancelled' AND v_fulfillment_reason IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Informe o motivo para interromper a entrega';
    END IF;
  END IF;

  -- Null means "leave unchanged" at the API boundary. An empty notes string
  -- still deliberately clears the notes. This prevents an unrelated PATCH
  -- from silently erasing data on legacy orders.
  v_next_delivery_date := COALESCE(p_delivery_date, v_previous_delivery_date);
  v_next_internal_notes := CASE
    WHEN p_internal_notes IS NULL THEN v_previous_internal_notes
    ELSE NULLIF(trim(p_internal_notes), '')
  END;

  IF v_status_changed
    AND v_target_delivery_status = 'delivered'
    AND p_delivery_date IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Informe a data ao marcar o pedido como entregue';
  END IF;

  v_date_changed := v_next_delivery_date IS DISTINCT FROM v_previous_delivery_date;
  v_notes_changed := v_next_internal_notes IS DISTINCT FROM v_previous_internal_notes;

  IF NOT (v_status_changed OR v_date_changed OR v_notes_changed) THEN
    IF p_order_type = 'presale' THEN
      SELECT to_jsonb(o) INTO v_result
      FROM public.presale_orders o
      WHERE o.id = p_order_id;
    ELSE
      SELECT to_jsonb(o) INTO v_result
      FROM public.stock_orders o
      WHERE o.id = p_order_id;
    END IF;
    RETURN v_result;
  END IF;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET delivery_status = v_target_delivery_status,
        delivery_date = v_next_delivery_date,
        internal_notes = v_next_internal_notes,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET delivery_status = v_target_delivery_status,
        delivery_date = v_next_delivery_date,
        internal_notes = v_next_internal_notes,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  IF v_status_changed THEN
    INSERT INTO public.sales_status_events (
      order_type,
      order_id,
      previous_status,
      new_status,
      reason,
      metadata,
      actor_id
    ) VALUES (
      p_order_type,
      p_order_id,
      v_previous_delivery_status,
      v_target_delivery_status,
      COALESCE(v_fulfillment_reason, 'Etapa de entrega atualizada'),
      jsonb_build_object(
        'action', 'fulfillment_status_changed',
        'status_domain', 'delivery',
        'previous_delivery_status', v_previous_delivery_status,
        'new_delivery_status', v_target_delivery_status,
        'delivery_date', v_next_delivery_date,
        'legacy_status_was_unset', v_previous_delivery_status IS NULL
      ),
      p_actor_id
    );
  END IF;

  RETURN v_result;
END;
$$;

-- Keep the existing caller contract available during the function rollout.
-- It receives the same validation, but cannot interrupt delivery without the
-- new explicit reason accepted by the seven-argument version above.
CREATE OR REPLACE FUNCTION public.update_order_fulfillment(
  p_order_type TEXT,
  p_order_id UUID,
  p_delivery_status TEXT,
  p_delivery_date DATE,
  p_internal_notes TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.update_order_fulfillment(
    p_order_type,
    p_order_id,
    p_delivery_status,
    p_delivery_date,
    p_internal_notes,
    NULL::TEXT,
    p_actor_id
  );
$$;

REVOKE ALL ON FUNCTION public.update_order_fulfillment(TEXT, UUID, TEXT, DATE, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_order_fulfillment(TEXT, UUID, TEXT, DATE, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_order_fulfillment(TEXT, UUID, TEXT, DATE, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_order_fulfillment(TEXT, UUID, TEXT, DATE, TEXT, TEXT, UUID)
  TO service_role;;
