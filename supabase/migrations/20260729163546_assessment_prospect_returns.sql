-- Classifica a relação do prospect com a assessoria sem considerar compras
-- da loja. O retorno só é confirmado quando o pagamento converte o prospect.

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS prospect_customer_relationship text,
  ADD COLUMN IF NOT EXISTS prospect_previous_contract_id uuid,
  ADD COLUMN IF NOT EXISTS prospect_reactivated_at timestamptz;

WITH relationship_candidates AS (
  SELECT
    prospect.id,
    active_contract.id AS active_contract_id,
    previous_contract.id AS previous_contract_id
  FROM public.assessment_contracts prospect
  LEFT JOIN LATERAL (
    SELECT candidate.id
    FROM public.assessment_contracts candidate
    WHERE candidate.customer_id = prospect.customer_id
      AND candidate.id <> prospect.id
      AND candidate.created_at <= prospect.created_at
      AND candidate.status IN ('active', 'scheduled', 'overdue', 'on_leave')
    ORDER BY candidate.created_at DESC, candidate.id DESC
    LIMIT 1
  ) active_contract ON true
  LEFT JOIN LATERAL (
    SELECT candidate.id
    FROM public.assessment_contracts candidate
    WHERE candidate.customer_id = prospect.customer_id
      AND candidate.id <> prospect.id
      AND candidate.created_at <= prospect.created_at
      AND (
        candidate.status IN ('active', 'overdue', 'on_leave', 'finished')
        OR (
          candidate.status IN ('cancelled', 'scheduled')
          AND (
            candidate.payment_status = 'paid'
            OR candidate.payment_date IS NOT NULL
            OR coalesce(candidate.manual_payment, false)
          )
        )
      )
    ORDER BY
      coalesce(candidate.cancellation_date, candidate.end_date, candidate.updated_at::date, candidate.created_at::date) DESC,
      candidate.created_at DESC,
      candidate.id DESC
    LIMIT 1
  ) previous_contract ON true
  WHERE prospect.prospect_stage IS NOT NULL
    AND prospect.prospect_customer_relationship IS NULL
)
UPDATE public.assessment_contracts prospect
SET prospect_customer_relationship = CASE
      WHEN candidate.active_contract_id IS NOT NULL THEN 'active_student'
      WHEN candidate.previous_contract_id IS NOT NULL THEN 'former_student'
      ELSE 'new_customer'
    END,
    prospect_previous_contract_id = coalesce(
      candidate.active_contract_id,
      candidate.previous_contract_id
    ),
    prospect_reactivated_at = CASE
      WHEN candidate.active_contract_id IS NULL
        AND candidate.previous_contract_id IS NOT NULL
        AND prospect.prospect_stage = 'converted'
      THEN coalesce(prospect.prospect_converted_at, prospect.updated_at, now())
      ELSE prospect.prospect_reactivated_at
    END
