-- Pro rata do plano mensal.
--
-- O aluno novo pode entrar no meio do mês e passar a ter o ciclo sempre no
-- mesmo dia (o dia da assinatura no Asaas). O primeiro contrato termina no
-- próximo dia do ciclo e custa só os dias até lá: mensal ÷ 30 × dias. A
-- renovação seguinte nasce do dia do ciclo ao dia do ciclo, com o valor cheio.
--
-- O pro rata fica no plan_snapshot do contrato: price_total passa a ser o
-- valor proporcional e plan_snapshot.prorata guarda o dia do ciclo, os dias e
-- o valor cheio. Assim cobrança, conferência no Asaas e mensagens usam o valor
-- proporcional sem mudança. O repasse do coach já é calculado por dia.

-- Próximo dia do ciclo depois do início (dia 1 a 28, existe em todo mês).
CREATE OR REPLACE FUNCTION eon_private.prorata_cycle_end(
  p_start date,
  p_cycle_day integer
) RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN make_date(extract(year FROM p_start)::integer, extract(month FROM p_start)::integer, p_cycle_day) > p_start
      THEN make_date(extract(year FROM p_start)::integer, extract(month FROM p_start)::integer, p_cycle_day)
    ELSE (make_date(extract(year FROM p_start)::integer, extract(month FROM p_start)::integer, p_cycle_day)
          + interval '1 month')::date
  END;
$function$;

REVOKE ALL ON FUNCTION eon_private.prorata_cycle_end(date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.prorata_cycle_end(date, integer) TO service_role;

-- Snapshot sem o pro rata: valor cheio de volta (para a renovação).
CREATE OR REPLACE FUNCTION eon_private.plan_snapshot_without_prorata(
  p_snapshot jsonb
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_snapshot IS NULL OR NOT p_snapshot ? 'prorata' THEN p_snapshot
    ELSE (p_snapshot - 'prorata')
      || jsonb_build_object('price_total', p_snapshot->'prorata'->'full_price_total')
  END;
$function$;

REVOKE ALL ON FUNCTION eon_private.plan_snapshot_without_prorata(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.plan_snapshot_without_prorata(jsonb) TO service_role;

-- Aplica (p_cycle_day de 1 a 28) ou desfaz (p_cycle_day NULL) o pro rata de
-- um contrato mensal ainda sem pagamento. O link de cobrança já enviado não é
-- tocado: a tela pede o novo link com o valor proporcional.
CREATE OR REPLACE FUNCTION public.apply_assessment_contract_prorata(
  p_contract_id uuid,
  p_cycle_day integer,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_snapshot jsonb;
  v_full numeric;
  v_end date;
  v_days integer;
  v_value numeric;
  v_end_before date;
BEGIN
  IF p_contract_id IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do pro rata inválidos';
  END IF;
  IF p_cycle_day IS NOT NULL AND (p_cycle_day < 1 OR p_cycle_day > 28) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O dia do ciclo vai de 1 a 28';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  IF COALESCE(eon_private.assessment_contract_period_months(v_contract.plan_id, v_contract.plan_snapshot), 0) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pro rata vale só para plano mensal';
  END IF;
  IF v_contract.status NOT IN ('draft', 'scheduled', 'active', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O estado do contrato não permite pro rata';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
     OR COALESCE(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR NULLIF(v_contract.asaas_charge_id, '') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.asaas_payments AS payment
       WHERE payment.order_type = 'contract' AND payment.order_id = v_contract.id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O pro rata só pode ser ajustado antes do pagamento do contrato';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contracts AS child
    WHERE child.parent_contract_id = v_contract.id
      AND child.status NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A renovação deste contrato já foi criada';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = v_contract.id AND change.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato tem mudança de plano registrada';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_leaves AS leave
    WHERE leave.contract_id = v_contract.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato tem licença registrada';
  END IF;

  v_snapshot := eon_private.plan_snapshot_without_prorata(COALESCE(v_contract.plan_snapshot, '{}'::jsonb));
  v_full := CASE
    WHEN COALESCE(v_snapshot->>'price_total', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_snapshot->>'price_total')::numeric
  END;
  IF v_full IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato não tem o valor do plano';
  END IF;
  v_end_before := v_contract.end_date;

  IF p_cycle_day IS NULL THEN
    IF NOT (COALESCE(v_contract.plan_snapshot, '{}'::jsonb) ? 'prorata') THEN
      RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
    END IF;
    v_end := (v_contract.start_date + interval '1 month')::date;
  ELSE
    IF extract(day FROM v_contract.start_date)::integer = p_cycle_day THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'O contrato já começa no dia do ciclo; não há pro rata';
    END IF;
    v_end := eon_private.prorata_cycle_end(v_contract.start_date, p_cycle_day);
    v_days := v_end - v_contract.start_date;
    v_value := round(v_full / 30 * v_days, 2);
    v_snapshot := v_snapshot || jsonb_build_object(
      'price_total', v_value,
      'prorata', jsonb_build_object(
        'cycle_day', p_cycle_day,
        'days', v_days,
        'full_price_total', v_full,
        'start_date', v_contract.start_date,
        'end_date', v_end
      )
    );
  END IF;

  UPDATE public.assessment_contracts
  SET plan_snapshot = v_snapshot,
      end_date = v_end,
      original_end_date = v_end,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    CASE WHEN p_cycle_day IS NULL THEN 'prorata_removed' ELSE 'prorata_applied' END,
    jsonb_build_object(
      'cycle_day', p_cycle_day,
      'days', v_days,
      'value', v_value,
      'full_price_total', v_full,
      'end_before', v_end_before,
      'end_after', v_end
    ),
    CASE WHEN p_cycle_day IS NULL
      THEN 'Pro rata desfeito: plano mensal cheio até ' || to_char(v_end, 'DD/MM/YYYY')
      ELSE format('Pro rata até %s: %s dias, R$ %s (mensal R$ %s)',
        to_char(v_end, 'DD/MM/YYYY'), v_days,
        replace(to_char(v_value, 'FM999999990.00'), '.', ','),
        replace(to_char(v_full, 'FM999999990.00'), '.', ','))
    END,
    p_actor_id
  );

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'had_charge', NULLIF(v_contract.external_payment_link, '') IS NOT NULL
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_assessment_contract_prorata(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_assessment_contract_prorata(uuid, integer, timestamptz, uuid) TO service_role;

COMMENT ON FUNCTION public.apply_assessment_contract_prorata(uuid, integer, timestamptz, uuid) IS
  'Pro rata do plano mensal: primeiro período até o dia do ciclo, valor mensal ÷ 30 × dias. NULL desfaz. Só o backend chama.';

-- A renovação de um contrato com pro rata nasce com o valor cheio.
DO $do$
DECLARE
  v_def text;
  v_anchor constant text := $a$        v_snapshot := v_parent.plan_snapshot || jsonb_build_object($a$;
BEGIN
  v_def := pg_get_functiondef(
    'eon_private.process_internal_assessment_renewals(integer,integer,uuid[])'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'process_internal_assessment_renewals: cópia do snapshot não encontrada uma única vez';
  END IF;
  v_def := replace(v_def, v_anchor,
    $a$        v_snapshot := eon_private.plan_snapshot_without_prorata(v_parent.plan_snapshot) || jsonb_build_object($a$);
  EXECUTE v_def;
END
$do$;

-- Conferência de assinaturas: o valor esperado é o mensal cheio.
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
