BEGIN;

-- Troca de coach com a data em que o novo coach começa.
--
-- - Hoje ou antes: o contrato troca de coach na hora. Para trás, a troca não
--   entra em mês de repasse já aprovado ou pago, nem antes do início do coach
--   atual.
-- - Depois de hoje: a troca fica agendada e o coach do contrato muda sozinho
--   na data, junto com as outras transições do dia. A troca agendada pode ser
--   cancelada.
-- - A renovação que ainda não começou acompanha o coach do último dia do
--   contrato.
-- O fechamento do repasse já divide os dias pelo histórico de coach: a linha
-- registrada por último vale a partir do started_at dela.

-- 1. Linha do histórico que vale no dia e troca agendada ------------------------------

-- Mesma regra de eon_private.contract_coach_on, devolvendo a linha.
CREATE OR REPLACE FUNCTION eon_private.contract_coach_row_on(
  p_contract_id uuid,
  p_day date
)
RETURNS public.assessment_contract_coach_history
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.assessment_contract_coach_history%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.assessment_contract_coach_history AS history
  WHERE history.contract_id = p_contract_id
    AND history.started_at <= p_day
  ORDER BY history.created_at DESC NULLS LAST,
           (history.ended_at IS NULL) DESC,
           history.started_at DESC,
           history.id DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  SELECT * INTO v_row
  FROM public.assessment_contract_coach_history AS history
  WHERE history.contract_id = p_contract_id
  ORDER BY history.created_at ASC NULLS FIRST,
           (history.ended_at IS NULL) ASC,
           history.started_at ASC,
           history.id ASC
  LIMIT 1;
  RETURN v_row;
END;
$$;

-- Troca agendada: troca de coach (fora de mudança de plano) que começa depois
-- de hoje e depois do início do contrato. A primeira linha do contrato começa
-- no início dele e não conta.
CREATE OR REPLACE FUNCTION eon_private.pending_contract_coach_change(
  p_contract_id uuid
)
RETURNS public.assessment_contract_coach_history
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_row public.assessment_contract_coach_history%ROWTYPE;
BEGIN
  SELECT history.* INTO v_row
  FROM public.assessment_contract_coach_history AS history
  JOIN public.assessment_contracts AS contract
    ON contract.id = history.contract_id
  WHERE history.contract_id = p_contract_id
    AND history.plan_change_id IS NULL
    AND history.started_at > v_today
    AND history.started_at > contract.start_date
  ORDER BY history.created_at DESC
  LIMIT 1;
  RETURN v_row;
END;
$$;

-- 2. O gatilho antigo usa a data de São Paulo ------------------------------------------

-- Continua valendo para as trocas que não passam pela troca com data (por
-- exemplo, a edição de uma renovação em rascunho). CURRENT_DATE é a data em
-- UTC: depois das 21h, já é o dia seguinte no Brasil.
CREATE OR REPLACE FUNCTION public.sync_coach_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, NEW.start_date);
  ELSIF TG_OP = 'UPDATE' AND NEW.coach_id IS DISTINCT FROM OLD.coach_id THEN
    IF current_setting('eon.plan_change_coach_sync', true) = 'on' THEN
      RETURN NEW;
    END IF;
    UPDATE assessment_contract_coach_history
       SET ended_at = v_today
     WHERE contract_id = NEW.id AND ended_at IS NULL;
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, v_today);
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Trocar o coach a partir de uma data -------------------------------------------------

