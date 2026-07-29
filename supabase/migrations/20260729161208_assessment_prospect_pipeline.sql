-- Funil comercial dos prospects da assessoria.
-- Mantém o contrato em rascunho até o pagamento e preserva perdas para métricas.

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS prospect_stage text,
  ADD COLUMN IF NOT EXISTS prospect_proposal_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_message_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_lost_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_loss_reason_code text,
  ADD COLUMN IF NOT EXISTS prospect_loss_notes text;

-- Recupera os contratos já vinculados a envios do formulário público.
UPDATE public.assessment_contracts contract
SET prospect_stage = CASE
      WHEN contract.payment_status = 'paid'
        OR contract.status IN ('active', 'scheduled', 'overdue', 'on_leave', 'finished')
        THEN 'converted'
      WHEN contract.status = 'voided' THEN 'lost'
      ELSE 'new'
    END,
    prospect_converted_at = CASE
      WHEN contract.payment_status = 'paid'
        OR contract.status IN ('active', 'scheduled', 'overdue', 'on_leave', 'finished')
        THEN coalesce(contract.payment_message_sent_at, contract.updated_at, contract.created_at, now())
      ELSE contract.prospect_converted_at
    END,
    prospect_lost_at = CASE
      WHEN contract.status = 'voided'
        THEN coalesce(contract.updated_at, contract.created_at, now())
      ELSE contract.prospect_lost_at
    END,
    prospect_loss_reason_code = CASE
      WHEN contract.status = 'voided' THEN coalesce(contract.prospect_loss_reason_code, 'other')
      ELSE contract.prospect_loss_reason_code
    END
