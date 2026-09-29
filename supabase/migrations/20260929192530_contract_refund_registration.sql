BEGIN;

-- Registro do estorno de contrato de assessoria.
--
-- Pagamento e estorno são coisas diferentes: o dinheiro que entrou continua
-- como entrada, e o estorno é registrado à parte, com a forma usada.
--
-- - PIX, transferência, dinheiro ou outro: uma saída na data do estorno.
-- - Cartão (Asaas ou maquininha): o estorno é por parcela, como no Asaas. A
--   parte estornada de uma parcela que já tinha caído na conta sai do saldo
--   na data do estorno; a parte de uma parcela que ainda não tinha caído
--   reduz o que ela vai receber.
-- - Cancelar o contrato deixa de cancelar as parcelas do pagamento. As
--   parcelas que o gatilho antigo cancelou em contratos pagos voltam, com
--   cópia em eon_private.
-- - O registro pode ser desfeito, com motivo.

-- 1. Forma e valor calculado do estorno -------------------------------------------

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS refund_method text,
  ADD COLUMN IF NOT EXISTS refund_calculated_amount numeric(12,2);

ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_refund_method_check
  CHECK (refund_method IS NULL
    OR refund_method IN ('pix', 'bank_transfer', 'cash', 'card_asaas', 'card_machine', 'other'));

COMMENT ON COLUMN public.assessment_contracts.refund_method IS
  'Forma do estorno feito: pix, bank_transfer, cash, card_asaas, card_machine ou other.';
COMMENT ON COLUMN public.assessment_contracts.refund_calculated_amount IS
  'Estorno calculado no cancelamento, guardado quando o valor devolvido é registrado; volta para refund_amount se o registro for desfeito.';

-- 2. Estorno por parcela no cartão ------------------------------------------------

CREATE TABLE public.assessment_contract_refund_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL
    REFERENCES public.assessment_contracts(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL
    REFERENCES public.asaas_payments(id) ON DELETE RESTRICT,
  value numeric(12,2) NOT NULL,
  refunded_on date NOT NULL,
  already_credited boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT assessment_contract_refund_allocations_value_check CHECK (value > 0),
  CONSTRAINT assessment_contract_refund_allocations_payment_key UNIQUE (payment_id)
);

CREATE INDEX assessment_contract_refund_allocations_contract_idx
  ON public.assessment_contract_refund_allocations (contract_id);

COMMENT ON TABLE public.assessment_contract_refund_allocations IS
  'Quanto do estorno no cartão saiu de cada parcela. already_credited diz se a parcela já tinha caído na conta quando foi estornada.';

-- 3. Valores em reais nas mensagens -------------------------------------------------

