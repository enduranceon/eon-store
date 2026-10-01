-- Update existing rows in place so cash-flow links and payment identities survive.
CREATE OR REPLACE FUNCTION public.api_edit_manual_payment_installments(
  p_order_type text, p_order_id uuid, p_installments jsonb, p_expected jsonb, p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_manual boolean;
  v_charge text;
  v_refund numeric;
  v_before jsonb;
  v_after jsonb;
  v_count integer;
  v_total numeric;
  v_sum numeric;
  v_row jsonb;
  v_payment public.asaas_payments%ROWTYPE;
  v_value numeric;
  v_net_total numeric;
  v_net_allocated numeric := 0;
  v_net numeric;
  v_index integer := 0;
BEGIN
  IF p_actor_id IS NULL OR p_order_id IS NULL OR p_order_type IS NULL
     OR p_order_type NOT IN ('presale','stock','contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Venda ou operador inválido';
  END IF;
  IF p_order_type = 'presale' THEN
    SELECT payment_status, manual_payment, asaas_charge_id INTO v_status, v_manual, v_charge
      FROM public.presale_orders WHERE id = p_order_id FOR UPDATE;
  ELSIF p_order_type = 'stock' THEN
    SELECT payment_status, manual_payment, asaas_charge_id INTO v_status, v_manual, v_charge
      FROM public.stock_orders WHERE id = p_order_id FOR UPDATE;
  ELSE
    SELECT payment_status, manual_payment, asaas_charge_id, refund_amount INTO v_status, v_manual, v_charge, v_refund
      FROM public.assessment_contracts WHERE id = p_order_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;
  IF v_status IS DISTINCT FROM 'paid' OR v_manual IS DISTINCT FROM true OR nullif(v_charge, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente pagamentos manuais pagos podem ter parcelas editadas';
  END IF;
  IF coalesce(v_refund, 0) > 0 OR EXISTS (
    SELECT 1 FROM public.assessment_contract_refund_allocations WHERE contract_id = p_order_id
  ) OR EXISTS (
    SELECT 1 FROM public.order_returns WHERE order_id = p_order_id AND order_type = p_order_type AND refund_value > 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Pagamento com estorno não pode ter parcelas editadas';
  END IF;
  PERFORM id FROM public.asaas_payments WHERE order_id = p_order_id AND order_type = p_order_type ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.asaas_payments WHERE order_id = p_order_id AND order_type = p_order_type
    AND (source IS DISTINCT FROM 'manual' OR status NOT IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') OR status IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pagamento possui parcelas não editáveis';
  END IF;
  SELECT count(*), sum(value), sum(coalesce(net_value,value)), jsonb_agg(jsonb_build_object('id',id,'value',value,'due_date',due_date,'credit_date',credit_date) ORDER BY id)
    INTO v_count, v_total, v_net_total, v_before FROM public.asaas_payments
    WHERE order_id = p_order_id AND order_type = p_order_type AND source = 'manual';
  IF v_count = 0 OR jsonb_typeof(p_installments) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_expected) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcelas inválidas';
  END IF;
  IF jsonb_array_length(p_installments) <> v_count OR jsonb_array_length(p_expected) <> v_count
    OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_installments) x) <> v_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A quantidade de parcelas deve permanecer igual';
  END IF;
  IF (SELECT jsonb_agg(jsonb_build_object('id',(x->>'id')::uuid,'value',(x->>'value')::numeric,
      'due_date',(x->>'due_date')::date,'credit_date',(x->>'credit_date')::date) ORDER BY (x->>'id')::uuid)
      FROM jsonb_array_elements(p_expected) x) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'As parcelas foram alteradas. Atualize a página e tente novamente';
  END IF;
  v_sum := 0;
  FOR v_row IN SELECT x FROM jsonb_array_elements(p_installments) x ORDER BY x->>'id' LOOP
    SELECT * INTO v_payment FROM public.asaas_payments WHERE id = (v_row->>'id')::uuid
      AND order_id = p_order_id AND order_type = p_order_type AND source = 'manual';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela não pertence a este pagamento';
    END IF;
    v_value := (v_row->>'value')::numeric;
    IF v_value IS NULL OR v_value <= 0 OR v_value > 100000000 OR v_value <> round(v_value,2)
      OR nullif(v_row->>'credit_date','') IS NULL OR nullif(v_row->>'due_date','') IS NULL
      OR NOT isfinite((v_row->>'credit_date')::date) OR NOT isfinite((v_row->>'due_date')::date) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Data ou valor da parcela inválido';
    END IF;
    v_sum := v_sum + v_value;
    v_index := v_index + 1;
    v_net := CASE WHEN v_index = v_count THEN v_net_total - v_net_allocated
      ELSE round(v_sum * v_net_total / nullif(v_total,0),2) - v_net_allocated END;
    v_net_allocated := v_net_allocated + v_net;
    UPDATE public.asaas_payments SET value = v_value, net_value = v_net,
      due_date = (v_row->>'due_date')::date, credit_date = (v_row->>'credit_date')::date
      WHERE id = v_payment.id;
  END LOOP;
  IF v_sum IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A soma das parcelas precisa ser igual ao valor total';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id',id,'value',value,'due_date',due_date,'credit_date',credit_date) ORDER BY id)
    INTO v_after FROM public.asaas_payments WHERE order_id = p_order_id AND order_type = p_order_type AND source = 'manual';
  INSERT INTO public.sales_status_events(order_type,order_id,previous_status,new_status,reason,metadata,actor_id)
    VALUES(p_order_type,p_order_id,v_status,v_status,'manual_payment_installments_edited',
      jsonb_build_object('before',v_before,'after',v_after),p_actor_id);
  IF p_order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event(contract_id,event_type,payload,created_by)
      VALUES(p_order_id,'manual_payment_installments_edited',jsonb_build_object('before',v_before,'after',v_after),p_actor_id);
  END IF;
  RETURN jsonb_build_object('installments',v_count,'total',v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.api_edit_manual_payment_installments(text,uuid,jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.api_edit_manual_payment_installments(text,uuid,jsonb,jsonb,uuid) TO service_role;
