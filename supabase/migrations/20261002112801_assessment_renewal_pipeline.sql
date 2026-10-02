-- Operational renewal pipeline. The child contract remains the only sale and
-- financial record. This migration does not contact a payment provider.

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS renewal_stage text,
  ADD COLUMN IF NOT EXISTS renewal_stage_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_response_code text,
  ADD COLUMN IF NOT EXISTS renewal_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_follow_up_at date,
  ADD COLUMN IF NOT EXISTS renewal_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_last_contact_at timestamptz;

ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_renewal_stage_values CHECK (
    renewal_stage IS NULL OR renewal_stage IN (
      'contact_pending', 'waiting_response', 'charge_pending',
      'waiting_payment', 'renewed', 'not_renewed'
    )
  ),
  ADD CONSTRAINT assessment_renewal_response_values CHECK (
    renewal_response_code IS NULL OR renewal_response_code IN (
      'will_renew', 'thinking', 'change_plan_or_coach',
      'needs_agent', 'not_renewing'
    )
  ),
  ADD CONSTRAINT assessment_renewal_only_children CHECK (
    parent_contract_id IS NOT NULL OR renewal_stage IS NULL
  );

COMMENT ON COLUMN public.assessment_contracts.renewal_stage IS
  'Operational stage of the child renewal; independent of contract and payment status.';

CREATE INDEX IF NOT EXISTS assessment_renewal_board_idx
  ON public.assessment_contracts (renewal_stage, renewal_resolved_at, start_date)
  WHERE parent_contract_id IS NOT NULL AND renewal_stage IS NOT NULL;

