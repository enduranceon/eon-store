-- Cancelamento agendado.
--
-- Antes existiam só duas saídas quando o aluno avisava que ia sair numa data
-- futura: cancelar na hora (e ele sumia dos ativos enquanto ainda treinava,
-- tirando do treinador o repasse dos dias efetivamente atendidos) ou esperar o
-- dia e lembrar de fazer na mão. O agendamento descreve o que de fato acontece:
-- o aluno segue ativo até a data combinada e o cancelamento executa sozinho.
--
-- A trava de data futura em cancel_assessment_contract CONTINUA valendo: um
-- cancelamento imediato realmente não pode ter data futura. Data futura agora é
-- outra operação, com rota própria.

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS scheduled_cancellation_date date,
  ADD COLUMN IF NOT EXISTS scheduled_cancellation_fee_pct numeric,
  ADD COLUMN IF NOT EXISTS scheduled_cancellation_reason text,
  ADD COLUMN IF NOT EXISTS scheduled_cancellation_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_cancellation_by uuid;

COMMENT ON COLUMN public.assessment_contracts.scheduled_cancellation_date IS
  'Data futura combinada para o cancelamento. O contrato segue ativo até lá; apply_assessment_contract_transitions executa o cancelamento quando o dia chega.';

CREATE INDEX IF NOT EXISTS assessment_contracts_scheduled_cancellation_idx
  ON public.assessment_contracts (scheduled_cancellation_date)
  WHERE scheduled_cancellation_date IS NOT NULL;

-- Núcleo do cancelamento, compartilhado pelo caminho imediato e pelo agendado.
-- Existe para que a matemática do pró-rata não possa divergir entre os dois.
-- Pressupõe que quem chama já travou a linha (FOR UPDATE) e já validou status,
-- datas e concorrência.
CREATE OR REPLACE FUNCTION public.perform_assessment_contract_cancellation(
  p_contract public.assessment_contracts,
  p_cancellation_date date,
  p_cancellation_fee_pct numeric,
  p_reason text,
  p_actor_id uuid,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE := p_contract;
  v_price_total numeric;
  v_total_days integer;
  v_remaining_days integer;
  v_remaining numeric;
  v_fee numeric;
  v_refund numeric;
  v_payment_status_before text := p_contract.payment_status;
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

  UPDATE public.assessment_contracts
  SET status = 'cancelled',
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
    'source', p_source
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

-- Cancelamento imediato: mesma validação de antes, agora delegando a conta.
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
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Para uma data futura, use o agendamento de cancelamento';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  RETURN public.perform_assessment_contract_cancellation(
    v_contract, p_cancellation_date, p_cancellation_fee_pct, p_reason, p_actor_id, 'immediate'
  );
END;
$$;

