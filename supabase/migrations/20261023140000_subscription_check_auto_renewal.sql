-- "Conferir assinaturas no Asaas" (quadro de Renovações).
--
-- Lista os planos mensais com a renovação automática desligada para o backend
-- consultar no Asaas (só leitura, pelo CPF/CNPJ da pessoa) quem já tem uma
-- assinatura mensal ativa. Ligar a automática a partir dali guarda a
-- assinatura no contrato, e a próxima renovação já busca a fatura nela. Nada é
-- criado, alterado ou cancelado no Asaas.

-- Contrato atual (sem renovação em aberto) de plano mensal, com a automática
-- desligada. Contrato terminado há mais de 30 dias fica de fora.
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
          CASE WHEN COALESCE(contract.plan_snapshot->>'price_total', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (contract.plan_snapshot->>'price_total')::numeric
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

REVOKE ALL ON FUNCTION public.list_assessment_auto_renewal_candidates(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_assessment_auto_renewal_candidates(uuid[]) TO service_role;

COMMENT ON FUNCTION public.list_assessment_auto_renewal_candidates(uuid[]) IS
  'Planos mensais atuais com a renovação automática desligada, para a conferência de assinaturas no Asaas. Só o backend chama.';

-- Liga a renovação automática com a assinatura que o backend acabou de
-- conferir no Asaas. Mesmas condições da lista; a assinatura não pode estar
-- guardada no contrato de outra pessoa.
CREATE OR REPLACE FUNCTION public.enable_assessment_auto_renewal_from_subscription(
  p_contract_id uuid,
  p_subscription_id text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
BEGIN
  IF p_subscription_id IS NULL OR p_subscription_id !~ '^sub_[A-Za-z0-9]{4,40}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Assinatura do Asaas inválida';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  IF v_contract.auto_renewal THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.list_assessment_auto_renewal_candidates(ARRAY[p_contract_id])
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Este contrato não está mais na lista de planos mensais sem renovação automática. Atualize a conferência';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS other
    WHERE other.asaas_subscription_id = p_subscription_id
      AND other.customer_id IS DISTINCT FROM v_contract.customer_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esta assinatura do Asaas já está no contrato de outra pessoa';
  END IF;

  UPDATE public.assessment_contracts
  SET auto_renewal = true,
      asaas_subscription_id = p_subscription_id,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'auto_renewal_changed',
    jsonb_build_object(
      'enabled', true,
      'source', 'asaas_subscription_check',
      'subscription_id', p_subscription_id
    ),
    'Renovação automática ativada pela assinatura do Asaas',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$function$;

REVOKE ALL ON FUNCTION public.enable_assessment_auto_renewal_from_subscription(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enable_assessment_auto_renewal_from_subscription(uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION public.enable_assessment_auto_renewal_from_subscription(uuid, text, uuid) IS
  'Liga a renovação automática de um plano mensal e guarda a assinatura do Asaas conferida pelo backend. Só o backend chama.';

-- Início da renovação automática. A ativação no início da vigência (job
-- diário e transições das telas) pulava toda renovação automática cujo
-- contrato anterior estivesse manual. A regra existe para quem desligou a
-- automática do contrato anterior depois de a renovação nascer (desistiu);
-- mas também travava a renovação que virou automática por conta própria,
-- com o anterior sempre manual, e ela ficava "agendada" depois do início.
-- Agora só a desistência segura a renovação.
CREATE OR REPLACE FUNCTION eon_private.assessment_auto_renewal_opted_out(
  p_parent_id uuid,
  p_since timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS parent
    JOIN public.assessment_contract_event AS event
      ON event.contract_id = parent.id
    WHERE parent.id = p_parent_id
      AND NOT parent.auto_renewal
      AND event.event_type = 'auto_renewal_changed'
      AND event.payload->>'enabled' = 'false'
      AND event.created_at >= p_since
  );
$function$;

REVOKE ALL ON FUNCTION eon_private.assessment_auto_renewal_opted_out(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.assessment_auto_renewal_opted_out(uuid, timestamptz) TO service_role;

DO $do$
DECLARE
  v_def text;
  v_job_where constant text := $a$      AND (NOT renewal.auto_renewal OR parent.auto_renewal)$a$;
  v_job_if constant text := $a$       OR (v_renewal.auto_renewal AND NOT v_parent.auto_renewal) THEN$a$;
  v_transition_where constant text := $a$            AND (NOT contract.auto_renewal OR parent.auto_renewal)$a$;
BEGIN
  v_def := pg_get_functiondef(
    'eon_private.process_internal_assessment_renewals(integer,integer,uuid[])'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_job_where, ''))) / length(v_job_where) <> 1
     OR (length(v_def) - length(replace(v_def, v_job_if, ''))) / length(v_job_if) <> 1 THEN
    RAISE EXCEPTION 'process_internal_assessment_renewals: trava da renovação automática não encontrada uma única vez';
  END IF;
  v_def := replace(v_def, v_job_where,
    $a$      AND (NOT renewal.auto_renewal OR parent.auto_renewal
           OR NOT eon_private.assessment_auto_renewal_opted_out(parent.id, renewal.created_at))$a$);
  v_def := replace(v_def, v_job_if,
    $a$       OR (v_renewal.auto_renewal AND NOT v_parent.auto_renewal
           AND eon_private.assessment_auto_renewal_opted_out(v_parent.id, v_renewal.created_at)) THEN$a$);
  EXECUTE v_def;

  v_def := pg_get_functiondef('public.apply_assessment_contract_transitions(uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_transition_where, ''))) / length(v_transition_where) <> 1 THEN
    RAISE EXCEPTION 'apply_assessment_contract_transitions: trava da renovação automática não encontrada uma única vez';
  END IF;
  v_def := replace(v_def, v_transition_where,
    $a$            AND (NOT contract.auto_renewal OR parent.auto_renewal
                 OR NOT eon_private.assessment_auto_renewal_opted_out(parent.id, contract.created_at))$a$);
  EXECUTE v_def;
END
$do$;