CREATE TABLE IF NOT EXISTS eon_private.assessment_renewal_stage_backups (
  contract_id uuid PRIMARY KEY,
  before_row jsonb NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON eon_private.assessment_renewal_stage_backups FROM PUBLIC, anon, authenticated;
ALTER TABLE eon_private.assessment_renewal_stage_backups ENABLE ROW LEVEL SECURITY;

-- A repeatable migration/backfill never overwrites an already classified item.
INSERT INTO eon_private.assessment_renewal_stage_backups(contract_id, before_row)
SELECT id, to_jsonb(contract)
FROM public.assessment_contracts AS contract
WHERE parent_contract_id IS NOT NULL AND renewal_stage IS NULL
ON CONFLICT (contract_id) DO NOTHING;

WITH classified AS (
  SELECT child.id,
    CASE
      WHEN child.status IN ('voided', 'cancelled')
        AND declined.created_at IS NOT NULL THEN 'not_renewed'
      WHEN child.status IN ('voided', 'cancelled') THEN NULL
      WHEN child.payment_status = 'paid' THEN 'renewed'
      WHEN child.status IN ('scheduled', 'active', 'overdue', 'on_leave', 'finished')
        THEN 'waiting_payment'
      WHEN child.status = 'draft' AND child.payment_message_sent_at IS NOT NULL
        THEN 'waiting_payment'
      WHEN child.status = 'draft' AND EXISTS (
        SELECT 1 FROM public.assessment_contract_event AS sent
        WHERE sent.contract_id = child.parent_contract_id
          AND sent.event_type = 'renewal_message_sent'
          AND sent.created_at >= child.created_at
          AND (
            sent.payload->>'renewal_contract_id' IS NULL
            OR sent.payload->>'renewal_contract_id' = child.id::text
          )
      ) THEN 'waiting_response'
      WHEN child.status = 'draft' THEN 'contact_pending'
      ELSE NULL
    END AS stage,
    declined.created_at AS declined_at
  FROM public.assessment_contracts AS child
  LEFT JOIN LATERAL (
    SELECT event.created_at
    FROM public.assessment_contract_event AS event
    WHERE event.contract_id = child.parent_contract_id
      AND event.event_type = 'renewal_declined'
      AND event.payload->>'discarded_contract_id' = child.id::text
      AND event.payload->>'resolution' = 'non_renewal'
    ORDER BY event.created_at DESC
    LIMIT 1
  ) AS declined ON true
  WHERE child.parent_contract_id IS NOT NULL
)
UPDATE public.assessment_contracts AS child
SET renewal_stage = classified.stage,
    renewal_entered_at = COALESCE(child.created_at, now()),
    renewal_stage_updated_at = COALESCE(
      CASE WHEN classified.stage = 'renewed' AND child.payment_date IS NOT NULL
        THEN child.payment_date::timestamp AT TIME ZONE 'America/Sao_Paulo'
      WHEN classified.stage = 'not_renewed' THEN classified.declined_at
      ELSE child.created_at END, now()),
    renewal_resolved_at = CASE
      WHEN classified.stage = 'renewed' THEN COALESCE(
        child.payment_date::timestamp AT TIME ZONE 'America/Sao_Paulo',
        child.updated_at, child.created_at, now())
      WHEN classified.stage = 'not_renewed' THEN classified.declined_at
      ELSE NULL END
FROM classified
WHERE child.id = classified.id
  AND child.renewal_stage IS NULL
  AND classified.stage IS NOT NULL;

CREATE TABLE IF NOT EXISTS eon_private.renewal_stage_requests (
  idempotency_key text PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES public.assessment_contracts(id),
  action text NOT NULL,
  request_payload jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON eon_private.renewal_stage_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON eon_private.renewal_stage_requests TO service_role;
ALTER TABLE eon_private.renewal_stage_requests ENABLE ROW LEVEL SECURITY;

-- Kept after the existing open-sale normalization trigger (alphabetical order).
CREATE OR REPLACE FUNCTION eon_private.sync_assessment_renewal_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_months integer;
  v_plan_months integer;
  v_plan_period text;
  v_check_auto boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_check_auto := NEW.auto_renewal;
  ELSE
    v_check_auto := NEW.auto_renewal AND (
      NOT OLD.auto_renewal OR NEW.plan_snapshot IS DISTINCT FROM OLD.plan_snapshot
      OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    );
  END IF;
  IF v_check_auto THEN
    v_months := CASE
      WHEN NEW.plan_snapshot->>'period_months' ~ '^[0-9]+$'
        THEN (NEW.plan_snapshot->>'period_months')::integer
      ELSE NULL END;
    IF v_months IS NULL THEN
      SELECT period_months, period INTO v_plan_months, v_plan_period
      FROM public.assessment_plans WHERE id = NEW.plan_id;
      v_months := COALESCE(v_plan_months, CASE COALESCE(
        NEW.plan_snapshot->>'period', v_plan_period
      ) WHEN 'mensal' THEN 1 WHEN 'trimestral' THEN 3
        WHEN 'semestral' THEN 6 ELSE NULL END);
    END IF;
    IF v_months IS DISTINCT FROM 1 THEN
      IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = 'Renovação automática só pode ser ativada em plano mensal';
      ELSIF NOT OLD.auto_renewal THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = 'Renovação automática só pode ser ativada em plano mensal';
      END IF;
      NEW.auto_renewal := false;
    END IF;
  END IF;

  IF NEW.parent_contract_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.renewal_entered_at := COALESCE(NEW.renewal_entered_at, now());
    NEW.renewal_stage := CASE
      WHEN NEW.payment_status = 'paid' AND NEW.status NOT IN ('voided', 'cancelled')
        THEN 'renewed'
      WHEN NEW.status IN ('voided', 'cancelled') THEN NULL
      WHEN NEW.status IN ('scheduled', 'active', 'overdue', 'on_leave', 'finished')
        THEN 'waiting_payment'
      ELSE 'contact_pending' END;
  ELSE
    -- Financial/lifecycle facts outrank an open operational stage.
    IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid'
       AND NEW.status NOT IN ('voided', 'cancelled') THEN
      NEW.renewal_stage := 'renewed';
    ELSIF OLD.payment_status = 'paid' AND NEW.payment_status <> 'paid'
      AND OLD.renewal_stage = 'renewed'
      AND NEW.status NOT IN ('voided', 'cancelled') THEN
      NEW.renewal_stage := 'waiting_payment';
    ELSIF NEW.status IN ('voided', 'cancelled')
      AND OLD.status NOT IN ('voided', 'cancelled') THEN
      NEW.renewal_stage := NULL;
    ELSIF NEW.status IN ('scheduled', 'active', 'overdue', 'on_leave', 'finished')
      AND OLD.status = 'draft' AND NEW.payment_status <> 'paid' THEN
      NEW.renewal_stage := 'waiting_payment';
    END IF;
  END IF;

  IF NEW.status NOT IN ('voided', 'cancelled') AND NEW.payment_status = 'paid' THEN
    NEW.renewal_stage := 'renewed';
  ELSIF NEW.renewal_stage = 'renewed'
    AND (NEW.payment_status <> 'paid' OR NEW.status IN ('voided', 'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Renovou exige pagamento confirmado';
  END IF;
  IF NEW.renewal_stage = 'not_renewed' AND (
    NEW.status <> 'voided' OR NEW.payment_status <> 'cancelled'
    OR NOT EXISTS (
      SELECT 1 FROM public.assessment_contract_event event
      WHERE event.contract_id = NEW.parent_contract_id
        AND event.event_type = 'renewal_declined'
        AND event.payload->>'discarded_contract_id' = NEW.id::text
        AND event.payload->>'resolution' = 'non_renewal'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Não renovou exige resolução segura registrada';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.renewal_stage_updated_at := now();
    IF NEW.renewal_stage IN ('renewed', 'not_renewed') THEN
      NEW.renewal_resolved_at := COALESCE(NEW.renewal_resolved_at, now());
    END IF;
  ELSIF NEW.renewal_stage IS DISTINCT FROM OLD.renewal_stage THEN
    NEW.renewal_stage_updated_at := now();
    IF NEW.renewal_stage IN ('renewed', 'not_renewed') THEN
      NEW.renewal_resolved_at := COALESCE(NEW.renewal_resolved_at, now());
    ELSE
      NEW.renewal_resolved_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_assessment_renewal_stage_sync ON public.assessment_contracts;
CREATE TRIGGER zz_assessment_renewal_stage_sync
BEFORE INSERT OR UPDATE OF status, payment_status, renewal_stage, auto_renewal,
  plan_id, plan_snapshot, renewal_response_code, renewal_follow_up_at
ON public.assessment_contracts FOR EACH ROW
EXECUTE FUNCTION eon_private.sync_assessment_renewal_stage();

CREATE OR REPLACE FUNCTION eon_private.audit_assessment_renewal_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_action text := NULLIF(current_setting('app.renewal_action', true), '');
  v_actor text := NULLIF(current_setting('app.renewal_actor_id', true), '');
BEGIN
  IF NEW.parent_contract_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.renewal_stage IS NOT DISTINCT FROM OLD.renewal_stage
       AND NEW.renewal_response_code IS NOT DISTINCT FROM OLD.renewal_response_code
       AND NEW.renewal_follow_up_at IS NOT DISTINCT FROM OLD.renewal_follow_up_at
       AND NEW.renewal_last_contact_at IS NOT DISTINCT FROM OLD.renewal_last_contact_at
    THEN RETURN NEW; END IF;
  END IF;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    NEW.id,
    'renewal_stage_changed',
    jsonb_build_object(
      'stage_before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.renewal_stage END,
      'stage_after', NEW.renewal_stage,
      'action', COALESCE(v_action, 'automatic_sync'),
      'actor_id', v_actor,
      'response_code', NEW.renewal_response_code,
      'follow_up_at', NEW.renewal_follow_up_at,
      'occurred_at', now()
    ),
    'Etapa operacional da renovação atualizada.',
    CASE WHEN v_actor ~* '^[0-9a-f-]{36}$' THEN v_actor::uuid ELSE auth.uid() END
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_assessment_renewal_stage_audit ON public.assessment_contracts;
CREATE TRIGGER zz_assessment_renewal_stage_audit
AFTER INSERT OR UPDATE OF status, payment_status, renewal_stage,
  renewal_response_code, renewal_follow_up_at, renewal_last_contact_at
ON public.assessment_contracts FOR EACH ROW
EXECUTE FUNCTION eon_private.audit_assessment_renewal_stage();

-- The audited resolution writes the parent renewal_declined event after it
-- voids the child. Only that event establishes a real non-renewal.
CREATE OR REPLACE FUNCTION eon_private.sync_assessment_non_renewal_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_child_id uuid;
BEGIN
  IF NEW.event_type = 'renewal_message_sent' THEN
    PERFORM set_config('app.renewal_action', 'message_sent_in_communication_center', true);
    PERFORM set_config('app.renewal_actor_id', COALESCE(NEW.created_by::text, ''), true);
    UPDATE public.assessment_contracts AS child
    SET renewal_stage = 'waiting_response',
        renewal_last_contact_at = NEW.created_at,
        updated_at = now()
    WHERE child.parent_contract_id = NEW.contract_id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
      AND child.renewal_stage = 'contact_pending'
      AND (
        NEW.payload->>'renewal_contract_id' IS NULL
        OR NEW.payload->>'renewal_contract_id' = child.id::text
      );
    RETURN NEW;
  END IF;
  IF NEW.event_type <> 'renewal_declined'
     OR NEW.payload->>'resolution' IS DISTINCT FROM 'non_renewal' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.payload->>'discarded_contract_id', '') !~*
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  v_child_id := (NEW.payload->>'discarded_contract_id')::uuid;
  PERFORM set_config('app.renewal_action', 'safe_non_renewal_resolution', true);
  PERFORM set_config('app.renewal_actor_id', COALESCE(NEW.created_by::text, ''), true);
  UPDATE public.assessment_contracts
  SET renewal_stage = 'not_renewed',
      renewal_response_code = 'not_renewing',
      renewal_response_at = COALESCE(renewal_response_at, NEW.created_at),
      renewal_resolved_at = NEW.created_at,
      updated_at = now()
  WHERE id = v_child_id AND parent_contract_id = NEW.contract_id
    AND status = 'voided' AND payment_status = 'cancelled'
    AND renewal_stage IS DISTINCT FROM 'not_renewed';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_assessment_non_renewal_stage ON public.assessment_contract_event;
CREATE TRIGGER zz_assessment_non_renewal_stage
AFTER INSERT ON public.assessment_contract_event FOR EACH ROW
EXECUTE FUNCTION eon_private.sync_assessment_non_renewal_event();

CREATE OR REPLACE FUNCTION public.transition_assessment_renewal_stage(
  p_contract_id uuid, p_action text, p_response_code text,
  p_follow_up_at date, p_expected_updated_at timestamptz,
  p_actor_id uuid, p_idempotency_key text, p_subscription_link text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_request eon_private.renewal_stage_requests%ROWTYPE;
  v_result jsonb;
  v_new_stage text;
  v_request_payload jsonb;
  v_clean_subscription_link text := NULLIF(btrim(p_subscription_link), '');
  v_previous_subscription_link text;
BEGIN
  IF p_actor_id IS NULL OR p_expected_updated_at IS NULL
     OR p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da transição inválidos';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('message_sent', 'register_response',
                      'set_follow_up', 'change_resolved',
                      'register_subscription_link') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Ação de renovação inválida';
  END IF;
  IF p_action = 'register_subscription_link' THEN
    IF v_clean_subscription_link IS NULL
       OR length(v_clean_subscription_link) > 2048
       OR v_clean_subscription_link !~ '^https://[^/@[:space:][:cntrl:]]+(/[^[:space:][:cntrl:]]*)?$'
       OR v_clean_subscription_link ~ '[[:cntrl:][:space:]]' THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'Informe um link HTTPS válido da assinatura existente';
    END IF;
  ELSIF v_clean_subscription_link IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Link de assinatura incompatível com a ação';
  END IF;

  v_request_payload := jsonb_build_object(
    'response_code', p_response_code,
    'follow_up_at', p_follow_up_at,
    'expected_updated_at', p_expected_updated_at,
    'actor_id', p_actor_id,
    'subscription_link_fingerprint', md5(v_clean_subscription_link)
  );

  INSERT INTO eon_private.renewal_stage_requests(
    idempotency_key, contract_id, action, request_payload
  ) VALUES (p_idempotency_key, p_contract_id, p_action, v_request_payload)
  ON CONFLICT (idempotency_key) DO NOTHING;
  SELECT * INTO v_request FROM eon_private.renewal_stage_requests
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF v_request.contract_id <> p_contract_id OR v_request.action <> p_action
     OR v_request.request_payload IS DISTINCT FROM v_request_payload THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Chave de idempotência reutilizada para outra ação';
  END IF;
  IF v_request.result IS NOT NULL THEN RETURN v_request.result; END IF;

  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Renovação não encontrada';
  END IF;
  IF v_contract.parent_contract_id IS NULL OR v_contract.renewal_stage IS NULL
     OR v_contract.renewal_stage IN ('renewed', 'not_renewed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta renovação não está aberta no quadro';
  END IF;
  IF v_contract.payment_status = 'paid' OR v_contract.status IN ('voided', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Pagamento ou contrato exige conferência antes de alterar a etapa';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A renovação foi alterada. Atualize o quadro e tente novamente';
  END IF;
  v_new_stage := v_contract.renewal_stage;
  IF p_action = 'message_sent' THEN
    IF v_contract.renewal_stage <> 'contact_pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A mensagem já foi registrada ou a etapa mudou';
    END IF;
    v_new_stage := 'waiting_response';
  ELSIF p_action = 'register_response' THEN
    IF v_contract.renewal_stage NOT IN ('contact_pending', 'waiting_response')
       OR p_response_code IS NULL OR p_response_code NOT IN (
         'will_renew', 'thinking', 'change_plan_or_coach', 'needs_agent'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Resposta incompatível com a etapa atual';
    END IF;
    IF p_response_code = 'will_renew' THEN
      v_new_stage := 'charge_pending';
    ELSE
      v_new_stage := 'waiting_response';
    END IF;
  ELSIF p_action = 'set_follow_up' THEN
    IF v_contract.renewal_stage <> 'waiting_response' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Follow-up exige resposta pendente';
    END IF;
  ELSIF p_action = 'change_resolved' THEN
    IF v_contract.renewal_stage <> 'waiting_response'
       OR v_contract.renewal_response_code <> 'change_plan_or_coach' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Não há alteração pendente para resolver';
    END IF;
    v_new_stage := 'charge_pending';
  ELSIF p_action = 'register_subscription_link' THEN
    IF v_contract.renewal_stage <> 'waiting_payment'
       OR v_contract.status NOT IN ('scheduled', 'active', 'overdue', 'on_leave', 'finished')
       OR NOT v_contract.auto_renewal
       OR COALESCE(v_contract.plan_snapshot->>'period_months', '') <> '1'
       OR NULLIF(v_contract.external_payment_link, '') IS NOT NULL
       OR NULLIF(v_contract.external_invoice_number, '') IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'O link só pode ser informado na assinatura mensal automática aberta';
    END IF;
    IF v_contract.asaas_payment_link IS NOT DISTINCT FROM v_clean_subscription_link THEN
      v_result := jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
      UPDATE eon_private.renewal_stage_requests SET result = v_result
      WHERE idempotency_key = p_idempotency_key;
      RETURN v_result;
    END IF;
  END IF;

  v_previous_subscription_link := v_contract.asaas_payment_link;
  PERFORM set_config('app.renewal_action', p_action, true);
  PERFORM set_config('app.renewal_actor_id', p_actor_id::text, true);
  UPDATE public.assessment_contracts
  SET renewal_stage = v_new_stage,
      renewal_response_code = CASE WHEN p_action = 'register_response'
        THEN p_response_code ELSE renewal_response_code END,
      renewal_response_at = CASE WHEN p_action = 'register_response'
        THEN now() ELSE renewal_response_at END,
      renewal_follow_up_at = CASE WHEN p_action IN ('set_follow_up', 'register_response')
        THEN p_follow_up_at ELSE renewal_follow_up_at END,
      renewal_last_contact_at = CASE WHEN p_action = 'message_sent'
        THEN now() ELSE renewal_last_contact_at END,
      asaas_payment_link = CASE WHEN p_action = 'register_subscription_link'
        THEN v_clean_subscription_link ELSE asaas_payment_link END,
      updated_at = now()
  WHERE id = p_contract_id RETURNING * INTO v_contract;

  IF p_action = 'register_subscription_link' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id,
      'renewal_subscription_link_registered',
      jsonb_build_object(
        'had_previous_link', NULLIF(v_previous_subscription_link, '') IS NOT NULL,
        'new_link_host', split_part(v_clean_subscription_link, '/', 3),
        'action', p_action,
        'actor_id', p_actor_id,
        'occurred_at', now()
      ),
      'Link da cobrança da assinatura existente registrado; nenhuma cobrança foi criada.',
      p_actor_id
    );
  END IF;

  IF p_action = 'message_sent' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.parent_contract_id,
      'renewal_message_sent',
      jsonb_build_object(
        'source', 'renewal_board',
        'rule_slug', 'renewal-reminder-14d',
        'renewal_contract_id', v_contract.id,
        'action', 'message_sent'
      ),
      'Mensagem de intenção de renovação registrada como enviada.',
      p_actor_id
    );
  END IF;

  v_result := jsonb_build_object('contract', to_jsonb(v_contract));
  UPDATE eon_private.renewal_stage_requests SET result = v_result
  WHERE idempotency_key = p_idempotency_key;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, text, date, timestamptz, uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, text, date, timestamptz, uuid, text, text
) TO service_role;

-- The slug remains stable for old events. Update the stock template only;
-- teams that edited their WhatsApp wording keep that wording.
WITH stock_template AS (
  SELECT
    $old$Ola, {nome}! Tudo bem?

Seu acompanhamento na Endurance ON pelo plano *{plano}* esta chegando perto do vencimento em *{data_fim}*.

Quero deixar sua continuidade organizada para voce nao interromper o acompanhamento. Posso te enviar as opcoes de renovacao?$old$ AS old_text,
    $new$Oi, {nome}! Tudo bem?
Sou o Pebinha, assistente virtual da EON. Estou aqui pra te lembrar que seu plano {situacao_vencimento}.
Pra ajudar nosso time nesse processo, você gostaria de realizar a renovação?
1. Sim, vou renovar.
2. Ainda estou pensando.
3. Gostaria de mudar de plano/treinador.
4. Gostaria de falar com um atendente.
5. Não vou renovar.$new$ AS new_text
)
UPDATE public.communication_rules AS rule
SET days_offset = -10,
    message_template = CASE
      WHEN rule.message_template = stock_template.old_text
        THEN stock_template.new_text
      ELSE rule.message_template END,
    updated_at = now()
FROM stock_template
WHERE rule.slug = 'renewal-reminder-14d'
  AND rule.task_kind = 'renewal_reminder'
  AND rule.days_offset IN (-14, -15);
REVOKE ALL ON FUNCTION eon_private.sync_assessment_renewal_stage()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.audit_assessment_renewal_stage()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.sync_assessment_non_renewal_event()
  FROM PUBLIC, anon, authenticated;