-- Agenda o cancelamento para uma data futura. Só grava a intenção: o estorno
-- nasce na data da execução, para o Financeiro não exibir estorno pendente de
-- aluno que ainda está treinando, e para desfazer não ter nada a reverter.
CREATE OR REPLACE FUNCTION public.schedule_assessment_contract_cancellation(
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
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
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
  IF v_contract.status NOT IN ('active', 'on_leave') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Só dá para agendar o cancelamento de um contrato vigente';
  END IF;
  IF p_cancellation_date <= v_today THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A data agendada precisa ser futura. Para hoje ou antes, use o cancelamento normal';
  END IF;
  IF p_cancellation_date < v_contract.start_date OR p_cancellation_date >= v_contract.end_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A data agendada precisa estar dentro da vigência. Para o fim natural, use "Não renovar"';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  UPDATE public.assessment_contracts
  SET scheduled_cancellation_date = p_cancellation_date,
      scheduled_cancellation_fee_pct = p_cancellation_fee_pct,
      scheduled_cancellation_reason = nullif(btrim(p_reason), ''),
      scheduled_cancellation_at = now(),
      scheduled_cancellation_by = p_actor_id,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
  VALUES (p_contract_id, 'cancellation_scheduled', jsonb_build_object(
    'scheduled_cancellation_date', p_cancellation_date,
    'cancellation_fee_pct', p_cancellation_fee_pct,
    'cancellation_reason', nullif(btrim(p_reason), '')
  ), nullif(btrim(p_reason), ''), p_actor_id);

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- Desfaz o agendamento. Não há estorno para reverter, por construção.
CREATE OR REPLACE FUNCTION public.unschedule_assessment_contract_cancellation(
  p_contract_id uuid,
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
  v_previous_date date;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.scheduled_cancellation_date IS NULL THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_previous_date := v_contract.scheduled_cancellation_date;

  UPDATE public.assessment_contracts
  SET scheduled_cancellation_date = NULL,
      scheduled_cancellation_fee_pct = NULL,
      scheduled_cancellation_reason = NULL,
      scheduled_cancellation_at = NULL,
      scheduled_cancellation_by = NULL,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
  VALUES (p_contract_id, 'cancellation_schedule_removed', jsonb_build_object(
    'previous_scheduled_cancellation_date', v_previous_date
  ), 'Agendamento de cancelamento desfeito', p_actor_id);

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- Motor de transições: executa os cancelamentos agendados cuja data chegou.
-- O laço novo vem ANTES do de fim de vigência de propósito: se ninguém abriu o
-- sistema entre a data agendada e o fim do contrato, o cancelamento ainda
-- executa com a data combinada (e o pró-rata certo) em vez de o contrato
-- simplesmente vencer.
CREATE OR REPLACE FUNCTION public.apply_assessment_contract_transitions(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_changed jsonb := '[]'::jsonb;
  v_next_status text;
  v_previous_status text;
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE status = 'scheduled' AND start_date <= v_today
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.assessment_contracts
    SET status = 'active', updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object('status_before', 'scheduled', 'status_after', 'active', 'effective_date', v_today),
      'Contrato ativado automaticamente no início da vigência', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id, 'status', v_contract.status, 'updated_at', v_contract.updated_at
    ));
  END LOOP;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE scheduled_cancellation_date IS NOT NULL
      AND scheduled_cancellation_date <= v_today
      AND status IN ('active', 'on_leave', 'overdue')
    FOR UPDATE SKIP LOCKED
  LOOP
    v_result := public.perform_assessment_contract_cancellation(
      v_contract,
      v_contract.scheduled_cancellation_date,
      coalesce(v_contract.scheduled_cancellation_fee_pct, 0),
      v_contract.scheduled_cancellation_reason,
      p_actor_id,
      'scheduled'
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id,
      'status', 'cancelled',
      'updated_at', v_result->'contract'->>'updated_at'
    ));
  END LOOP;

  FOR v_contract IN
    SELECT parent.*
    FROM public.assessment_contracts parent
    WHERE parent.status IN ('active', 'overdue', 'on_leave')
      AND EXISTS (
        SELECT 1 FROM public.assessment_contracts renewal
        WHERE renewal.parent_contract_id = parent.id
          AND renewal.status = 'active'
          AND renewal.start_date <= v_today
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    v_previous_status := v_contract.status;
    UPDATE public.assessment_contracts
    SET status = 'finished', updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object('status_before', v_previous_status, 'status_after', 'finished', 'effective_date', v_today, 'reason', 'renewal_started'),
      'Contrato concluído automaticamente pelo início da renovação', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id, 'status', 'finished', 'updated_at', v_contract.updated_at
    ));
  END LOOP;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE status = 'active' AND end_date < v_today
    FOR UPDATE SKIP LOCKED
  LOOP
    v_next_status := CASE
      WHEN lower(COALESCE(v_contract.cancellation_reason, '')) ~
        '(não renovou|nao renovou|não vai renovar|nao vai renovar)'
        THEN 'finished'
      ELSE 'overdue'
    END;
    UPDATE public.assessment_contracts
    SET status = v_next_status, updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object('status_before', 'active', 'status_after', v_next_status, 'effective_date', v_today, 'reason', 'end_date_passed'),
      'Status atualizado automaticamente após o fim da vigência', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id, 'status', v_contract.status, 'updated_at', v_contract.updated_at
    ));
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed, 'effective_date', v_today);
END;
$$;

REVOKE ALL ON FUNCTION public.perform_assessment_contract_cancellation(
  public.assessment_contracts, date, numeric, text, uuid, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_assessment_contract_cancellation(
  uuid, date, numeric, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unschedule_assessment_contract_cancellation(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_assessment_contract(
  uuid, date, numeric, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_assessment_contract_transitions(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.perform_assessment_contract_cancellation(
  public.assessment_contracts, date, numeric, text, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.schedule_assessment_contract_cancellation(
  uuid, date, numeric, text, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.unschedule_assessment_contract_cancellation(
  uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_assessment_contract(
  uuid, date, numeric, text, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_assessment_contract_transitions(uuid)
  TO service_role;