FROM (
  SELECT DISTINCT contract_id
  FROM public.assessment_prospect_submissions
  WHERE contract_id IS NOT NULL
) submission
WHERE contract.id = submission.contract_id
  AND contract.prospect_stage IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_stage_check'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_stage_check
      CHECK (
        prospect_stage IS NULL OR prospect_stage IN (
          'new', 'proposal_ready', 'payment_link_sent', 'converted', 'lost'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_loss_reason_check'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_loss_reason_check
      CHECK (
        prospect_loss_reason_code IS NULL OR prospect_loss_reason_code IN (
          'price', 'no_response', 'changed_mind', 'chose_competitor',
          'coach_availability', 'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_stage_dates_check'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_stage_dates_check
      CHECK (
        prospect_stage IS NULL OR (
          (prospect_stage <> 'payment_link_sent' OR prospect_message_sent_at IS NOT NULL)
          AND (prospect_stage <> 'converted' OR prospect_converted_at IS NOT NULL)
          AND (
            prospect_stage <> 'lost'
            OR (prospect_lost_at IS NOT NULL AND prospect_loss_reason_code IS NOT NULL)
          )
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS assessment_contracts_prospect_stage_created_idx
  ON public.assessment_contracts(prospect_stage, created_at DESC)
  WHERE prospect_stage IS NOT NULL;

CREATE OR REPLACE FUNCTION public.initialize_assessment_prospect_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.assessment_contracts
  SET prospect_stage = CASE
        WHEN payment_status = 'paid'
          OR status IN ('active', 'scheduled', 'overdue', 'on_leave', 'finished')
          THEN 'converted'
        WHEN status = 'voided' THEN 'lost'
        ELSE 'new'
      END,
      prospect_converted_at = CASE
        WHEN payment_status = 'paid'
          OR status IN ('active', 'scheduled', 'overdue', 'on_leave', 'finished')
          THEN now()
        ELSE prospect_converted_at
      END,
      prospect_lost_at = CASE WHEN status = 'voided' THEN now() ELSE prospect_lost_at END,
      prospect_loss_reason_code = CASE
        WHEN status = 'voided' THEN coalesce(prospect_loss_reason_code, 'other')
        ELSE prospect_loss_reason_code
      END
  WHERE id = NEW.contract_id
    AND prospect_stage IS NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_assessment_prospect_stage()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_assessment_prospect_stage()
  TO service_role;

DROP TRIGGER IF EXISTS assessment_prospect_submission_initialize_stage
  ON public.assessment_prospect_submissions;
CREATE TRIGGER assessment_prospect_submission_initialize_stage
AFTER INSERT ON public.assessment_prospect_submissions
FOR EACH ROW
EXECUTE FUNCTION public.initialize_assessment_prospect_stage();

CREATE OR REPLACE FUNCTION public.sync_assessment_prospect_conversion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.prospect_stage IS NOT NULL
     AND NEW.prospect_stage <> 'lost'
     AND NEW.payment_status = 'paid'
     AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    NEW.prospect_stage := 'converted';
    NEW.prospect_converted_at := coalesce(NEW.prospect_converted_at, now());
    IF NEW.status = 'draft' THEN
      NEW.status := CASE
        WHEN NEW.start_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date
          THEN 'scheduled'
        ELSE 'active'
      END;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_assessment_prospect_conversion()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_assessment_prospect_conversion()
  TO service_role;

DROP TRIGGER IF EXISTS assessment_contract_sync_prospect_conversion
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_sync_prospect_conversion
BEFORE UPDATE OF payment_status ON public.assessment_contracts
FOR EACH ROW
EXECUTE FUNCTION public.sync_assessment_prospect_conversion();

CREATE OR REPLACE FUNCTION public.audit_assessment_prospect_conversion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.prospect_stage IS DISTINCT FROM NEW.prospect_stage
     AND NEW.prospect_stage = 'converted' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      NEW.id,
      'prospect_converted',
      jsonb_build_object(
        'stage_before', OLD.prospect_stage,
        'payment_status', NEW.payment_status,
        'status_after', NEW.status,
        'converted_at', NEW.prospect_converted_at
      ),
      'Prospect convertido após confirmação do pagamento',
      NEW.created_by
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_assessment_prospect_conversion()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_assessment_prospect_conversion()
  TO service_role;

DROP TRIGGER IF EXISTS assessment_contract_audit_prospect_conversion
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_audit_prospect_conversion
AFTER UPDATE ON public.assessment_contracts
FOR EACH ROW
EXECUTE FUNCTION public.audit_assessment_prospect_conversion();

CREATE OR REPLACE FUNCTION public.prepare_assessment_prospect_proposal(
  p_contract_id uuid,
  p_enrollment_fee numeric,
  p_manual_discount numeric,
  p_external_payment_link text,
  p_due_date date,
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
  v_link text := nullif(btrim(p_external_payment_link), '');
  v_now timestamptz := now();
BEGIN
  IF p_enrollment_fee IS NULL OR p_enrollment_fee < 0 OR p_enrollment_fee > 1000000
     OR p_manual_discount IS NULL OR p_manual_discount < 0 OR p_manual_discount > 1000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Os valores da proposta são inválidos';
  END IF;
  IF v_link IS NULL OR length(v_link) > 2048
     OR v_link !~ '^https://[^[:space:][:cntrl:]]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um link HTTPS válido';
  END IF;
  IF p_due_date IS NULL
     OR p_due_date < (v_now AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um vencimento válido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     OR v_contract.prospect_stage NOT IN ('new', 'proposal_ready', 'payment_link_sent')
     OR v_contract.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect não aceita uma nova proposta';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent')
     OR coalesce(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR coalesce(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect já possui movimentação financeira';
  END IF;

  UPDATE public.assessment_contracts
  SET enrollment_fee = p_enrollment_fee,
      manual_discount = p_manual_discount,
      external_payment_link = v_link,
      due_date = p_due_date,
      payment_status = 'charge_sent',
      prospect_stage = 'proposal_ready',
      prospect_proposal_ready_at = v_now,
      prospect_message_sent_at = NULL,
      payment_message_sent_at = NULL,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_proposal_prepared',
    jsonb_build_object(
      'due_date', p_due_date,
      'enrollment_fee', p_enrollment_fee,
      'manual_discount', p_manual_discount,
      'stage_after', 'proposal_ready'
    ),
    'Proposta e link de pagamento preparados',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_assessment_prospect_message_sent(
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
  v_was_sent boolean;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.status <> 'draft'
     OR v_contract.prospect_stage NOT IN ('proposal_ready', 'payment_link_sent') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Prepare a proposta antes de registrar o envio';
  END IF;
  IF nullif(v_contract.external_payment_link, '') IS NULL
     AND nullif(v_contract.asaas_payment_link, '') IS NULL
     AND nullif(v_contract.asaas_pix_copy, '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect ainda não possui link de pagamento';
  END IF;

  v_was_sent := v_contract.prospect_message_sent_at IS NOT NULL;

  UPDATE public.assessment_contracts
  SET prospect_stage = 'payment_link_sent',
      prospect_message_sent_at = v_now,
      payment_message_sent_at = v_now,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_payment_message_sent',
    jsonb_build_object(
      'stage_after', 'payment_link_sent',
      'sent_at', v_now,
      'resent', v_was_sent
    ),
    'Mensagem com link de pagamento marcada como enviada',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.lose_assessment_prospect(
  p_contract_id uuid,
  p_reason_code text,
  p_reason_notes text,
  p_external_cancellation_confirmed boolean,
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
  v_notes text := nullif(btrim(p_reason_notes), '');
  v_now timestamptz := now();
BEGIN
  IF p_reason_code NOT IN (
    'price', 'no_response', 'changed_mind', 'chose_competitor',
    'coach_availability', 'other'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione um motivo válido';
  END IF;
  IF length(coalesce(v_notes, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O detalhe da perda é muito longo';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     OR v_contract.prospect_stage NOT IN ('new', 'proposal_ready', 'payment_link_sent')
     OR v_contract.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente um prospect aberto pode ser marcado como não convertido';
  END IF;
  IF v_contract.payment_status = 'paid'
     OR coalesce(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR coalesce(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect possui movimentação financeira e não pode ser encerrado aqui';
  END IF;
  IF nullif(v_contract.external_payment_link, '') IS NOT NULL
     AND coalesce(p_external_cancellation_confirmed, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Confirme que o link externo foi cancelado antes de encerrar o prospect';
  END IF;

  UPDATE public.assessment_contracts
  SET status = 'voided',
      payment_status = 'cancelled',
      prospect_stage = 'lost',
      prospect_lost_at = v_now,
      prospect_loss_reason_code = p_reason_code,
      prospect_loss_notes = v_notes,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_lost',
    jsonb_build_object(
      'reason_code', p_reason_code,
      'reason_notes', v_notes,
      'stage_after', 'lost',
      'external_cancellation_confirmed', coalesce(p_external_cancellation_confirmed, false)
    ),
    'Prospect marcado como não convertido',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- Compatibilidade com versões antigas do frontend: recusar deixa de apagar.
CREATE OR REPLACE FUNCTION public.refuse_assessment_contract_enrollment(
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
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Adesão não encontrada';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A adesão foi alterada. Atualize a página e tente novamente';
  END IF;
  IF v_contract.status <> 'draft' OR v_contract.parent_contract_id IS NOT NULL
     OR v_contract.payment_status = 'paid'
     OR coalesce(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR nullif(v_contract.external_payment_link, '') IS NOT NULL
     OR coalesce(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta adesão não pode ser recusada';
  END IF;

  UPDATE public.assessment_contracts
  SET status = 'voided',
      payment_status = 'cancelled',
      prospect_stage = 'lost',
      prospect_lost_at = v_now,
      prospect_loss_reason_code = 'other',
      prospect_loss_notes = 'Recusado pelo fluxo anterior da Central de Prospects',
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_lost',
    jsonb_build_object('reason_code', 'other', 'stage_after', 'lost', 'legacy_action', true),
    'Prospect arquivado pelo fluxo de recusa legado',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'refused', true);
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_assessment_prospect_proposal(
  uuid, numeric, numeric, text, date, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_assessment_prospect_message_sent(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lose_assessment_prospect(
  uuid, text, text, boolean, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refuse_assessment_contract_enrollment(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_assessment_prospect_proposal(
  uuid, numeric, numeric, text, date, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_assessment_prospect_message_sent(
  uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.lose_assessment_prospect(
  uuid, text, text, boolean, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.refuse_assessment_contract_enrollment(
  uuid, timestamptz, uuid
) TO service_role;

COMMENT ON COLUMN public.assessment_contracts.prospect_stage IS
  'Etapa comercial do cadastro público; nulo para contratos que não nasceram como prospect.';
COMMENT ON FUNCTION public.prepare_assessment_prospect_proposal(
  uuid, numeric, numeric, text, date, timestamptz, uuid
) IS 'Prepara proposta sem ativar contrato; conversão ocorre somente após pagamento.';