CREATE OR REPLACE FUNCTION public.change_assessment_contract_coach(
  p_contract_id uuid,
  p_coach_id uuid,
  p_effective_date date,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_date date := coalesce(p_effective_date, (now() AT TIME ZONE 'America/Sao_Paulo')::date);
  v_contract public.assessment_contracts%ROWTYPE;
  v_current public.assessment_contract_coach_history%ROWTYPE;
  v_pending public.assessment_contract_coach_history%ROWTYPE;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_last_day date;
  v_segment_start date;
  v_first_open date;
  v_plan_date date;
  v_regenerate date;
  v_from_coach_id uuid;
  v_last_coach_before uuid;
  v_from_coach_name text;
  v_last_coach_name text;
  v_new_coach_name text;
  v_new_coach_active boolean;
  v_new_coach_modalities uuid[];
  v_plan_modality_id uuid;
  v_applies_now boolean;
  v_renewals jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O coach de um contrato encerrado não pode ser alterado';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  -- Mudança de plano agendada leva o coach dela.
  SELECT change.effective_date INTO v_plan_date
  FROM public.assessment_contract_plan_changes AS change
  WHERE change.contract_id = p_contract_id
    AND change.status = 'scheduled'
  ORDER BY change.effective_date
  LIMIT 1;
  IF v_plan_date IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'Há uma mudança de plano agendada para %s; edite ou cancele a mudança para trocar o coach',
        to_char(v_plan_date, 'DD/MM/YYYY')
      );
  END IF;

  v_pending := eon_private.pending_contract_coach_change(p_contract_id);
  IF v_pending.id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'Já há uma troca de coach agendada para %s; cancele essa troca antes de fazer outra',
        to_char(v_pending.started_at, 'DD/MM/YYYY')
      );
  END IF;

  v_current := eon_private.contract_coach_row_on(
    p_contract_id, greatest(v_today, v_contract.start_date)
  );
  IF p_coach_id = v_contract.coach_id
     AND (v_current.id IS NULL OR v_current.coach_id = p_coach_id) THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;

  SELECT coach.name, coach.active, coach.modality_ids
  INTO v_new_coach_name, v_new_coach_active, v_new_coach_modalities
  FROM public.assessment_coaches AS coach
  WHERE coach.id = p_coach_id;
  IF NOT FOUND OR v_new_coach_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione um coach ativo';
  END IF;
  SELECT plan.modality_id INTO v_plan_modality_id
  FROM public.assessment_plans AS plan
  WHERE plan.id = v_contract.plan_id;
  IF v_plan_modality_id IS NULL
     OR NOT (v_plan_modality_id = ANY(coalesce(v_new_coach_modalities, '{}'::uuid[]))) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Esse coach não atende a modalidade do plano';
  END IF;

  -- Datas finais são exclusivas: o último dia do contrato é end_date - 1.
  v_last_day := v_contract.end_date - 1;
  v_segment_start := greatest(coalesce(v_current.started_at, v_contract.start_date), v_contract.start_date);
  v_first_open := eon_private.first_open_payout_day();

  IF v_date < v_contract.start_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format(
        'O novo coach não pode começar antes do início do contrato (%s)',
        to_char(v_contract.start_date, 'DD/MM/YYYY')
      );
  END IF;
  IF v_date > v_last_day THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format(
        'O novo coach precisa começar até o último dia do contrato (%s)',
        to_char(v_last_day, 'DD/MM/YYYY')
      );
  END IF;
  IF v_date < v_segment_start THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format(
        'O coach atual está no contrato desde %s; o novo coach precisa começar a partir dessa data',
        to_char(v_segment_start, 'DD/MM/YYYY')
      );
  END IF;
  IF v_first_open IS NOT NULL AND v_date < v_first_open THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format(
        'O repasse até %s já foi fechado; o novo coach precisa começar a partir de %s',
        to_char(v_first_open - 1, 'DD/MM/YYYY'),
        to_char(v_first_open, 'DD/MM/YYYY')
      );
  END IF;

  v_from_coach_id := eon_private.contract_coach_on(p_contract_id, v_date);
  v_last_coach_before := eon_private.contract_coach_on(
    p_contract_id, greatest(v_contract.start_date, v_last_day)
  );
  SELECT name INTO v_from_coach_name FROM public.assessment_coaches WHERE id = v_from_coach_id;
  SELECT name INTO v_last_coach_name FROM public.assessment_coaches WHERE id = v_last_coach_before;

  INSERT INTO public.assessment_contract_coach_history (
    contract_id, coach_id, started_at, created_at
  ) VALUES (
    p_contract_id, p_coach_id, v_date, clock_timestamp()
  );

  -- Troca de hoje ou para trás vale na hora. Num contrato que ainda não
  -- começou, trocar desde o primeiro dia também.
  v_applies_now := v_date <= v_today OR v_date = v_contract.start_date;

  -- O histórico já foi gravado com a data escolhida: o gatilho antigo não
  -- grava outra linha, e a trava da mudança de plano já foi conferida acima.
  PERFORM set_config('eon.plan_change_coach_sync', 'on', true);
  UPDATE public.assessment_contracts
  SET coach_id = CASE WHEN v_applies_now THEN p_coach_id ELSE coach_id END,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;
  PERFORM set_config('eon.plan_change_coach_sync', 'off', true);

  -- A renovação que ainda não começou acompanha o coach do último dia.
  IF v_last_coach_before IS DISTINCT FROM p_coach_id THEN
    FOR v_renewal IN
      SELECT renewal.*
      FROM public.assessment_contracts AS renewal
      JOIN public.assessment_plans AS renewal_plan
        ON renewal_plan.id = renewal.plan_id
      WHERE renewal.parent_contract_id = p_contract_id
        AND renewal.status IN ('draft', 'scheduled')
        AND renewal.start_date > v_today
        AND renewal.coach_id = v_last_coach_before
        AND renewal_plan.modality_id = ANY(coalesce(v_new_coach_modalities, '{}'::uuid[]))
        AND (
          SELECT count(*)
          FROM public.assessment_contract_coach_history AS history
          WHERE history.contract_id = renewal.id
        ) <= 1
      FOR UPDATE OF renewal
    LOOP
      PERFORM set_config('eon.plan_change_coach_sync', 'on', true);
      UPDATE public.assessment_contracts
      SET coach_id = p_coach_id, updated_at = now()
      WHERE id = v_renewal.id;
      PERFORM set_config('eon.plan_change_coach_sync', 'off', true);
      UPDATE public.assessment_contract_coach_history
      SET coach_id = p_coach_id
      WHERE contract_id = v_renewal.id;
      INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
      VALUES (v_renewal.id, 'coach_changed', jsonb_build_object(
        'from_coach_id', v_last_coach_before,
        'from_coach_name', v_last_coach_name,
        'to_coach_id', p_coach_id,
        'to_coach_name', v_new_coach_name,
        'effective_date', v_renewal.start_date,
        'source_contract_id', p_contract_id
      ), 'Acompanhou a troca de coach do contrato anterior', p_actor_id);
      v_renewals := v_renewals || jsonb_build_array(v_renewal.id);
    END LOOP;
  END IF;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, created_by)
  VALUES (
    p_contract_id,
    CASE WHEN v_applies_now THEN 'coach_changed' ELSE 'coach_change_scheduled' END,
    jsonb_build_object(
      'from_coach_id', v_from_coach_id,
      'from_coach_name', v_from_coach_name,
      'to_coach_id', p_coach_id,
      'to_coach_name', v_new_coach_name,
      'effective_date', v_date,
      'retroactive', v_date < v_today,
      'renewal_ids', v_renewals
    ),
    p_actor_id
  );

  -- Fechamento ainda não aprovado que pega a data precisa ser gerado de novo.
  SELECT closing.competence INTO v_regenerate
  FROM public.payout_monthly_closings AS closing
  WHERE closing.status = 'pending_approval'
    AND closing.competence >= date_trunc('month', v_date)::date
  ORDER BY closing.competence
  LIMIT 1;

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'effective_date', v_date,
    'applies_now', v_applies_now,
    'renewal_ids', v_renewals,
    'regenerate_competence', v_regenerate
  );
