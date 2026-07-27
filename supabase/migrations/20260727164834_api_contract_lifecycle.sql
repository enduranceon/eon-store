-- Contract lifecycle mutations are executed only by api-v1 with the service role.
-- Each function locks the contract, checks optimistic concurrency, changes state,
-- and writes its audit event in the same transaction.

CREATE OR REPLACE FUNCTION public.update_assessment_contract_dates(
  p_contract_id uuid,
  p_start_date date,
  p_end_date date,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_old_start date;
  v_old_end date;
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date <= p_start_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um período válido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.start_date = p_start_date AND v_contract.end_date = p_end_date THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'As datas de um contrato encerrado não podem ser alteradas';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_old_start := v_contract.start_date;
  v_old_end := v_contract.end_date;

  UPDATE public.assessment_contracts
  SET start_date = p_start_date,
      end_date = p_end_date,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, created_by)
  VALUES (
    p_contract_id,
    'dates_changed',
    jsonb_build_object(
      'old_start', v_old_start,
      'new_start', p_start_date,
      'old_end', v_old_end,
      'new_end', p_end_date
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.change_assessment_contract_coach(
  p_contract_id uuid,
  p_coach_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_old_coach_name text;
  v_new_coach_name text;
  v_old_coach_id uuid;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.coach_id = p_coach_id THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O coach de um contrato encerrado não pode ser alterado';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_old_coach_id := v_contract.coach_id;
  SELECT name INTO v_old_coach_name FROM public.assessment_coaches WHERE id = v_old_coach_id;
  SELECT name INTO v_new_coach_name FROM public.assessment_coaches WHERE id = p_coach_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione um coach ativo';
  END IF;

  UPDATE public.assessment_contracts
  SET coach_id = p_coach_id, updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, created_by)
  VALUES (p_contract_id, 'coach_changed', jsonb_build_object(
    'from_coach_id', v_old_coach_id,
    'from_coach_name', v_old_coach_name,
    'to_coach_id', p_coach_id,
    'to_coach_name', v_new_coach_name
  ), p_actor_id);

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.start_assessment_contract_leave(
  p_contract_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_leave public.assessment_leaves%ROWTYPE;
  v_old_end date;
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um período de licença válido';
  END IF;
  IF length(coalesce(p_reason, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O motivo da licença é muito longo';
  END IF;

  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  SELECT * INTO v_leave FROM public.assessment_leaves
  WHERE contract_id = p_contract_id AND status = 'active'
  ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_leave.start_date = p_start_date AND v_leave.end_date = p_end_date
       AND v_leave.reason IS NOT DISTINCT FROM nullif(btrim(p_reason), '') THEN
      RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'leave', to_jsonb(v_leave), 'unchanged', true);
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato já possui uma licença ativa';
  END IF;
  IF v_contract.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente contratos ativos podem iniciar licença';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_old_end := v_contract.end_date;
  INSERT INTO public.assessment_leaves(contract_id, start_date, end_date, days, reason, status, created_by)
  VALUES (p_contract_id, p_start_date, p_end_date, (p_end_date - p_start_date) + 1,
          nullif(btrim(p_reason), ''), 'active', p_actor_id)
  RETURNING * INTO v_leave;

  UPDATE public.assessment_contracts SET updated_at = now()
  WHERE id = p_contract_id RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
  VALUES (p_contract_id, 'leave_started', jsonb_build_object(
    'leave_id', v_leave.id,
    'leave_start', v_leave.start_date,
    'leave_end', v_leave.end_date,
    'days', v_leave.days,
    'reason', v_leave.reason,
    'old_end_date', v_old_end,
    'new_end_date', v_contract.end_date
  ), v_leave.reason, p_actor_id);

  RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'leave', to_jsonb(v_leave));
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_assessment_contract_leave(
  p_contract_id uuid,
  p_leave_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_leave public.assessment_leaves%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  SELECT * INTO v_leave FROM public.assessment_leaves
  WHERE id = p_leave_id AND contract_id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Licença não encontrada';
  END IF;
  IF v_leave.status = 'finished' THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'leave', to_jsonb(v_leave), 'unchanged', true);
  END IF;
  IF v_contract.status <> 'on_leave' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato não está em licença';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  UPDATE public.assessment_leaves SET status = 'finished', updated_at = now()
  WHERE id = p_leave_id RETURNING * INTO v_leave;

  v_status := CASE
    WHEN v_contract.end_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'overdue'
    ELSE 'active'
  END;
  IF EXISTS (SELECT 1 FROM public.assessment_leaves WHERE contract_id = p_contract_id AND status = 'active') THEN
    v_status := 'on_leave';
  END IF;
  UPDATE public.assessment_contracts SET status = v_status, updated_at = now()
  WHERE id = p_contract_id RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, created_by)
  VALUES (p_contract_id, 'leave_ended', jsonb_build_object(
    'leave_id', v_leave.id, 'days', v_leave.days, 'new_status', v_status
  ), p_actor_id);

  RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'leave', to_jsonb(v_leave));
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_assessment_contract(
  p_contract_id uuid,
  p_cancellation_date date,
  p_cancellation_fee_pct numeric,
  p_reason text,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_price_total numeric;
  v_total_days integer;
  v_remaining_days integer;
  v_remaining numeric;
  v_fee numeric;
  v_refund numeric;
  v_payment_status_before text;
BEGIN
  IF p_cancellation_date IS NULL OR p_cancellation_fee_pct IS NULL
     OR p_cancellation_fee_pct < 0 OR p_cancellation_fee_pct > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe dados válidos para o cancelamento';
  END IF;
  IF length(coalesce(p_reason, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O motivo do cancelamento é muito longo';
  END IF;

  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.status = 'cancelled' THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF v_contract.status IN ('voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já está encerrado';
  END IF;
  IF p_cancellation_date < v_contract.start_date OR p_cancellation_date >= v_contract.end_date
     OR p_cancellation_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A data deve estar entre o início e antes do fim do contrato, sem ser futura';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  SELECT coalesce(
    CASE WHEN jsonb_typeof(v_contract.plan_snapshot->'price_total') IN ('number', 'string')
      THEN nullif(v_contract.plan_snapshot->>'price_total', '')::numeric END,
    p.price_total,
    0
  ) INTO v_price_total
  FROM public.assessment_plans p WHERE p.id = v_contract.plan_id;

  v_total_days := greatest(1, (v_contract.end_date - v_contract.start_date) + 1);
  v_remaining_days := greatest(0, (v_contract.end_date - p_cancellation_date) + 1);
  v_remaining := round(v_price_total * v_remaining_days / v_total_days, 2);
  v_fee := round(v_remaining * p_cancellation_fee_pct / 100, 2);
  v_refund := greatest(0, round(v_remaining - v_fee, 2));
  v_payment_status_before := v_contract.payment_status;

  UPDATE public.assessment_contracts
  SET status = 'cancelled',
      cancellation_date = p_cancellation_date,
      cancellation_fee = v_fee,
      cancellation_reason = nullif(btrim(p_reason), ''),
      refund_status = CASE WHEN v_refund > 0 THEN 'pending' ELSE NULL END,
      refund_amount = CASE WHEN v_refund > 0 THEN v_refund ELSE NULL END,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
  VALUES (p_contract_id, 'cancelled', jsonb_build_object(
    'remaining_days', v_remaining_days,
    'remaining_value', v_remaining,
    'cancellation_fee', v_fee,
    'cancellation_fee_pct', p_cancellation_fee_pct,
    'refund_amount', v_refund,
    'cancellation_reason', nullif(btrim(p_reason), ''),
    'cancellation_date', p_cancellation_date,
    'payment_status_before', v_payment_status_before
  ), nullif(btrim(p_reason), ''), p_actor_id);

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'remaining_days', v_remaining_days,
    'remaining', v_remaining,
    'cancellation_fee', v_fee,
    'refund_amount', v_refund
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_assessment_contract_dates(uuid, date, date, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_assessment_contract_leave(uuid, date, date, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_assessment_contract_leave(uuid, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_assessment_contract(uuid, date, numeric, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_assessment_contract_dates(uuid, date, date, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_assessment_contract_leave(uuid, date, date, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_assessment_contract_leave(uuid, uuid, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_assessment_contract(uuid, date, numeric, text, timestamptz, uuid) TO service_role;
