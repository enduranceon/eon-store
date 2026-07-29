-- Permite iniciar uma licença sem definir previamente a data de retorno.
-- Para licenças abertas, o vencimento do contrato só é prorrogado quando
-- a licença é encerrada, usando a duração efetivamente transcorrida.

ALTER TABLE public.assessment_leaves
  DROP CONSTRAINT IF EXISTS assessment_leaves_check;

ALTER TABLE public.assessment_leaves
  ALTER COLUMN end_date DROP NOT NULL,
  ALTER COLUMN days DROP NOT NULL;

ALTER TABLE public.assessment_leaves
  ADD CONSTRAINT assessment_leaves_check
  CHECK (
    (end_date IS NULL AND days IS NULL AND status = 'active')
    OR (
      end_date IS NOT NULL
      AND end_date >= start_date
      AND days = (end_date - start_date) + 1
    )
  );

COMMENT ON COLUMN public.assessment_leaves.end_date IS
  'Data de retorno. NULL enquanto uma licença por tempo indeterminado estiver ativa.';
COMMENT ON COLUMN public.assessment_leaves.days IS
  'Duração inclusiva da licença. NULL até o encerramento de uma licença sem data definida.';

CREATE OR REPLACE FUNCTION public.handle_leave_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.end_date IS NULL THEN
      NEW.days := NULL;
      UPDATE public.assessment_contracts
      SET status = 'on_leave'
      WHERE id = NEW.contract_id;
    ELSE
      NEW.days := (NEW.end_date - NEW.start_date) + 1;
      UPDATE public.assessment_contracts
      SET end_date = end_date + NEW.days,
          status = 'on_leave'
      WHERE id = NEW.contract_id;
    END IF;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.status = 'finished'
    AND OLD.status = 'active' THEN
    IF OLD.end_date IS NULL THEN
      NEW.end_date := GREATEST(
        COALESCE(NEW.end_date, (now() AT TIME ZONE 'America/Sao_Paulo')::date),
        NEW.start_date
      );
      NEW.days := (NEW.end_date - NEW.start_date) + 1;

      UPDATE public.assessment_contracts
      SET end_date = end_date + NEW.days
      WHERE id = NEW.contract_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.assessment_leaves
      WHERE contract_id = NEW.contract_id
        AND status = 'active'
        AND id <> NEW.id
    ) THEN
      UPDATE public.assessment_contracts
      SET status = 'active'
      WHERE id = NEW.contract_id
        AND status = 'on_leave';
    END IF;
  END IF;

  RETURN NEW;
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
  IF p_start_date IS NULL OR (p_end_date IS NOT NULL AND p_end_date < p_start_date) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um período de licença válido';
  END IF;
  IF length(coalesce(p_reason, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O motivo da licença é muito longo';
  END IF;

  SELECT *
  INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  SELECT *
  INTO v_leave
  FROM public.assessment_leaves
  WHERE contract_id = p_contract_id
    AND status = 'active'
  ORDER BY created_at DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_leave.start_date = p_start_date
      AND v_leave.end_date IS NOT DISTINCT FROM p_end_date
      AND v_leave.reason IS NOT DISTINCT FROM nullif(btrim(p_reason), '') THEN
      RETURN jsonb_build_object(
        'contract', to_jsonb(v_contract),
        'leave', to_jsonb(v_leave),
        'unchanged', true
      );
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato já possui uma licença ativa';
  END IF;
  IF v_contract.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente contratos ativos podem iniciar licença';
  END IF;
  IF p_expected_updated_at IS NULL
    OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_old_end := v_contract.end_date;
  INSERT INTO public.assessment_leaves(
    contract_id,
    start_date,
    end_date,
    days,
    reason,
    status,
    created_by
  )
  VALUES (
    p_contract_id,
    p_start_date,
    p_end_date,
    CASE WHEN p_end_date IS NULL THEN NULL ELSE (p_end_date - p_start_date) + 1 END,
    nullif(btrim(p_reason), ''),
    'active',
    p_actor_id
  )
  RETURNING * INTO v_leave;

  UPDATE public.assessment_contracts
  SET updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id,
    event_type,
    payload,
    notes,
    created_by
  )
  VALUES (
    p_contract_id,
    'leave_started',
    jsonb_build_object(
      'leave_id', v_leave.id,
      'leave_start', v_leave.start_date,
      'leave_end', v_leave.end_date,
      'days', v_leave.days,
      'open_ended', v_leave.end_date IS NULL,
      'reason', v_leave.reason,
      'old_end_date', v_old_end,
      'new_end_date', v_contract.end_date
    ),
    v_leave.reason,
    p_actor_id
  );

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'leave', to_jsonb(v_leave)
  );
END;
$$;