END;
$$;

-- Assinatura antiga (sem data): troca a partir de hoje. Fica para a versão
-- anterior da API durante a publicação.
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
BEGIN
  RETURN public.change_assessment_contract_coach(
    p_contract_id, p_coach_id, NULL::date, p_expected_updated_at, p_actor_id
  );
END;
$$;

-- 4. Cancelar a troca agendada ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_assessment_contract_coach_change(
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
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract public.assessment_contracts%ROWTYPE;
  v_pending public.assessment_contract_coach_history%ROWTYPE;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_last_coach uuid;
  v_coach_name text;
  v_last_coach_name text;
  v_renewals jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_pending := eon_private.pending_contract_coach_change(p_contract_id);
  IF v_pending.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Não há troca de coach agendada neste contrato';
  END IF;

  SELECT name INTO v_coach_name FROM public.assessment_coaches WHERE id = v_pending.coach_id;
  DELETE FROM public.assessment_contract_coach_history WHERE id = v_pending.id;

  -- A renovação que acompanhou a troca volta para o coach do último dia.
  v_last_coach := eon_private.contract_coach_on(
    p_contract_id, greatest(v_contract.start_date, v_contract.end_date - 1)
  );
  SELECT name INTO v_last_coach_name FROM public.assessment_coaches WHERE id = v_last_coach;
  IF v_last_coach IS DISTINCT FROM v_pending.coach_id THEN
    FOR v_renewal IN
      SELECT renewal.*
      FROM public.assessment_contracts AS renewal
      WHERE renewal.parent_contract_id = p_contract_id
        AND renewal.status IN ('draft', 'scheduled')
        AND renewal.start_date > v_today
        AND renewal.coach_id = v_pending.coach_id
        AND (
          SELECT count(*)
          FROM public.assessment_contract_coach_history AS history
          WHERE history.contract_id = renewal.id
        ) <= 1
      FOR UPDATE OF renewal
    LOOP
      BEGIN
        PERFORM set_config('eon.plan_change_coach_sync', 'on', true);
        UPDATE public.assessment_contracts
        SET coach_id = v_last_coach, updated_at = now()
        WHERE id = v_renewal.id;
        PERFORM set_config('eon.plan_change_coach_sync', 'off', true);
        UPDATE public.assessment_contract_coach_history
        SET coach_id = v_last_coach
        WHERE contract_id = v_renewal.id;
        INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
        VALUES (v_renewal.id, 'coach_changed', jsonb_build_object(
          'from_coach_id', v_pending.coach_id,
          'from_coach_name', v_coach_name,
          'to_coach_id', v_last_coach,
          'to_coach_name', v_last_coach_name,
          'effective_date', v_renewal.start_date,
          'source_contract_id', p_contract_id
        ), 'Voltou ao coach do contrato anterior com a troca cancelada', p_actor_id);
        v_renewals := v_renewals || jsonb_build_array(v_renewal.id);
      EXCEPTION WHEN OTHERS THEN
        -- Coach anterior indisponível: a renovação fica como está.
        NULL;
      END;
    END LOOP;
  END IF;

  UPDATE public.assessment_contracts
  SET updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, created_by)
  VALUES (p_contract_id, 'coach_change_cancelled', jsonb_build_object(
    'coach_id', v_pending.coach_id,
    'coach_name', v_coach_name,
    'effective_date', v_pending.started_at,
    'renewal_ids', v_renewals
  ), p_actor_id);

  RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'renewal_ids', v_renewals);
