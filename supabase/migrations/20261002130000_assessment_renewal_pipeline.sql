-- Quadro de Renovações: a etapa operacional passa a ser gravada no próprio
-- contrato de renovação (o contrato-filho), sem tabela ou módulo paralelo.
--
-- São três dimensões diferentes, que podem coexistir:
--   - vigência do contrato (status: draft, scheduled, active, ...);
--   - pagamento da venda (payment_status: awaiting_charge, paid, ...);
--   - etapa da renovação (renewal_stage), que é o que o quadro mostra.
--
-- Regras principais:
--   - a data coloca a renovação no quadro (manual 10 dias antes; mensal
--     automática 5 dias antes, direto em "Aguardando pagamento");
--   - a data nunca tira um card aberto do quadro: só uma resolução terminal
--     (Renovou, Não renovou ou venda descartada) encerra a etapa;
--   - a etapa acompanha o contrato e o pagamento pelo banco: venda aprovada ou
--     com cobrança vai para "Aguardando pagamento", pagamento confirmado vai
--     para "Renovou", pagamento desfeito volta para "Aguardando pagamento";
--   - mensagem, resposta, follow-up e alteração resolvida só mudam pela API
--     (transition_assessment_renewal_stage), com versão, idempotência e
--     histórico;
--   - renovação automática só vale para plano mensal.

-- 1. Período do plano do contrato ---------------------------------------------------

CREATE OR REPLACE FUNCTION eon_private.assessment_contract_period_months(
  p_plan_id uuid,
  p_plan_snapshot jsonb
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    CASE
      WHEN COALESCE(p_plan_snapshot->>'period_months', '') ~ '^[0-9]+$'
        THEN (p_plan_snapshot->>'period_months')::integer
    END,
    (SELECT plan.period_months FROM public.assessment_plans AS plan WHERE plan.id = p_plan_id),
    CASE COALESCE(
      p_plan_snapshot->>'period',
      (SELECT plan.period FROM public.assessment_plans AS plan WHERE plan.id = p_plan_id)
    )
      WHEN 'mensal' THEN 1
      WHEN 'trimestral' THEN 3
      WHEN 'semestral' THEN 6
      WHEN 'anual' THEN 12
    END
  );
$$;

REVOKE ALL ON FUNCTION eon_private.assessment_contract_period_months(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.assessment_contract_period_months(uuid, jsonb)
  TO service_role;

-- 2. Campos da etapa no contrato de renovação ----------------------------------------

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS renewal_stage text,
  ADD COLUMN IF NOT EXISTS renewal_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_stage_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_response_code text,
  ADD COLUMN IF NOT EXISTS renewal_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_follow_up_at date,
  ADD COLUMN IF NOT EXISTS renewal_last_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_resolved_at timestamptz;

COMMENT ON COLUMN public.assessment_contracts.renewal_stage IS
  'Etapa do quadro de Renovações (só em contrato de renovação): contact_pending, waiting_response, charge_pending, waiting_payment, renewed, not_renewed ou discarded (venda descartada, fora do quadro e sem contar como saída).';
COMMENT ON COLUMN public.assessment_contracts.renewal_resolved_at IS
  'Quando a renovação chegou a uma etapa final; o quadro mostra Renovou/Não renovou por 5 dias depois disso, sem apagar nada.';
COMMENT ON COLUMN public.assessment_contracts.renewal_follow_up_at IS
  'Próximo contato combinado enquanto o atleta decide (só em waiting_response).';

-- Índice das consultas do quadro (etapas abertas e finais recentes).
CREATE INDEX IF NOT EXISTS assessment_contracts_renewal_stage_idx
  ON public.assessment_contracts (renewal_stage, renewal_resolved_at)
  WHERE parent_contract_id IS NOT NULL;

-- 3. Idempotência das ações do quadro -------------------------------------------------

ALTER TABLE public.order_operations
  DROP CONSTRAINT IF EXISTS order_operations_operation_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
    'cancel_order'::text, 'refund_order'::text, 'cancel_item'::text,
    'change_due_date'::text, 'create_charge'::text, 'cancel_charge'::text,
    'resolve_renewal'::text, 'void_contract_sale'::text,
    'change_contract_plan'::text, 'create_contract_renewal'::text,
    'renewal_stage'::text
  ]));

-- 4. Só o backend muda a etapa ----------------------------------------------------------

