BEGIN;

-- Upgrade de plano no meio do ciclo, entrega 2: o pedido de mudança de plano.
--
-- A mudança (upgrade ou lateral) acontece dentro do contrato pago: mesmo
-- ciclo, mesma data final, e o aluno paga só a diferença proporcional aos
-- dias que faltam, pelos preços de tabela de hoje. A venda original (plano
-- vendido, preço e parcelas do contrato) não muda.
--
-- - assessment_contract_plan_changes guarda o pedido: planos, treinadores,
--   data efetiva, o cálculo da diferença e a cobrança própria (link externo,
--   vencimento, forma de pagamento e pagamento manual). Os pagamentos do
--   pedido ficam em asaas_payments com order_type 'plan_change', fora das
--   parcelas do contrato.
-- - Na criação, o histórico de plano (e o de treinador, se ele muda) ganha o
--   trecho novo a partir da data efetiva. O plano e o treinador do contrato
--   passam a ser os novos na data efetiva: na hora, se ela já chegou; senão,
--   pelas transições diárias.
-- - Correções: editar enquanto não pago e sem tocar mês com fechamento
--   aprovado; registrar ou reabrir a cobrança; registrar ou desfazer o
--   pagamento; cancelar enquanto não pago (volta ao plano anterior desde a
--   data efetiva e descarta a pendência de repasse; a troca de treinador
--   segue valendo nos dias de fechamentos aprovados).
-- - A pendência de repasse da diferença fica ligada ao pedido.
-- - A renovação sai no plano e com o treinador que valem no fim do contrato.
-- - Cancelamento do contrato: estorno e multa incluem a parte não usada dos
--   upgrades pagos; upgrades não pagos são cancelados.
-- - Extrato financeiro: os pagamentos de upgrade entram como assessoria.

-- 1. Pedido de mudança de plano -------------------------------------------------

CREATE TABLE public.assessment_contract_plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL
    REFERENCES public.assessment_contracts(id) ON DELETE CASCADE,
  change_type text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  effective_date date NOT NULL,
  from_plan_id uuid NOT NULL
    REFERENCES public.assessment_plans(id) ON DELETE RESTRICT,
  to_plan_id uuid NOT NULL
    REFERENCES public.assessment_plans(id) ON DELETE RESTRICT,
  to_plan_snapshot jsonb NOT NULL,
  from_coach_id uuid NOT NULL
    REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  to_coach_id uuid NOT NULL
    REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  from_price numeric(12,2) NOT NULL,
  to_price numeric(12,2) NOT NULL,
  cycle_days integer NOT NULL,
  remaining_days integer NOT NULL,
  amount numeric(12,2) NOT NULL,
  max_installments integer NOT NULL,
  payment_status text NOT NULL,
  due_date date,
  charge_payment_method text,
  external_payment_link text,
  external_invoice_number text,
  paid_payment_method_id uuid REFERENCES public.payment_methods(id),
  paid_payment_method text,
  payment_date date,
  manual_payment boolean NOT NULL DEFAULT false,
  notes text,
  applied_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT assessment_contract_plan_changes_type_check
    CHECK (change_type IN ('upgrade', 'lateral')),
  CONSTRAINT assessment_contract_plan_changes_status_check
    CHECK (status IN ('scheduled', 'applied', 'cancelled')),
  CONSTRAINT assessment_contract_plan_changes_payment_status_check
    CHECK (payment_status IN ('not_required', 'awaiting_charge', 'charge_sent', 'paid', 'cancelled')),
  CONSTRAINT assessment_contract_plan_changes_cancelled_check
    CHECK ((status = 'cancelled') = (payment_status = 'cancelled')),
  CONSTRAINT assessment_contract_plan_changes_amount_check
    CHECK (amount >= 0 AND (status = 'cancelled' OR (amount = 0) = (payment_status = 'not_required'))),
  CONSTRAINT assessment_contract_plan_changes_days_check
    CHECK (cycle_days > 0 AND remaining_days > 0),
  CONSTRAINT assessment_contract_plan_changes_installments_check
    CHECK (max_installments BETWEEN 1 AND 6),
  CONSTRAINT assessment_contract_plan_changes_plans_check
    CHECK (from_plan_id <> to_plan_id),
  CONSTRAINT assessment_contract_plan_changes_charge_method_check
    CHECK (charge_payment_method IS NULL OR charge_payment_method ~ '^(pix|boleto|card_[1-6]x)$'),
  CONSTRAINT assessment_contract_plan_changes_link_check
    CHECK (external_payment_link IS NULL OR external_payment_link ~ '^https://[^[:space:][:cntrl:]]+$')
);

CREATE INDEX assessment_contract_plan_changes_contract_idx
  ON public.assessment_contract_plan_changes (contract_id, effective_date);

-- Uma cobrança de mudança em aberto por contrato: a próxima mudança parte de
-- um plano já pago, e o repasse sabe qual é o plano base de cada dia.
CREATE UNIQUE INDEX assessment_contract_plan_changes_one_open_charge_idx
  ON public.assessment_contract_plan_changes (contract_id)
  WHERE payment_status IN ('awaiting_charge', 'charge_sent');

CREATE UNIQUE INDEX assessment_contract_plan_changes_one_per_day_idx
  ON public.assessment_contract_plan_changes (contract_id, effective_date)
  WHERE status <> 'cancelled';

COMMENT ON TABLE public.assessment_contract_plan_changes IS
  'Mudança de plano no meio do ciclo (upgrade ou lateral), com a diferença cobrada à parte da venda original.';

-- 2. Ligações com históricos e repasse ------------------------------------------