CREATE OR REPLACE FUNCTION eon_private.format_brl(p_value numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 'R$ ' || translate(to_char(round(p_value, 2), 'FM999,999,990.00'), ',.', '.,');
$$;

-- 4. Registrar o estorno feito ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_assessment_contract_refund(
  p_contract_id uuid,
  p_refund_date date,
  p_method text,
  p_amount numeric,
  p_allocations jsonb,
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
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract public.assessment_contracts%ROWTYPE;
  v_notes text := nullif(btrim(p_notes), '');
  v_amount numeric := round(p_amount, 2);
  v_calculated numeric;
  v_is_card boolean := p_method IN ('card_asaas', 'card_machine');
  v_item jsonb;
  v_payment public.asaas_payments%ROWTYPE;
  v_payment_id uuid;
  v_value numeric;
  v_allocated numeric := 0;
  v_paid_total numeric;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_refund_date IS NULL OR p_refund_date > v_today THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a data do estorno (hoje ou antes)';
  END IF;
  IF p_method IS NULL
     OR p_method NOT IN ('pix', 'bank_transfer', 'cash', 'card_asaas', 'card_machine', 'other') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Forma do estorno inválida';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe o valor devolvido';
  END IF;
  IF length(coalesce(v_notes, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A observação é muito longa';
  END IF;
  IF p_allocations IS NOT NULL AND jsonb_typeof(p_allocations) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcelas do estorno inválidas';
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
  IF v_contract.refund_status IS DISTINCT FROM 'pending'
     OR coalesce(v_contract.refund_amount, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não possui estorno pendente';
  END IF;
  IF v_contract.payment_date IS NOT NULL AND p_refund_date < v_contract.payment_date THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('O estorno não pode ser antes do pagamento (%s)',
        to_char(v_contract.payment_date, 'DD/MM/YYYY'));
  END IF;

  v_calculated := round(v_contract.refund_amount, 2);
  IF v_amount <> v_calculated AND v_notes IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('O estorno calculado é %s; informe na observação o motivo do valor diferente',
        eon_private.format_brl(v_calculated));
  END IF;

  -- O estorno não passa do que foi pago no contrato e nas mudanças de plano.
  SELECT coalesce(sum(payment.value), 0) INTO v_paid_total
  FROM public.asaas_payments AS payment
  WHERE payment.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
    AND (
      (payment.order_type = 'contract' AND payment.order_id = v_contract.id)
      OR (payment.order_type = 'plan_change' AND payment.order_id IN (
        SELECT change.id
        FROM public.assessment_contract_plan_changes AS change
        WHERE change.contract_id = v_contract.id
      ))
    );
  IF v_paid_total = 0 THEN
    -- Pagamento antigo sem parcelas registradas: vale o total da venda.
    v_paid_total := greatest(0,
      coalesce(CASE
        WHEN coalesce(v_contract.plan_snapshot ->> 'price_total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (v_contract.plan_snapshot ->> 'price_total')::numeric
      END, 0)
      + coalesce(v_contract.enrollment_fee, 0)
      - coalesce(v_contract.manual_discount, 0)
      - coalesce(v_contract.credit_balance, 0));
  END IF;
  IF v_amount > round(v_paid_total, 2) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('O estorno não pode passar do valor pago (%s)', eon_private.format_brl(v_paid_total));
  END IF;

  IF v_is_card THEN
    IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'No estorno no cartão, informe quanto foi estornado em cada parcela';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
      IF jsonb_typeof(v_item) <> 'object'
         OR jsonb_typeof(v_item -> 'payment_id') <> 'string'
         OR (v_item ->> 'payment_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR jsonb_typeof(v_item -> 'value') <> 'number'
         OR jsonb_typeof(v_item -> 'already_credited') <> 'boolean' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcelas do estorno inválidas';
      END IF;
      v_payment_id := (v_item ->> 'payment_id')::uuid;

      SELECT * INTO v_payment
      FROM public.asaas_payments
      WHERE id = v_payment_id
      FOR UPDATE;
      IF NOT FOUND OR NOT (
        (v_payment.order_type = 'contract' AND v_payment.order_id = v_contract.id)
        OR (v_payment.order_type = 'plan_change' AND v_payment.order_id IN (
          SELECT change.id
          FROM public.assessment_contract_plan_changes AS change
          WHERE change.contract_id = v_contract.id
        ))
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A parcela não é deste contrato';
      END IF;
      IF v_payment.status NOT IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = format('A parcela %s não tem pagamento ativo', coalesce(v_payment.installment_number, 1));
      END IF;
      IF v_payment.id = ANY(v_seen) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A mesma parcela foi informada duas vezes';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.assessment_contract_refund_allocations AS allocation
        WHERE allocation.payment_id = v_payment.id
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = format('A parcela %s já tem estorno registrado', coalesce(v_payment.installment_number, 1));
      END IF;

      v_value := round((v_item ->> 'value')::numeric, 2);
      IF v_value <= 0 OR v_value > round(v_payment.value, 2) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = format('Na parcela %s, o estorno vai de R$ 0,01 até %s',
            coalesce(v_payment.installment_number, 1), eon_private.format_brl(v_payment.value));
      END IF;

      v_seen := array_append(v_seen, v_payment.id);
      v_allocated := v_allocated + v_value;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'payment_id', v_payment.id,
        'order_type', v_payment.order_type,
        'installment_number', v_payment.installment_number,
        'total_installments', v_payment.total_installments,
        'installment_value', v_payment.value,
        'credit_date', v_payment.credit_date,
        'value', v_value,
        'already_credited', (v_item ->> 'already_credited')::boolean
      ));
    END LOOP;
    IF v_allocated <> v_amount THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('A soma das parcelas (%s) precisa ser igual ao valor devolvido (%s)',
          eon_private.format_brl(v_allocated), eon_private.format_brl(v_amount));
    END IF;
  ELSIF p_allocations IS NOT NULL AND jsonb_array_length(p_allocations) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'As parcelas só são informadas no estorno no cartão';
  END IF;

  UPDATE public.assessment_contracts
  SET refund_status = 'done',
      refund_date = p_refund_date,
      refund_method = p_method,
      refund_calculated_amount = coalesce(refund_calculated_amount, refund_amount),
      refund_amount = v_amount,
      refund_notes = v_notes,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_refund_allocations (
    contract_id, payment_id, value, refunded_on, already_credited, created_by
  )
  SELECT
    v_contract.id,
    (allocation_row ->> 'payment_id')::uuid,
    (allocation_row ->> 'value')::numeric,
    p_refund_date,
    (allocation_row ->> 'already_credited')::boolean,
    p_actor_id
  FROM jsonb_array_elements(v_rows) AS allocation_row;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'refund_completed',
    jsonb_build_object(
      'refund_amount', v_amount,
      'calculated_amount', v_contract.refund_calculated_amount,
      'refund_date', p_refund_date,
      'refund_status', 'done',
      'method', p_method,
      'allocations', v_rows
    ),
    v_notes,
    p_actor_id
  );

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'allocations', v_rows
  );
END;
$$;

-- 5. Desfazer o registro ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reopen_assessment_contract_refund(
  p_contract_id uuid,
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
  v_before public.assessment_contracts%ROWTYPE;
  v_reason text := nullif(btrim(p_reason), '');
  v_allocations jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe o motivo';
  END IF;

  SELECT * INTO v_before
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_before.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;
  IF v_before.refund_status IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este estorno não está registrado como feito';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', allocation.payment_id,
    'value', allocation.value,
    'already_credited', allocation.already_credited
  ) ORDER BY allocation.created_at), '[]'::jsonb)
  INTO v_allocations
  FROM public.assessment_contract_refund_allocations AS allocation
  WHERE allocation.contract_id = v_before.id;

  DELETE FROM public.assessment_contract_refund_allocations
  WHERE contract_id = v_before.id;

  UPDATE public.assessment_contracts
  SET refund_status = 'pending',
      refund_date = NULL,
      refund_method = NULL,
      refund_amount = coalesce(refund_calculated_amount, refund_amount),
      refund_notes = NULL,
      updated_at = now()
  WHERE id = v_before.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'refund_reopened',
    jsonb_build_object(
      'previous_refund_date', v_before.refund_date,
      'previous_method', v_before.refund_method,
      'previous_refund_amount', v_before.refund_amount,
      'refund_amount', v_contract.refund_amount,
      'allocations', v_allocations
    ),
    v_reason,
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- 6. Cancelar o contrato não cancela mais as parcelas do pagamento ---------------------

DROP TRIGGER IF EXISTS trg_cleanup_asaas_payments_contract_status ON public.assessment_contracts;
DROP FUNCTION IF EXISTS public.cleanup_asaas_payments_on_contract_status_cancel();

-- 7. Parcelas canceladas pelo gatilho antigo em contratos pagos voltam -----------------

CREATE TABLE IF NOT EXISTS eon_private.contract_installment_restore_backups (
  restore_key text PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);

REVOKE ALL ON TABLE eon_private.contract_installment_restore_backups
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO eon_private.contract_installment_restore_backups (restore_key, snapshot)
SELECT
  'asaas_payment:' || payment.id::text,
  jsonb_build_object(
    'payment', to_jsonb(payment),
    'contract_id', contract.id,
    'contract_number', contract.contract_number,
    'contract_status', contract.status,
    'contract_payment_status', contract.payment_status
  )
FROM public.asaas_payments AS payment
JOIN public.assessment_contracts AS contract
  ON contract.id = payment.order_id
 AND payment.order_type = 'contract'
WHERE payment.status = 'CANCELLED'
  AND payment.source = 'manual'
  AND contract.payment_status = 'paid'
  AND contract.status IN ('cancelled', 'finished')
ON CONFLICT (restore_key) DO NOTHING;

-- Parcelas manuais nascem CONFIRMED (api_record_manual_payment).
UPDATE public.asaas_payments AS payment
   SET status = 'CONFIRMED',
       updated_at = now()
  FROM public.assessment_contracts AS contract
 WHERE contract.id = payment.order_id
   AND payment.order_type = 'contract'
   AND payment.status = 'CANCELLED'
   AND payment.source = 'manual'
   AND contract.payment_status = 'paid'
   AND contract.status IN ('cancelled', 'finished');

-- 8. Central de estornos mostra a forma ----------------------------------------------

CREATE OR REPLACE VIEW public.refunds_overview
WITH (security_invoker = true) AS
SELECT
  'assessment_contract'::text AS source_type,
  contracts.id AS source_id,
  contracts.contract_number AS reference,
  contracts.customer_id,
  customers.full_name AS customer_name,
  COALESCE(contracts.refund_amount, 0)::numeric AS amount,
  contracts.refund_status AS status,
  'manual'::text AS kind,
  contracts.cancellation_date AS requested_on,
  contracts.refund_date AS completed_on,
  contracts.refund_notes AS notes,
  contracts.payment_method,
  contracts.cancellation_reason AS reason,
  contracts.updated_at,
  contracts.refund_method AS method,
  contracts.refund_calculated_amount AS calculated_amount
FROM public.assessment_contracts AS contracts
LEFT JOIN public.presale_customers AS customers
  ON customers.id = contracts.customer_id
WHERE contracts.refund_status IS NOT NULL
  AND COALESCE(contracts.refund_amount, 0) > 0

UNION ALL

SELECT
  'presale_order',
  orders.id,
  orders.order_number,
  orders.customer_id,
  COALESCE(customers.full_name, orders.checkout_name, orders.customer_name),
  COALESCE(orders.total_amount, orders.total_value, 0)::numeric,
  'done',
  'automatic',
  orders.status_changed_at::date,
  orders.status_changed_at::date,
  NULL,
  orders.payment_method,
  orders.cancellation_reason,
  orders.status_changed_at,
  NULL::text,
  NULL::numeric
FROM public.presale_orders AS orders
LEFT JOIN public.presale_customers AS customers
  ON customers.id = orders.customer_id
WHERE orders.payment_status = 'refunded'

UNION ALL

SELECT
  'stock_order',
  orders.id,
  orders.order_number,
  orders.customer_id,
  COALESCE(customers.full_name, orders.customer_name),
  COALESCE(orders.total_value, 0)::numeric,
  'done',
  'automatic',
  orders.status_changed_at::date,
  orders.status_changed_at::date,
  NULL,
  orders.payment_method,
  orders.cancellation_reason,
  orders.status_changed_at,
  NULL::text,
  NULL::numeric
FROM public.stock_orders AS orders
LEFT JOIN public.presale_customers AS customers
  ON customers.id = orders.customer_id
WHERE orders.payment_status = 'refunded';

REVOKE ALL ON public.refunds_overview FROM PUBLIC, anon;
GRANT SELECT ON public.refunds_overview TO authenticated, service_role;

-- 9. Extrato financeiro: estorno por parcela no cartão -----------------------------

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
-- Estorno no cartão por parcela: a parte estornada antes de a parcela cair
-- reduz o que ela recebe; a parte de parcela já recebida sai como estorno.
refund_allocations AS (
  SELECT
    allocation.payment_id,
    sum(allocation.value) FILTER (WHERE NOT allocation.already_credited) AS before_credit
  FROM public.assessment_contract_refund_allocations AS allocation
  GROUP BY allocation.payment_id
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
    (COALESCE(p.value, 0) - COALESCE(refund.before_credit, 0))::numeric AS gross_amount,
    GREATEST(0::numeric, COALESCE(p.value, 0) - COALESCE(p.net_value, p.value, 0)) AS fee_amount,
    (COALESCE(p.net_value, p.value, 0) - COALESCE(refund.before_credit, 0))::numeric AS net_amount,
    (COALESCE(p.net_value, p.value, 0) - COALESCE(refund.before_credit, 0))::numeric AS signed_net_amount,
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
      'external_reference', p.external_reference,
      'refunded_before_credit', refund.before_credit
    )) AS metadata
  FROM public.asaas_payments p
  LEFT JOIN order_context order_row
    ON order_row.order_id = p.order_id
   AND order_row.order_type = p.order_type
  LEFT JOIN refund_allocations refund
    ON refund.payment_id = p.id
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
    AND COALESCE(p.value, 0) - COALESCE(refund.before_credit, 0) > 0
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
    refund_split.outflow AS gross_amount,
    0::numeric AS fee_amount,
    refund_split.outflow AS net_amount,
    -refund_split.outflow AS signed_net_amount,
    COALESCE(c.refund_method, c.payment_method) AS payment_method,
    c.refund_date AS occurred_on,
    NULL::date AS due_on,
    c.refund_date AS recognition_on,
    c.refund_date AS scheduled_on,
    COALESCE(c.contract_number, 'Estorno de contrato') AS description,
    c.updated_at AS created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'refund_notes', c.refund_notes,
      'refund_method', c.refund_method,
      'refund_amount', c.refund_amount,
      'calculated_amount', c.refund_calculated_amount,
      'refunded_before_credit', NULLIF(COALESCE(c.refund_amount, 0) - refund_split.outflow, 0)
    )) AS metadata
  FROM public.assessment_contracts c
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN count(allocation.id) > 0
        THEN COALESCE(sum(allocation.value) FILTER (WHERE allocation.already_credited), 0)
      ELSE COALESCE(c.refund_amount, 0)
    END::numeric AS outflow
    FROM public.assessment_contract_refund_allocations AS allocation
    WHERE allocation.contract_id = c.id
  ) AS refund_split
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
    AND refund_split.outflow > 0
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