-- O painel lê os contratos direto (RLS de admin), mas a etapa não pode ser
-- gravada por update do navegador: só pelas funções do servidor. A trava olha
-- apenas o que o próprio comando tentou mudar; a sincronização automática
-- (gatilho seguinte) continua valendo para qualquer origem.
CREATE OR REPLACE FUNCTION eon_private.guard_assessment_renewal_stage_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.renewal_stage IS NOT NULL
       OR NEW.renewal_entered_at IS NOT NULL
       OR NEW.renewal_stage_updated_at IS NOT NULL
       OR NEW.renewal_response_code IS NOT NULL
       OR NEW.renewal_response_at IS NOT NULL
       OR NEW.renewal_follow_up_at IS NOT NULL
       OR NEW.renewal_last_contact_at IS NOT NULL
       OR NEW.renewal_resolved_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'A etapa da renovação só pode ser alterada pelas ações de Renovações';
    END IF;
  ELSIF (
    NEW.renewal_stage, NEW.renewal_entered_at, NEW.renewal_stage_updated_at,
    NEW.renewal_response_code, NEW.renewal_response_at, NEW.renewal_follow_up_at,
    NEW.renewal_last_contact_at, NEW.renewal_resolved_at
  ) IS DISTINCT FROM (
    OLD.renewal_stage, OLD.renewal_entered_at, OLD.renewal_stage_updated_at,
    OLD.renewal_response_code, OLD.renewal_response_at, OLD.renewal_follow_up_at,
    OLD.renewal_last_contact_at, OLD.renewal_resolved_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'A etapa da renovação só pode ser alterada pelas ações de Renovações';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.guard_assessment_renewal_stage_columns()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS assessment_contract_guard_renewal_stage
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_guard_renewal_stage
  BEFORE INSERT OR UPDATE ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.guard_assessment_renewal_stage_columns();

-- 5. Etapa acompanha contrato e pagamento -----------------------------------------------

-- Roda por último entre os gatilhos BEFORE (ordem alfabética: "trg_sync_..."
-- vem depois de "trg_normalize_contract_on_cancel"), para enxergar o status e o
-- pagamento finais da linha.
CREATE OR REPLACE FUNCTION eon_private.sync_assessment_renewal_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_stage text;
  v_cause text;
  v_actor uuid;
  v_operation_id uuid;
  v_resolution text;
  v_reason_code text;
BEGIN
  IF NEW.parent_contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Entrada no quadro: renovação criada, contrato ligado como renovação ou
  -- linha antiga ainda sem etapa.
  IF TG_OP = 'INSERT'
     OR OLD.parent_contract_id IS NULL
     OR OLD.renewal_stage IS NULL THEN
    IF NEW.renewal_stage IS NULL THEN
      NEW.renewal_stage := CASE
        WHEN NEW.payment_status IN ('paid', 'refunded') THEN 'renewed'
        WHEN NEW.status IN ('voided', 'cancelled') THEN 'discarded'
        WHEN NEW.status = 'draft' THEN 'contact_pending'
        ELSE 'waiting_payment'
      END;
      NEW.renewal_stage_updated_at := v_now;
      NEW.renewal_resolved_at := CASE
        WHEN NEW.renewal_stage = 'renewed' THEN LEAST(
          v_now,
          (NEW.payment_date + time '12:00') AT TIME ZONE 'America/Sao_Paulo'
        )
        WHEN NEW.renewal_stage = 'discarded' THEN v_now
        ELSE NULL
      END;
      IF TG_OP = 'UPDATE' THEN
        INSERT INTO public.assessment_contract_event (
          contract_id, event_type, payload, notes
        ) VALUES (
          NEW.id,
          'renewal_pipeline_entered',
          jsonb_build_object(
            'stage_after', NEW.renewal_stage,
            'source', 'renewal_linked',
            'status', NEW.status,
            'payment_status', NEW.payment_status
          ),
          'Contrato ligado como renovação; entrou no quadro de Renovações.'
        );
      END IF;
    END IF;
    NEW.renewal_entered_at := COALESCE(NEW.renewal_entered_at, v_now);
    NEW.renewal_stage_updated_at := COALESCE(NEW.renewal_stage_updated_at, v_now);
    RETURN NEW;
  END IF;

  -- Mudança explícita feita pelo próprio comando (ações do quadro): vale ela.
  IF NEW.renewal_stage IS DISTINCT FROM OLD.renewal_stage THEN
    IF NEW.renewal_stage_updated_at IS NOT DISTINCT FROM OLD.renewal_stage_updated_at THEN
      NEW.renewal_stage_updated_at := v_now;
    END IF;
    RETURN NEW;
  END IF;

  v_stage := NEW.renewal_stage;

  IF NEW.renewal_stage IN (
    'contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment'
  ) THEN
    IF NEW.payment_status = 'paid'
       AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
      v_stage := 'renewed';
      v_cause := 'payment_confirmed';
    ELSIF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
      -- A janela segura de renovação conclui a operação depois de anular a
      -- venda; enquanto isso, a operação ainda está "prepared".
      SELECT operation.id,
             operation.payload->>'resolution',
             operation.payload->>'reason_code',
             operation.requested_by
      INTO v_operation_id, v_resolution, v_reason_code, v_actor
      FROM public.order_operations AS operation
      WHERE operation.operation_type = 'resolve_renewal'
        AND operation.order_type = 'contract'
        AND operation.order_id = NEW.id
        AND operation.status = 'prepared'
      ORDER BY operation.created_at DESC
      LIMIT 1;
      v_stage := CASE
        WHEN v_resolution = 'non_renewal' THEN 'not_renewed'
        ELSE 'discarded'
      END;
      v_cause := CASE
        WHEN v_operation_id IS NOT NULL THEN 'renewal_resolution'
        ELSE 'sale_voided'
      END;
      IF v_stage = 'not_renewed' AND v_reason_code = 'customer_declined' THEN
        NEW.renewal_response_code := 'not_renewing';
        NEW.renewal_response_at := v_now;
      END IF;
    ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
      -- A saída fica registrada como cancelamento, não como "Não renovou".
      v_stage := 'discarded';
      v_cause := 'contract_cancelled';
    ELSIF OLD.status = 'draft'
          AND NEW.status IN ('scheduled', 'active', 'overdue', 'on_leave')
          AND NEW.renewal_stage <> 'waiting_payment' THEN
      -- Aprovação ou cobrança cadastrada: a venda abriu no Financeiro.
      v_stage := 'waiting_payment';
      v_cause := 'sale_opened';
    ELSIF NEW.status = 'draft'
          AND OLD.status IS DISTINCT FROM 'draft'
          AND NEW.renewal_stage = 'waiting_payment' THEN
      v_stage := 'charge_pending';
      v_cause := 'sale_returned_to_draft';
    END IF;
  ELSIF NEW.renewal_stage = 'renewed'
        AND OLD.payment_status = 'paid'
        AND NEW.payment_status IN (
          'pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid'
        )
        AND NEW.status NOT IN ('voided', 'cancelled') THEN
    v_stage := CASE WHEN NEW.status = 'draft' THEN 'charge_pending' ELSE 'waiting_payment' END;
    v_cause := 'payment_reverted';
  END IF;

  IF v_stage IS DISTINCT FROM NEW.renewal_stage THEN
    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      NEW.id,
      'renewal_stage_changed',
      jsonb_build_object(
        'action', v_cause,
        'source', 'automatic',
        'stage_before', NEW.renewal_stage,
        'stage_after', v_stage,
        'status_before', OLD.status,
        'status_after', NEW.status,
        'payment_status_before', OLD.payment_status,
        'payment_status_after', NEW.payment_status,
        'operation_id', v_operation_id,
        'resolution', v_resolution,
        'reason_code', v_reason_code
      ),
      CASE v_cause
        WHEN 'payment_confirmed' THEN 'Pagamento confirmado: renovação concluída.'
        WHEN 'payment_reverted' THEN 'Pagamento desfeito: renovação voltou a aguardar pagamento.'
        WHEN 'sale_opened' THEN 'Venda da renovação aberta no Financeiro: aguardando pagamento.'
        WHEN 'sale_returned_to_draft' THEN 'Venda voltou para rascunho: cobrança pendente.'
        WHEN 'contract_cancelled' THEN 'Contrato cancelado: renovação encerrada sem contar como "Não renovou".'
        WHEN 'renewal_resolution' THEN CASE
          WHEN v_stage = 'not_renewed' THEN 'Atleta não renovou.'
          ELSE 'Venda da renovação descartada, sem contar como saída.'
        END
        ELSE 'Venda da renovação anulada.'
      END,
      COALESCE(v_actor, auth.uid())
    );
    NEW.renewal_stage := v_stage;
    NEW.renewal_stage_updated_at := v_now;
    NEW.renewal_resolved_at := CASE
      WHEN v_stage IN ('renewed', 'not_renewed', 'discarded') THEN v_now
      ELSE NULL
    END;
    IF v_stage <> 'waiting_response' THEN
      NEW.renewal_follow_up_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.sync_assessment_renewal_stage()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_assessment_renewal_stage
  ON public.assessment_contracts;
CREATE TRIGGER trg_sync_assessment_renewal_stage
  BEFORE INSERT OR UPDATE ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.sync_assessment_renewal_stage();

-- A entrada de uma renovação recém-criada fica na linha do tempo dela.
CREATE OR REPLACE FUNCTION eon_private.log_assessment_renewal_pipeline_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    NEW.id,
    'renewal_pipeline_entered',
    jsonb_build_object(
      'stage_after', NEW.renewal_stage,
      'source', 'renewal_created',
      'status', NEW.status,
      'payment_status', NEW.payment_status,
      'automatic', NEW.auto_renewal
    ),
    CASE NEW.renewal_stage
      WHEN 'contact_pending' THEN 'Renovação entrou no quadro em "Enviar mensagem".'
      WHEN 'waiting_payment' THEN 'Renovação entrou no quadro em "Aguardando pagamento".'
      WHEN 'renewed' THEN 'Renovação registrada já paga.'
      ELSE 'Renovação registrada.'
    END,
    COALESCE(auth.uid(), NEW.created_by)
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.log_assessment_renewal_pipeline_entry()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS assessment_contract_log_renewal_pipeline_entry
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_log_renewal_pipeline_entry
  AFTER INSERT ON public.assessment_contracts
  FOR EACH ROW
  WHEN (NEW.parent_contract_id IS NOT NULL)
  EXECUTE FUNCTION eon_private.log_assessment_renewal_pipeline_entry();

-- 6. Renovação automática só em plano mensal ----------------------------------------------

