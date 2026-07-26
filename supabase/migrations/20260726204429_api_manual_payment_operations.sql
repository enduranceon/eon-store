-- Server-only operations for the complete manual-payment lifecycle.
-- The Edge Function calculates the credit schedule; PostgreSQL validates and
-- persists every local side effect in one transaction.

CREATE OR REPLACE FUNCTION public.api_record_manual_payment(
  p_order_type TEXT,
  p_order_id UUID,
  p_payment_method_id UUID,
  p_payment_date DATE,
  p_total NUMERIC,
  p_installments JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_method public.payment_methods%ROWTYPE;
  v_previous_status TEXT;
  v_order_total NUMERIC;
  v_order_number TEXT;
  v_asaas_charge_id TEXT;
  v_manual_payment BOOLEAN;
  v_contract_status TEXT;
  v_contract_start_date DATE;
  v_parent_contract_id UUID;
  v_next_contract_status TEXT;
  v_fee NUMERIC;
  v_installment_count INTEGER;
  v_existing_count INTEGER;
  v_existing_total NUMERIC;
  v_existing_method_matches BOOLEAN;
  v_existing_date_matches BOOLEAN;
  v_item JSONB;
  v_number INTEGER;
  v_due_date DATE;
  v_credit_date DATE;
  v_value NUMERIC;
  v_allocated_value NUMERIC := 0;
  v_method_code TEXT;
  v_expected_number INTEGER := 1;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_order_type IS NULL OR p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de venda inválido';
  END IF;
  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Data de pagamento obrigatória';
  END IF;
  IF p_payment_date > (now() AT TIME ZONE 'America/Sao_Paulo')::DATE THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A data do pagamento não pode estar no futuro';
  END IF;
  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valor inválido';
  END IF;

  SELECT *
  INTO v_method
  FROM public.payment_methods
  WHERE id = p_payment_method_id
    AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Método de pagamento inválido ou inativo';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT total_value, payment_status, order_number, asaas_charge_id, manual_payment
    INTO v_order_total, v_previous_status, v_order_number, v_asaas_charge_id, v_manual_payment
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSIF p_order_type = 'stock' THEN
    SELECT total_value, payment_status, order_number, asaas_charge_id, manual_payment
    INTO v_order_total, v_previous_status, v_order_number, v_asaas_charge_id, v_manual_payment
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT
      GREATEST(
        0,
        COALESCE((c.plan_snapshot->>'price_total')::NUMERIC, p.price_total, 0)
        + COALESCE(c.enrollment_fee, 0)
        - COALESCE(c.manual_discount, 0)
        - COALESCE(c.credit_balance, 0)
      ),
      c.payment_status,
      c.contract_number,
      c.asaas_charge_id,
      c.manual_payment,
      c.status,
      c.start_date,
      c.parent_contract_id
    INTO v_order_total, v_previous_status, v_order_number, v_asaas_charge_id,
         v_manual_payment, v_contract_status, v_contract_start_date, v_parent_contract_id
    FROM public.assessment_contracts c
    LEFT JOIN public.assessment_plans p ON p.id = c.plan_id
    WHERE c.id = p_order_id
    FOR UPDATE OF c;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;
  IF v_previous_status IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Não é possível registrar pagamento nesta venda';
  END IF;
  IF v_previous_status = 'paid' AND NOT COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A venda já foi paga por outro fluxo';
  END IF;
  IF NULLIF(v_asaas_charge_id, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cancele a cobrança Asaas antes de registrar pagamento por fora';
  END IF;
  IF abs(round(COALESCE(v_order_total, 0), 2) - round(p_total, 2)) > 0.009 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Pagamento parcial ainda não está habilitado. Informe o valor integral.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.asaas_payments
    WHERE order_id = p_order_id
      AND order_type = p_order_type
      AND source = 'asaas'
      AND status IN ('PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe uma cobrança Asaas ativa. Cancele ou estorne antes de registrar pagamento por fora.';
  END IF;

  v_installment_count := GREATEST(1, LEAST(12, COALESCE(v_method.installments, 1)));
  IF jsonb_typeof(p_installments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_installments) <> v_installment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Projeção de parcelas inválida';
  END IF;

  SELECT
    count(*)::INTEGER,
    COALESCE(sum(value), 0),
    COALESCE(bool_and(payment_method_id = v_method.id), false),
    COALESCE(bool_and(payment_date = p_payment_date), false)
  INTO v_existing_count, v_existing_total, v_existing_method_matches, v_existing_date_matches
  FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = p_order_type
    AND source = 'manual'
    AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

  -- A network retry of the same command must not recreate installments or
  -- duplicate audit events.
  IF v_previous_status = 'paid'
     AND COALESCE(v_manual_payment, false)
     AND v_existing_count = v_installment_count
     AND round(v_existing_total, 2) = round(p_total, 2)
     AND v_existing_method_matches
     AND v_existing_date_matches THEN
    RETURN jsonb_build_object(
      'installments', v_installment_count,
      'total_gross', round(p_total, 2),
      'total_fee', round(
        (p_total * COALESCE(v_method.fee_percent, 0) / 100)
        + COALESCE(v_method.fee_fixed, 0),
        2
      ),
      'total_net', round(p_total, 2),
      'value_per_installment', round(p_total / v_installment_count, 2),
      'already_recorded', true
    );
  END IF;

  v_fee := round(
    (p_total * COALESCE(v_method.fee_percent, 0) / 100)
    + COALESCE(v_method.fee_fixed, 0),
    2
  );
  v_method_code := COALESCE(NULLIF(v_method.internal_code, ''), v_method.kind);

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = p_order_type
    AND source = 'manual';

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_installments)
    ORDER BY (value->>'number')::INTEGER
  LOOP
    v_number := (v_item->>'number')::INTEGER;
    v_due_date := (v_item->>'due_date')::DATE;
    v_credit_date := (v_item->>'credit_date')::DATE;

    IF v_number IS NULL OR v_number <> v_expected_number
       OR v_due_date IS NULL OR v_credit_date IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela inválida';
    END IF;

    IF v_number = v_installment_count THEN
      v_value := round(p_total, 2) - v_allocated_value;
    ELSE
      v_value := round(p_total / v_installment_count, 2);
    END IF;

    INSERT INTO public.asaas_payments(
      asaas_payment_id, source, payment_method_id, installment_number,
      total_installments, billing_type, status, value, net_value, due_date,
      credit_date, payment_date, description, external_reference, order_id,
      order_type, raw, last_synced_at
    )
    VALUES (
      'manual_' || p_order_id::TEXT || '_' || v_number || '_' || replace(gen_random_uuid()::TEXT, '-', ''),
      'manual',
      v_method.id,
      v_number,
      v_installment_count,
      upper(v_method.kind),
      'CONFIRMED',
      v_value,
      v_value,
      v_due_date,
      v_credit_date,
      p_payment_date,
      'Pagamento manual - ' || v_method.name ||
        CASE WHEN v_installment_count > 1
          THEN ' (parcela ' || v_number || '/' || v_installment_count || ')'
          ELSE ''
        END,
      v_order_number,
      p_order_id,
      p_order_type,
      NULL,
      now()
    );

    v_allocated_value := v_allocated_value + v_value;
    v_expected_number := v_expected_number + 1;
  END LOOP;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET payment_status = 'paid',
        payment_method = v_method_code,
        payment_date = p_payment_date,
        manual_payment = true,
        manual_fee = NULL,
        updated_date = now()
    WHERE id = p_order_id;
  ELSIF p_order_type = 'stock' THEN
    UPDATE public.stock_orders
    SET payment_status = 'paid',
        payment_method = v_method_code,
        payment_date = p_payment_date,
        manual_payment = true,
        manual_fee = NULL,
        updated_date = now()
    WHERE id = p_order_id;
  ELSE
    v_next_contract_status := CASE
      WHEN v_contract_status = 'draft' AND v_contract_start_date > (now() AT TIME ZONE 'America/Sao_Paulo')::DATE
        THEN 'scheduled'
      WHEN v_contract_status = 'draft' THEN 'active'
      ELSE v_contract_status
    END;

    UPDATE public.assessment_contracts
    SET payment_status = 'paid',
        payment_method = v_method_code,
        payment_date = p_payment_date,
        manual_payment = true,
        manual_fee = NULL,
        status = v_next_contract_status,
        updated_at = now()
    WHERE id = p_order_id;

    IF v_contract_status = 'draft' THEN
      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, created_by
      )
      VALUES (
        p_order_id,
        CASE
          WHEN v_parent_contract_id IS NOT NULL AND v_next_contract_status = 'scheduled'
            THEN 'renewal_scheduled'
          ELSE 'enrollment_activated'
        END,
        jsonb_build_object(
          'source', 'admin_action',
          'status_after', v_next_contract_status,
          'start_date', v_contract_start_date
        ),
        p_actor_id
      );
    END IF;
  END IF;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    p_order_type,
    p_order_id,
    v_previous_status,
    'paid',
    CASE WHEN v_previous_status = 'paid'
      THEN 'manual_payment_reconciled'
      ELSE 'manual_payment_recorded'
    END,
    jsonb_build_object(
      'payment_method_id', v_method.id,
      'payment_method', v_method_code,
      'payment_date', p_payment_date,
      'total', round(p_total, 2),
      'fee', v_fee,
      'installments', v_installment_count
    ),
    p_actor_id
  );

  IF p_order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, created_by
    )
    VALUES (
      p_order_id,
      'manual_payment_recorded',
      jsonb_build_object(
        'method', v_method_code,
        'method_name', v_method.name,
        'date', p_payment_date,
        'value', round(p_total, 2),
        'fee', v_fee,
        'installments', v_installment_count
      ),
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'installments', v_installment_count,
    'total_gross', round(p_total, 2),
    'total_fee', v_fee,
    'total_net', round(p_total, 2),
    'value_per_installment', round(p_total / v_installment_count, 2),
    'already_recorded', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_adjust_manual_payment(
  p_order_type TEXT,
  p_order_id UUID,
  p_total NUMERIC,
  p_manual_discount NUMERIC,
  p_discount_reason TEXT,
  p_discount_recurring BOOLEAN,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status TEXT;
  v_manual_payment BOOLEAN;
  v_total NUMERIC;
  v_calculated_total NUMERIC;
  v_subtotal NUMERIC;
  v_coupon_discount NUMERIC;
  v_items JSONB;
  v_previous_discount NUMERIC;
  v_previous_total NUMERIC;
  v_installment_count INTEGER;
  v_index INTEGER := 0;
  v_allocated NUMERIC := 0;
  v_value NUMERIC;
  v_row RECORD;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de venda inválido';
  END IF;
  IF p_total IS NULL OR p_total < 0 OR p_manual_discount IS NULL OR p_manual_discount < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valores do desconto são inválidos';
  END IF;
  IF char_length(COALESCE(p_discount_reason, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo do desconto é muito longo';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, manual_payment, COALESCE(items, '[]'::JSONB),
           COALESCE(discount_value, 0), COALESCE(manual_discount, 0)
    INTO v_payment_status, v_manual_payment, v_items,
         v_coupon_discount, v_previous_discount
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSIF p_order_type = 'stock' THEN
    SELECT payment_status, manual_payment, COALESCE(items, '[]'::JSONB),
           COALESCE(discount_value, 0), COALESCE(manual_discount, 0)
    INTO v_payment_status, v_manual_payment, v_items,
         v_coupon_discount, v_previous_discount
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT
      c.payment_status,
      c.manual_payment,
      round(
        COALESCE((c.plan_snapshot->>'price_total')::NUMERIC, p.price_total, 0)
        + COALESCE(c.enrollment_fee, 0)
        - COALESCE(c.credit_balance, 0),
        2
      ),
      COALESCE(c.manual_discount, 0)
    INTO v_payment_status, v_manual_payment, v_subtotal, v_previous_discount
    FROM public.assessment_contracts c
    LEFT JOIN public.assessment_plans p ON p.id = c.plan_id
    WHERE c.id = p_order_id
    FOR UPDATE OF c;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;
  IF v_payment_status <> 'paid' OR NOT COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente pagamentos manuais confirmados podem ser recalculados';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT round(GREATEST(
      0,
      COALESCE(sum(
        (
          COALESCE(NULLIF(item->>'sale_price', '')::NUMERIC, 0)
          + COALESCE(NULLIF(item->>'extras_total', '')::NUMERIC, 0)
        ) * COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0)
      ) FILTER (WHERE NOT COALESCE((item->>'cancelled')::BOOLEAN, false)), 0)
      - v_coupon_discount
    ), 2)
    INTO v_subtotal
    FROM jsonb_array_elements(v_items) item;
  ELSIF p_order_type = 'stock' THEN
    SELECT round(GREATEST(
      0,
      COALESCE(sum(
        COALESCE(NULLIF(item->>'sale_price', '')::NUMERIC, 0)
        * COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0)
      ) FILTER (WHERE NOT COALESCE((item->>'cancelled')::BOOLEAN, false)), 0)
      - v_coupon_discount
    ), 2)
    INTO v_subtotal
    FROM jsonb_array_elements(v_items) item;
  END IF;

  IF p_manual_discount > v_subtotal THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Desconto maior que o subtotal';
  END IF;
  v_calculated_total := round(GREATEST(0, v_subtotal - p_manual_discount), 2);
  IF abs(round(p_total, 2) - v_calculated_total) > 0.009 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O total informado não corresponde aos dados atuais da venda';
  END IF;
  v_total := v_calculated_total;

  SELECT count(*)::INTEGER, round(COALESCE(sum(value), 0), 2)
  INTO v_installment_count, v_previous_total
  FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = p_order_type
    AND source = 'manual'
    AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET manual_discount = round(p_manual_discount, 2),
        discount_reason = NULLIF(trim(COALESCE(p_discount_reason, '')), ''),
        total_value = v_total,
        updated_date = now()
    WHERE id = p_order_id;
  ELSIF p_order_type = 'stock' THEN
    UPDATE public.stock_orders
    SET manual_discount = round(p_manual_discount, 2),
        discount_reason = NULLIF(trim(COALESCE(p_discount_reason, '')), ''),
        total_value = v_total,
        updated_date = now()
    WHERE id = p_order_id;
  ELSE
    UPDATE public.assessment_contracts
    SET manual_discount = round(p_manual_discount, 2),
        discount_reason = NULLIF(trim(COALESCE(p_discount_reason, '')), ''),
        discount_recurring = COALESCE(p_discount_recurring, false),
        updated_at = now()
    WHERE id = p_order_id;
  END IF;

  IF round(v_previous_discount, 2) <> round(p_manual_discount, 2) THEN
    INSERT INTO public.discount_log(
      entity_type, entity_id, previous_value, new_value, reason, created_by
    )
    VALUES (
      CASE p_order_type
        WHEN 'presale' THEN 'presale_order'
        WHEN 'stock' THEN 'stock_order'
        ELSE 'assessment_contract'
      END,
      p_order_id,
      round(v_previous_discount, 2),
      round(p_manual_discount, 2),
      NULLIF(trim(COALESCE(p_discount_reason, '')), ''),
      p_actor_id
    );
  END IF;

  IF v_installment_count = 0 AND v_total = 0 AND EXISTS (
    SELECT 1
    FROM public.asaas_payments
    WHERE order_id = p_order_id
      AND order_type = p_order_type
      AND source = 'manual'
      AND status = 'CANCELLED'
  ) THEN
    RETURN jsonb_build_object(
      'adjusted', false,
      'already_adjusted', true,
      'installments', 0,
      'total', v_total,
      'cancelled', true,
      'audit_logged', round(v_previous_discount, 2) <> round(p_manual_discount, 2)
    );
  END IF;

  IF v_installment_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Parcelas manuais não encontradas para esta venda';
  END IF;

  IF v_previous_total = v_total THEN
    RETURN jsonb_build_object(
      'adjusted', false,
      'already_adjusted', true,
      'installments', v_installment_count,
      'total', v_total,
      'audit_logged', round(v_previous_discount, 2) <> round(p_manual_discount, 2)
    );
  END IF;

  IF v_total = 0 THEN
    UPDATE public.asaas_payments
    SET status = 'CANCELLED', updated_at = now()
    WHERE order_id = p_order_id
      AND order_type = p_order_type
      AND source = 'manual'
      AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');
  ELSE
    FOR v_row IN
      SELECT id
      FROM public.asaas_payments
      WHERE order_id = p_order_id
        AND order_type = p_order_type
        AND source = 'manual'
        AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
      ORDER BY installment_number, id
      FOR UPDATE
    LOOP
      v_index := v_index + 1;
      v_value := CASE
        WHEN v_index = v_installment_count THEN v_total - v_allocated
        ELSE round(v_total / v_installment_count, 2)
      END;

      UPDATE public.asaas_payments
      SET value = v_value,
          net_value = v_value,
          updated_at = now()
      WHERE id = v_row.id;

      v_allocated := v_allocated + v_value;
    END LOOP;
  END IF;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    p_order_type,
    p_order_id,
    'paid',
    'paid',
    'manual_payment_adjusted',
    jsonb_build_object(
      'previous_total', v_previous_total,
      'new_total', v_total,
      'installments', v_installment_count,
      'cancelled', v_total = 0,
      'manual_discount', round(p_manual_discount, 2)
    ),
    p_actor_id
  );

  IF p_order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, created_by
    )
    VALUES (
      p_order_id,
      'manual_payment_adjusted',
      jsonb_build_object(
        'previous_total', v_previous_total,
        'new_total', v_total,
        'installments', v_installment_count,
        'cancelled', v_total = 0,
        'manual_discount', round(p_manual_discount, 2)
      ),
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'adjusted', true,
    'already_adjusted', false,
    'installments', v_installment_count,
    'total', v_total,
    'cancelled', v_total = 0,
    'audit_logged', round(v_previous_discount, 2) <> round(p_manual_discount, 2)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_reopen_manual_payment(
  p_order_type TEXT,
  p_order_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status TEXT;
  v_manual_payment BOOLEAN;
  v_asaas_charge_id TEXT;
  v_payment_method TEXT;
  v_manual_fee NUMERIC;
  v_target_status TEXT;
  v_removed INTEGER := 0;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de venda inválido';
  END IF;

  v_target_status := CASE WHEN p_order_type = 'contract' THEN 'pending' ELSE 'awaiting_charge' END;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, manual_payment, asaas_charge_id, payment_method, manual_fee
    INTO v_payment_status, v_manual_payment, v_asaas_charge_id, v_payment_method, v_manual_fee
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSIF p_order_type = 'stock' THEN
    SELECT payment_status, manual_payment, asaas_charge_id, payment_method, manual_fee
    INTO v_payment_status, v_manual_payment, v_asaas_charge_id, v_payment_method, v_manual_fee
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, manual_payment, asaas_charge_id, payment_method, manual_fee
    INTO v_payment_status, v_manual_payment, v_asaas_charge_id, v_payment_method, v_manual_fee
    FROM public.assessment_contracts
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  IF v_payment_status = v_target_status AND NOT COALESCE(v_manual_payment, false) THEN
    RETURN jsonb_build_object(
      'reopened', true,
      'already_reopened', true,
      'payment_status', v_target_status,
      'manual_payments_removed', 0
    );
  END IF;

  IF v_payment_status <> 'paid' OR NOT COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente pagamentos manuais confirmados podem ser reabertos';
  END IF;
  IF NULLIF(v_asaas_charge_id, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A venda possui uma cobrança Asaas vinculada e precisa de conferência';
  END IF;

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = p_order_type
    AND source = 'manual';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET payment_status = v_target_status,
        payment_date = NULL,
        payment_method = NULL,
        manual_payment = false,
        manual_fee = NULL,
        updated_date = now()
    WHERE id = p_order_id;
  ELSIF p_order_type = 'stock' THEN
    UPDATE public.stock_orders
    SET payment_status = v_target_status,
        payment_date = NULL,
        payment_method = NULL,
        manual_payment = false,
        manual_fee = NULL,
        updated_date = now()
    WHERE id = p_order_id;
  ELSE
    UPDATE public.assessment_contracts
    SET payment_status = v_target_status,
        payment_date = NULL,
        payment_method = NULL,
        manual_payment = false,
        manual_fee = NULL,
        updated_at = now()
    WHERE id = p_order_id;
  END IF;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    p_order_type,
    p_order_id,
    v_payment_status,
    v_target_status,
    'manual_payment_reopened',
    jsonb_build_object(
      'payment_method_before', v_payment_method,
      'manual_fee_before', v_manual_fee,
      'manual_payments_removed', v_removed
    ),
    p_actor_id
  );

  IF p_order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    )
    VALUES (
      p_order_id,
      'payment_reverted',
      jsonb_build_object(
        'method_before', v_payment_method,
        'fee_before', v_manual_fee,
        'manual_payments_removed', v_removed
      ),
      'Pagamento manual revertido',
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'reopened', true,
    'already_reopened', false,
    'payment_status', v_target_status,
    'manual_payments_removed', v_removed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.api_record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_adjust_manual_payment(TEXT, UUID, NUMERIC, NUMERIC, TEXT, BOOLEAN, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_reopen_manual_payment(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.api_record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.api_adjust_manual_payment(TEXT, UUID, NUMERIC, NUMERIC, TEXT, BOOLEAN, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.api_reopen_manual_payment(TEXT, UUID, UUID)
  TO service_role;

-- Keep the old frontend operational during a staggered rollout, but harden the
-- compatibility wrapper with the same admin allowlist used by api-v1. Direct
-- access to the private implementation is removed.
CREATE OR REPLACE FUNCTION public.record_manual_payment(
  p_order_type TEXT,
  p_order_id UUID,
  p_payment_method_id UUID,
  p_payment_date DATE,
  p_total NUMERIC,
  p_installments JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT eon_private.is_app_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso administrativo obrigatório';
  END IF;

  RETURN eon_private.record_manual_payment(
    p_order_type,
    p_order_id,
    p_payment_method_id,
    p_payment_date,
    p_total,
    p_installments
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION eon_private.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB)
  FROM authenticated;
REVOKE ALL ON FUNCTION public.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB)
  TO authenticated;

COMMENT ON FUNCTION public.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB) IS
  'Temporary admin-only compatibility wrapper; new frontend code uses api-v1.';

COMMENT ON FUNCTION public.api_record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB, UUID) IS
  'Server-only, atomic and retry-safe manual payment registration.';
COMMENT ON FUNCTION public.api_adjust_manual_payment(TEXT, UUID, NUMERIC, NUMERIC, TEXT, BOOLEAN, UUID) IS
  'Server-only exact-cent reallocation of confirmed manual installments.';
COMMENT ON FUNCTION public.api_reopen_manual_payment(TEXT, UUID, UUID) IS
  'Server-only, atomic and retry-safe reopening of a confirmed manual payment.';