-- 10. Acesso: painel admin lê; escrita só pelo backend ------------------------------

ALTER TABLE public.assessment_contract_refund_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_contract_refund_allocations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_contract_refund_allocations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_contract_refund_allocations FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.assessment_contract_refund_allocations FROM authenticated;
GRANT SELECT ON public.assessment_contract_refund_allocations TO authenticated;
GRANT SELECT, INSERT, DELETE
  ON public.assessment_contract_refund_allocations TO service_role;

REVOKE ALL ON FUNCTION eon_private.format_brl(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eon_private.format_brl(numeric) TO service_role;

REVOKE ALL ON FUNCTION public.register_assessment_contract_refund(uuid, date, text, numeric, jsonb, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reopen_assessment_contract_refund(uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_assessment_contract_refund(uuid, date, text, numeric, jsonb, text, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reopen_assessment_contract_refund(uuid, text, timestamptz, uuid) TO service_role;

COMMENT ON FUNCTION public.register_assessment_contract_refund(uuid, date, text, numeric, jsonb, text, timestamptz, uuid) IS
  'Registra o estorno feito de um contrato: forma, data, valor devolvido e, no cartão, quanto saiu de cada parcela.';
COMMENT ON FUNCTION public.reopen_assessment_contract_refund(uuid, text, timestamptz, uuid) IS
  'Desfaz o registro do estorno: volta para pendente com o valor calculado e apaga as parcelas estornadas.';

COMMIT;
