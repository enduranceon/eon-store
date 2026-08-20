CREATE OR REPLACE FUNCTION public.perform_assessment_contract_cancellation(
  p_contract assessment_contracts,
  p_cancellation_date date,
  p_cancellation_fee_pct numeric,
  p_reason text,
  p_actor_id uuid,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE := p_contract;
  v_price_total numeric;
  v_total_days integer;
  v_remaining_days integer;
  v_remaining numeric;
  v_fee numeric;
  v_refund numeric;
  v_payment_status_before text := p_contract.payment_status;
  v_term_completed boolean;
  v_next_status text;
BEGIN
  SELECT coalesce(
    CASE WHEN jsonb_typeof(v_contract.plan_snapshot->'price_total') IN ('number', 'string')
      THEN nullif(v_contract.plan_snapshot->>'price_total', '')::numeric END,
    p.price_total,
    0
  ) INTO v_price_total
  FROM public.assessment_plans p WHERE p.id = v_contract.plan_id;
  v_price_total := coalesce(v_price_total, 0);

  v_total_days := greatest(1, (v_contract.end_date - v_contract.start_date) + 1);
  v_remaining_days := greatest(0, (v_contract.end_date - p_cancellation_date) + 1);
  v_remaining := round(v_price_total * v_remaining_days / v_total_days, 2);
  v_fee := round(v_remaining * p_cancellation_fee_pct / 100, 2);
  v_refund := greatest(0, round(v_remaining - v_fee, 2));

  -- Prazo cumprido => nao-renovacao, e nao interrupcao.
  -- end_date e EXCLUSIVA (ultimo dia ativo = end_date - 1), como em activeDayKeys
  -- da edge function generate-monthly-closing.
  v_term_completed := v_contract.end_date IS NOT NULL
                      AND p_cancellation_date >= v_contract.end_date;
  v_next_status := CASE WHEN v_term_completed THEN 'finished' ELSE 'cancelled' END;

  UPDATE public.assessment_contracts
  SET status = v_next_status,
      cancellation_date = p_cancellation_date,
      cancellation_fee = v_fee,
      cancellation_reason = nullif(btrim(p_reason), ''),
      refund_status = CASE WHEN v_refund > 0 THEN 'pending' ELSE NULL END,
      refund_amount = CASE WHEN v_refund > 0 THEN v_refund ELSE NULL END,
      scheduled_cancellation_date = NULL,
      scheduled_cancellation_fee_pct = NULL,
      scheduled_cancellation_reason = NULL,
      scheduled_cancellation_at = NULL,
      scheduled_cancellation_by = NULL,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
  VALUES (v_contract.id, 'cancelled', jsonb_build_object(
    'remaining_days', v_remaining_days,
    'remaining_value', v_remaining,
    'cancellation_fee', v_fee,
    'cancellation_fee_pct', p_cancellation_fee_pct,
    'refund_amount', v_refund,
    'cancellation_reason', nullif(btrim(p_reason), ''),
    'cancellation_date', p_cancellation_date,
    'payment_status_before', v_payment_status_before,
    'term_completed', v_term_completed,
    'status_after', v_next_status,
    'source', p_source
  ), nullif(btrim(p_reason), ''), p_actor_id);

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'remaining_days', v_remaining_days,
    'remaining', v_remaining,
    'cancellation_fee', v_fee,
    'refund_amount', v_refund,
    'term_completed', v_term_completed,
    'status', v_next_status
  );
END;
$function$;

DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'apply_assessment_contract_transitions';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'apply_assessment_contract_transitions nao encontrada';
  END IF;

  v_new := replace(
    v_src,
    $q$      'status', 'cancelled',$q$,
    $q$      'status', coalesce(v_result->'contract'->>'status', 'cancelled'),$q$
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION 'trecho status/cancelled nao encontrado - revisar manualmente';
  END IF;

  EXECUTE v_new;
END
$mig$;;