END;
$$;

-- 5. Aplicar as trocas cuja data chegou --------------------------------------------------

-- Chamada junto com as outras transições diárias de contrato; uma troca com
-- problema não trava as outras.
CREATE OR REPLACE FUNCTION public.apply_due_assessment_coach_changes(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract_id uuid;
  v_contract public.assessment_contracts%ROWTYPE;
  v_row public.assessment_contract_coach_history%ROWTYPE;
  v_from_coach_id uuid;
  v_from_name text;
  v_to_name text;
  v_changed jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  FOR v_contract_id IN
    SELECT DISTINCT history.contract_id
    FROM public.assessment_contract_coach_history AS history
    JOIN public.assessment_contracts AS contract
      ON contract.id = history.contract_id
    WHERE history.plan_change_id IS NULL
      AND history.started_at <= v_today
      AND history.started_at > contract.start_date
      AND history.coach_id IS DISTINCT FROM contract.coach_id
      AND contract.status IN ('scheduled', 'active', 'overdue', 'on_leave')
  LOOP
    BEGIN
      SELECT * INTO v_contract
      FROM public.assessment_contracts
      WHERE id = v_contract_id
      FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;

      -- Só a troca que vale hoje; a de mudança de plano entra pela mudança.
      v_row := eon_private.contract_coach_row_on(v_contract_id, v_today);
      CONTINUE WHEN v_row.id IS NULL
        OR v_row.plan_change_id IS NOT NULL
        OR v_row.started_at <= v_contract.start_date
        OR v_row.coach_id = v_contract.coach_id;

      v_from_coach_id := v_contract.coach_id;
      SELECT name INTO v_from_name FROM public.assessment_coaches WHERE id = v_from_coach_id;
      SELECT name INTO v_to_name FROM public.assessment_coaches WHERE id = v_row.coach_id;

      PERFORM set_config('eon.plan_change_coach_sync', 'on', true);
      UPDATE public.assessment_contracts
      SET coach_id = v_row.coach_id, updated_at = now()
      WHERE id = v_contract_id
      RETURNING * INTO v_contract;
      PERFORM set_config('eon.plan_change_coach_sync', 'off', true);

      INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
      VALUES (v_contract_id, 'coach_changed', jsonb_build_object(
        'from_coach_id', v_from_coach_id,
        'from_coach_name', v_from_name,
        'to_coach_id', v_row.coach_id,
        'to_coach_name', v_to_name,
        'effective_date', v_row.started_at,
        'scheduled', true
      ), 'Troca de coach agendada aplicada na data', p_actor_id);

      v_changed := v_changed || jsonb_build_array(jsonb_build_object(
        'id', v_contract.id,
        'coach_id', v_contract.coach_id,
        'updated_at', v_contract.updated_at
      ));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_array(jsonb_build_object(
        'contract_id', v_contract_id,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed, 'failed', v_failed);
END;
$$;

-- 6. Mudança de plano e renovação ------------------------------------------------------

-- Com troca de coach agendada, a mudança de plano espera: ela leva um coach
-- próprio a partir da data dela.
CREATE OR REPLACE FUNCTION eon_private.guard_plan_change_pending_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pending public.assessment_contract_coach_history%ROWTYPE;
BEGIN
  v_pending := eon_private.pending_contract_coach_change(NEW.contract_id);
  IF v_pending.id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'Há uma troca de coach agendada para %s; cancele a troca antes de mudar o plano',
        to_char(v_pending.started_at, 'DD/MM/YYYY')
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_plan_change_pending_coach ON public.assessment_contract_plan_changes;
CREATE TRIGGER guard_plan_change_pending_coach
  BEFORE INSERT ON public.assessment_contract_plan_changes
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.guard_plan_change_pending_coach();

-- A renovação sai com o coach que vale no último dia do contrato anterior,
-- quando ele teve troca de coach. Coach escolhido na renovação fica.
CREATE OR REPLACE FUNCTION eon_private.carry_coach_change_into_renewal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent public.assessment_contracts%ROWTYPE;
  v_coach_id uuid;
BEGIN
  SELECT * INTO v_parent
  FROM public.assessment_contracts
  WHERE id = NEW.parent_contract_id;
  IF NOT FOUND OR NEW.coach_id IS DISTINCT FROM v_parent.coach_id THEN
    RETURN NEW;
  END IF;
  IF (
    SELECT count(*)
    FROM public.assessment_contract_coach_history AS history
    WHERE history.contract_id = v_parent.id
  ) <= 1 THEN
    RETURN NEW;
  END IF;

  v_coach_id := eon_private.contract_coach_on(
    v_parent.id, greatest(v_parent.start_date, v_parent.end_date - 1)
  );
  IF v_coach_id IS NOT NULL THEN
    NEW.coach_id := v_coach_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS carry_coach_change_into_renewal ON public.assessment_contracts;
CREATE TRIGGER carry_coach_change_into_renewal
  BEFORE INSERT ON public.assessment_contracts
  FOR EACH ROW
  WHEN (NEW.parent_contract_id IS NOT NULL)
  EXECUTE FUNCTION eon_private.carry_coach_change_into_renewal();

-- 7. Acesso: só o backend troca o coach ---------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_contract_coach_history TO service_role;

REVOKE ALL ON FUNCTION eon_private.contract_coach_row_on(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.pending_contract_coach_change(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.guard_plan_change_pending_coach() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.carry_coach_change_into_renewal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.contract_coach_row_on(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.pending_contract_coach_change(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, date, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_assessment_contract_coach_change(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_due_assessment_coach_changes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, date, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_assessment_contract_coach_change(uuid, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_due_assessment_coach_changes(uuid) TO service_role;

COMMENT ON FUNCTION public.change_assessment_contract_coach(uuid, uuid, date, timestamptz, uuid) IS
  'Troca o coach do contrato a partir de uma data: hoje ou antes vale na hora; depois de hoje fica agendada.';
COMMENT ON FUNCTION public.cancel_assessment_contract_coach_change(uuid, timestamptz, uuid) IS
  'Cancela a troca de coach agendada do contrato.';
COMMENT ON FUNCTION public.apply_due_assessment_coach_changes(uuid) IS
  'Aplica ao contrato as trocas de coach agendadas cuja data chegou.';

COMMIT;