FROM relationship_candidates candidate
WHERE prospect.id = candidate.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_relationship_check'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_relationship_check
      CHECK (
        prospect_customer_relationship IS NULL
        OR prospect_customer_relationship IN (
          'new_customer', 'former_student', 'active_student'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_previous_contract_fkey'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_previous_contract_fkey
      FOREIGN KEY (prospect_previous_contract_id)
      REFERENCES public.assessment_contracts(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_relationship_source_check'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_relationship_source_check
      CHECK (
        prospect_customer_relationship IS NULL
        OR (
          prospect_customer_relationship = 'new_customer'
          AND prospect_previous_contract_id IS NULL
        )
        OR (
          prospect_customer_relationship IN ('former_student', 'active_student')
          AND prospect_previous_contract_id IS NOT NULL
          AND prospect_previous_contract_id <> id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assessment_contracts_prospect_reactivation_check'
      AND conrelid = 'public.assessment_contracts'::regclass
  ) THEN
    ALTER TABLE public.assessment_contracts
      ADD CONSTRAINT assessment_contracts_prospect_reactivation_check
      CHECK (
        (prospect_reactivated_at IS NULL OR prospect_customer_relationship = 'former_student')
        AND (
          prospect_customer_relationship <> 'former_student'
          OR prospect_stage <> 'converted'
          OR prospect_reactivated_at IS NOT NULL
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS assessment_contracts_prospect_previous_contract_idx
  ON public.assessment_contracts(prospect_previous_contract_id)
  WHERE prospect_previous_contract_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.classify_assessment_prospect_relationship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_active_contract_id uuid;
  v_previous_contract_id uuid;
  v_relationship text;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = NEW.contract_id
  FOR UPDATE;

  IF NOT FOUND OR v_contract.prospect_customer_relationship IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT candidate.id INTO v_active_contract_id
  FROM public.assessment_contracts candidate
  WHERE candidate.customer_id = NEW.customer_id
    AND candidate.id <> NEW.contract_id
    AND candidate.created_at <= v_contract.created_at
    AND candidate.status IN ('active', 'scheduled', 'overdue', 'on_leave')
  ORDER BY candidate.created_at DESC, candidate.id DESC
  LIMIT 1;

  SELECT candidate.id INTO v_previous_contract_id
  FROM public.assessment_contracts candidate
  WHERE candidate.customer_id = NEW.customer_id
    AND candidate.id <> NEW.contract_id
    AND candidate.created_at <= v_contract.created_at
    AND (
      candidate.status IN ('active', 'overdue', 'on_leave', 'finished')
      OR (
        candidate.status IN ('cancelled', 'scheduled')
        AND (
          candidate.payment_status = 'paid'
          OR candidate.payment_date IS NOT NULL
          OR coalesce(candidate.manual_payment, false)
        )
      )
    )
  ORDER BY
    coalesce(candidate.cancellation_date, candidate.end_date, candidate.updated_at::date, candidate.created_at::date) DESC,
    candidate.created_at DESC,
    candidate.id DESC
  LIMIT 1;

  v_relationship := CASE
    WHEN v_active_contract_id IS NOT NULL THEN 'active_student'
    WHEN v_previous_contract_id IS NOT NULL THEN 'former_student'
    ELSE 'new_customer'
  END;

  UPDATE public.assessment_contracts
  SET prospect_customer_relationship = v_relationship,
      prospect_previous_contract_id = coalesce(
        v_active_contract_id,
        v_previous_contract_id
      ),
      updated_at = now()
  WHERE id = NEW.contract_id;

  IF v_relationship IN ('former_student', 'active_student') THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      NEW.contract_id,
      'prospect_customer_recognized',
      jsonb_build_object(
        'relationship', v_relationship,
        'customer_id', NEW.customer_id,
        'previous_contract_id', coalesce(v_active_contract_id, v_previous_contract_id),
        'classification_source', 'assessment_contract_history'
      ),
      CASE
        WHEN v_relationship = 'former_student'
          THEN 'Ex-aluno identificado pelo CPF no formulário público'
        ELSE 'Aluno atual identificado pelo CPF no formulário público'
      END,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.classify_assessment_prospect_relationship()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.classify_assessment_prospect_relationship()
  TO service_role;

DROP TRIGGER IF EXISTS assessment_prospect_submission_relationship
  ON public.assessment_prospect_submissions;
CREATE TRIGGER assessment_prospect_submission_relationship
AFTER INSERT ON public.assessment_prospect_submissions
FOR EACH ROW
EXECUTE FUNCTION public.classify_assessment_prospect_relationship();

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
    IF NEW.prospect_customer_relationship = 'former_student' THEN
      NEW.prospect_reactivated_at := coalesce(NEW.prospect_reactivated_at, now());
    END IF;
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

CREATE OR REPLACE FUNCTION public.audit_assessment_prospect_reactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.prospect_stage IS DISTINCT FROM NEW.prospect_stage
     AND NEW.prospect_stage = 'converted'
     AND NEW.prospect_customer_relationship = 'former_student' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      NEW.id,
      'prospect_reactivated',
      jsonb_build_object(
        'previous_contract_id', NEW.prospect_previous_contract_id,
        'reactivated_at', NEW.prospect_reactivated_at,
        'payment_status', NEW.payment_status,
        'status_after', NEW.status
      ),
      'Retorno de ex-aluno confirmado após o pagamento',
      NEW.created_by
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_assessment_prospect_reactivation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_assessment_prospect_reactivation()
  TO service_role;

DROP TRIGGER IF EXISTS assessment_contract_audit_prospect_reactivation
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_audit_prospect_reactivation
AFTER UPDATE ON public.assessment_contracts
FOR EACH ROW
EXECUTE FUNCTION public.audit_assessment_prospect_reactivation();

COMMENT ON COLUMN public.assessment_contracts.prospect_customer_relationship IS
  'Relação com a assessoria no envio: novo, ex-aluno ou aluno atual. Compras da loja não participam.';
COMMENT ON COLUMN public.assessment_contracts.prospect_previous_contract_id IS
  'Contrato de assessoria anterior que fundamentou a classificação; nunca aponta para pedido de produto.';
COMMENT ON COLUMN public.assessment_contracts.prospect_reactivated_at IS
  'Confirmação do retorno, preenchida somente quando um ex-aluno paga o novo contrato.';