-- Ligar a automática num plano não mensal é recusado. Quando um contrato
-- automático passa para um plano não mensal (troca de plano), a automática é
-- desligada junto e o histórico registra o motivo. Roda depois de
-- carry_plan_change_into_renewal (ordem alfabética), que pode trocar o plano de
-- uma renovação na criação.
CREATE OR REPLACE FUNCTION eon_private.enforce_monthly_auto_renewal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_months integer;
BEGIN
  IF NOT COALESCE(NEW.auto_renewal, false) THEN
    RETURN NEW;
  END IF;

  v_months := eon_private.assessment_contract_period_months(NEW.plan_id, NEW.plan_snapshot);
  IF v_months IS NULL OR v_months = 1 THEN
    RETURN NEW;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.parent_contract_id IS NULL)
     OR (TG_OP = 'UPDATE' AND NOT COALESCE(OLD.auto_renewal, false)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A renovação automática só vale para plano mensal';
  END IF;

  NEW.auto_renewal := false;
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes
    ) VALUES (
      NEW.id,
      'auto_renewal_changed',
      jsonb_build_object(
        'enabled', false,
        'reason', 'plan_not_monthly',
        'period_months', v_months,
        'source', 'automatic'
      ),
      'Renovação automática desativada: o plano deixou de ser mensal.'
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.enforce_monthly_auto_renewal()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_monthly_auto_renewal
  ON public.assessment_contracts;
CREATE TRIGGER trg_enforce_monthly_auto_renewal
  BEFORE INSERT OR UPDATE OF auto_renewal, plan_id, plan_snapshot
  ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.enforce_monthly_auto_renewal();

CREATE OR REPLACE FUNCTION public.set_assessment_contract_auto_renewal(
  p_contract_id uuid,
  p_auto_renewal boolean,
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
  IF p_auto_renewal IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a configuração de renovação automática';
  END IF;
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.auto_renewal IS NOT DISTINCT FROM p_auto_renewal THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF p_auto_renewal
     AND COALESCE(
       eon_private.assessment_contract_period_months(v_contract.plan_id, v_contract.plan_snapshot),
       1
     ) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A renovação automática só vale para plano mensal';
  END IF;

  UPDATE public.assessment_contracts
  SET auto_renewal = p_auto_renewal,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'auto_renewal_changed',
    jsonb_build_object('enabled', p_auto_renewal),
    CASE WHEN p_auto_renewal
      THEN 'Renovação automática ativada'
      ELSE 'Renovação automática desativada' END,
    p_actor_id
  );
  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

REVOKE ALL ON FUNCTION public.set_assessment_contract_auto_renewal(
  uuid, boolean, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_assessment_contract_auto_renewal(
  uuid, boolean, timestamptz, uuid
) TO service_role;

-- 7. Rotina diária: manual entra em "Enviar mensagem"; só a mensal automática ---------
--    vai direto para "Aguardando pagamento" (a etapa vem do gatilho de entrada).

CREATE OR REPLACE FUNCTION eon_private.process_internal_assessment_renewals(
  p_horizon_days integer,
  p_auto_horizon_days integer,
  p_contract_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_forced boolean := COALESCE(array_length(p_contract_ids, 1), 0) > 0;
  v_parent public.assessment_contracts%ROWTYPE;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_snapshot jsonb;
  v_months integer;
  v_start date;
  v_target_month date;
  v_end date;
  v_due_date date;
  v_new_status text;
  v_previous_parent_status text;
  v_is_auto boolean;
  v_discount_recurring boolean;
  v_created_count integer := 0;
  v_draft_count integer := 0;
  v_auto_scheduled_count integer := 0;
  v_auto_activated_count integer := 0;
  v_existing_auto_approved_count integer := 0;
  v_scheduled_activated_count integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
BEGIN
  IF p_horizon_days IS NULL OR p_horizon_days < 1 OR p_horizon_days > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'A janela de renovação deve ficar entre 1 e 90 dias';
  END IF;
  IF p_auto_horizon_days IS NULL OR p_auto_horizon_days < 1
     OR p_auto_horizon_days > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'A janela automática deve ficar entre 1 e 90 dias';
  END IF;

  -- Scheduled renewals must become active without depending on an operator
  -- opening a page. The parent term ends in the same transaction.
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts AS renewal
    JOIN public.assessment_contracts AS parent
      ON parent.id = renewal.parent_contract_id
    WHERE renewal.parent_contract_id IS NOT NULL
      AND renewal.status = 'scheduled'
      AND renewal.start_date <= v_today
      AND parent.status IN ('active', 'overdue', 'on_leave', 'finished')
      AND parent.scheduled_cancellation_date IS NULL
      AND parent.cancellation_date IS NULL
      AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
      AND (NOT renewal.auto_renewal OR parent.auto_renewal)
    ORDER BY renewal.start_date, renewal.created_at
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    SELECT * INTO v_parent
    FROM public.assessment_contracts
    WHERE id = v_renewal.parent_contract_id
    FOR UPDATE;

    IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished')
       OR v_parent.scheduled_cancellation_date IS NOT NULL
       OR v_parent.cancellation_date IS NOT NULL
       OR NULLIF(btrim(v_parent.cancellation_reason), '') IS NOT NULL
       OR (v_renewal.auto_renewal AND NOT v_parent.auto_renewal) THEN
      CONTINUE;
    END IF;

    v_previous_parent_status := v_parent.status;

    UPDATE public.assessment_contracts
    SET status = 'active',
        updated_at = now()
    WHERE id = v_renewal.id
    RETURNING * INTO v_renewal;

    UPDATE public.assessment_contracts
    SET renewal_generated = true,
        status = CASE
          WHEN status IN ('active', 'overdue', 'on_leave') THEN 'finished'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_parent.id
    RETURNING * INTO v_parent;

    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes
    ) VALUES (
      v_renewal.id,
      'status_transitioned',
      jsonb_build_object(
        'status_before', 'scheduled',
        'status_after', 'active',
        'effective_date', v_today,
        'source', 'internal_renewal_job'
      ),
      'Renovação ativada automaticamente no início da vigência.'
    );

    IF v_parent.status IS DISTINCT FROM v_previous_parent_status THEN
      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, notes
      ) VALUES (
        v_parent.id,
        'status_transitioned',
        jsonb_build_object(
          'status_before', v_previous_parent_status,
          'status_after', v_parent.status,
          'effective_date', v_today,
          'reason', 'renewal_started',
          'renewal_contract_id', v_renewal.id,
          'source', 'internal_renewal_job'
        ),
        'Contrato concluído automaticamente pelo início da renovação.'
      );
    END IF;

    v_scheduled_activated_count := v_scheduled_activated_count + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'action', 'scheduled_renewal_activated',
      'parent_id', v_parent.id,
      'parent_number', v_parent.contract_number,
      'renewal_id', v_renewal.id,
      'renewal_number', v_renewal.contract_number,
      'status', v_renewal.status,
      'payment_status', v_renewal.payment_status
    ));
  END LOOP;

  -- Drafts created by the previous implementation are approved only when both
  -- the parent and the draft still opt into automatic renewal.
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts AS renewal
    JOIN public.assessment_contracts AS parent
      ON parent.id = renewal.parent_contract_id
    WHERE renewal.status = 'draft'
      AND renewal.auto_renewal
      AND COALESCE(eon_private.assessment_contract_period_months(renewal.plan_id, renewal.plan_snapshot), 1) = 1
      AND renewal.start_date <= v_today + p_auto_horizon_days
      AND renewal.payment_status IN ('pending', 'awaiting_charge')
      AND NOT COALESCE(renewal.manual_payment, false)
      AND renewal.payment_date IS NULL
      AND COALESCE(renewal.refund_amount, 0) = 0
      AND renewal.refund_status IS NULL
      AND NULLIF(renewal.asaas_charge_id, '') IS NULL
      AND NULLIF(renewal.asaas_payment_link, '') IS NULL
      AND NULLIF(renewal.asaas_pix_copy, '') IS NULL
      AND NULLIF(renewal.asaas_pix_qrcode, '') IS NULL
      AND NULLIF(renewal.external_payment_link, '') IS NULL
      AND parent.auto_renewal
      AND parent.status IN ('active', 'overdue', 'on_leave', 'finished')
      AND parent.scheduled_cancellation_date IS NULL
      AND parent.cancellation_date IS NULL
      AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
    ORDER BY renewal.start_date, renewal.created_at
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    SELECT * INTO v_parent
    FROM public.assessment_contracts
    WHERE id = v_renewal.parent_contract_id
    FOR UPDATE;

    IF NOT v_parent.auto_renewal
       OR v_parent.scheduled_cancellation_date IS NOT NULL
       OR v_parent.cancellation_date IS NOT NULL
       OR NULLIF(btrim(v_parent.cancellation_reason), '') IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_new_status := CASE
      WHEN v_renewal.start_date > v_today THEN 'scheduled'
      ELSE 'active'
    END;
    v_previous_parent_status := v_parent.status;

    UPDATE public.assessment_contracts
    SET status = v_new_status,
        due_date = GREATEST(start_date, v_today),
        updated_at = now()
    WHERE id = v_renewal.id
    RETURNING * INTO v_renewal;

    UPDATE public.assessment_contracts
    SET renewal_generated = true,
        status = CASE
          WHEN v_new_status = 'active'
            AND status IN ('active', 'overdue', 'on_leave') THEN 'finished'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_parent.id
    RETURNING * INTO v_parent;

    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes
    ) VALUES (
      v_renewal.id,
      CASE WHEN v_new_status = 'scheduled'
        THEN 'renewal_scheduled' ELSE 'renewal_activated' END,
      jsonb_build_object(
        'parent_contract_id', v_parent.id,
        'parent_contract_number', v_parent.contract_number,
        'status_after', v_new_status,
        'payment_status_after', v_renewal.payment_status,
        'start_date', v_renewal.start_date,
        'automatic', true,
        'source', 'internal_renewal_job'
      ),
      CASE WHEN v_new_status = 'scheduled'
        THEN 'Rascunho aprovado e agendado pela renovação automática interna.'
        ELSE 'Rascunho ativado pela renovação automática interna.' END
    ), (
      v_parent.id,
      'renewed',
      jsonb_build_object(
        'new_contract_id', v_renewal.id,
        'new_contract_number', v_renewal.contract_number,
        'new_start', v_renewal.start_date,
        'new_end', v_renewal.end_date,
        'new_status', v_new_status,
        'automatic', true,
        'source', 'internal_renewal_job'
      ),
      'Renovação automática interna confirmada.'
    );

    IF v_parent.status IS DISTINCT FROM v_previous_parent_status THEN
      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, notes
      ) VALUES (
        v_parent.id,
        'status_transitioned',
        jsonb_build_object(
          'status_before', v_previous_parent_status,
          'status_after', v_parent.status,
          'effective_date', v_today,
          'reason', 'renewal_started',
          'renewal_contract_id', v_renewal.id,
          'source', 'internal_renewal_job'
        ),
        'Contrato concluído automaticamente pelo início da renovação.'
      );
    END IF;

    v_existing_auto_approved_count := v_existing_auto_approved_count + 1;
    IF v_new_status = 'scheduled' THEN
      v_auto_scheduled_count := v_auto_scheduled_count + 1;
    ELSE
      v_auto_activated_count := v_auto_activated_count + 1;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'action', 'automatic_draft_approved',
      'parent_id', v_parent.id,
      'parent_number', v_parent.contract_number,
      'renewal_id', v_renewal.id,
      'renewal_number', v_renewal.contract_number,
      'status', v_renewal.status,
      'payment_status', v_renewal.payment_status,
      'new_start', v_renewal.start_date,
      'new_end', v_renewal.end_date
    ));
  END LOOP;

  FOR v_parent IN
    SELECT parent.*
    FROM public.assessment_contracts AS parent
    WHERE parent.status IN ('active', 'overdue', 'on_leave')
      AND NOT COALESCE(parent.renewal_generated, false)
      AND parent.scheduled_cancellation_date IS NULL
      AND parent.cancellation_date IS NULL
      AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.assessment_contracts AS child
        WHERE child.parent_contract_id = parent.id
          AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
      )
      AND (
        (v_forced AND parent.id = ANY(p_contract_ids))
        OR (
          NOT v_forced
          AND (
            (
              NOT (
                parent.auto_renewal
                AND COALESCE(eon_private.assessment_contract_period_months(parent.plan_id, parent.plan_snapshot), 1) = 1
              )
              AND parent.end_date <= v_today + p_horizon_days
            )
            OR (
              parent.auto_renewal
              AND COALESCE(eon_private.assessment_contract_period_months(parent.plan_id, parent.plan_snapshot), 1) = 1
              AND parent.end_date <= v_today + p_auto_horizon_days
            )
          )
        )
      )
    ORDER BY parent.end_date, parent.created_at
    FOR UPDATE OF parent SKIP LOCKED
  LOOP
    BEGIN
      SELECT * INTO v_plan
      FROM public.assessment_plans
      WHERE id = v_parent.plan_id;

      IF v_parent.plan_snapshot IS NULL AND NOT FOUND THEN
        RAISE EXCEPTION 'Plano do contrato não encontrado';
      END IF;

      v_months := COALESCE(
        CASE
          WHEN COALESCE(v_parent.plan_snapshot->>'period_months', '') ~ '^[0-9]+$'
            THEN (v_parent.plan_snapshot->>'period_months')::integer
          ELSE NULL
        END,
        v_plan.period_months,
        CASE COALESCE(v_parent.plan_snapshot->>'period', v_plan.period)
          WHEN 'mensal' THEN 1
          WHEN 'trimestral' THEN 3
          WHEN 'semestral' THEN 6
          WHEN 'anual' THEN 12
          ELSE 1
        END
      );
      IF v_months < 1 OR v_months > 120 THEN
        RAISE EXCEPTION 'Período do plano inválido';
      END IF;

      IF v_parent.plan_snapshot IS NOT NULL THEN
        v_snapshot := v_parent.plan_snapshot || jsonb_build_object(
          'snapshot_at', now(),
          'snapshot_source', 'renewal_parent_snapshot'
        );
      ELSE
        v_snapshot := jsonb_build_object(
          'plan_id', v_plan.id,
          'name', v_plan.name,
          'modality_id', v_plan.modality_id,
          'price_total', v_plan.price_total,
          'price_monthly', v_plan.price_monthly,
          'enrollment_fee', v_plan.enrollment_fee,
          'max_installments', v_plan.max_installments,
          'period_months', v_plan.period_months,
          'period', v_plan.period,
          'revenue_center_id', v_plan.revenue_center_id,
          'snapshot_at', now(),
          'snapshot_source', 'renewal_plan_fallback'
        );
      END IF;

      v_start := v_parent.end_date;
      v_target_month := (
        date_trunc('month', v_start)::date + make_interval(months => v_months)
      )::date;
      v_end := v_target_month + (
        LEAST(
          extract(day FROM v_start)::integer,
          extract(day FROM (v_target_month + interval '1 month - 1 day'))::integer
        ) - 1
      );
      v_due_date := GREATEST(v_start, v_today);
      -- Só o plano mensal renova sozinho (assinatura que já existe no Asaas);
      -- trimestral e semestral seguem o fluxo manual do quadro.
      v_is_auto := v_parent.auto_renewal AND v_months = 1;
      v_new_status := CASE
        WHEN NOT v_is_auto THEN 'draft'
        WHEN v_start > v_today THEN 'scheduled'
        ELSE 'active'
      END;
      v_discount_recurring := COALESCE(v_parent.discount_recurring, false)
        AND COALESCE(v_parent.manual_discount, 0) > 0;

      INSERT INTO public.assessment_contracts (
        customer_id, coach_id, plan_id, plan_snapshot, status,
        start_date, end_date, original_end_date, due_date, installments,
        enrollment_fee, manual_discount, discount_reason, discount_recurring,
        payment_status, payment_method, auto_renewal, parent_contract_id, notes
      ) VALUES (
        v_parent.customer_id,
        v_parent.coach_id,
        v_parent.plan_id,
        v_snapshot,
        v_new_status,
        v_start,
        v_end,
        v_end,
        v_due_date,
        COALESCE(v_parent.installments, 1),
        0,
        CASE WHEN v_discount_recurring THEN v_parent.manual_discount ELSE 0 END,
        CASE WHEN v_discount_recurring THEN v_parent.discount_reason ELSE NULL END,
        v_discount_recurring,
        'pending',
        v_parent.payment_method,
        v_is_auto,
        v_parent.id,
        CASE WHEN v_is_auto
          THEN 'Renovação automática interna de ' || COALESCE(v_parent.contract_number, v_parent.id::text)
          ELSE 'Rascunho de renovação de ' || COALESCE(v_parent.contract_number, v_parent.id::text)
        END
      )
      RETURNING * INTO v_renewal;

      v_previous_parent_status := v_parent.status;
      UPDATE public.assessment_contracts
      SET renewal_generated = true,
          status = CASE
            WHEN v_new_status = 'active' THEN 'finished'
            ELSE status
          END,
          updated_at = now()
      WHERE id = v_parent.id
      RETURNING * INTO v_parent;

      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, notes
      ) VALUES (
        v_renewal.id,
        'created',
        jsonb_build_object(
          'via', CASE WHEN v_is_auto
            THEN 'automatic_renewal' ELSE 'renewal_draft' END,
          'parent_contract_id', v_parent.id,
          'parent_contract_num', v_parent.contract_number,
          'plan_id', v_parent.plan_id,
          'installments', v_parent.installments,
          'due_date', v_due_date,
          'status_after', v_new_status,
          'payment_status_after', v_renewal.payment_status,
          'automatic', v_is_auto
        ),
        CASE WHEN v_is_auto
          THEN 'Renovação automática interna criada.'
          ELSE 'Rascunho de renovação criado automaticamente.' END
      );

      IF v_is_auto THEN
        INSERT INTO public.assessment_contract_event(
          contract_id, event_type, payload, notes
        ) VALUES (
          v_renewal.id,
          CASE WHEN v_new_status = 'scheduled'
            THEN 'renewal_scheduled' ELSE 'renewal_activated' END,
          jsonb_build_object(
            'parent_contract_id', v_parent.id,
            'parent_contract_number', v_parent.contract_number,
            'status_after', v_new_status,
            'payment_status_after', v_renewal.payment_status,
            'start_date', v_start,
            'automatic', true,
            'source', 'internal_renewal_job'
          ),
          CASE WHEN v_new_status = 'scheduled'
            THEN 'Renovação automática interna agendada.'
            ELSE 'Renovação automática interna ativada.' END
        ), (
          v_parent.id,
          'renewed',
          jsonb_build_object(
            'new_contract_id', v_renewal.id,
            'new_contract_number', v_renewal.contract_number,
            'new_start', v_start,
            'new_end', v_end,
            'new_status', v_new_status,
            'payment_status', v_renewal.payment_status,
            'automatic', true,
            'source', 'internal_renewal_job'
          ),
          'Renovação automática interna registrada.'
        );
      ELSE
        INSERT INTO public.assessment_contract_event(
          contract_id, event_type, payload, notes
        ) VALUES (
          v_parent.id,
          'renewal_drafted',
          jsonb_build_object(
            'draft_contract_id', v_renewal.id,
            'draft_contract_number', v_renewal.contract_number,
            'draft_start', v_start,
            'draft_end', v_end,
            'draft_due_date', v_due_date,
            'auto_generated', true,
            'horizon_days', p_horizon_days
          ),
          'Rascunho de renovação gerado automaticamente. Aguardando revisão.'
        );
      END IF;

      IF v_parent.status IS DISTINCT FROM v_previous_parent_status THEN
        INSERT INTO public.assessment_contract_event(
          contract_id, event_type, payload, notes
        ) VALUES (
          v_parent.id,
          'status_transitioned',
          jsonb_build_object(
            'status_before', v_previous_parent_status,
            'status_after', v_parent.status,
            'effective_date', v_today,
            'reason', 'renewal_started',
            'renewal_contract_id', v_renewal.id,
            'source', 'internal_renewal_job'
          ),
          'Contrato concluído automaticamente pelo início da renovação.'
        );
      END IF;

      v_created_count := v_created_count + 1;
      IF NOT v_is_auto THEN
        v_draft_count := v_draft_count + 1;
      ELSIF v_new_status = 'scheduled' THEN
        v_auto_scheduled_count := v_auto_scheduled_count + 1;
      ELSE
        v_auto_activated_count := v_auto_activated_count + 1;
      END IF;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'action', CASE WHEN v_is_auto
          THEN 'automatic_renewal_created' ELSE 'renewal_draft_created' END,
        'parent_id', v_parent.id,
        'parent_number', v_parent.contract_number,
        'renewal_id', v_renewal.id,
        'renewal_number', v_renewal.contract_number,
        'status', v_renewal.status,
        'payment_status', v_renewal.payment_status,
        'new_start', v_start,
        'new_end', v_end,
        'due_date', v_due_date
      ));
    EXCEPTION
      WHEN unique_violation THEN
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'contract_id', v_parent.id,
          'contract_number', v_parent.contract_number,
          'error', 'Já existe uma renovação aberta para este contrato'
        ));
      WHEN OTHERS THEN
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'contract_id', v_parent.id,
          'contract_number', v_parent.contract_number,
          'error', SQLERRM
        ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'processed', v_created_count + v_existing_auto_approved_count
      + v_scheduled_activated_count,
    'contracts_created', v_created_count,
    'drafts_created', v_draft_count,
    'automatic_renewals_scheduled', v_auto_scheduled_count,
    'automatic_renewals_activated', v_auto_activated_count,
    'automatic_drafts_approved', v_existing_auto_approved_count,
    'scheduled_renewals_activated', v_scheduled_activated_count,
    'results', v_results,
    'errors', v_errors,
    'message', CASE
      WHEN v_created_count + v_existing_auto_approved_count
           + v_scheduled_activated_count = 0
        THEN 'Nenhum contrato dentro da janela de renovação.'
      ELSE NULL
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION eon_private.process_internal_assessment_renewals(
  integer, integer, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.process_internal_assessment_renewals(
  integer, integer, uuid[]
) TO service_role;

-- 8. Ações do quadro (mensagem, resposta, follow-up, alteração resolvida) ----------------

-- "Não vou renovar" continua pela janela segura de renovação (que cuida da
-- cobrança, do repasse e do contrato anterior) e o pagamento continua pelo
-- registro de pagamento; a etapa acompanha os dois pelo gatilho acima.
CREATE OR REPLACE FUNCTION public.transition_assessment_renewal_stage(
  p_contract_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_actor_id uuid,
  p_response_code text DEFAULT NULL,
  p_follow_up_at date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_operation public.order_operations%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_now timestamptz := now();
  v_notes text := NULLIF(btrim(p_notes), '');
  v_message text := NULLIF(btrim(p_message), '');
  v_stage_before text;
  v_stage_after text;
  v_event_type text;
  v_event_note text;
  v_result jsonb;
BEGIN
  IF p_contract_id IS NULL OR p_actor_id IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da renovação são inválidos';
  END IF;
  IF p_action IS NULL OR p_action NOT IN (
    'message_sent', 'register_response', 'set_follow_up', 'change_resolved'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Ação de renovação inválida';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A observação deve ter até 500 caracteres';
  END IF;
  IF v_message IS NOT NULL AND char_length(v_message) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A mensagem deve ter até 4000 caracteres';
  END IF;
  IF p_follow_up_at IS NOT NULL
     AND (p_follow_up_at < v_today OR p_follow_up_at > v_today + 365) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um follow-up a partir de hoje';
  END IF;

  IF p_action = 'register_response' THEN
    IF p_response_code IS NULL OR p_response_code NOT IN (
      'will_renew', 'thinking', 'change_plan_or_coach', 'needs_agent', 'not_renewing'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resposta de renovação inválida';
    END IF;
    IF p_response_code = 'not_renewing' THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'Para "Não vou renovar", use o encerramento da renovação';
    END IF;
    IF p_response_code = 'will_renew' AND p_follow_up_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'O follow-up só vale enquanto o atleta decide';
    END IF;
  ELSIF p_response_code IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A resposta só vale ao registrar a resposta';
  END IF;
  IF p_action = 'change_resolved' AND p_follow_up_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'O follow-up só vale enquanto o atleta decide';
  END IF;
  IF p_action <> 'message_sent' AND v_message IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O texto da mensagem só vale ao registrar o envio';
  END IF;
  IF p_action IN ('message_sent', 'set_follow_up') AND v_notes IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Observação não é aceita nesta ação';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Renovação não encontrada';
  END IF;
  IF v_contract.parent_contract_id IS NULL OR v_contract.renewal_stage IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não é uma renovação';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'renewal_stage'
    AND order_type = 'contract'
    AND order_id = p_contract_id
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.payload->>'action' IS DISTINCT FROM p_action THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'A chave de idempotência já foi usada em outra ação';
    END IF;
    IF v_operation.status = 'completed' AND v_operation.result IS NOT NULL THEN
      RETURN v_operation.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta ação ainda está em processamento';
  END IF;

  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A renovação foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;

  v_stage_before := v_contract.renewal_stage;

  IF p_action = 'message_sent' THEN
    IF v_stage_before NOT IN ('contact_pending', 'waiting_response') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'A mensagem de renovação só pode ser registrada antes da decisão do atleta';
    END IF;
    v_stage_after := 'waiting_response';
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage_after,
        renewal_stage_updated_at = CASE
          WHEN v_stage_before <> v_stage_after THEN v_now
          ELSE renewal_stage_updated_at
        END,
        renewal_last_contact_at = v_now,
        renewal_follow_up_at = p_follow_up_at,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_message_sent';
    v_event_note := CASE
      WHEN v_stage_before = 'contact_pending' THEN 'Mensagem de intenção de renovação enviada.'
      ELSE 'Nova mensagem de renovação enviada.'
    END;
  ELSIF p_action = 'register_response' THEN
    IF v_stage_before NOT IN ('contact_pending', 'waiting_response') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'A resposta do atleta só pode ser registrada antes da cobrança';
    END IF;
    v_stage_after := CASE
      WHEN p_response_code = 'will_renew' THEN 'charge_pending'
      ELSE 'waiting_response'
    END;
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage_after,
        renewal_stage_updated_at = CASE
          WHEN v_stage_before <> v_stage_after THEN v_now
          ELSE renewal_stage_updated_at
        END,
        renewal_response_code = p_response_code,
        renewal_response_at = v_now,
        renewal_last_contact_at = v_now,
        renewal_follow_up_at = CASE
          WHEN v_stage_after = 'waiting_response' THEN p_follow_up_at
          ELSE NULL
        END,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_response_recorded';
    v_event_note := 'Resposta registrada: ' || CASE p_response_code
      WHEN 'will_renew' THEN 'vai renovar.'
      WHEN 'thinking' THEN 'ainda está pensando.'
      WHEN 'change_plan_or_coach' THEN 'quer mudar de plano/treinador.'
      ELSE 'quer falar com um atendente.'
    END;
  ELSIF p_action = 'set_follow_up' THEN
    IF v_stage_before <> 'waiting_response' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'O follow-up só vale enquanto a renovação aguarda a decisão do atleta';
    END IF;
    v_stage_after := v_stage_before;
    UPDATE public.assessment_contracts
    SET renewal_follow_up_at = p_follow_up_at,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_follow_up_set';
    v_event_note := CASE
      WHEN p_follow_up_at IS NULL THEN 'Follow-up removido.'
      ELSE 'Follow-up marcado para ' || to_char(p_follow_up_at, 'DD/MM/YYYY') || '.'
    END;
  ELSE
    IF v_stage_before <> 'waiting_response'
       OR v_contract.renewal_response_code IS DISTINCT FROM 'change_plan_or_coach' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Não há mudança de plano ou treinador pendente nesta renovação';
    END IF;
    v_stage_after := 'charge_pending';
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage_after,
        renewal_stage_updated_at = v_now,
        renewal_follow_up_at = NULL,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_change_resolved';
    v_event_note := 'Mudança de plano/treinador resolvida: renovação segue para cobrança.';
  END IF;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    v_event_type,
    jsonb_build_object(
      'action', p_action,
      'source', 'renewal_pipeline',
      'stage_before', v_stage_before,
      'stage_after', v_stage_after,
      'response_code', p_response_code,
      'follow_up_at', p_follow_up_at,
      'notes', v_notes,
      'message', v_message,
      'channel', CASE WHEN p_action = 'message_sent' THEN 'whatsapp' END,
      'idempotency_key', p_idempotency_key
    ),
    v_event_note,
    p_actor_id
  );

  v_result := jsonb_build_object(
    'status', 'completed',
    'action', p_action,
    'stage_before', v_stage_before,
    'stage_after', v_stage_after,
    'contract', to_jsonb(v_contract)
  );
  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, result
  ) VALUES (
    'renewal_stage', p_idempotency_key, 'contract', v_contract.id, 'completed',
    p_actor_id, 'Etapa da renovação: ' || p_action,
    jsonb_build_object(
      'action', p_action,
      'expected_updated_at', p_expected_updated_at,
      'response_code', p_response_code,
      'follow_up_at', p_follow_up_at
    ),
    v_result
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, timestamptz, text, uuid, text, date, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, timestamptz, text, uuid, text, date, text, text
) TO service_role;

COMMENT ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, timestamptz, text, uuid, text, date, text, text
) IS
  'Ações do quadro de Renovações (mensagem enviada, resposta, follow-up, mudança resolvida), com versão, idempotência e histórico. Só o servidor chama.';

-- 9. Conferência do quadro ----------------------------------------------------------------

-- Situações que precisam de conferência humana. Nada aqui é corrigido sozinho.
CREATE OR REPLACE VIEW public.assessment_renewal_pipeline_issues
WITH (security_invoker = true)
AS
WITH params AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
),
contracts AS (
  SELECT contract.*,
    COALESCE(
      CASE
        WHEN COALESCE(contract.plan_snapshot->>'period_months', '') ~ '^[0-9]+$'
          THEN (contract.plan_snapshot->>'period_months')::integer
      END,
      plan.period_months,
      CASE COALESCE(contract.plan_snapshot->>'period', plan.period)
        WHEN 'mensal' THEN 1
        WHEN 'trimestral' THEN 3
        WHEN 'semestral' THEN 6
        WHEN 'anual' THEN 12
      END,
      1
    ) AS period_months
  FROM public.assessment_contracts AS contract
  LEFT JOIN public.assessment_plans AS plan ON plan.id = contract.plan_id
)
SELECT child.id AS contract_id, child.contract_number, child.customer_id,
       child.parent_contract_id, 'paid_but_open_stage'::text AS issue_code,
       'Pagamento confirmado, mas a renovação não está em Renovou'::text AS issue_label,
       jsonb_build_object('renewal_stage', child.renewal_stage, 'payment_status', child.payment_status) AS details
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage IN ('contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment')
  AND child.payment_status = 'paid'
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'renewed_without_payment',
       'Renovação marcada como Renovou sem pagamento confirmado',
       jsonb_build_object('payment_status', child.payment_status, 'status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage = 'renewed'
  AND child.payment_status NOT IN ('paid', 'refunded', 'partially_refunded')
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'stage_behind_open_sale',
       'Venda já aberta no Financeiro, mas a renovação está antes da cobrança',
       jsonb_build_object('renewal_stage', child.renewal_stage, 'status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage IN ('contact_pending', 'waiting_response', 'charge_pending')
  AND child.status NOT IN ('draft', 'voided', 'cancelled')
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'waiting_payment_without_open_sale',
       'Aguardando pagamento, mas a venda ainda é rascunho',
       jsonb_build_object('status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage = 'waiting_payment'
  AND child.status = 'draft'
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'mixed_charge',
       'Renovação com cobrança Asaas e cobrança externa ao mesmo tempo',
       jsonb_build_object('renewal_stage', child.renewal_stage)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage IN ('contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment')
  AND NULLIF(child.asaas_charge_id, '') IS NOT NULL
  AND (NULLIF(child.external_payment_link, '') IS NOT NULL
       OR NULLIF(child.external_invoice_number, '') IS NOT NULL)
UNION ALL
SELECT parent.id, parent.contract_number, parent.customer_id, NULL::uuid,
       CASE WHEN parent.end_date < params.today
         THEN 'expired_without_renewal' ELSE 'renewal_not_created' END,
       CASE WHEN parent.end_date < params.today
         THEN 'Contrato venceu sem renovação no quadro'
         ELSE 'Renovação deveria estar no quadro e ainda não foi criada' END,
       jsonb_build_object(
         'end_date', parent.end_date,
         'auto_renewal', parent.auto_renewal AND parent.period_months = 1
       )
FROM contracts AS parent
CROSS JOIN params
WHERE parent.status IN ('active', 'overdue', 'on_leave')
  AND NOT COALESCE(parent.renewal_generated, false)
  AND parent.scheduled_cancellation_date IS NULL
  AND parent.cancellation_date IS NULL
  AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
  AND parent.end_date <= params.today + CASE
    WHEN parent.auto_renewal AND parent.period_months = 1 THEN 4
    ELSE 9
  END
  AND NOT EXISTS (
    SELECT 1 FROM public.assessment_contracts AS child
    WHERE child.parent_contract_id = parent.id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  )
UNION ALL
SELECT contract.id, contract.contract_number, contract.customer_id, contract.parent_contract_id,
       'non_monthly_auto_renewal',
       'Renovação automática ligada em plano que não é mensal',
       jsonb_build_object('period_months', contract.period_months)
FROM contracts AS contract
WHERE contract.auto_renewal
  AND contract.period_months <> 1
  AND contract.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave');

REVOKE ALL ON public.assessment_renewal_pipeline_issues FROM PUBLIC, anon;
GRANT SELECT ON public.assessment_renewal_pipeline_issues TO authenticated, service_role;

COMMENT ON VIEW public.assessment_renewal_pipeline_issues IS
  'Renovações que precisam de conferência (etapa x pagamento, renovação que não entrou no quadro, automática em plano não mensal). Respeita o RLS de admin.';

-- 10. Mensagem de intenção (Pebinha) ---------------------------------------------------------

UPDATE public.communication_rules
SET name = 'Intenção de renovação',
    days_offset = -10,
    message_template = $tpl$Oi, {nome}! Tudo bem?

Sou o Pebinha, assistente virtual da EON. Estou aqui pra te lembrar que {aviso_vencimento}.

Pra ajudar nosso time nesse processo, você gostaria de realizar a renovação?

1. Sim, vou renovar.
2. Ainda estou pensando.
3. Gostaria de mudar de plano/treinador.
4. Gostaria de falar com um atendente.
5. Não vou renovar.$tpl$,
    updated_at = now()
WHERE slug = 'renewal-reminder-14d'
  AND task_kind = 'renewal_reminder';

-- 11. Etapa inicial das renovações que já existem ---------------------------------------------

CREATE TABLE IF NOT EXISTS eon_private.assessment_renewal_stage_backfill (
  contract_id uuid PRIMARY KEY,
  previous jsonb NOT NULL,
  assigned_stage text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE eon_private.assessment_renewal_stage_backfill
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE eon_private.assessment_renewal_stage_backfill IS
  'Cópia do estado de cada renovação antes de receber a etapa inicial do quadro, com a etapa atribuída e a evidência usada.';

-- Idempotente: só toca renovações ainda sem etapa. Sem evidência confiável,
-- fica na etapa anterior/mais segura; nunca inventa resposta do atleta.
CREATE OR REPLACE FUNCTION eon_private.backfill_assessment_renewal_stages()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_row record;
  v_stage text;
  v_resolved_at timestamptz;
  v_last_contact timestamptz;
  v_evidence jsonb;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  FOR v_row IN
    SELECT child.*,
      parent.cancellation_reason AS parent_cancellation_reason,
      (
        SELECT max(event.created_at)
        FROM public.assessment_contract_event AS event
        WHERE event.event_type = 'renewal_message_sent'
          AND (
            event.contract_id = child.id
            OR (event.contract_id = child.parent_contract_id
                AND event.created_at >= child.created_at)
          )
      ) AS message_sent_at,
      (
        SELECT operation.id
        FROM public.order_operations AS operation
        WHERE operation.operation_type = 'resolve_renewal'
          AND operation.order_type = 'contract'
          AND operation.order_id = child.id
          AND operation.status = 'completed'
          AND operation.payload->>'resolution' = 'non_renewal'
        ORDER BY operation.updated_at DESC
        LIMIT 1
      ) AS non_renewal_operation_id,
      (
        SELECT max(event.created_at)
        FROM public.assessment_contract_event AS event
        WHERE event.contract_id = child.id
          AND event.event_type = 'sale_voided'
      ) AS voided_at,
      (
        SELECT max(event.created_at)
        FROM public.assessment_contract_event AS event
        WHERE event.contract_id = child.id
          AND event.event_type = 'manual_payment_recorded'
      ) AS payment_recorded_at
    FROM public.assessment_contracts AS child
    LEFT JOIN public.assessment_contracts AS parent ON parent.id = child.parent_contract_id
    WHERE child.parent_contract_id IS NOT NULL
      AND child.renewal_stage IS NULL
    ORDER BY child.created_at, child.id
    FOR UPDATE OF child
  LOOP
    v_resolved_at := NULL;
    v_last_contact := NULL;
    IF v_row.payment_status IN ('paid', 'refunded', 'partially_refunded') THEN
      v_stage := 'renewed';
      v_resolved_at := COALESCE(
        CASE
          WHEN v_row.payment_date IS NOT NULL THEN LEAST(
            v_now,
            (v_row.payment_date + time '12:00') AT TIME ZONE 'America/Sao_Paulo'
          )
        END,
        v_row.payment_recorded_at,
        v_row.updated_at,
        v_now
      );
      v_evidence := jsonb_build_object(
        'rule', 'payment_confirmed',
        'payment_date', v_row.payment_date
      );
    ELSIF v_row.status = 'voided' THEN
      IF v_row.non_renewal_operation_id IS NOT NULL
         OR lower(COALESCE(v_row.parent_cancellation_reason, '')) ~
           '(não renovou|nao renovou|não vai renovar|nao vai renovar)' THEN
        v_stage := 'not_renewed';
        v_evidence := jsonb_build_object(
          'rule', 'non_renewal_recorded',
          'operation_id', v_row.non_renewal_operation_id,
          'parent_reason', v_row.parent_cancellation_reason
        );
      ELSE
        v_stage := 'discarded';
        v_evidence := jsonb_build_object(
          'rule', 'voided_without_exit',
          'cancellation_reason', v_row.cancellation_reason
        );
      END IF;
      v_resolved_at := COALESCE(v_row.voided_at, v_row.updated_at, v_now);
    ELSIF v_row.status = 'cancelled' THEN
      v_stage := 'discarded';
      v_resolved_at := COALESCE(v_row.updated_at, v_now);
      v_evidence := jsonb_build_object('rule', 'contract_cancelled_unpaid');
    ELSIF v_row.status = 'draft' THEN
      IF v_row.message_sent_at IS NOT NULL THEN
        v_stage := 'waiting_response';
        v_last_contact := v_row.message_sent_at;
        v_evidence := jsonb_build_object(
          'rule', 'renewal_message_sent',
          'message_sent_at', v_row.message_sent_at
        );
      ELSE
        v_stage := 'contact_pending';
        v_evidence := jsonb_build_object('rule', 'draft_without_message');
      END IF;
    ELSE
      v_stage := 'waiting_payment';
      v_evidence := jsonb_build_object(
        'rule', 'open_sale',
        'status', v_row.status,
        'payment_status', v_row.payment_status,
        'automatic', v_row.auto_renewal,
        'has_charge', (
          NULLIF(v_row.asaas_charge_id, '') IS NOT NULL
          OR NULLIF(v_row.asaas_payment_link, '') IS NOT NULL
          OR NULLIF(v_row.asaas_pix_copy, '') IS NOT NULL
          OR NULLIF(v_row.external_payment_link, '') IS NOT NULL
          OR NULLIF(v_row.external_invoice_number, '') IS NOT NULL
        )
      );
    END IF;

    INSERT INTO eon_private.assessment_renewal_stage_backfill (
      contract_id, previous, assigned_stage, evidence
    ) VALUES (
      v_row.id,
      jsonb_build_object(
        'contract_number', v_row.contract_number,
        'parent_contract_id', v_row.parent_contract_id,
        'status', v_row.status,
        'payment_status', v_row.payment_status,
        'payment_date', v_row.payment_date,
        'auto_renewal', v_row.auto_renewal,
        'start_date', v_row.start_date,
        'end_date', v_row.end_date,
        'payment_message_sent_at', v_row.payment_message_sent_at,
        'created_at', v_row.created_at,
        'updated_at', v_row.updated_at
      ),
      v_stage,
      v_evidence
    )
    ON CONFLICT (contract_id) DO NOTHING;

    -- Sem mexer em updated_at: telas abertas durante a publicação não perdem
    -- a versão que já carregaram.
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage,
        renewal_entered_at = COALESCE(v_row.created_at, v_now),
        renewal_stage_updated_at = COALESCE(v_resolved_at, v_now),
        renewal_resolved_at = v_resolved_at,
        renewal_last_contact_at = v_last_contact
    WHERE id = v_row.id;

    IF v_stage IN ('contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment') THEN
      INSERT INTO public.assessment_contract_event (
        contract_id, event_type, payload, notes, created_by
      ) VALUES (
        v_row.id,
        'renewal_pipeline_entered',
        jsonb_build_object('stage_after', v_stage, 'source', 'backfill', 'evidence', v_evidence),
        'Etapa inicial no quadro de Renovações definida pela implantação do quadro.',
        NULL
      );
    END IF;

    v_counts := jsonb_set(
      v_counts,
      ARRAY[v_stage],
      to_jsonb(COALESCE((v_counts->>v_stage)::integer, 0) + 1)
    );
  END LOOP;

  RETURN v_counts;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.backfill_assessment_renewal_stages()
  FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_counts jsonb;
BEGIN
  v_counts := eon_private.backfill_assessment_renewal_stages();
  RAISE NOTICE 'Etapas iniciais das renovações: %', v_counts;
END;
$$;

-- 12. Regras da etapa (depois do preenchimento inicial) --------------------------------------

ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_renewal_stage_check
  CHECK (
    renewal_stage IS NULL OR renewal_stage IN (
      'contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment',
      'renewed', 'not_renewed', 'discarded'
    )
  ),
  ADD CONSTRAINT assessment_contracts_renewal_response_code_check
  CHECK (
    renewal_response_code IS NULL OR renewal_response_code IN (
      'will_renew', 'thinking', 'change_plan_or_coach', 'needs_agent', 'not_renewing'
    )
  ),
  ADD CONSTRAINT assessment_contracts_renewal_stage_scope_check
  CHECK (
    CASE
      WHEN parent_contract_id IS NULL THEN
        renewal_stage IS NULL
        AND renewal_entered_at IS NULL
        AND renewal_stage_updated_at IS NULL
        AND renewal_response_code IS NULL
        AND renewal_response_at IS NULL
        AND renewal_follow_up_at IS NULL
        AND renewal_last_contact_at IS NULL
        AND renewal_resolved_at IS NULL
      ELSE
        renewal_stage IS NOT NULL
        AND renewal_entered_at IS NOT NULL
        AND renewal_stage_updated_at IS NOT NULL
    END
  ),
  ADD CONSTRAINT assessment_contracts_renewal_stage_dates_check
  CHECK (
    renewal_stage IS NULL OR (
      (renewal_stage IN ('renewed', 'not_renewed', 'discarded')) = (renewal_resolved_at IS NOT NULL)
      AND (renewal_response_code IS NULL) = (renewal_response_at IS NULL)
      AND (renewal_stage <> 'waiting_response' OR renewal_last_contact_at IS NOT NULL)
      AND (renewal_follow_up_at IS NULL OR renewal_stage = 'waiting_response')
      AND (renewal_stage <> 'not_renewed' OR status = 'voided')
      AND (renewal_stage <> 'discarded' OR status IN ('voided', 'cancelled'))
    )
  );
