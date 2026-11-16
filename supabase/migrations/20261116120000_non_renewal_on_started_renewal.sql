-- "Não renovar" também para renovação que já começou (plano mensal).
--
-- Até aqui `mark_assessment_contract_non_renewal` recusava qualquer contrato
-- com contrato anterior ("Use a resolução da renovação para esta venda"). Isso
-- vale para a venda de renovação que ainda não começou (rascunho/agendada, que
-- sai do quadro de Renovações), mas no plano mensal quase todo contrato é uma
-- renovação: o aluno que avisa que não continua ficava sem caminho. A renovação
-- já em andamento (ativa, em atraso ou em licença, com início até hoje) é igual
-- ao contrato de origem: cumpre a vigência atual e não gera a próxima.
--
-- Mudanças em relação à versão de 20260727173928:
--   1. contrato de renovação só é recusado se a vigência ainda não começou;
--   2. a renovação automática do contrato é desligada junto (a tela mostrava
--      "Auto-renovação: ON" ao lado de "Não renovou"), com registro no histórico.
-- Nada é criado, alterado ou cancelado no Asaas.

CREATE OR REPLACE FUNCTION public.mark_assessment_contract_non_renewal(
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
  v_status text;
  v_finish_now boolean;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_was_auto boolean;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF lower(COALESCE(v_contract.cancellation_reason, '')) IN ('não renovou', 'nao renovou') THEN
    RETURN jsonb_build_object(
      'contract', to_jsonb(v_contract),
      'should_finish_now', v_contract.status = 'finished',
      'unchanged', true
    );
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     AND v_contract.start_date > v_today THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Use a resolução da renovação para esta venda';
  END IF;
  IF v_contract.status NOT IN ('active', 'overdue', 'on_leave') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O estado atual do contrato não permite registrar não renovação';
  END IF;
  IF NULLIF(btrim(v_contract.cancellation_reason), '') IS NOT NULL
     OR v_contract.cancellation_date IS NOT NULL
     OR COALESCE(v_contract.cancellation_fee, 0) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato já possui outro registro de encerramento';
  END IF;
  IF v_contract.refund_status IS NOT NULL
     OR COALESCE(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_date IS NOT NULL
     OR NULLIF(btrim(v_contract.refund_notes), '') IS NOT NULL
     OR v_contract.payment_status IN ('refunded', 'partially_refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato possui movimentação de estorno e precisa de conferência';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contracts child
    WHERE child.parent_contract_id = v_contract.id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Resolva primeiro a venda de renovação aberta';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contracts other
    WHERE other.customer_id = v_contract.customer_id
      AND other.id <> v_contract.id
      AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outro contrato de continuidade para esta atleta';
  END IF;

  v_was_auto := COALESCE(v_contract.auto_renewal, false);
  v_finish_now := v_contract.end_date <= v_today;
  v_status := CASE WHEN v_finish_now THEN 'finished' ELSE v_contract.status END;
  UPDATE public.assessment_contracts
  SET renewal_generated = true,
      auto_renewal = false,
      cancellation_date = end_date,
      cancellation_fee = 0,
      cancellation_reason = 'Não renovou',
      status = v_status,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;
  IF v_was_auto THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id,
      'auto_renewal_changed',
      jsonb_build_object('enabled', false, 'source', 'non_renewal'),
      'Renovação automática desativada: o aluno não vai renovar.',
      p_actor_id
    );
  END IF;
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'renewal_declined',
    jsonb_build_object(
      'discarded_draft_id', NULL,
      'discarded_draft_number', NULL,
      'effective_end_date', v_contract.end_date,
      'status_after', v_status,
      'no_financial_penalty', true,
      'auto_renewal_disabled', v_was_auto
    ),
    'Aluno não vai renovar. Encerramento sem multa, estorno ou nova cobrança.',
    p_actor_id
  );
  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'should_finish_now', v_finish_now,
    'status_after', v_status
  );
END;
$$;

-- Quem avisou que não renova não é candidato a "Ligar automática" na
-- conferência de assinaturas: a automática agora fica desligada de propósito.
-- Mesma função de 20261027120000, só com o filtro do motivo de encerramento.
CREATE OR REPLACE FUNCTION public.list_assessment_auto_renewal_candidates(
  p_contract_ids uuid[] DEFAULT NULL
) RETURNS TABLE (
  contract_id uuid,
  contract_number text,
  customer_id uuid,
  customer_name text,
  cpf text,
  cnpj text,
  plan_name text,
  start_date date,
  end_date date,
  status text,
  expected_value numeric,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT
    contract.id,
    contract.contract_number,
    contract.customer_id,
    customer.full_name,
    customer.cpf,
    customer.cnpj,
    COALESCE(NULLIF(contract.plan_snapshot->>'name', ''), plan.name),
    contract.start_date,
    contract.end_date,
    contract.status,
    GREATEST(
      0,
      round(
        COALESCE(
          CASE WHEN COALESCE(eon_private.plan_snapshot_without_prorata(contract.plan_snapshot)->>'price_total', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (eon_private.plan_snapshot_without_prorata(contract.plan_snapshot)->>'price_total')::numeric
          END,
          0
        )
        + COALESCE(contract.enrollment_fee, 0)
        - COALESCE(contract.manual_discount, 0)
        - COALESCE(contract.credit_balance, 0),
        2
      )
    ),
    contract.updated_at
  FROM public.assessment_contracts AS contract
  LEFT JOIN public.assessment_plans AS plan ON plan.id = contract.plan_id
  LEFT JOIN public.presale_customers AS customer ON customer.id = contract.customer_id
  WHERE NOT contract.auto_renewal
    AND contract.status IN ('scheduled', 'active', 'overdue')
    AND contract.end_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30
    AND eon_private.assessment_contract_period_months(contract.plan_id, contract.plan_snapshot) = 1
    AND NULLIF(btrim(contract.cancellation_reason), '') IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.assessment_contracts AS child
      WHERE child.parent_contract_id = contract.id
        AND child.status NOT IN ('voided', 'cancelled')
    )
    AND (p_contract_ids IS NULL OR contract.id = ANY (p_contract_ids))
  ORDER BY contract.end_date, contract.contract_number
  LIMIT 100;
$function$;
