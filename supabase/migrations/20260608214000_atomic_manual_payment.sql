CREATE OR REPLACE FUNCTION eon_private.record_manual_payment(
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
DECLARE
  v_method public.payment_methods%ROWTYPE;
  v_previous_status TEXT;
  v_order_total NUMERIC;
  v_order_number TEXT;
  v_asaas_charge_id TEXT;
  v_manual_payment BOOLEAN;
  v_fee NUMERIC;
  v_net_total NUMERIC;
  v_installment_count INTEGER;
  v_item JSONB;
  v_number INTEGER;
  v_due_date DATE;
  v_credit_date DATE;
  v_value NUMERIC;
  v_net_value NUMERIC;
  v_allocated_value NUMERIC := 0;
  v_allocated_net NUMERIC := 0;
  v_method_code TEXT;
  v_expected_number INTEGER := 1;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  IF p_order_type IS NULL OR p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION 'Tipo de venda inválido';
  END IF;
  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION 'Data de pagamento obrigatória';
  END IF;
  IF p_total IS NULL OR p_total < 0 THEN
    RAISE EXCEPTION 'Valor inválido';
  END IF;

  SELECT *
  INTO v_method
  FROM public.payment_methods
  WHERE id = p_payment_method_id
    AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Método de pagamento inválido ou inativo';
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
        COALESCE((c.plan_snapshot->>'price_total')::numeric, p.price_total, 0)
        + COALESCE(c.enrollment_fee, 0)
        - COALESCE(c.manual_discount, 0)
        - COALESCE(c.credit_balance, 0)
      ),
      c.payment_status,
      c.contract_number,
      c.asaas_charge_id,
      c.manual_payment
    INTO v_order_total, v_previous_status, v_order_number, v_asaas_charge_id, v_manual_payment
    FROM public.assessment_contracts c
    LEFT JOIN public.assessment_plans p ON p.id = c.plan_id
    WHERE c.id = p_order_id
    FOR UPDATE OF c;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não encontrada';
  END IF;
  IF v_previous_status IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION 'Não é possível registrar pagamento nesta venda';
  END IF;
  IF v_previous_status = 'paid' AND NOT COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION 'A venda já foi paga por outro fluxo';
  END IF;
  IF v_asaas_charge_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cancele a cobrança Asaas antes de registrar pagamento por fora';
  END IF;
  IF abs(COALESCE(v_order_total, 0) - p_total) > 0.009 THEN
    RAISE EXCEPTION 'Pagamento parcial ainda não está habilitado. Informe o valor integral.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.asaas_payments
    WHERE order_id = p_order_id
      AND order_type = p_order_type
      AND source = 'asaas'
      AND status IN ('PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
  ) THEN
    RAISE EXCEPTION 'Existe uma cobrança Asaas ativa. Cancele ou estorne antes de registrar pagamento por fora.';
  END IF;

  v_installment_count := GREATEST(1, LEAST(12, COALESCE(v_method.installments, 1)));
  IF jsonb_typeof(p_installments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_installments) <> v_installment_count THEN
    RAISE EXCEPTION 'Projeção de parcelas inválida';
  END IF;

  v_fee := round(
    (p_total * COALESCE(v_method.fee_percent, 0) / 100)
    + COALESCE(v_method.fee_fixed, 0),
    2
  );
  v_net_total := GREATEST(0, p_total - v_fee);
  v_method_code := COALESCE(NULLIF(v_method.internal_code, ''), v_method.kind);

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = p_order_type
    AND source = 'manual';

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_installments)
    ORDER BY (value->>'number')::integer
  LOOP
    v_number := (v_item->>'number')::integer;
    v_due_date := (v_item->>'due_date')::date;
    v_credit_date := (v_item->>'credit_date')::date;

    IF v_number IS NULL OR v_number <> v_expected_number
       OR v_due_date IS NULL OR v_credit_date IS NULL THEN
      RAISE EXCEPTION 'Parcela inválida';
    END IF;

    IF v_number = v_installment_count THEN
      v_value := p_total - v_allocated_value;
      v_net_value := v_net_total - v_allocated_net;
    ELSE
      v_value := round(p_total / v_installment_count, 2);
      v_net_value := round(v_net_total / v_installment_count, 2);
    END IF;

    INSERT INTO public.asaas_payments(
      asaas_payment_id, source, payment_method_id, installment_number,
      total_installments, billing_type, status, value, net_value, due_date,
      credit_date, payment_date, description, external_reference, order_id,
      order_type, raw, last_synced_at
    )
    VALUES (
      'manual_' || p_order_id::text || '_' || v_number || '_' || replace(gen_random_uuid()::text, '-', ''),
      'manual',
      v_method.id,
      v_number,
      v_installment_count,
      upper(v_method.kind),
      'CONFIRMED',
      v_value,
      v_net_value,
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
    v_allocated_net := v_allocated_net + v_net_value;
    v_expected_number := v_expected_number + 1;
  END LOOP;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET payment_status = 'paid',
        payment_method = v_method_code,
        payment_date = p_payment_date,
        manual_payment = true,
        manual_fee = NULLIF(v_fee, 0),
        updated_date = now()
    WHERE id = p_order_id;
  ELSIF p_order_type = 'stock' THEN
    UPDATE public.stock_orders
    SET payment_status = 'paid',
        payment_method = v_method_code,
        payment_date = p_payment_date,
        manual_payment = true,
        manual_fee = NULLIF(v_fee, 0),
        updated_date = now()
    WHERE id = p_order_id;
  ELSE
    UPDATE public.assessment_contracts
    SET payment_status = 'paid',
        payment_method = v_method_code,
        payment_date = p_payment_date,
        manual_payment = true,
        manual_fee = NULLIF(v_fee, 0),
        updated_at = now()
    WHERE id = p_order_id;
  END IF;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata
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
      'total', p_total,
      'fee', v_fee,
      'installments', v_installment_count
    )
  );

  RETURN jsonb_build_object(
    'installments', v_installment_count,
    'total_gross', p_total,
    'total_fee', v_fee,
    'total_net', v_net_total,
    'value_per_installment', round(p_total / v_installment_count, 2)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_manual_payment(
  p_order_type TEXT,
  p_order_id UUID,
  p_payment_method_id UUID,
  p_payment_date DATE,
  p_total NUMERIC,
  p_installments JSONB
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT eon_private.record_manual_payment(
    p_order_type,
    p_order_id,
    p_payment_method_id,
    p_payment_date,
    p_total,
    p_installments
  );
$$;

REVOKE ALL ON FUNCTION eon_private.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION eon_private.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_payment(TEXT, UUID, UUID, DATE, NUMERIC, JSONB) TO authenticated;