ALTER TABLE public.assessment_contract_plan_history
  ADD COLUMN plan_change_id uuid
    REFERENCES public.assessment_contract_plan_changes(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX assessment_contract_plan_history_plan_change_idx
  ON public.assessment_contract_plan_history (plan_change_id)
  WHERE plan_change_id IS NOT NULL;

-- Uma mudança pode valer desde o primeiro dia do contrato: no mesmo dia, a
-- linha da mudança vale por cima da original.
ALTER TABLE public.assessment_contract_plan_history
  DROP CONSTRAINT assessment_contract_plan_history_contract_day_key;
CREATE UNIQUE INDEX assessment_contract_plan_history_change_day_idx
  ON public.assessment_contract_plan_history (contract_id, valid_from)
  WHERE change_type <> 'original';
CREATE INDEX assessment_contract_plan_history_contract_idx
  ON public.assessment_contract_plan_history (contract_id, valid_from);

ALTER TABLE public.assessment_contract_coach_history
  ADD COLUMN plan_change_id uuid
    REFERENCES public.assessment_contract_plan_changes(id) ON DELETE SET NULL;

-- Pendência da diferença de um upgrade não pago: liberada quando o pedido é
-- pago, não quando o contrato é pago.
ALTER TABLE public.payout_pending_repasse
  ADD COLUMN plan_change_id uuid
    REFERENCES public.assessment_contract_plan_changes(id) ON DELETE CASCADE;
ALTER TABLE public.payout_pending_repasse
  DROP CONSTRAINT payout_pending_repasse_uniq;
CREATE UNIQUE INDEX payout_pending_repasse_uniq
  ON public.payout_pending_repasse (
    contract_id, coach_id, source_type, reference_competence,
    coalesce(plan_change_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX payout_pending_repasse_plan_change_idx
  ON public.payout_pending_repasse (plan_change_id)
  WHERE plan_change_id IS NOT NULL;

-- 3. Consultas de apoio -----------------------------------------------------------

-- Primeiro dia sem fechamento de repasse aprovado ou pago (nulo = nenhum).
CREATE OR REPLACE FUNCTION eon_private.first_open_payout_day()
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (max(closing.competence) + interval '1 month')::date
  FROM public.payout_monthly_closings AS closing
  WHERE closing.status IN ('approved', 'paid');
$$;

-- Linha do histórico de plano que vale no dia (antes da primeira, a primeira).
-- No mesmo dia, a linha de uma mudança vale por cima da original.
CREATE OR REPLACE FUNCTION eon_private.contract_plan_row_on(
  p_contract_id uuid,
  p_day date,
  p_ignore_plan_change_id uuid
)
RETURNS public.assessment_contract_plan_history
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT history.*
  FROM public.assessment_contract_plan_history AS history
  WHERE history.contract_id = p_contract_id
    AND (
      p_ignore_plan_change_id IS NULL
      OR history.plan_change_id IS DISTINCT FROM p_ignore_plan_change_id
    )
  ORDER BY
    (history.valid_from <= p_day) DESC,
    CASE WHEN history.valid_from <= p_day THEN history.valid_from END DESC NULLS LAST,
    (history.change_type = 'original') ASC,
    history.valid_from ASC
  LIMIT 1;
$$;

-- Treinador do contrato no dia: a troca registrada por último que já vale
-- naquele dia; antes de todas, a primeira. Mesma regra do fechamento.
CREATE OR REPLACE FUNCTION eon_private.contract_coach_on(
  p_contract_id uuid,
  p_day date
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (
      SELECT history.coach_id
      FROM public.assessment_contract_coach_history AS history
      WHERE history.contract_id = p_contract_id
        AND history.started_at <= p_day
      ORDER BY history.created_at DESC NULLS LAST,
               (history.ended_at IS NULL) DESC,
               history.started_at DESC,
               history.id DESC
      LIMIT 1
    ),
    (
      SELECT history.coach_id
      FROM public.assessment_contract_coach_history AS history
      WHERE history.contract_id = p_contract_id
      ORDER BY history.created_at ASC NULLS FIRST,
               (history.ended_at IS NULL) ASC,
               history.started_at ASC,
               history.id ASC
      LIMIT 1
    ),
    (
      SELECT contract.coach_id
      FROM public.assessment_contracts AS contract
      WHERE contract.id = p_contract_id
    )
  );
$$;

CREATE OR REPLACE FUNCTION eon_private.assessment_plan_catalog_snapshot(
  p_plan public.assessment_plans,
  p_source text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'plan_id', p_plan.id,
    'name', p_plan.name,
    'modality_id', p_plan.modality_id,
    'price_total', p_plan.price_total,
    'price_monthly', p_plan.price_monthly,
    'enrollment_fee', p_plan.enrollment_fee,
    'max_installments', p_plan.max_installments,
    'period_months', p_plan.period_months,
    'period', p_plan.period,
    'revenue_center_id', p_plan.revenue_center_id,
    'snapshot_at', now(),
    'snapshot_source', p_source
  );
$$;

-- Parcelas permitidas para a diferença: até 6x, parcela mínima de R$ 50.
CREATE OR REPLACE FUNCTION eon_private.plan_change_max_installments(p_amount numeric)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_amount >= 100 THEN least(6, floor(p_amount / 50)::integer)
    ELSE 1
  END;
$$;

-- 4. Cálculo e travas -------------------------------------------------------------

-- Confere todas as travas e calcula a diferença. Não grava nada.
-- p_plan_change_id: pedido em edição (fica fora das travas de ordem).
CREATE OR REPLACE FUNCTION eon_private.quote_assessment_plan_change(
  p_contract public.assessment_contracts,
  p_to_plan_id uuid,
  p_effective_date date,
  p_to_coach_id uuid,
  p_plan_change_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_first_open date := eon_private.first_open_payout_day();
  v_from_row public.assessment_contract_plan_history;
  v_from_plan public.assessment_plans%ROWTYPE;
  v_to_plan public.assessment_plans%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_transition text;
  v_from_coach uuid;
  v_to_coach uuid;
  v_cycle_days integer;
  v_remaining_days integer;
  v_amount numeric;
  v_regenerate date;
BEGIN
  IF p_to_plan_id IS NULL OR p_effective_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Informe o plano de destino e a data efetiva';
  END IF;
  IF p_contract.payment_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Mudança de plano só em contrato pago. Contrato sem pagamento usa "Ajustar plano"';
  END IF;
  -- O estorno e o extrato leem o preço da venda no snapshot do contrato; sem
  -- ele, cairiam no preço do plano atual, que a mudança troca.
  IF coalesce(p_contract.plan_snapshot->>'price_total', '') !~ '^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato não tem o preço da venda registrado; corrija o contrato antes da mudança';
  END IF;
  IF p_contract.status NOT IN ('active', 'on_leave', 'scheduled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A mudança de plano só vale para contrato ativo';
  END IF;
  IF p_contract.scheduled_cancellation_date IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato tem cancelamento agendado';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS child
    WHERE child.parent_contract_id = p_contract.id
      AND child.status NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato já tem renovação criada; a mudança de plano entra na renovação';
  END IF;
  IF p_effective_date < p_contract.start_date
     OR p_effective_date >= p_contract.end_date THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'A data efetiva precisa estar dentro do contrato, de %s a %s',
        to_char(p_contract.start_date, 'DD/MM/YYYY'),
        to_char(p_contract.end_date - 1, 'DD/MM/YYYY')
      );
  END IF;
  IF v_first_open IS NOT NULL AND p_effective_date < v_first_open THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'A data efetiva cai num mês com fechamento de repasse aprovado; escolha a partir de %s',
        to_char(v_first_open, 'DD/MM/YYYY')
      );
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.assessment_leaves AS leave
    WHERE leave.contract_id = p_contract.id
      AND leave.status = 'active'
      AND leave.end_date IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Aluno em licença sem data de volta; registre o retorno antes da mudança';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.assessment_leaves AS leave
    WHERE leave.contract_id = p_contract.id
      AND leave.start_date <= p_effective_date
      AND leave.end_date >= p_effective_date
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A data efetiva cai dentro de uma licença; escolha um dia depois do retorno';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = p_contract.id
      AND change.id IS DISTINCT FROM p_plan_change_id
      AND change.payment_status IN ('awaiting_charge', 'charge_sent')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Há uma mudança de plano com cobrança em aberto; registre o pagamento ou cancele a mudança antes';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = p_contract.id
      AND change.id IS DISTINCT FROM p_plan_change_id
      AND change.status <> 'cancelled'
      AND change.effective_date >= p_effective_date
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Já existe mudança de plano nesta data ou depois dela';
  END IF;

  v_from_row := eon_private.contract_plan_row_on(p_contract.id, p_effective_date, p_plan_change_id);
  SELECT * INTO v_from_plan
  FROM public.assessment_plans
  WHERE id = coalesce(v_from_row.plan_id, p_contract.plan_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano atual não encontrado';
  END IF;

  SELECT * INTO v_to_plan
  FROM public.assessment_plans
  WHERE id = p_to_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano de destino não encontrado';
  END IF;
  IF v_to_plan.id = v_from_plan.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O aluno já está neste plano na data escolhida';
  END IF;
  IF v_to_plan.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O plano de destino está inativo';
  END IF;
  IF v_to_plan.period_months IS DISTINCT FROM v_from_plan.period_months THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No meio do ciclo, a mudança precisa ser para um plano do mesmo ciclo';
  END IF;

  SELECT transition.transition_type INTO v_transition
  FROM public.assessment_plan_transitions AS transition
  WHERE transition.from_plan_id = v_from_plan.id
    AND transition.to_plan_id = v_to_plan.id;
  IF v_transition IS NULL OR v_transition = 'not_allowed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esta troca não é permitida na matriz de trocas de plano';
  END IF;
  IF v_transition = 'downgrade' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Downgrade só vale na renovação';
  END IF;

  IF p_plan_change_id IS NOT NULL THEN
    SELECT change.from_coach_id INTO v_from_coach
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.id = p_plan_change_id;
  ELSE
    v_from_coach := eon_private.contract_coach_on(p_contract.id, p_effective_date);
  END IF;
  v_to_coach := coalesce(p_to_coach_id, v_from_coach);

  SELECT * INTO v_coach
  FROM public.assessment_coaches
  WHERE id = v_to_coach;
  IF NOT FOUND OR v_coach.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Treinador indisponível';
  END IF;
  IF NOT (v_to_plan.modality_id = ANY(coalesce(v_coach.modality_ids, ARRAY[]::uuid[]))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = CASE WHEN p_to_coach_id IS NULL OR p_to_coach_id = v_from_coach
        THEN 'O treinador atual não atende a modalidade do novo plano; escolha outro treinador'
        ELSE 'O treinador escolhido não atende a modalidade do novo plano'
      END;
  END IF;

  -- Datas finais são exclusivas: o último dia do contrato é end_date - 1.
  v_cycle_days := greatest(1, coalesce(p_contract.original_end_date, p_contract.end_date) - p_contract.start_date);
  v_remaining_days := p_contract.end_date - p_effective_date;
  v_amount := CASE
    WHEN v_transition = 'lateral' THEN 0
    ELSE greatest(
      0,
      round((v_to_plan.price_total - v_from_plan.price_total) * v_remaining_days / v_cycle_days, 2)
    )
  END;

  SELECT closing.competence INTO v_regenerate
  FROM public.payout_monthly_closings AS closing
  WHERE closing.status = 'pending_approval'
    AND closing.competence >= date_trunc('month', p_effective_date)::date
  ORDER BY closing.competence
  LIMIT 1;

  RETURN jsonb_build_object(
    'contract_id', p_contract.id,
    'change_type', v_transition,
    'effective_date', p_effective_date,
    'applies_now', p_effective_date <= v_today,
    'from_plan', jsonb_build_object(
      'id', v_from_plan.id,
      'name', v_from_plan.name,
      'price_total', v_from_plan.price_total,
      'modality_id', v_from_plan.modality_id
    ),
    'to_plan', eon_private.assessment_plan_catalog_snapshot(v_to_plan, 'plan_change'),
    'from_coach_id', v_from_coach,
    'to_coach_id', v_to_coach,
    'coach_changes', v_to_coach IS DISTINCT FROM v_from_coach,
    'cycle_days', v_cycle_days,
    'remaining_days', v_remaining_days,
    'from_price', v_from_plan.price_total,
    'to_price', v_to_plan.price_total,
    'amount', v_amount,
    'max_installments', eon_private.plan_change_max_installments(v_amount),
    'payment_status', CASE WHEN v_amount > 0 THEN 'awaiting_charge' ELSE 'not_required' END,
    'closing_to_regenerate', v_regenerate
  );
END;
$$;

-- 5. Efeitos no contrato e nos históricos -------------------------------------------

-- Liga a flag que faz o gatilho antigo do histórico de treinador deixar a
-- escrita para quem registrou a mudança (a troca vale na data efetiva, não
-- no dia em que o contrato foi atualizado).
CREATE OR REPLACE FUNCTION eon_private.sync_contract_to_plan_history(
  p_contract_id uuid
)
RETURNS public.assessment_contracts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract public.assessment_contracts%ROWTYPE;
  v_plan_row public.assessment_contract_plan_history;
  v_coach_id uuid;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;

  v_plan_row := eon_private.contract_plan_row_on(
    p_contract_id,
    greatest(v_today, v_contract.start_date),
    NULL
  );
  v_coach_id := eon_private.contract_coach_on(
    p_contract_id,
    greatest(v_today, v_contract.start_date)
  );

  IF v_plan_row.plan_id IS NOT NULL
     AND (v_contract.plan_id IS DISTINCT FROM v_plan_row.plan_id
       OR v_contract.coach_id IS DISTINCT FROM v_coach_id) THEN
    PERFORM set_config('eon.plan_change_coach_sync', 'on', true);
    UPDATE public.assessment_contracts
    SET plan_id = v_plan_row.plan_id,
        coach_id = coalesce(v_coach_id, coach_id),
        updated_at = now()
    WHERE id = p_contract_id
    RETURNING * INTO v_contract;
    PERFORM set_config('eon.plan_change_coach_sync', 'off', true);
  END IF;

  RETURN v_contract;
END;
$$;

-- Grava no histórico de treinador a troca feita pela mudança. Uma edição
-- atualiza a mesma linha, preservando a ordem em relação a trocas manuais
-- feitas depois.
CREATE OR REPLACE FUNCTION eon_private.write_plan_change_coach_history(
  p_plan_change_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_row_id uuid;
BEGIN
  SELECT * INTO v_change
  FROM public.assessment_contract_plan_changes
  WHERE id = p_plan_change_id;

  SELECT history.id INTO v_row_id
  FROM public.assessment_contract_coach_history AS history
  WHERE history.plan_change_id = p_plan_change_id
  ORDER BY history.created_at
  LIMIT 1;

  IF v_change.status = 'cancelled'
     OR v_change.to_coach_id = v_change.from_coach_id THEN
    DELETE FROM public.assessment_contract_coach_history
    WHERE plan_change_id = p_plan_change_id;
    RETURN;
  END IF;

  IF v_row_id IS NULL THEN
    INSERT INTO public.assessment_contract_coach_history (
      contract_id, coach_id, started_at, created_at, plan_change_id
    ) VALUES (
      v_change.contract_id, v_change.to_coach_id, v_change.effective_date,
      clock_timestamp(), p_plan_change_id
    );
  ELSE
    UPDATE public.assessment_contract_coach_history
    SET coach_id = v_change.to_coach_id,
        started_at = v_change.effective_date,
        ended_at = NULL
    WHERE id = v_row_id;
    DELETE FROM public.assessment_contract_coach_history
    WHERE plan_change_id = p_plan_change_id
      AND id <> v_row_id;
  END IF;
END;
$$;

-- Aplica ao contrato o plano e o treinador de uma mudança cuja data chegou.
CREATE OR REPLACE FUNCTION eon_private.apply_assessment_plan_change(
  p_plan_change_id uuid,
  p_actor_id uuid
)
RETURNS public.assessment_contract_plan_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_change
  FROM public.assessment_contract_plan_changes
  WHERE id = p_plan_change_id
  FOR UPDATE;
  IF NOT FOUND OR v_change.status <> 'scheduled' OR v_change.effective_date > v_today THEN
    RETURN v_change;
  END IF;

  v_contract := eon_private.sync_contract_to_plan_history(v_change.contract_id);

  UPDATE public.assessment_contract_plan_changes
  SET status = 'applied',
      applied_at = now(),
      updated_at = now()
  WHERE id = p_plan_change_id
  RETURNING * INTO v_change;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_change.contract_id,
    'plan_change_applied',
    jsonb_build_object(
      'plan_change_id', v_change.id,
      'effective_date', v_change.effective_date,
      'plan_id', v_contract.plan_id,
      'coach_id', v_contract.coach_id
    ),
    'Novo plano em vigor',
    p_actor_id
  );

  RETURN v_change;
END;
$$;

-- Desfaz os efeitos de uma mudança não paga: o plano anterior volta desde a
-- data efetiva e a pendência de repasse da diferença é descartada. Dias de
-- fechamentos aprovados seguem com o treinador que foi pago neles.
CREATE OR REPLACE FUNCTION eon_private.revert_assessment_plan_change(
  p_plan_change_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_source text,
  p_update_contract boolean
)
RETURNS public.assessment_contract_plan_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_first_open date := eon_private.first_open_payout_day();
  v_coach_row public.assessment_contract_coach_history%ROWTYPE;
  v_discarded integer := 0;
BEGIN
  SELECT * INTO v_change
  FROM public.assessment_contract_plan_changes
  WHERE id = p_plan_change_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  IF v_change.status = 'cancelled' THEN
    RETURN v_change;
  END IF;
  IF v_change.payment_status = 'paid' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Mudança já paga: desfaça o registro do pagamento antes de cancelar. Desistência depois de pagar vale na renovação';
  END IF;

  DELETE FROM public.assessment_contract_plan_history
  WHERE plan_change_id = p_plan_change_id;

  IF v_change.to_coach_id <> v_change.from_coach_id THEN
    SELECT * INTO v_coach_row
    FROM public.assessment_contract_coach_history
    WHERE plan_change_id = p_plan_change_id
    ORDER BY created_at
    LIMIT 1;

    IF v_first_open IS NULL OR v_change.effective_date >= v_first_open THEN
      DELETE FROM public.assessment_contract_coach_history
      WHERE plan_change_id = p_plan_change_id;
    ELSIF v_coach_row.id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.assessment_contract_coach_history AS later
      WHERE later.contract_id = v_change.contract_id
        AND later.created_at > v_coach_row.created_at
        AND later.plan_change_id IS DISTINCT FROM p_plan_change_id
    ) THEN
      INSERT INTO public.assessment_contract_coach_history (
        contract_id, coach_id, started_at, created_at, plan_change_id
      ) VALUES (
        v_change.contract_id, v_change.from_coach_id, v_first_open,
        clock_timestamp(), p_plan_change_id
      );
    END IF;
  END IF;

  UPDATE public.payout_pending_repasse
  SET status = 'cancelled',
      resolved_at = now()
  WHERE plan_change_id = p_plan_change_id
    AND status = 'open';
  GET DIAGNOSTICS v_discarded = ROW_COUNT;

  UPDATE public.assessment_contract_plan_changes
  SET status = 'cancelled',
      payment_status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_actor_id,
      cancellation_reason = nullif(btrim(p_reason), ''),
      updated_at = now(),
      updated_by = p_actor_id
  WHERE id = p_plan_change_id
  RETURNING * INTO v_change;

  IF p_update_contract THEN
    PERFORM eon_private.sync_contract_to_plan_history(v_change.contract_id);
  END IF;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_change.contract_id,
    'plan_change_cancelled',
    jsonb_build_object(
      'plan_change_id', v_change.id,
      'effective_date', v_change.effective_date,
      'from_plan_id', v_change.from_plan_id,
      'to_plan_id', v_change.to_plan_id,
      'amount', v_change.amount,
      'discarded_pending_payouts', v_discarded,
      'source', p_source
    ),
    nullif(btrim(p_reason), ''),
    p_actor_id
  );

  RETURN v_change;
END;
$$;

-- 6. Operações do painel -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_assessment_plan_change(
  p_contract_id uuid,
  p_to_plan_id uuid,
  p_effective_date date,
  p_to_coach_id uuid,
  p_plan_change_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF p_plan_change_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.assessment_contract_plan_changes
    WHERE id = p_plan_change_id
      AND contract_id = p_contract_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  RETURN eon_private.quote_assessment_plan_change(
    v_contract, p_to_plan_id, p_effective_date, p_to_coach_id, p_plan_change_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_assessment_plan_change(
  p_contract_id uuid,
  p_to_plan_id uuid,
  p_effective_date date,
  p_to_coach_id uuid,
  p_notes text,
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
  v_quote jsonb;
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_notes text := nullif(btrim(p_notes), '');
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF length(coalesce(v_notes, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A observação é muito longa';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_quote := eon_private.quote_assessment_plan_change(
    v_contract, p_to_plan_id, p_effective_date, p_to_coach_id, NULL
  );

  INSERT INTO public.assessment_contract_plan_changes (
    contract_id, change_type, status, effective_date,
    from_plan_id, to_plan_id, to_plan_snapshot, from_coach_id, to_coach_id,
    from_price, to_price, cycle_days, remaining_days, amount, max_installments,
    payment_status, notes, created_by, updated_by
  ) VALUES (
    v_contract.id,
    v_quote->>'change_type',
    'scheduled',
    p_effective_date,
    (v_quote->'from_plan'->>'id')::uuid,
    p_to_plan_id,
    v_quote->'to_plan',
    (v_quote->>'from_coach_id')::uuid,
    (v_quote->>'to_coach_id')::uuid,
    (v_quote->>'from_price')::numeric,
    (v_quote->>'to_price')::numeric,
    (v_quote->>'cycle_days')::integer,
    (v_quote->>'remaining_days')::integer,
    (v_quote->>'amount')::numeric,
    (v_quote->>'max_installments')::integer,
    v_quote->>'payment_status',
    v_notes,
    p_actor_id,
    p_actor_id
  )
  RETURNING * INTO v_change;

  INSERT INTO public.assessment_contract_plan_history (
    contract_id, plan_id, plan_snapshot, valid_from, change_type, plan_change_id
  ) VALUES (
    v_contract.id, v_change.to_plan_id, v_change.to_plan_snapshot,
    v_change.effective_date, v_change.change_type, v_change.id
  );
  PERFORM eon_private.write_plan_change_coach_history(v_change.id);

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'plan_change_created',
    v_quote || jsonb_build_object('plan_change_id', v_change.id),
    v_notes,
    p_actor_id
  );

  v_change := eon_private.apply_assessment_plan_change(v_change.id, p_actor_id);

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id;

  RETURN jsonb_build_object(
    'plan_change', to_jsonb(v_change),
    'contract', to_jsonb(v_contract),
    'closing_to_regenerate', v_quote->'closing_to_regenerate'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_assessment_plan_change(
  p_plan_change_id uuid,
  p_to_plan_id uuid,
  p_effective_date date,
  p_to_coach_id uuid,
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
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_first_open date := eon_private.first_open_payout_day();
  v_before public.assessment_contract_plan_changes%ROWTYPE;
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_quote jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_amount numeric;
  v_keep_charge boolean;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe o motivo da correção';
  END IF;

  SELECT * INTO v_before
  FROM public.assessment_contract_plan_changes
  WHERE id = p_plan_change_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = v_before.contract_id
  FOR UPDATE;
  IF p_expected_updated_at IS NULL
     OR v_before.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A mudança foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_before.status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Mudança de plano cancelada';
  END IF;
  IF v_before.payment_status = 'paid' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Mudança já paga: desfaça o registro do pagamento para editar';
  END IF;
  IF v_first_open IS NOT NULL AND v_before.effective_date < v_first_open THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A mudança já tem dias em fechamento de repasse aprovado e não pode ser editada';
  END IF;

  -- Sem treinador informado, a edição mantém o treinador escolhido na mudança.
  v_quote := eon_private.quote_assessment_plan_change(
    v_contract, p_to_plan_id, p_effective_date,
    coalesce(p_to_coach_id, v_before.to_coach_id), p_plan_change_id
  );
  v_amount := (v_quote->>'amount')::numeric;
  v_keep_charge := v_amount = v_before.amount
    AND (v_quote->>'max_installments')::integer = v_before.max_installments;

  UPDATE public.assessment_contract_plan_changes
  SET change_type = v_quote->>'change_type',
      status = CASE WHEN p_effective_date <= v_today THEN 'applied' ELSE 'scheduled' END,
      effective_date = p_effective_date,
      from_plan_id = (v_quote->'from_plan'->>'id')::uuid,
      to_plan_id = p_to_plan_id,
      to_plan_snapshot = v_quote->'to_plan',
      to_coach_id = (v_quote->>'to_coach_id')::uuid,
      from_price = (v_quote->>'from_price')::numeric,
      to_price = (v_quote->>'to_price')::numeric,
      cycle_days = (v_quote->>'cycle_days')::integer,
      remaining_days = (v_quote->>'remaining_days')::integer,
      amount = v_amount,
      max_installments = (v_quote->>'max_installments')::integer,
      payment_status = CASE
        WHEN v_amount = 0 THEN 'not_required'
        WHEN v_keep_charge AND v_before.payment_status = 'charge_sent' THEN 'charge_sent'
        ELSE 'awaiting_charge'
      END,
      due_date = CASE WHEN v_keep_charge THEN due_date END,
      charge_payment_method = CASE WHEN v_keep_charge THEN charge_payment_method END,
      external_payment_link = CASE WHEN v_keep_charge THEN external_payment_link END,
      external_invoice_number = CASE WHEN v_keep_charge THEN external_invoice_number END,
      applied_at = CASE WHEN p_effective_date <= v_today THEN coalesce(applied_at, now()) END,
      updated_at = now(),
      updated_by = p_actor_id
  WHERE id = p_plan_change_id
  RETURNING * INTO v_change;

  UPDATE public.assessment_contract_plan_history
  SET plan_id = v_change.to_plan_id,
      plan_snapshot = v_change.to_plan_snapshot,
      valid_from = v_change.effective_date,
      change_type = v_change.change_type
  WHERE plan_change_id = p_plan_change_id;
  PERFORM eon_private.write_plan_change_coach_history(p_plan_change_id);
  v_contract := eon_private.sync_contract_to_plan_history(v_change.contract_id);

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_change.contract_id,
    'plan_change_updated',
    jsonb_build_object(
      'plan_change_id', v_change.id,
      'before', jsonb_build_object(
        'effective_date', v_before.effective_date,
        'to_plan_id', v_before.to_plan_id,
        'to_coach_id', v_before.to_coach_id,
        'amount', v_before.amount
      ),
      'after', jsonb_build_object(
        'effective_date', v_change.effective_date,
        'to_plan_id', v_change.to_plan_id,
        'to_coach_id', v_change.to_coach_id,
        'amount', v_change.amount
      ),
      'charge_reset', NOT v_keep_charge
    ),
    v_reason,
    p_actor_id
  );

  IF v_change.status = 'applied' AND v_before.status = 'scheduled' THEN
    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_change.contract_id,
      'plan_change_applied',
      jsonb_build_object(
        'plan_change_id', v_change.id,
        'effective_date', v_change.effective_date,
        'plan_id', v_contract.plan_id,
        'coach_id', v_contract.coach_id
      ),
      'Novo plano em vigor',
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'plan_change', to_jsonb(v_change),
    'contract', to_jsonb(v_contract),
    'closing_to_regenerate', v_quote->'closing_to_regenerate'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_assessment_plan_change(
  p_plan_change_id uuid,
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
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe o motivo do cancelamento';
  END IF;

  SELECT * INTO v_change
  FROM public.assessment_contract_plan_changes
  WHERE id = p_plan_change_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  PERFORM 1
  FROM public.assessment_contracts
  WHERE id = v_change.contract_id
  FOR UPDATE;
  IF v_change.status = 'cancelled' THEN
    SELECT * INTO v_contract FROM public.assessment_contracts WHERE id = v_change.contract_id;
    RETURN jsonb_build_object(
      'plan_change', to_jsonb(v_change),
      'contract', to_jsonb(v_contract),
      'already_cancelled', true
    );
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_change.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A mudança foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;

  v_change := eon_private.revert_assessment_plan_change(
    p_plan_change_id, v_reason, p_actor_id, 'admin', true
  );
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = v_change.contract_id;

  RETURN jsonb_build_object(
    'plan_change', to_jsonb(v_change),
    'contract', to_jsonb(v_contract),
    'already_cancelled', false
  );
END;
$$;

-- Cobrança externa do pedido. Salvar de novo (outro vencimento, forma de
-- pagamento ou link) é o "reabrir a cobrança": o upgrade não muda.
CREATE OR REPLACE FUNCTION public.save_assessment_plan_change_external_charge(
  p_plan_change_id uuid,
  p_external_link text,
  p_due_date date,
  p_payment_method text,
  p_invoice_number text,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_before public.assessment_contract_plan_changes%ROWTYPE;
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_invoice text := nullif(btrim(p_invoice_number), '');
  v_installments integer;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_external_link IS NULL OR length(p_external_link) > 2048
     OR p_external_link !~ '^https://[^[:space:][:cntrl:]]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um link HTTPS válido';
  END IF;
  IF p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a data de vencimento';
  END IF;
  IF p_payment_method IS NULL
     OR p_payment_method !~ '^(pix|boleto|card_([1-9]|1[0-2])x)$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe uma forma de pagamento externa válida';
  END IF;
  IF length(coalesce(v_invoice, '')) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O número da cobrança é muito longo';
  END IF;

  SELECT * INTO v_before
  FROM public.assessment_contract_plan_changes
  WHERE id = p_plan_change_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  IF v_before.payment_status NOT IN ('awaiting_charge', 'charge_sent') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = CASE v_before.payment_status
        WHEN 'paid' THEN 'A diferença já foi paga'
        WHEN 'not_required' THEN 'Esta mudança não tem cobrança'
        ELSE 'Mudança de plano cancelada'
      END;
  END IF;
  v_installments := CASE
    WHEN p_payment_method LIKE 'card\_%' THEN substring(p_payment_method FROM '^card_([0-9]+)x$')::integer
    ELSE 1
  END;
  IF v_installments > v_before.max_installments THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'Parcelamento acima do permitido para este valor: até %sx, com parcela mínima de R$ 50',
        v_before.max_installments
      );
  END IF;
  IF v_before.external_payment_link = p_external_link
     AND v_before.due_date = p_due_date
     AND v_before.charge_payment_method = p_payment_method
     AND v_before.external_invoice_number IS NOT DISTINCT FROM v_invoice
     AND v_before.payment_status = 'charge_sent' THEN
    RETURN jsonb_build_object('plan_change', to_jsonb(v_before), 'unchanged', true);
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_before.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A mudança foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;

  UPDATE public.assessment_contract_plan_changes
  SET external_payment_link = p_external_link,
      due_date = p_due_date,
      charge_payment_method = p_payment_method,
      external_invoice_number = v_invoice,
      payment_status = 'charge_sent',
      updated_at = now(),
      updated_by = p_actor_id
  WHERE id = p_plan_change_id
  RETURNING * INTO v_change;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, created_by
  ) VALUES (
    v_change.contract_id,
    CASE WHEN v_before.external_payment_link IS NULL
      THEN 'plan_change_charge_registered'
      ELSE 'plan_change_charge_updated'
    END,
    jsonb_build_object(
      'plan_change_id', v_change.id,
      'amount', v_change.amount,
      'link', p_external_link,
      'due_date', p_due_date,
      'payment_method', p_payment_method,
      'invoice_number', v_invoice,
      'previous_link', v_before.external_payment_link,
      'previous_due_date', v_before.due_date,
      'previous_payment_method', v_before.charge_payment_method
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('plan_change', to_jsonb(v_change), 'unchanged', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.api_record_plan_change_manual_payment(
  p_order_id uuid,
  p_payment_method_id uuid,
  p_payment_date date,
  p_total numeric,
  p_installments jsonb,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_method public.payment_methods%ROWTYPE;
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_contract_number text;
  v_fee numeric;
  v_installment_count integer;
  v_existing_count integer;
  v_existing_total numeric;
  v_existing_method_matches boolean;
  v_existing_date_matches boolean;
  v_item jsonb;
  v_number integer;
  v_due_date date;
  v_credit_date date;
  v_value numeric;
  v_allocated numeric := 0;
  v_expected_number integer := 1;
  v_method_code text;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Data de pagamento obrigatória';
  END IF;
  IF p_payment_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A data do pagamento não pode estar no futuro';
  END IF;
  IF p_total IS NULL OR p_total <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valor inválido';
  END IF;

  SELECT * INTO v_method
  FROM public.payment_methods
  WHERE id = p_payment_method_id
    AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Método de pagamento inválido ou inativo';
  END IF;

  SELECT * INTO v_change
  FROM public.assessment_contract_plan_changes
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  SELECT contract_number INTO v_contract_number
  FROM public.assessment_contracts
  WHERE id = v_change.contract_id;

  IF v_change.status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Mudança de plano cancelada';
  END IF;
  IF v_change.payment_status = 'not_required' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta mudança não tem cobrança';
  END IF;
  IF abs(round(v_change.amount, 2) - round(p_total, 2)) > 0.009 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Informe o valor integral da diferença';
  END IF;

  v_installment_count := greatest(1, least(12, coalesce(v_method.installments, 1)));
  IF v_installment_count > v_change.max_installments THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'Parcelamento acima do permitido para este valor: até %sx, com parcela mínima de R$ 50',
        v_change.max_installments
      );
  END IF;
  IF jsonb_typeof(p_installments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_installments) <> v_installment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Projeção de parcelas inválida';
  END IF;

  SELECT
    count(*)::integer,
    coalesce(sum(value), 0),
    coalesce(bool_and(payment_method_id = v_method.id), false),
    coalesce(bool_and(payment_date = p_payment_date), false)
  INTO v_existing_count, v_existing_total, v_existing_method_matches, v_existing_date_matches
  FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = 'plan_change'
    AND source = 'manual'
    AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

  v_fee := round(
    (p_total * coalesce(v_method.fee_percent, 0) / 100) + coalesce(v_method.fee_fixed, 0),
    2
  );

  -- Repetição do mesmo comando (rede) não recria parcelas nem eventos.
  IF v_change.payment_status = 'paid'
     AND v_change.manual_payment
     AND v_existing_count = v_installment_count
     AND round(v_existing_total, 2) = round(p_total, 2)
     AND v_existing_method_matches
     AND v_existing_date_matches THEN
    RETURN jsonb_build_object(
      'installments', v_installment_count,
      'total_gross', round(p_total, 2),
      'total_fee', v_fee,
      'total_net', round(p_total, 2),
      'value_per_installment', round(p_total / v_installment_count, 2),
      'already_recorded', true
    );
  END IF;
  IF v_change.payment_status = 'paid' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O pagamento já foi registrado; desfaça o registro antes de lançar outro';
  END IF;

  v_method_code := coalesce(nullif(v_method.internal_code, ''), v_method.kind);

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = 'plan_change'
    AND source = 'manual';

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_installments)
    ORDER BY (value->>'number')::integer
  LOOP
    v_number := (v_item->>'number')::integer;
    v_due_date := (v_item->>'due_date')::date;
    v_credit_date := (v_item->>'credit_date')::date;
    v_value := round((v_item->>'value')::numeric, 2);

    IF v_number IS NULL OR v_number <> v_expected_number
       OR v_due_date IS NULL OR v_credit_date IS NULL
       OR v_value IS NULL OR v_value <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela inválida';
    END IF;

    INSERT INTO public.asaas_payments (
      asaas_payment_id, source, payment_method_id, installment_number,
      total_installments, billing_type, status, value, net_value, due_date,
      credit_date, payment_date, description, external_reference, order_id,
      order_type, raw, last_synced_at
    ) VALUES (
      'manual_' || p_order_id::text || '_' || v_number || '_' || replace(gen_random_uuid()::text, '-', ''),
      'manual',
      v_method.id,
      v_number,
      v_installment_count,
      upper(v_method.kind),
      'CONFIRMED',
      v_value,
      v_value,
      v_due_date,
      v_credit_date,
      p_payment_date,
      'Mudança de plano - ' || v_method.name ||
        CASE WHEN v_installment_count > 1
          THEN ' (parcela ' || v_number || '/' || v_installment_count || ')'
          ELSE ''
        END,
      v_contract_number,
      p_order_id,
      'plan_change',
      NULL,
      now()
    );

    v_allocated := v_allocated + v_value;
    v_expected_number := v_expected_number + 1;
  END LOOP;

  IF abs(v_allocated - round(p_total, 2)) > 0.01 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'A soma das parcelas precisa ser igual ao valor total';
  END IF;

  UPDATE public.assessment_contract_plan_changes
  SET payment_status = 'paid',
      paid_payment_method_id = v_method.id,
      paid_payment_method = v_method_code,
      payment_date = p_payment_date,
      manual_payment = true,
      updated_at = now(),
      updated_by = p_actor_id
  WHERE id = p_order_id
  RETURNING * INTO v_change;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, created_by
  ) VALUES (
    v_change.contract_id,
    'plan_change_payment_recorded',
    jsonb_build_object(
      'plan_change_id', v_change.id,
      'method', v_method_code,
      'method_name', v_method.name,
      'date', p_payment_date,
      'value', round(p_total, 2),
      'fee', v_fee,
      'installments', v_installment_count
    ),
    p_actor_id
  );

  RETURN jsonb_build_object(
    'installments', v_installment_count,
    'total_gross', round(p_total, 2),
    'total_fee', v_fee,
    'total_net', round(p_total, 2),
    'value_per_installment', round(p_total / v_installment_count, 2),
    'already_recorded', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_reopen_plan_change_manual_payment(
  p_order_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_target_status text;
  v_removed integer := 0;
  v_approved date;
  v_regenerate date;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT * INTO v_change
  FROM public.assessment_contract_plan_changes
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Mudança de plano não encontrada';
  END IF;
  v_target_status := CASE
    WHEN v_change.external_payment_link IS NOT NULL THEN 'charge_sent'
    ELSE 'awaiting_charge'
  END;
  IF v_change.payment_status IN ('awaiting_charge', 'charge_sent') AND NOT v_change.manual_payment THEN
    RETURN jsonb_build_object(
      'reopened', true,
      'already_reopened', true,
      'payment_status', v_change.payment_status,
      'manual_payments_removed', 0
    );
  END IF;
  IF v_change.payment_status <> 'paid' OR NOT v_change.manual_payment THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Somente pagamentos manuais confirmados podem ser desfeitos';
  END IF;
  -- O estorno do cancelamento já contou a parte não usada deste upgrade.
  IF EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS contract
    WHERE contract.id = v_change.contract_id
      AND contract.status = 'cancelled'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi cancelado e o estorno já contou este upgrade; o pagamento da diferença não pode ser desfeito';
  END IF;

  SELECT closing.competence INTO v_approved
  FROM public.payout_pending_repasse AS pending
  JOIN public.payout_monthly_closings AS closing
    ON closing.id = pending.resolved_in_closing_id
  WHERE pending.plan_change_id = p_order_id
    AND pending.status = 'resolved'
    AND closing.status IN ('approved', 'paid')
  ORDER BY closing.competence
  LIMIT 1;
  IF v_approved IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'A diferença de repasse deste upgrade já foi aprovada no fechamento de %s',
        to_char(v_approved, 'MM/YYYY')
      );
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.assessment_contract_plan_changes AS other
    WHERE other.contract_id = v_change.contract_id
      AND other.id <> v_change.id
      AND other.payment_status IN ('awaiting_charge', 'charge_sent')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Há outra mudança de plano com cobrança em aberto; resolva-a antes de desfazer este pagamento';
  END IF;

  SELECT closing.competence INTO v_regenerate
  FROM public.payout_pending_repasse AS pending
  JOIN public.payout_monthly_closings AS closing
    ON closing.id = pending.resolved_in_closing_id
  WHERE pending.plan_change_id = p_order_id
    AND pending.status = 'resolved'
    AND closing.status = 'pending_approval'
  ORDER BY closing.competence
  LIMIT 1;

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = 'plan_change'
    AND source = 'manual';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  UPDATE public.assessment_contract_plan_changes
  SET payment_status = v_target_status,
      paid_payment_method_id = NULL,
      paid_payment_method = NULL,
      payment_date = NULL,
      manual_payment = false,
      updated_at = now(),
      updated_by = p_actor_id
  WHERE id = p_order_id
  RETURNING * INTO v_change;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_change.contract_id,
    'plan_change_payment_reverted',
    jsonb_build_object(
      'plan_change_id', v_change.id,
      'manual_payments_removed', v_removed,
      'payment_status_after', v_target_status
    ),
    'Pagamento da mudança de plano desfeito',
    p_actor_id
  );

  RETURN jsonb_build_object(
    'reopened', true,
    'already_reopened', false,
    'payment_status', v_target_status,
    'manual_payments_removed', v_removed,
    'closing_to_regenerate', v_regenerate
  );
END;
$$;

-- Aplica as mudanças cuja data efetiva chegou. Chamada junto com as outras
-- transições diárias de contrato; uma mudança com problema não trava as outras.
CREATE OR REPLACE FUNCTION public.apply_due_assessment_plan_changes(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_change_id uuid;
  v_change public.assessment_contract_plan_changes%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_changed jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  FOR v_change_id IN
    SELECT change.id
    FROM public.assessment_contract_plan_changes AS change
    JOIN public.assessment_contracts AS contract
      ON contract.id = change.contract_id
    WHERE change.status = 'scheduled'
      AND change.effective_date <= v_today
      AND contract.status IN ('scheduled', 'active', 'overdue', 'on_leave')
    ORDER BY change.effective_date, change.created_at
  LOOP
    BEGIN
      v_change := eon_private.apply_assessment_plan_change(v_change_id, p_actor_id);
      IF v_change.status = 'applied' THEN
        SELECT * INTO v_contract
        FROM public.assessment_contracts
        WHERE id = v_change.contract_id;
        v_changed := v_changed || jsonb_build_array(jsonb_build_object(
          'id', v_contract.id,
          'plan_id', v_contract.plan_id,
          'coach_id', v_contract.coach_id,
          'updated_at', v_contract.updated_at
        ));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_array(jsonb_build_object(
        'plan_change_id', v_change_id,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed, 'failed', v_failed);
END;
$$;

-- 7. Travas no contrato e renovação ---------------------------------------------------

-- Com mudança agendada, a troca de treinador passa pela mudança; as datas do
-- contrato não podem deixar uma mudança de fora; e o pagamento do contrato não
-- volta a ficar em aberto com mudança ativa (o repasse da diferença depende do
-- contrato pago).
CREATE OR REPLACE FUNCTION eon_private.guard_contract_plan_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date date;
BEGIN
  IF current_setting('eon.plan_change_coach_sync', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.coach_id IS DISTINCT FROM OLD.coach_id THEN
    SELECT change.effective_date INTO v_date
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = NEW.id
      AND change.status = 'scheduled'
    ORDER BY change.effective_date
    LIMIT 1;
    IF v_date IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format(
          'Há uma mudança de plano agendada para %s; edite ou cancele a mudança para trocar o treinador',
          to_char(v_date, 'DD/MM/YYYY')
        );
    END IF;
  END IF;

  IF OLD.payment_status = 'paid'
     AND NEW.payment_status IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid')
     AND EXISTS (
       SELECT 1
       FROM public.assessment_contract_plan_changes AS change
       WHERE change.contract_id = NEW.id
         AND change.status <> 'cancelled'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato tem mudança de plano; desfaça o pagamento da diferença e cancele a mudança antes de reabrir o pagamento do contrato';
  END IF;

  IF NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    SELECT change.effective_date INTO v_date
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = NEW.id
      AND change.status <> 'cancelled'
      AND (change.effective_date < NEW.start_date OR change.effective_date >= NEW.end_date)
    ORDER BY change.effective_date
    LIMIT 1;
    IF v_date IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format(
          'A mudança de plano de %s ficaria fora do contrato; ajuste ou cancele a mudança antes',
          to_char(v_date, 'DD/MM/YYYY')
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_contract_plan_changes
  BEFORE UPDATE OF coach_id, start_date, end_date, payment_status ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.guard_contract_plan_changes();

-- A renovação de um contrato com mudança de plano sai no plano e com o
-- treinador que valem no fim dele, pelo preço cheio da tabela.
CREATE OR REPLACE FUNCTION eon_private.carry_plan_change_into_renewal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent public.assessment_contracts%ROWTYPE;
  v_plan_row public.assessment_contract_plan_history;
  v_plan public.assessment_plans%ROWTYPE;
  v_coach_id uuid;
BEGIN
  IF NEW.parent_contract_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = NEW.parent_contract_id
      AND change.status <> 'cancelled'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_parent
  FROM public.assessment_contracts
  WHERE id = NEW.parent_contract_id;
  v_plan_row := eon_private.contract_plan_row_on(
    v_parent.id, greatest(v_parent.start_date, v_parent.end_date - 1), NULL
  );
  v_coach_id := eon_private.contract_coach_on(
    v_parent.id, greatest(v_parent.start_date, v_parent.end_date - 1)
  );

  IF v_plan_row.plan_id IS NOT NULL
     AND (NEW.plan_id IS DISTINCT FROM v_plan_row.plan_id
       OR (NEW.plan_snapshot->>'plan_id') IS DISTINCT FROM v_plan_row.plan_id::text) THEN
    SELECT * INTO v_plan
    FROM public.assessment_plans
    WHERE id = v_plan_row.plan_id;
    IF FOUND THEN
      NEW.plan_id := v_plan.id;
      NEW.plan_snapshot := eon_private.assessment_plan_catalog_snapshot(
        v_plan, 'renewal_after_plan_change'
      );
    END IF;
  END IF;
  IF v_coach_id IS NOT NULL THEN
    NEW.coach_id := v_coach_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER carry_plan_change_into_renewal
  BEFORE INSERT ON public.assessment_contracts
  FOR EACH ROW
  WHEN (NEW.parent_contract_id IS NOT NULL)
  EXECUTE FUNCTION eon_private.carry_plan_change_into_renewal();

-- O gatilho antigo do histórico de treinador registra a troca no dia da
-- atualização; quando a mudança de plano já gravou a troca na data efetiva,
-- ele não escreve de novo.
CREATE OR REPLACE FUNCTION public.sync_coach_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, NEW.start_date);
  ELSIF TG_OP = 'UPDATE' AND NEW.coach_id IS DISTINCT FROM OLD.coach_id THEN
    IF current_setting('eon.plan_change_coach_sync', true) = 'on' THEN
      RETURN NEW;
    END IF;
    UPDATE assessment_contract_coach_history
       SET ended_at = CURRENT_DATE
     WHERE contract_id = NEW.id AND ended_at IS NULL;
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$$;

-- 8. Cancelamento do contrato com mudança de plano ---------------------------------

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
SET search_path TO ''
AS $function$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE := p_contract;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_price_total numeric;
  v_total_days integer;
  v_remaining_days integer;
  v_remaining numeric;
  v_fee numeric;
  v_refund numeric;
  v_payment_status_before text := p_contract.payment_status;
  v_term_completed boolean;
  v_next_status text;
  v_parent_renewal_generated boolean;
  v_voided_renewal_ids uuid[] := ARRAY[]::uuid[];
  v_upgrade_unused numeric := 0;
  v_plan_change_id uuid;
  v_cancelled_plan_change_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Mudanças de plano ainda não pagas saem junto com o contrato: o plano
  -- anterior volta desde a data efetiva e a pendência de repasse é descartada.
  FOR v_plan_change_id IN
    SELECT change.id
    FROM public.assessment_contract_plan_changes AS change
    WHERE change.contract_id = v_contract.id
      AND change.status <> 'cancelled'
      AND change.payment_status IN ('awaiting_charge', 'charge_sent')
    ORDER BY change.effective_date
  LOOP
    PERFORM eon_private.revert_assessment_plan_change(
      v_plan_change_id, 'Contrato cancelado', p_actor_id, 'contract_cancellation', false
    );
    v_cancelled_plan_change_ids := array_append(v_cancelled_plan_change_ids, v_plan_change_id);
  END LOOP;

  SELECT coalesce(
    CASE WHEN jsonb_typeof(v_contract.plan_snapshot->'price_total') IN ('number', 'string')
      THEN nullif(v_contract.plan_snapshot->>'price_total', '')::numeric END,
    plan.price_total,
    0
  ) INTO v_price_total
  FROM public.assessment_plans plan
  WHERE plan.id = v_contract.plan_id;
  v_price_total := coalesce(v_price_total, 0);

  v_total_days := greatest(1, (v_contract.end_date - v_contract.start_date) + 1);
  v_remaining_days := greatest(0, (v_contract.end_date - p_cancellation_date) + 1);
  -- A parte não usada das mudanças de plano pagas entra no valor restante,
  -- com a mesma contagem de dias do contrato.
  SELECT coalesce(sum(
    change.amount
    * greatest(0, (v_contract.end_date - greatest(p_cancellation_date, change.effective_date)) + 1)
    / greatest(1, (v_contract.end_date - change.effective_date) + 1)
  ), 0)
  INTO v_upgrade_unused
  FROM public.assessment_contract_plan_changes AS change
  WHERE change.contract_id = v_contract.id
    AND change.status <> 'cancelled'
    AND change.payment_status = 'paid';
  v_remaining := round(v_price_total * v_remaining_days / v_total_days + v_upgrade_unused, 2);
  v_fee := round(v_remaining * p_cancellation_fee_pct / 100, 2);
  v_refund := greatest(0, round(v_remaining - v_fee, 2));

  -- end_date is exclusive: the last active day is end_date - 1.
  v_term_completed := v_contract.end_date IS NOT NULL
                      AND p_cancellation_date >= v_contract.end_date;
  v_next_status := CASE WHEN v_term_completed THEN 'finished' ELSE 'cancelled' END;

  -- SKIP LOCKED prevents a deadlock with the renewal-resolution workflow,
  -- whose canonical lock order is child -> parent. A concurrently handled
  -- child is left for that workflow, which also accepts a cancelled parent
  -- through the parent_cancelled discard reason added below.
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts renewal
    WHERE renewal.parent_contract_id = v_contract.id
      AND renewal.status = 'draft'
      AND renewal.payment_status = 'pending'
      AND NOT coalesce(renewal.manual_payment, false)
      AND renewal.payment_date IS NULL
      AND coalesce(renewal.refund_amount, 0) = 0
      AND renewal.refund_status IS NULL
      AND renewal.refund_date IS NULL
      AND nullif(trim(renewal.refund_notes), '') IS NULL
      AND nullif(renewal.asaas_charge_id, '') IS NULL
      AND nullif(renewal.asaas_payment_link, '') IS NULL
      AND nullif(renewal.asaas_pix_copy, '') IS NULL
      AND nullif(renewal.asaas_pix_qrcode, '') IS NULL
      AND nullif(renewal.external_payment_link, '') IS NULL
      AND nullif(renewal.external_invoice_number, '') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.asaas_payments payment
        WHERE payment.order_type = 'contract'
          AND payment.order_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payout_monthly_statement_items statement_item
        WHERE statement_item.contract_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payout_pending_repasse pending_repasse
        WHERE pending_repasse.contract_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_operations operation
        WHERE operation.order_type = 'contract'
          AND operation.order_id = renewal.id
          AND operation.status IN ('prepared', 'reconciliation_required')
      )
    ORDER BY renewal.id
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    UPDATE public.assessment_contracts
    SET status = 'voided',
        payment_status = 'cancelled',
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        manual_payment = false,
        manual_fee = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        external_payment_link = NULL,
        external_invoice_number = NULL,
        payment_message_sent_at = NULL,
        cancellation_date = NULL,
        cancellation_fee = 0,
        cancellation_reason = 'Contrato anterior cancelado',
        refund_status = NULL,
        refund_amount = NULL,
        refund_date = NULL,
        refund_notes = NULL,
        updated_at = now()
    WHERE id = v_renewal.id;

    INSERT INTO public.sales_status_events (
      order_type, order_id, previous_status, new_status, reason, metadata, actor_id
    ) VALUES (
      'contract', v_renewal.id, v_renewal.payment_status, 'cancelled',
      'Contrato anterior cancelado',
      jsonb_build_object(
        'action', 'renewal_resolved',
        'resolution', 'discard',
        'reason_code', 'parent_cancelled',
        'parent_contract_id', v_contract.id,
        'automatic', true
      ),
      p_actor_id
    );

    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_renewal.id,
      'sale_voided',
      jsonb_build_object(
        'resolution', 'discard',
        'reason_code', 'parent_cancelled',
        'parent_contract_id', v_contract.id,
        'previous_status', v_renewal.status,
        'previous_payment_status', v_renewal.payment_status,
        'automatic', true,
        'no_financial_penalty', true
      ),
      'Contrato anterior cancelado',
      p_actor_id
    );

    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id,
      'renewal_discarded',
      jsonb_build_object(
        'discarded_contract_id', v_renewal.id,
        'discarded_contract_number', v_renewal.contract_number,
        'resolution', 'discard',
        'reason_code', 'parent_cancelled',
        'automatic', true,
        'no_financial_penalty', true
      ),
      'Rascunho descartado automaticamente pelo cancelamento do contrato anterior',
      p_actor_id
    );

    v_voided_renewal_ids := array_append(v_voided_renewal_ids, v_renewal.id);
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM public.assessment_contracts other
    WHERE other.parent_contract_id = v_contract.id
      AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) INTO v_parent_renewal_generated;

  UPDATE public.assessment_contracts
  SET status = v_next_status,
      cancellation_date = p_cancellation_date,
      cancellation_fee = v_fee,
      cancellation_reason = nullif(btrim(p_reason), ''),
      refund_status = CASE WHEN v_refund > 0 THEN 'pending' ELSE NULL END,
      refund_amount = CASE WHEN v_refund > 0 THEN v_refund ELSE NULL END,
      renewal_generated = v_parent_renewal_generated,
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
    'term_completed', v_term_completed,
    'status_after', v_next_status,
    'source', p_source,
    'voided_renewal_ids', to_jsonb(v_voided_renewal_ids),
    'upgrade_unused_value', round(v_upgrade_unused, 2),
    'cancelled_plan_change_ids', to_jsonb(v_cancelled_plan_change_ids)
  ), nullif(btrim(p_reason), ''), p_actor_id);

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'remaining_days', v_remaining_days,
    'remaining', v_remaining,
    'cancellation_fee', v_fee,
    'refund_amount', v_refund,
    'term_completed', v_term_completed,
    'status', v_next_status,
    'voided_renewal_ids', to_jsonb(v_voided_renewal_ids),
    'upgrade_unused_value', round(v_upgrade_unused, 2),
    'cancelled_plan_change_ids', to_jsonb(v_cancelled_plan_change_ids)
  );
END;
$function$;

-- 9. Extrato financeiro: pagamentos de mudança de plano entram como assessoria --------

CREATE OR REPLACE VIEW public.financial_movements
WITH (security_invoker = true) AS
WITH order_context AS (
  SELECT
    'presale'::text AS order_type,
    o.id AS order_id,
    o.order_number AS reference,
    o.payment_status,
    o.payment_date,
    o.due_date,
    o.payment_method,
    o.manual_payment,
    o.status_changed_at::date AS refund_on,
    COALESCE(o.total_value, o.total_amount, 0)::numeric AS gross_amount,
    product_center.revenue_center_id,
    COALESCE(NULLIF(o.checkout_name, ''), NULLIF(o.customer_name, ''), o.order_number, 'Pedido de pre-venda') AS description,
    o.created_date AS created_at
  FROM public.presale_orders o
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND count(product_centers.revenue_center_id) = count(*)
        AND count(DISTINCT product_centers.revenue_center_id) = 1
      THEN (array_agg(product_centers.revenue_center_id))[1]
      ELSE NULL::uuid
    END AS revenue_center_id
    FROM (
      SELECT COALESCE(stock_product.revenue_center_id, presale_product.revenue_center_id) AS revenue_center_id
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS item(value)
      LEFT JOIN public.stock_products stock_product
        ON stock_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
      LEFT JOIN public.presale_products presale_product
        ON presale_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
    ) product_centers
  ) product_center ON true

  UNION ALL

  SELECT
    'stock'::text,
    o.id,
    o.order_number,
    o.payment_status,
    o.payment_date,
    o.due_date,
    o.payment_method,
    o.manual_payment,
    o.status_changed_at::date,
    COALESCE(o.total_value, 0)::numeric,
    product_center.revenue_center_id,
    COALESCE(NULLIF(o.customer_name, ''), o.order_number, 'Pedido de loja'),
    o.created_date
  FROM public.stock_orders o
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND count(product_centers.revenue_center_id) = count(*)
        AND count(DISTINCT product_centers.revenue_center_id) = 1
      THEN (array_agg(product_centers.revenue_center_id))[1]
      ELSE NULL::uuid
    END AS revenue_center_id
    FROM (
      SELECT COALESCE(stock_product.revenue_center_id, presale_product.revenue_center_id) AS revenue_center_id
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS item(value)
      LEFT JOIN public.stock_products stock_product
        ON stock_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
      LEFT JOIN public.presale_products presale_product
        ON presale_product.id = CASE
          WHEN COALESCE(item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (item.value ->> 'product_id')::uuid
          ELSE NULL
        END
    ) product_centers
  ) product_center ON true

  UNION ALL

  SELECT
    'contract'::text,
    c.id,
    c.contract_number,
    c.payment_status,
    c.payment_date,
    c.due_date,
    c.payment_method,
    c.manual_payment,
    NULL::date,
    GREATEST(
      0::numeric,
      COALESCE(
        CASE
          WHEN COALESCE(c.plan_snapshot ->> 'price_total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN (c.plan_snapshot ->> 'price_total')::numeric
          ELSE NULL
        END,
        plan.price_total,
        0
      ) + COALESCE(c.enrollment_fee, 0) - COALESCE(c.manual_discount, 0) - COALESCE(c.credit_balance, 0)
    ),
    COALESCE(
      CASE
        WHEN COALESCE(c.plan_snapshot ->> 'revenue_center_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (c.plan_snapshot ->> 'revenue_center_id')::uuid
        ELSE NULL
      END,
      plan.revenue_center_id
    ),
    COALESCE(c.contract_number, 'Contrato de assessoria'),
    c.created_at
  FROM public.assessment_contracts c
  -- O plano vendido (linha original do histórico): depois de uma mudança no
  -- meio do ciclo, c.plan_id passa a ser o plano novo.
  LEFT JOIN public.assessment_plans plan ON plan.id = COALESCE(
    (
      SELECT history.plan_id
      FROM public.assessment_contract_plan_history history
      WHERE history.contract_id = c.id
        AND history.change_type = 'original'
    ),
    c.plan_id
  )

  UNION ALL

  SELECT
    'event'::text,
    r.id,
    r.registration_number,
    r.payment_status,
    r.payment_date,
    r.due_date,
    r.payment_method,
    r.manual_payment,
    NULL::date,
    COALESCE(registration_type.price, 0)::numeric,
    event.revenue_center_id,
    concat_ws(' - ', NULLIF(event.name, ''), NULLIF(registration_type.name, ''), r.registration_number),
    r.created_at
  FROM public.event_registrations r
  LEFT JOIN public.events event ON event.id = r.event_id
  LEFT JOIN public.event_registration_types registration_type ON registration_type.id = r.registration_type_id

  UNION ALL

  SELECT
    'plan_change'::text,
    change.id,
    COALESCE(contract.contract_number, 'Contrato de assessoria') || ' · mudança de plano',
    change.payment_status,
    change.payment_date,
    change.due_date,
    COALESCE(change.paid_payment_method, change.charge_payment_method),
    change.manual_payment,
    NULL::date,
    change.amount,
    COALESCE(
      CASE
        WHEN COALESCE(change.to_plan_snapshot ->> 'revenue_center_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (change.to_plan_snapshot ->> 'revenue_center_id')::uuid
        ELSE NULL
      END,
      to_plan.revenue_center_id
    ),
    COALESCE(contract.contract_number, 'Contrato de assessoria') || ' · mudança para '
      || COALESCE(change.to_plan_snapshot ->> 'name', to_plan.name, 'novo plano'),
    change.created_at
  FROM public.assessment_contract_plan_changes change
  JOIN public.assessment_contracts contract ON contract.id = change.contract_id
  LEFT JOIN public.assessment_plans to_plan ON to_plan.id = change.to_plan_id
  WHERE change.status <> 'cancelled'
),
payment_movements AS (
  SELECT
    ('payment:' || p.id)::text AS movement_id,
    COALESCE(NULLIF(p.source, ''), 'asaas') AS source,
    'asaas_payments'::text AS source_table,
    p.id AS source_id,
    COALESCE(order_row.order_id, p.order_id) AS order_id,
    COALESCE(p.order_type, order_row.order_type) AS order_type,
    COALESCE(order_row.reference, NULLIF(p.external_reference, ''), p.asaas_payment_id) AS reference,
    CASE COALESCE(p.order_type, order_row.order_type)
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      WHEN 'contract' THEN 'assessoria'
      WHEN 'event' THEN 'eventos'
      WHEN 'plan_change' THEN 'assessoria'
      ELSE 'outros'
    END AS business_unit,
    order_row.revenue_center_id,
    CASE
      WHEN p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN 'receipt'
      ELSE 'receivable'
    END AS movement_kind,
    'inflow'::text AS cash_direction,
    p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') AS is_actual,
    false AS is_legacy,
    p.status,
    COALESCE(p.value, 0)::numeric AS gross_amount,
    GREATEST(0::numeric, COALESCE(p.value, 0) - COALESCE(p.net_value, p.value, 0)) AS fee_amount,
    COALESCE(p.net_value, p.value, 0)::numeric AS net_amount,
    COALESCE(p.net_value, p.value, 0)::numeric AS signed_net_amount,
    COALESCE(NULLIF(p.billing_type, ''), order_row.payment_method) AS payment_method,
    CASE
      WHEN p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN COALESCE(p.credit_date, p.payment_date)
      ELSE NULL::date
    END AS occurred_on,
    p.due_date AS due_on,
    COALESCE(p.payment_date, p.credit_date, p.due_date) AS recognition_on,
    CASE
      WHEN p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN COALESCE(p.credit_date, p.payment_date)
      ELSE COALESCE(p.credit_date, p.due_date)
    END AS scheduled_on,
    COALESCE(NULLIF(p.description, ''), order_row.description, 'Pagamento') AS description,
    p.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'asaas_payment_id', p.asaas_payment_id,
      'installment_number', p.installment_number,
      'total_installments', p.total_installments,
      'external_reference', p.external_reference
    )) AS metadata
  FROM public.asaas_payments p
  LEFT JOIN order_context order_row
    ON order_row.order_id = p.order_id
   AND order_row.order_type = p.order_type
  WHERE p.status IN (
    'RECEIVED',
    'CONFIRMED',
    'RECEIVED_IN_CASH',
    'PENDING',
    'OVERDUE',
    'AWAITING_RISK_ANALYSIS',
    'AWAITING_CREDIT_CARD',
    'AWAITING_CHARGEBACK_REVERSAL'
  )
),
legacy_receipts AS (
  SELECT
    ('legacy-receipt:' || order_row.order_type || ':' || order_row.order_id)::text AS movement_id,
    'legacy'::text AS source,
    'paid_order_without_receipt'::text AS source_table,
    order_row.order_id AS source_id,
    order_row.order_id,
    order_row.order_type,
    order_row.reference,
    CASE order_row.order_type
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      WHEN 'contract' THEN 'assessoria'
      WHEN 'event' THEN 'eventos'
      WHEN 'plan_change' THEN 'assessoria'
      ELSE 'outros'
    END AS business_unit,
    order_row.revenue_center_id,
    'receipt'::text AS movement_kind,
    'inflow'::text AS cash_direction,
    true AS is_actual,
    true AS is_legacy,
    'PAID_WITHOUT_RECEIPT'::text AS status,
    order_row.gross_amount,
    0::numeric AS fee_amount,
    order_row.gross_amount AS net_amount,
    order_row.gross_amount AS signed_net_amount,
    order_row.payment_method,
    order_row.payment_date AS occurred_on,
    NULL::date AS due_on,
    order_row.payment_date AS recognition_on,
    order_row.payment_date AS scheduled_on,
    COALESCE(order_row.description, 'Pagamento legado') AS description,
    order_row.created_at,
    jsonb_build_object('reason', 'paid_order_without_received_payment') AS metadata
  FROM order_context order_row
  WHERE order_row.payment_status = 'paid'
    AND order_row.payment_date IS NOT NULL
    AND order_row.gross_amount > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.asaas_payments p
      WHERE p.order_id = order_row.order_id
        AND p.order_type = order_row.order_type
        AND p.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
    )
),
return_refunds AS (
  SELECT
    ('order-return:' || r.id)::text AS movement_id,
    'order_return'::text AS source,
    'order_returns'::text AS source_table,
    r.id AS source_id,
    r.order_id,
    r.order_type,
    r.order_number AS reference,
    CASE r.order_type
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      ELSE 'outros'
    END AS business_unit,
    COALESCE(stock_product.revenue_center_id, presale_product.revenue_center_id) AS revenue_center_id,
    'refund'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    'COMPLETED'::text AS status,
    COALESCE(r.refund_value, 0)::numeric AS gross_amount,
    0::numeric AS fee_amount,
    COALESCE(r.refund_value, 0)::numeric AS net_amount,
    -COALESCE(r.refund_value, 0)::numeric AS signed_net_amount,
    NULL::text AS payment_method,
    r.completed_at::date AS occurred_on,
    NULL::date AS due_on,
    r.completed_at::date AS recognition_on,
    r.completed_at::date AS scheduled_on,
    COALESCE(NULLIF(r.product_name, ''), r.order_number, 'Estorno de pedido') AS description,
    r.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'item_index', r.item_index,
      'quantity', r.quantity,
      'was_delivered', r.was_delivered
    )) AS metadata
  FROM public.order_returns r
  LEFT JOIN public.stock_products stock_product ON stock_product.id = r.product_id
  LEFT JOIN public.presale_products presale_product ON presale_product.id = r.product_id
  WHERE r.status = 'completed'
    AND COALESCE(r.refund_value, 0) > 0
),
full_order_refunds AS (
  SELECT
    ('order-refund:' || order_row.order_type || ':' || order_row.order_id)::text AS movement_id,
    'order_refund'::text AS source,
    order_row.order_type || '_orders' AS source_table,
    order_row.order_id AS source_id,
    order_row.order_id,
    order_row.order_type,
    order_row.reference,
    CASE order_row.order_type
      WHEN 'presale' THEN 'pre_venda'
      WHEN 'stock' THEN 'loja'
      ELSE 'outros'
    END AS business_unit,
    order_row.revenue_center_id,
    'refund'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    'COMPLETED'::text AS status,
    order_row.gross_amount,
    0::numeric AS fee_amount,
    order_row.gross_amount AS net_amount,
    -order_row.gross_amount AS signed_net_amount,
    order_row.payment_method,
    order_row.refund_on AS occurred_on,
    NULL::date AS due_on,
    order_row.refund_on AS recognition_on,
    order_row.refund_on AS scheduled_on,
    COALESCE(order_row.description, 'Estorno de pedido') AS description,
    order_row.created_at,
    jsonb_build_object('reason', 'order_payment_status_refunded') AS metadata
  FROM order_context order_row
  WHERE order_row.order_type IN ('presale', 'stock')
    AND order_row.payment_status = 'refunded'
    AND order_row.refund_on IS NOT NULL
    AND order_row.gross_amount > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.order_returns r
      WHERE r.order_id = order_row.order_id
        AND r.order_type = order_row.order_type
        AND r.status = 'completed'
    )
),
contract_refunds AS (
  SELECT
    ('contract-refund:' || c.id)::text AS movement_id,
    'contract_refund'::text AS source,
    'assessment_contracts'::text AS source_table,
    c.id AS source_id,
    c.id AS order_id,
    'contract'::text AS order_type,
    c.contract_number AS reference,
    'assessoria'::text AS business_unit,
    COALESCE(
      CASE
        WHEN COALESCE(c.plan_snapshot ->> 'revenue_center_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (c.plan_snapshot ->> 'revenue_center_id')::uuid
        ELSE NULL
      END,
      plan.revenue_center_id
    ) AS revenue_center_id,
    'refund'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    UPPER(COALESCE(c.refund_status, 'COMPLETED')) AS status,
    COALESCE(c.refund_amount, 0)::numeric AS gross_amount,
    0::numeric AS fee_amount,
    COALESCE(c.refund_amount, 0)::numeric AS net_amount,
    -COALESCE(c.refund_amount, 0)::numeric AS signed_net_amount,
    c.payment_method,
    c.refund_date AS occurred_on,
    NULL::date AS due_on,
    c.refund_date AS recognition_on,
    c.refund_date AS scheduled_on,
    COALESCE(c.contract_number, 'Estorno de contrato') AS description,
    c.updated_at AS created_at,
    jsonb_strip_nulls(jsonb_build_object('refund_notes', c.refund_notes)) AS metadata
  FROM public.assessment_contracts c
  -- O plano vendido (linha original do histórico): depois de uma mudança no
  -- meio do ciclo, c.plan_id passa a ser o plano novo.
  LEFT JOIN public.assessment_plans plan ON plan.id = COALESCE(
    (
      SELECT history.plan_id
      FROM public.assessment_contract_plan_history history
      WHERE history.contract_id = c.id
        AND history.change_type = 'original'
    ),
    c.plan_id
  )
  WHERE c.refund_date IS NOT NULL
    AND COALESCE(c.refund_amount, 0) > 0
),
event_expense_movements AS (
  SELECT
    ('event-expense:' || expense.id)::text AS movement_id,
    'event_expense'::text AS source,
    'event_expenses'::text AS source_table,
    expense.id AS source_id,
    NULL::uuid AS order_id,
    'event'::text AS order_type,
    event.slug AS reference,
    'eventos'::text AS business_unit,
    event.revenue_center_id,
    'expense'::text AS movement_kind,
    'outflow'::text AS cash_direction,
    true AS is_actual,
    false AS is_legacy,
    'RECORDED'::text AS status,
    COALESCE(expense.amount, 0)::numeric AS gross_amount,
    0::numeric AS fee_amount,
    COALESCE(expense.amount, 0)::numeric AS net_amount,
    -COALESCE(expense.amount, 0)::numeric AS signed_net_amount,
    NULL::text AS payment_method,
    expense.expense_date AS occurred_on,
    NULL::date AS due_on,
    expense.expense_date AS recognition_on,
    expense.expense_date AS scheduled_on,
    concat_ws(' - ', NULLIF(event.name, ''), NULLIF(expense.description, '')) AS description,
    expense.created_at,
    jsonb_strip_nulls(jsonb_build_object('category', expense.category, 'event_id', expense.event_id)) AS metadata
  FROM public.event_expenses expense
  LEFT JOIN public.events event ON event.id = expense.event_id
  WHERE COALESCE(expense.amount, 0) > 0
),
payout_movements AS (
  SELECT
    ('payout:' || closing.id)::text AS movement_id,
    'payout_closing'::text AS source,
    'payout_monthly_closings'::text AS source_table,
    closing.id AS source_id,
    NULL::uuid AS order_id,
    'contract'::text AS order_type,
    to_char(closing.competence, 'YYYY-MM') AS reference,
    'assessoria'::text AS business_unit,
    NULL::uuid AS revenue_center_id,
    CASE WHEN SUM(item.amount) >= 0 THEN 'payout' ELSE 'payout_adjustment' END AS movement_kind,
    CASE WHEN SUM(item.amount) >= 0 THEN 'outflow' ELSE 'inflow' END AS cash_direction,
    closing.status = 'paid' AS is_actual,
    false AS is_legacy,
    UPPER(closing.status) AS status,
    ABS(SUM(item.amount))::numeric AS gross_amount,
    0::numeric AS fee_amount,
    ABS(SUM(item.amount))::numeric AS net_amount,
    SUM(item.amount)::numeric * -1 AS signed_net_amount,
    NULL::text AS payment_method,
    CASE WHEN closing.status = 'paid' THEN closing.paid_at::date ELSE NULL::date END AS occurred_on,
    NULL::date AS due_on,
    closing.competence AS recognition_on,
    COALESCE(closing.paid_at::date, closing.competence) AS scheduled_on,
    'Repasse de assessoria ' || to_char(closing.competence, 'MM/YYYY') AS description,
    closing.generated_at AS created_at,
    jsonb_build_object('item_count', count(item.id), 'closing_status', closing.status) AS metadata
  FROM public.payout_monthly_closings closing
  JOIN public.payout_monthly_statement_items item ON item.closing_id = closing.id
  WHERE closing.status IN ('approved', 'paid')
  GROUP BY closing.id, closing.status, closing.competence, closing.paid_at, closing.generated_at
  HAVING SUM(item.amount) <> 0
)
SELECT * FROM payment_movements
UNION ALL
SELECT * FROM legacy_receipts
UNION ALL
SELECT * FROM return_refunds
UNION ALL
SELECT * FROM full_order_refunds
UNION ALL
SELECT * FROM contract_refunds
UNION ALL
SELECT * FROM event_expense_movements
UNION ALL
SELECT * FROM payout_movements;

-- 10. Acesso: painel admin lê; escrita só pelo backend --------------------------------

ALTER TABLE public.assessment_contract_plan_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_contract_plan_changes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_contract_plan_changes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_contract_plan_changes FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.assessment_contract_plan_changes FROM authenticated;
GRANT SELECT ON public.assessment_contract_plan_changes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.assessment_contract_plan_changes TO service_role;

-- As funções SECURITY INVOKER precisam das permissões explícitas também em
-- instalações limpas: o pagamento manual da diferença grava e desfaz as
-- parcelas, e desfazer confere os fechamentos de repasse.
GRANT INSERT, DELETE ON public.asaas_payments TO service_role;
GRANT SELECT ON public.payout_monthly_closings TO service_role;

REVOKE ALL ON FUNCTION eon_private.first_open_payout_day() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.contract_plan_row_on(uuid, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.contract_coach_on(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.assessment_plan_catalog_snapshot(public.assessment_plans, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.plan_change_max_installments(numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.quote_assessment_plan_change(public.assessment_contracts, uuid, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.sync_contract_to_plan_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.write_plan_change_coach_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.apply_assessment_plan_change(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.revert_assessment_plan_change(uuid, text, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.guard_contract_plan_changes() FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.carry_plan_change_into_renewal() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION eon_private.first_open_payout_day() TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.contract_plan_row_on(uuid, date, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.contract_coach_on(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.assessment_plan_catalog_snapshot(public.assessment_plans, text) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.plan_change_max_installments(numeric) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.quote_assessment_plan_change(public.assessment_contracts, uuid, date, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.sync_contract_to_plan_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.write_plan_change_coach_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.apply_assessment_plan_change(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.revert_assessment_plan_change(uuid, text, uuid, text, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.preview_assessment_plan_change(uuid, uuid, date, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_assessment_plan_change(uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_assessment_plan_change_external_charge(uuid, text, date, text, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_record_plan_change_manual_payment(uuid, uuid, date, numeric, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_reopen_plan_change_manual_payment(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_due_assessment_plan_changes(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.preview_assessment_plan_change(uuid, uuid, date, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_assessment_plan_change(uuid, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_assessment_plan_change_external_charge(uuid, text, date, text, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_record_plan_change_manual_payment(uuid, uuid, date, numeric, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_reopen_plan_change_manual_payment(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_due_assessment_plan_changes(uuid) TO service_role;

COMMENT ON FUNCTION public.create_assessment_plan_change(uuid, uuid, date, uuid, text, timestamptz, uuid) IS
  'Cria a mudança de plano no meio do ciclo: histórico a partir da data efetiva e cobrança própria da diferença.';
COMMENT ON FUNCTION public.apply_due_assessment_plan_changes(uuid) IS
  'Aplica ao contrato o plano e o treinador das mudanças cuja data efetiva chegou.';

COMMIT;
