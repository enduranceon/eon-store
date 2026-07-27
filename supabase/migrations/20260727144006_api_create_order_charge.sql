-- Idempotent Asaas charge creation for presale, stock, and assessment sales.
-- The database owns the financial snapshot and final write. The Edge Function
-- performs the provider calls between short prepare/complete transactions.

ALTER TABLE public.order_operations
  DROP CONSTRAINT order_operations_operation_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_operation_type_check
  CHECK (operation_type IN (
    'cancel_order',
    'refund_order',
    'cancel_item',
    'change_due_date',
    'create_charge',
    'resolve_renewal'
  ));

CREATE OR REPLACE FUNCTION public.prepare_order_charge_creation(
  p_order_type TEXT,
  p_order_id UUID,
  p_billing_type TEXT,
  p_due_date DATE,
  p_installments INTEGER,
  p_customer_cpf TEXT,
  p_source TEXT,
  p_idempotency_key TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status TEXT;
  v_record_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_manual_payment BOOLEAN;
  v_total NUMERIC;
  v_order_number TEXT;
  v_customer_id UUID;
  v_customer_name TEXT;
  v_customer_email TEXT;
  v_customer_phone TEXT;
  v_customer_cpf TEXT;
  v_canonical_cpf TEXT;
  v_asaas_customer_id TEXT;
  v_contract_installments INTEGER;
  v_max_installments INTEGER := 12;
  v_installments INTEGER;
  v_description TEXT;
  v_customer_reference TEXT;
  v_payment_reference TEXT;
  v_plan_id UUID;
  v_source TEXT;
  v_request_fingerprint TEXT;
  v_original_cpf_hash TEXT;
  v_operation_id UUID;
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
BEGIN
  IF p_order_type NOT IN ('presale', 'stock', 'contract') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de venda inválido';
  END IF;
  IF p_order_id IS NULL OR p_actor_id IS NULL OR p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da cobrança são inválidos';
  END IF;
  IF p_billing_type NOT IN ('PIX', 'BOLETO', 'CREDIT_CARD') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Forma de cobrança inválida';
  END IF;
  IF p_installments IS NULL OR p_installments < 1 OR p_installments > 12
     OR (p_billing_type <> 'CREDIT_CARD' AND p_installments <> 1) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcelamento inválido';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;
  IF p_order_type = 'contract'
     AND COALESCE(p_source, '') NOT IN ('contract_detail', 'renewals_page') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Origem da cobrança inválida';
  END IF;
  v_source := CASE
    WHEN p_order_type = 'contract' THEN p_source
    ELSE 'order_detail'
  END;

  IF p_order_type = 'presale' THEN
    SELECT
      o.payment_status,
      o.status,
      o.asaas_charge_id,
      o.external_payment_link,
      o.manual_payment,
      round(COALESCE(o.total_value, o.total_amount, 0), 2),
      o.order_number,
      o.customer_id,
      COALESCE(NULLIF(trim(o.checkout_name), ''), NULLIF(trim(o.customer_name), ''), c.full_name),
      COALESCE(NULLIF(trim(o.checkout_email), ''), NULLIF(trim(o.customer_email), ''), c.email),
      COALESCE(NULLIF(trim(o.checkout_whatsapp), ''), NULLIF(trim(o.customer_whatsapp), ''), c.whatsapp),
      c.cpf,
      o.asaas_customer_id,
      NULL::INTEGER,
      12,
      NULL::UUID
    INTO
      v_payment_status, v_record_status, v_charge_id, v_external_link,
      v_manual_payment, v_total, v_order_number, v_customer_id,
      v_customer_name, v_customer_email, v_customer_phone, v_canonical_cpf,
      v_asaas_customer_id, v_contract_installments, v_max_installments,
      v_plan_id
    FROM public.presale_orders o
    LEFT JOIN public.presale_customers c ON c.id = o.customer_id
    WHERE o.id = p_order_id
    FOR UPDATE OF o;
  ELSIF p_order_type = 'stock' THEN
    SELECT
      o.payment_status,
      NULL::TEXT,
      o.asaas_charge_id,
      o.external_payment_link,
      o.manual_payment,
      round(COALESCE(o.total_value, 0), 2),
      o.order_number,
      o.customer_id,
      COALESCE(NULLIF(trim(o.customer_name), ''), c.full_name),
      COALESCE(NULLIF(trim(o.customer_email), ''), c.email),
      COALESCE(NULLIF(trim(o.customer_whatsapp), ''), c.whatsapp),
      COALESCE(NULLIF(trim(o.customer_cpf), ''), c.cpf),
      o.asaas_customer_id,
      NULL::INTEGER,
      12,
      NULL::UUID
    INTO
      v_payment_status, v_record_status, v_charge_id, v_external_link,
      v_manual_payment, v_total, v_order_number, v_customer_id,
      v_customer_name, v_customer_email, v_customer_phone, v_canonical_cpf,
      v_asaas_customer_id, v_contract_installments, v_max_installments,
      v_plan_id
    FROM public.stock_orders o
    LEFT JOIN public.presale_customers c ON c.id = o.customer_id
    WHERE o.id = p_order_id
    FOR UPDATE OF o;
  ELSE
    SELECT
      c.payment_status,
      c.status,
      c.asaas_charge_id,
      c.external_payment_link,
      c.manual_payment,
      round(
        GREATEST(
          0,
          COALESCE(
            CASE
              WHEN jsonb_typeof(c.plan_snapshot->'price_total') = 'number'
                THEN (c.plan_snapshot->>'price_total')::NUMERIC
              ELSE NULL
            END,
            p.price_total,
            0
          ) + COALESCE(c.enrollment_fee, 0)
            - COALESCE(c.manual_discount, 0)
            - COALESCE(c.credit_balance, 0)
        ),
        2
      ),
      c.contract_number,
      c.customer_id,
      customer.full_name,
      customer.email,
      customer.whatsapp,
      customer.cpf,
      NULL::TEXT,
      c.installments,
      COALESCE(
        CASE
          WHEN jsonb_typeof(c.plan_snapshot->'max_installments') = 'number'
            THEN (c.plan_snapshot->>'max_installments')::INTEGER
          ELSE NULL
        END,
        p.max_installments,
        1
      ),
      c.plan_id
    INTO
      v_payment_status, v_record_status, v_charge_id, v_external_link,
      v_manual_payment, v_total, v_order_number, v_customer_id,
      v_customer_name, v_customer_email, v_customer_phone, v_canonical_cpf,
      v_asaas_customer_id, v_contract_installments, v_max_installments,
      v_plan_id
    FROM public.assessment_contracts c
    JOIN public.presale_customers customer ON customer.id = c.customer_id
    JOIN public.assessment_plans p ON p.id = c.plan_id
    WHERE c.id = p_order_id
    FOR UPDATE OF c;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  v_customer_cpf := regexp_replace(
    COALESCE(
      CASE WHEN p_order_type = 'contract' THEN v_canonical_cpf ELSE p_customer_cpf END,
      ''
    ),
    '[^0-9]',
    '',
    'g'
  );
  v_original_cpf_hash := pg_catalog.encode(
    extensions.digest(
      regexp_replace(COALESCE(v_canonical_cpf, ''), '[^0-9]', '', 'g'),
      'sha256'
    ),
    'hex'
  );

  v_installments := CASE
    WHEN p_billing_type <> 'CREDIT_CARD' THEN 1
    WHEN p_order_type = 'contract' THEN LEAST(
      GREATEST(COALESCE(v_contract_installments, 1), 1),
      GREATEST(COALESCE(v_max_installments, 1), 1),
      12
    )
    ELSE p_installments
  END;
  v_description := CASE
    WHEN p_order_type = 'contract' THEN 'Contrato ' || COALESCE(v_order_number, p_order_id::TEXT)
    ELSE 'Pedido ' || COALESCE(v_order_number, p_order_id::TEXT)
  END;
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'billing_type', p_billing_type,
        'due_date', p_due_date,
        'installments', v_installments,
        'customer_cpf', v_customer_cpf,
        'source', v_source
      )::TEXT,
      'sha256'
    ),
    'hex'
  );

  -- Return an existing command before validating the sale's post-command state.
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'create_charge'
    AND operation_key = p_idempotency_key
    AND order_type = p_order_type
    AND order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.payload->>'request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'A chave de idempotência já foi usada com outros dados';
    END IF;

    IF v_operation.status IN ('completed', 'failed') THEN
      RETURN jsonb_build_object(
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'source', v_operation.payload->>'source',
        'result', v_operation.result,
        'error_code', v_operation.result->>'error_code',
        'error', v_operation.last_error
      );
    END IF;

    IF v_operation.status = 'prepared'
       AND (
         NULLIF(v_charge_id, '') IS NOT NULL
         OR NULLIF(v_external_link, '') IS NOT NULL
         OR COALESCE(v_manual_payment, false)
         OR COALESCE(v_payment_status, '') NOT IN (
           'pending', 'awaiting_charge', 'charge_sent', 'overdue'
         )
         OR (p_order_type = 'contract' AND v_record_status IN ('cancelled', 'voided', 'finished'))
         OR v_total IS DISTINCT FROM (v_operation.payload->>'total_value')::NUMERIC
         OR v_customer_id IS DISTINCT FROM NULLIF(v_operation.payload->>'local_customer_id', '')::UUID
         OR v_original_cpf_hash IS DISTINCT FROM v_operation.payload->>'original_customer_cpf_hash'
         OR NULLIF(v_asaas_customer_id, '') IS DISTINCT FROM
              NULLIF(v_operation.payload->>'original_asaas_customer_id', '')
         OR (
           p_order_type = 'contract'
           AND v_plan_id IS DISTINCT FROM NULLIF(v_operation.payload->>'plan_id', '')::UUID
         )
       ) THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          payload = (payload - ARRAY[
            'customer_cpf', 'customer_name', 'customer_email', 'customer_phone'
          ]) || jsonb_build_object(
            'customer_cpf_last4', right(COALESCE(payload->>'customer_cpf', ''), 4)
          ),
          last_error = 'O estado financeiro da venda mudou antes da retomada da cobrança',
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
    END IF;

    IF v_operation.status = 'prepared'
       AND (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at <= now()) THEN
      v_lease_token := gen_random_uuid();
      UPDATE public.order_operations
      SET lease_token = v_lease_token,
          lease_expires_at = now() + INTERVAL '120 seconds',
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
      v_lease_acquired := true;
    END IF;

    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'lease_acquired', v_lease_acquired,
      'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
      'lease_expires_at', v_operation.lease_expires_at,
      'billing_type', v_operation.payload->>'billing_type',
      'due_date', v_operation.payload->>'due_date',
      'installments', (v_operation.payload->>'installments')::INTEGER,
      'total_value', (v_operation.payload->>'total_value')::NUMERIC,
      'customer_cpf', v_operation.payload->>'customer_cpf',
      'customer_name', v_operation.payload->>'customer_name',
      'customer_email', v_operation.payload->>'customer_email',
      'customer_phone', v_operation.payload->>'customer_phone',
      'asaas_customer_id', v_operation.payload->>'asaas_customer_id',
      'customer_external_reference', v_operation.payload->>'customer_external_reference',
      'payment_external_reference', v_operation.payload->>'payment_external_reference',
      'description', v_operation.payload->>'description',
      'source', v_operation.payload->>'source',
      'result', v_operation.result,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error
    );
  END IF;

  IF COALESCE(v_payment_status, '') NOT IN (
    'pending', 'awaiting_charge', 'charge_sent', 'overdue'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente vendas ainda não pagas aceitam nova cobrança';
  END IF;
  IF p_order_type = 'contract' AND v_record_status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não aceita nova cobrança';
  END IF;
  IF NULLIF(v_charge_id, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A venda já possui cobrança Asaas';
  END IF;
  IF NULLIF(v_external_link, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Remova a cobrança externa antes de gerar uma cobrança Asaas';
  END IF;
  IF COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Reabra o pagamento manual antes de gerar uma cobrança Asaas';
  END IF;
  IF COALESCE(v_total, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O valor da cobrança precisa ser maior que zero';
  END IF;
  IF char_length(v_customer_cpf) <> 11 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CPF do cliente inválido';
  END IF;
  IF NULLIF(trim(v_customer_name), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Nome do cliente não encontrado';
  END IF;
  IF v_installments > GREATEST(COALESCE(v_max_installments, 1), 1)
     AND p_order_type = 'contract' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Parcelamento acima do limite do plano';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.asaas_payments payment
    WHERE payment.order_type = p_order_type
      AND payment.order_id = p_order_id
      AND payment.source = 'asaas'
      AND COALESCE(payment.status, '') NOT IN ('CANCELLED', 'CANCELED', 'REFUNDED', 'DELETED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A venda possui uma cobrança Asaas ativa no fluxo financeiro';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.order_operations operation
    WHERE operation.order_type = p_order_type
      AND operation.order_id = p_order_id
      AND operation.status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outra operação financeira pendente para esta venda';
  END IF;

  v_operation_id := gen_random_uuid();
  v_customer_reference := 'EONCUS-' || COALESCE(v_customer_id, p_order_id)::TEXT;
  v_payment_reference := 'EONCHG-' || v_operation_id::TEXT;
  v_lease_token := gen_random_uuid();

  INSERT INTO public.order_operations (
    id, operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, lease_token, lease_expires_at
  )
  VALUES (
    v_operation_id,
    'create_charge',
    p_idempotency_key,
    p_order_type,
    p_order_id,
    'prepared',
    p_actor_id,
    'Criação de cobrança Asaas',
    jsonb_build_object(
      'payment_status', v_payment_status,
      'record_status', v_record_status,
      'order_number', v_order_number,
      'total_value', v_total,
      'billing_type', p_billing_type,
      'due_date', p_due_date,
      'installments', v_installments,
      'customer_cpf', v_customer_cpf,
      'customer_name', trim(v_customer_name),
      'customer_email', NULLIF(trim(v_customer_email), ''),
      'customer_phone', NULLIF(regexp_replace(COALESCE(v_customer_phone, ''), '[^0-9]', '', 'g'), ''),
      'local_customer_id', v_customer_id,
      'original_customer_cpf_hash', v_original_cpf_hash,
      'plan_id', v_plan_id,
      'asaas_customer_id', v_asaas_customer_id,
      'original_asaas_customer_id', v_asaas_customer_id,
      'customer_external_reference', v_customer_reference,
      'payment_external_reference', v_payment_reference,
      'description', v_description,
      'source', v_source,
      'request_fingerprint', v_request_fingerprint
    ),
    v_lease_token,
    now() + INTERVAL '120 seconds'
  )
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'lease_acquired', true,
    'lease_token', v_lease_token,
    'lease_expires_at', v_operation.lease_expires_at,
    'billing_type', p_billing_type,
    'due_date', p_due_date,
    'installments', v_installments,
    'total_value', v_total,
    'customer_cpf', v_customer_cpf,
    'customer_name', trim(v_customer_name),
    'customer_email', NULLIF(trim(v_customer_email), ''),
    'customer_phone', NULLIF(regexp_replace(COALESCE(v_customer_phone, ''), '[^0-9]', '', 'g'), ''),
    'asaas_customer_id', v_asaas_customer_id,
    'customer_external_reference', v_customer_reference,
    'payment_external_reference', v_payment_reference,
    'description', v_description,
    'source', v_source,
    'result', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_order_charge_creation(
  p_operation_id UUID,
  p_lease_token UUID,
  p_external_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_payment_status TEXT;
  v_record_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_manual_payment BOOLEAN;
  v_total NUMERIC;
  v_current_installments INTEGER;
  v_current_customer_id UUID;
  v_current_customer_cpf TEXT;
  v_current_asaas_customer_id TEXT;
  v_current_plan_id UUID;
  v_current_cpf_hash TEXT;
  v_payment_id TEXT;
  v_customer_id TEXT;
  v_payment_method TEXT;
  v_next_contract_status TEXT;
  v_payments JSONB;
  v_payment JSONB;
  v_primary_payment JSONB;
  v_payment_ids TEXT[] := ARRAY[]::TEXT[];
  v_installment_numbers INTEGER[] := ARRAY[]::INTEGER[];
  v_installment_group_id TEXT;
  v_expected_installments INTEGER;
  v_expected_total_cents BIGINT;
  v_sum_cents BIGINT := 0;
  v_installment_number INTEGER;
  v_upserted_payment_id TEXT;
  v_conflicting_payment_id TEXT;
  v_cached_payment public.asaas_payments%ROWTYPE;
  v_effective_provider_status TEXT;
  v_effective_payment_status TEXT;
  v_effective_payment_date DATE;
  v_effective_due_date DATE;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'create_charge';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cobrança não encontrada';
  END IF;

  IF v_operation.order_type = 'presale' THEN
    SELECT o.payment_status, o.status, o.asaas_charge_id, o.external_payment_link,
           o.manual_payment, round(COALESCE(o.total_value, o.total_amount, 0), 2),
           NULL::INTEGER, o.customer_id, customer.cpf, o.asaas_customer_id,
           NULL::UUID
    INTO v_payment_status, v_record_status, v_charge_id, v_external_link,
         v_manual_payment, v_total, v_current_installments,
         v_current_customer_id, v_current_customer_cpf,
         v_current_asaas_customer_id, v_current_plan_id
    FROM public.presale_orders o
    LEFT JOIN public.presale_customers customer ON customer.id = o.customer_id
    WHERE o.id = v_operation.order_id
    FOR UPDATE OF o;
  ELSIF v_operation.order_type = 'stock' THEN
    SELECT o.payment_status, NULL::TEXT, o.asaas_charge_id, o.external_payment_link,
           o.manual_payment, round(COALESCE(o.total_value, 0), 2),
           NULL::INTEGER, o.customer_id,
           COALESCE(NULLIF(trim(o.customer_cpf), ''), customer.cpf),
           o.asaas_customer_id, NULL::UUID
    INTO v_payment_status, v_record_status, v_charge_id, v_external_link,
         v_manual_payment, v_total, v_current_installments,
         v_current_customer_id, v_current_customer_cpf,
         v_current_asaas_customer_id, v_current_plan_id
    FROM public.stock_orders o
    LEFT JOIN public.presale_customers customer ON customer.id = o.customer_id
    WHERE o.id = v_operation.order_id
    FOR UPDATE OF o;
  ELSE
    SELECT
      c.payment_status,
      c.status,
      c.asaas_charge_id,
      c.external_payment_link,
      c.manual_payment,
      round(
        GREATEST(
          0,
          COALESCE(
            CASE
              WHEN jsonb_typeof(c.plan_snapshot->'price_total') = 'number'
                THEN (c.plan_snapshot->>'price_total')::NUMERIC
              ELSE NULL
            END,
            p.price_total,
            0
          ) + COALESCE(c.enrollment_fee, 0)
            - COALESCE(c.manual_discount, 0)
            - COALESCE(c.credit_balance, 0)
        ),
        2
      ),
      c.installments,
      c.customer_id,
      customer.cpf,
      NULL::TEXT,
      c.plan_id
    INTO v_payment_status, v_record_status, v_charge_id, v_external_link,
         v_manual_payment, v_total, v_current_installments,
         v_current_customer_id, v_current_customer_cpf,
         v_current_asaas_customer_id, v_current_plan_id
    FROM public.assessment_contracts c
    JOIN public.presale_customers customer ON customer.id = c.customer_id
    JOIN public.assessment_plans p ON p.id = c.plan_id
    WHERE c.id = v_operation.order_id
    FOR UPDATE OF c;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Venda não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'create_charge'
  FOR UPDATE;

  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status = 'reconciliation_required' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error', v_operation.last_error
    );
  END IF;
  IF v_operation.status = 'failed' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error
    );
  END IF;
  IF p_lease_token IS NULL OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  -- Serialize cache ownership checks with webhook/sync writes. This lock is
  -- held only for the short local completion transaction, never for Asaas I/O.
  LOCK TABLE public.asaas_payments IN SHARE ROW EXCLUSIVE MODE;

  v_expected_installments := (v_operation.payload->>'installments')::INTEGER;
  v_expected_total_cents := round(
    (v_operation.payload->>'total_value')::NUMERIC * 100
  )::BIGINT;
  v_payment_id := NULLIF(p_external_result->>'payment_id', '');
  v_customer_id := NULLIF(p_external_result->>'customer_id', '');
  v_payments := p_external_result->'payments';
  IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
     OR COALESCE(p_external_result->>'outcome', '') NOT IN ('created', 'recovered')
     OR v_payment_id IS NULL
     OR v_customer_id IS NULL
     OR p_external_result->>'source' IS DISTINCT FROM v_operation.payload->>'source'
     OR COALESCE(p_external_result->>'requested_total_value', '') !~ '^[0-9]+([.][0-9]+)?$'
     OR round((p_external_result->>'requested_total_value')::NUMERIC * 100)::BIGINT
          IS DISTINCT FROM v_expected_total_cents
     OR COALESCE(p_external_result->>'total_installments', '') !~ '^[0-9]+$'
     OR (p_external_result->>'total_installments')::INTEGER
          IS DISTINCT FROM v_expected_installments
     OR jsonb_typeof(v_payments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(COALESCE(v_payments, '[]'::JSONB))
          IS DISTINCT FROM v_expected_installments THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
  END IF;

  FOR v_payment IN
    SELECT value FROM jsonb_array_elements(v_payments)
  LOOP
    IF jsonb_typeof(v_payment) IS DISTINCT FROM 'object'
       OR NULLIF(v_payment->>'payment_id', '') IS NULL
       OR v_payment->>'customer_id' IS DISTINCT FROM v_customer_id
       OR v_payment->>'billing_type' IS DISTINCT FROM v_operation.payload->>'billing_type'
       OR COALESCE(v_payment->>'status', '') NOT IN (
         'PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'
       )
       OR v_payment->>'external_reference' IS DISTINCT FROM v_operation.payload->>'payment_external_reference'
       OR COALESCE(v_payment->>'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR (
         NULLIF(v_payment->>'payment_date', '') IS NOT NULL
         AND v_payment->>'payment_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       )
       OR (
         NULLIF(v_payment->>'credit_date', '') IS NOT NULL
         AND v_payment->>'credit_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       )
       OR COALESCE(v_payment->>'value', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR (v_payment->>'value')::NUMERIC <= 0
       OR (
         NULLIF(v_payment->>'net_value', '') IS NOT NULL
         AND v_payment->>'net_value' !~ '^[0-9]+([.][0-9]+)?$'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela retornada pelo Asaas é inválida';
    END IF;

    IF v_payment->>'payment_id' = ANY(v_payment_ids) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O Asaas retornou parcelas duplicadas';
    END IF;
    v_payment_ids := array_append(v_payment_ids, v_payment->>'payment_id');
    v_sum_cents := v_sum_cents + round((v_payment->>'value')::NUMERIC * 100)::BIGINT;

    IF v_expected_installments = 1 THEN
      IF NULLIF(v_payment->>'installment_group_id', '') IS NOT NULL
         OR NULLIF(v_payment->>'installment_number', '') IS NOT NULL
         OR v_payment->>'due_date' IS DISTINCT FROM v_operation.payload->>'due_date' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cobrança avulsa retornada pelo Asaas é inválida';
      END IF;
      v_primary_payment := v_payment;
    ELSE
      IF NULLIF(v_payment->>'installment_group_id', '') IS NULL
         OR COALESCE(v_payment->>'installment_number', '') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcelamento retornado pelo Asaas é inválido';
      END IF;
      v_installment_number := (v_payment->>'installment_number')::INTEGER;
      IF v_installment_number < 1 OR v_installment_number > v_expected_installments
         OR v_installment_number = ANY(v_installment_numbers) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Sequência de parcelas retornada pelo Asaas é inválida';
      END IF;
      v_installment_numbers := array_append(v_installment_numbers, v_installment_number);
      IF v_installment_group_id IS NULL THEN
        v_installment_group_id := v_payment->>'installment_group_id';
      ELSIF v_payment->>'installment_group_id' IS DISTINCT FROM v_installment_group_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O Asaas retornou mais de um parcelamento';
      END IF;
      IF v_installment_number = 1 THEN
        IF v_payment->>'due_date' IS DISTINCT FROM v_operation.payload->>'due_date' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Vencimento inicial do parcelamento é inválido';
        END IF;
        v_primary_payment := v_payment;
      END IF;
    END IF;
  END LOOP;

  IF v_primary_payment IS NULL
     OR v_primary_payment->>'payment_id' IS DISTINCT FROM v_payment_id
     OR v_sum_cents IS DISTINCT FROM v_expected_total_cents
     OR (
       v_expected_installments > 1
       AND cardinality(v_installment_numbers) IS DISTINCT FROM v_expected_installments
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Conjunto de parcelas retornado pelo Asaas é inválido';
  END IF;

  v_current_cpf_hash := pg_catalog.encode(
    extensions.digest(
      regexp_replace(COALESCE(v_current_customer_cpf, ''), '[^0-9]', '', 'g'),
      'sha256'
    ),
    'hex'
  );

  IF v_charge_id IS NOT NULL AND v_charge_id IS DISTINCT FROM v_payment_id THEN
    v_error := 'Outra cobrança foi vinculada à venda durante a operação';
  ELSIF NULLIF(v_external_link, '') IS NOT NULL THEN
    v_error := 'Uma cobrança externa foi vinculada à venda durante a operação';
  ELSIF COALESCE(v_manual_payment, false) THEN
    v_error := 'Um pagamento manual foi registrado durante a operação';
  ELSIF COALESCE(v_payment_status, '') NOT IN (
    'pending', 'awaiting_charge', 'charge_sent', 'overdue'
  ) THEN
    v_error := 'O pagamento da venda foi concluído durante a operação';
  ELSIF v_operation.order_type = 'contract'
        AND v_record_status IN ('cancelled', 'voided', 'finished') THEN
    v_error := 'O contrato foi encerrado durante a operação';
  ELSIF v_total IS DISTINCT FROM (v_operation.payload->>'total_value')::NUMERIC THEN
    v_error := 'O valor da venda mudou durante a operação';
  ELSIF v_current_customer_id IS DISTINCT FROM NULLIF(v_operation.payload->>'local_customer_id', '')::UUID THEN
    v_error := 'O cliente da venda mudou durante a operação';
  ELSIF v_current_cpf_hash IS DISTINCT FROM v_operation.payload->>'original_customer_cpf_hash' THEN
    v_error := 'O CPF cadastrado mudou durante a operação';
  ELSIF NULLIF(v_current_asaas_customer_id, '') IS DISTINCT FROM
        NULLIF(v_operation.payload->>'original_asaas_customer_id', '') THEN
    v_error := 'O vínculo do cliente no Asaas mudou durante a operação';
  ELSIF v_operation.order_type = 'contract'
        AND v_current_plan_id IS DISTINCT FROM NULLIF(v_operation.payload->>'plan_id', '')::UUID THEN
    v_error := 'O plano do contrato mudou durante a operação';
  ELSIF v_operation.order_type = 'contract'
        AND v_operation.payload->>'billing_type' = 'CREDIT_CARD'
        AND v_current_installments IS DISTINCT FROM (v_operation.payload->>'installments')::INTEGER THEN
    v_error := 'O parcelamento do contrato mudou durante a operação';
  END IF;

  -- Webhooks may arrive after Asaas responds but before this completion RPC.
  -- Validate every existing cache row first so a newer paid status is kept and
  -- a deleted/refunded installment cannot be silently recreated.
  FOR v_payment IN
    SELECT value FROM jsonb_array_elements(v_payments)
  LOOP
    SELECT payment.* INTO v_cached_payment
    FROM public.asaas_payments payment
    WHERE payment.asaas_payment_id = v_payment->>'payment_id'
    FOR UPDATE;

    IF FOUND THEN
      IF v_cached_payment.source IS DISTINCT FROM 'asaas'
         OR (v_cached_payment.order_id IS NULL) IS DISTINCT FROM
              (v_cached_payment.order_type IS NULL)
         OR (
           v_cached_payment.order_id IS NOT NULL
           AND (
             v_cached_payment.order_id IS DISTINCT FROM v_operation.order_id
             OR v_cached_payment.order_type IS DISTINCT FROM v_operation.order_type
           )
         )
         OR (
           v_cached_payment.asaas_customer_id IS NOT NULL
           AND v_cached_payment.asaas_customer_id IS DISTINCT FROM v_payment->>'customer_id'
         )
         OR (
           v_cached_payment.external_reference IS NOT NULL
           AND v_cached_payment.external_reference IS DISTINCT FROM v_payment->>'external_reference'
         )
         OR (
           v_cached_payment.billing_type IS NOT NULL
           AND v_cached_payment.billing_type IS DISTINCT FROM v_payment->>'billing_type'
         )
         OR round(v_cached_payment.value * 100)::BIGINT IS DISTINCT FROM
              round((v_payment->>'value')::NUMERIC * 100)::BIGINT
         OR (
           v_cached_payment.total_installments IS NOT NULL
           AND v_cached_payment.total_installments IS DISTINCT FROM v_expected_installments
         )
         OR (
           v_cached_payment.installment_group_id IS NOT NULL
           AND v_cached_payment.installment_group_id IS DISTINCT FROM
                NULLIF(v_payment->>'installment_group_id', '')
         )
         OR (
           v_cached_payment.installment_number IS NOT NULL
           AND v_cached_payment.installment_number IS DISTINCT FROM
                NULLIF(v_payment->>'installment_number', '')::INTEGER
         ) THEN
        v_error := 'Uma parcela recebida por webhook diverge do retorno de criação';
        EXIT;
      ELSIF v_cached_payment.status IN (
        'DELETED', 'CANCELLED', 'CANCELED', 'REFUNDED'
      ) THEN
        v_error := 'Uma parcela foi removida ou estornada antes da conclusão local';
        EXIT;
      END IF;
    END IF;
  END LOOP;

  SELECT payment.asaas_payment_id INTO v_conflicting_payment_id
  FROM public.asaas_payments payment
  WHERE payment.order_id = v_operation.order_id
    AND payment.order_type = v_operation.order_type
    AND payment.source = 'asaas'
    AND COALESCE(payment.status, '') NOT IN ('CANCELLED', 'CANCELED', 'REFUNDED', 'DELETED')
    AND NOT (payment.asaas_payment_id = ANY(v_payment_ids))
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_error := 'Outra cobrança Asaas está vinculada à venda';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        payload = (payload - ARRAY[
          'customer_cpf', 'customer_name', 'customer_email', 'customer_phone'
        ]) || jsonb_build_object(
          'customer_cpf_last4', right(COALESCE(payload->>'customer_cpf', ''), 4)
        ),
        external_result = p_external_result,
        last_error = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', 'reconciliation_required',
      'error', v_error
    );
  END IF;

  v_payment_method := CASE v_operation.payload->>'billing_type'
    WHEN 'CREDIT_CARD' THEN 'card_' || (v_operation.payload->>'installments') || 'x'
    WHEN 'BOLETO' THEN 'boleto'
    ELSE 'pix'
  END;

  -- Claim every confirmed provider payment before mutating the sale. The
  -- conditional conflict update prevents a webhook row from being stolen.
  FOR v_payment IN
    SELECT value FROM jsonb_array_elements(v_payments)
  LOOP
    INSERT INTO public.asaas_payments AS cached (
      asaas_payment_id, asaas_customer_id, installment_group_id,
      installment_number, total_installments, billing_type, status, value,
      net_value, due_date, payment_date, credit_date, description,
      external_reference, order_id,
      order_type, raw, source, last_synced_at, updated_at
    )
    VALUES (
      v_payment->>'payment_id',
      v_payment->>'customer_id',
      NULLIF(v_payment->>'installment_group_id', ''),
      NULLIF(v_payment->>'installment_number', '')::INTEGER,
      v_expected_installments,
      v_payment->>'billing_type',
      v_payment->>'status',
      (v_payment->>'value')::NUMERIC,
      NULLIF(v_payment->>'net_value', '')::NUMERIC,
      (v_payment->>'due_date')::DATE,
      NULLIF(v_payment->>'payment_date', '')::DATE,
      NULLIF(v_payment->>'credit_date', '')::DATE,
      COALESCE(NULLIF(v_payment->>'description', ''), v_operation.payload->>'description'),
      v_payment->>'external_reference',
      v_operation.order_id,
      v_operation.order_type,
      v_payment,
      'asaas',
      now(),
      now()
    )
    ON CONFLICT (asaas_payment_id) DO UPDATE
    SET asaas_customer_id = COALESCE(cached.asaas_customer_id, EXCLUDED.asaas_customer_id),
        installment_group_id = COALESCE(cached.installment_group_id, EXCLUDED.installment_group_id),
        installment_number = COALESCE(cached.installment_number, EXCLUDED.installment_number),
        total_installments = EXCLUDED.total_installments,
        billing_type = COALESCE(cached.billing_type, EXCLUDED.billing_type),
        status = CASE
          WHEN cached.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
            THEN cached.status
          WHEN p_external_result->>'outcome' = 'recovered'
            THEN EXCLUDED.status
          ELSE cached.status
        END,
        value = cached.value,
        net_value = CASE
          WHEN p_external_result->>'outcome' = 'recovered'
            THEN COALESCE(EXCLUDED.net_value, cached.net_value)
          ELSE COALESCE(cached.net_value, EXCLUDED.net_value)
        END,
        due_date = CASE
          WHEN p_external_result->>'outcome' = 'recovered'
            THEN EXCLUDED.due_date
          ELSE COALESCE(cached.due_date, EXCLUDED.due_date)
        END,
        payment_date = COALESCE(EXCLUDED.payment_date, cached.payment_date),
        credit_date = COALESCE(EXCLUDED.credit_date, cached.credit_date),
        description = COALESCE(cached.description, EXCLUDED.description),
        external_reference = COALESCE(cached.external_reference, EXCLUDED.external_reference),
        order_id = EXCLUDED.order_id,
        order_type = EXCLUDED.order_type,
        raw = CASE
          WHEN p_external_result->>'outcome' = 'recovered' THEN EXCLUDED.raw
          ELSE COALESCE(cached.raw, EXCLUDED.raw)
        END,
        source = 'asaas',
        last_synced_at = COALESCE(cached.last_synced_at, now()),
        updated_at = now()
    WHERE cached.source = 'asaas'
      AND (
        (cached.order_id IS NULL AND cached.order_type IS NULL)
        OR (
          cached.order_id = EXCLUDED.order_id
          AND cached.order_type IS NOT DISTINCT FROM EXCLUDED.order_type
        )
      )
    RETURNING asaas_payment_id INTO v_upserted_payment_id;

    IF NOT FOUND THEN
      v_error := 'Uma parcela do Asaas já está vinculada a outra venda';
      EXIT;
    END IF;
  END LOOP;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        payload = (payload - ARRAY[
          'customer_cpf', 'customer_name', 'customer_email', 'customer_phone'
        ]) || jsonb_build_object(
          'customer_cpf_last4', right(COALESCE(payload->>'customer_cpf', ''), 4)
        ),
        external_result = p_external_result,
        last_error = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', 'reconciliation_required',
      'error', v_error
    );
  END IF;

  SELECT payment.status, payment.payment_date, payment.due_date
  INTO v_effective_provider_status, v_effective_payment_date,
       v_effective_due_date
  FROM public.asaas_payments payment
  WHERE payment.asaas_payment_id = v_payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A cobrança principal não foi persistida';
  END IF;
  v_effective_payment_status := CASE
    WHEN v_effective_provider_status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN 'paid'
    WHEN v_effective_provider_status = 'OVERDUE' THEN 'overdue'
    ELSE 'charge_sent'
  END;

  IF v_effective_payment_status = 'paid' THEN
    DELETE FROM public.asaas_payments
    WHERE order_id = v_operation.order_id
      AND order_type = v_operation.order_type
      AND source = 'manual';
  END IF;

  IF v_operation.order_type = 'presale' THEN
    UPDATE public.presale_orders
    SET asaas_customer_id = v_customer_id,
        asaas_charge_id = v_payment_id,
        asaas_payment_link = NULLIF(p_external_result->>'payment_link', ''),
        asaas_pix_qrcode = NULLIF(p_external_result->>'pix_qrcode', ''),
        asaas_pix_copy = NULLIF(p_external_result->>'pix_copy', ''),
        payment_status = v_effective_payment_status,
        payment_method = v_payment_method,
        due_date = COALESCE(v_effective_due_date, (v_operation.payload->>'due_date')::DATE),
        payment_date = CASE
          WHEN v_effective_payment_status = 'paid'
            THEN COALESCE(v_effective_payment_date, payment_date, CURRENT_DATE)
          ELSE payment_date
        END,
        manual_payment = false,
        updated_date = now()
    WHERE id = v_operation.order_id;
    IF v_current_customer_id IS NOT NULL THEN
      UPDATE public.presale_customers
      SET cpf = v_operation.payload->>'customer_cpf'
      WHERE id = v_current_customer_id;
    END IF;
  ELSIF v_operation.order_type = 'stock' THEN
    UPDATE public.stock_orders
    SET customer_cpf = v_operation.payload->>'customer_cpf',
        asaas_customer_id = v_customer_id,
        asaas_charge_id = v_payment_id,
        asaas_payment_link = NULLIF(p_external_result->>'payment_link', ''),
        asaas_pix_qrcode = NULLIF(p_external_result->>'pix_qrcode', ''),
        asaas_pix_copy = NULLIF(p_external_result->>'pix_copy', ''),
        payment_status = v_effective_payment_status,
        payment_method = v_payment_method,
        due_date = COALESCE(v_effective_due_date, (v_operation.payload->>'due_date')::DATE),
        payment_date = CASE
          WHEN v_effective_payment_status = 'paid'
            THEN COALESCE(v_effective_payment_date, payment_date, CURRENT_DATE)
          ELSE payment_date
        END,
        manual_payment = false,
        updated_date = now()
    WHERE id = v_operation.order_id;
  ELSE
    v_next_contract_status := CASE
      WHEN v_record_status = 'draft'
           AND (SELECT start_date FROM public.assessment_contracts WHERE id = v_operation.order_id)
                 > (now() AT TIME ZONE 'America/Sao_Paulo')::DATE
        THEN 'scheduled'
      WHEN v_record_status = 'draft' THEN 'active'
      ELSE v_record_status
    END;

    UPDATE public.assessment_contracts
    SET asaas_charge_id = v_payment_id,
        asaas_payment_link = NULLIF(p_external_result->>'payment_link', ''),
        asaas_pix_qrcode = NULLIF(p_external_result->>'pix_qrcode', ''),
        asaas_pix_copy = NULLIF(p_external_result->>'pix_copy', ''),
        payment_status = v_effective_payment_status,
        payment_method = v_payment_method,
        due_date = COALESCE(v_effective_due_date, (v_operation.payload->>'due_date')::DATE),
        payment_date = CASE
          WHEN v_effective_payment_status = 'paid'
            THEN COALESCE(v_effective_payment_date, payment_date, CURRENT_DATE)
          ELSE payment_date
        END,
        manual_payment = false,
        status = v_next_contract_status,
        updated_at = now()
    WHERE id = v_operation.order_id;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    v_operation.order_type,
    v_operation.order_id,
    v_operation.payload->>'payment_status',
    v_effective_payment_status,
    CASE
      WHEN v_effective_payment_status = 'paid'
        THEN 'Cobrança Asaas gerada e pagamento confirmado'
      WHEN v_effective_payment_status = 'overdue'
        THEN 'Cobrança Asaas gerada já vencida'
      ELSE 'Cobrança Asaas gerada'
    END,
    jsonb_build_object(
      'action', 'asaas_charge_created',
      'operation_id', v_operation.id,
      'billing_type', v_operation.payload->>'billing_type',
      'installments', (v_operation.payload->>'installments')::INTEGER,
      'due_date', v_operation.payload->>'due_date',
      'asaas_charge_id', v_payment_id,
      'provider_status', v_effective_provider_status,
      'external_outcome', p_external_result->>'outcome'
    ),
    v_operation.requested_by
  );

  IF v_operation.order_type = 'contract' THEN
    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    )
    VALUES (
      v_operation.order_id,
      'charge_generated',
      jsonb_build_object(
        'billing_type', v_operation.payload->>'billing_type',
        'installments', (v_operation.payload->>'installments')::INTEGER,
        'due_date', v_operation.payload->>'due_date',
        'asaas_charge_id', v_payment_id,
        'source', v_operation.payload->>'source',
        'operation_id', v_operation.id
      ),
      'Cobrança Asaas gerada pela API autenticada',
      v_operation.requested_by
    );

    IF v_record_status = 'draft' THEN
      INSERT INTO public.assessment_contract_event (
        contract_id, event_type, payload, created_by
      )
      VALUES (
        v_operation.order_id,
        CASE
          WHEN v_next_contract_status = 'scheduled' THEN 'renewal_scheduled'
          ELSE 'enrollment_activated'
        END,
        jsonb_build_object(
          'source', v_operation.payload->>'source',
          'status_after', v_next_contract_status,
          'operation_id', v_operation.id
        ),
        v_operation.requested_by
      );
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'charge_id', v_payment_id,
    'asaas_charge_id', v_payment_id,
    'payment_link', NULLIF(v_primary_payment->>'payment_link', ''),
    'pix_copy', NULLIF(p_external_result->>'pix_copy', ''),
    'due_date', COALESCE(v_effective_due_date, (v_operation.payload->>'due_date')::DATE),
    'payment_method', v_payment_method,
    'payment_status', v_effective_payment_status,
    'source', v_operation.payload->>'source',
    'installments', (v_operation.payload->>'installments')::INTEGER,
    'total_value', (v_operation.payload->>'total_value')::NUMERIC,
    'contract_status', CASE WHEN v_operation.order_type = 'contract' THEN v_next_contract_status ELSE NULL END
  );

  UPDATE public.order_operations
  SET status = 'completed',
      payload = (payload - ARRAY[
        'customer_cpf', 'customer_name', 'customer_email', 'customer_phone'
      ]) || jsonb_build_object(
        'customer_cpf_last4', right(COALESCE(v_operation.payload->>'customer_cpf', ''), 4)
      ),
      external_result = p_external_result,
      result = v_result,
      last_error = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_order_charge_creation_failure(
  p_operation_id UUID,
  p_lease_token UUID,
  p_error_code TEXT,
  p_error_message TEXT,
  p_requires_reconciliation BOOLEAN DEFAULT false,
  p_external_result JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_status TEXT;
  v_result JSONB;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{3,80}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Código de falha inválido';
  END IF;
  IF NULLIF(trim(p_error_message), '') IS NULL OR char_length(trim(p_error_message)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Descrição de falha inválida';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'create_charge'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cobrança não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'result', v_operation.result
    );
  END IF;
  IF v_operation.status IN ('failed', 'reconciliation_required') THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error,
      'result', v_operation.result
    );
  END IF;
  IF p_lease_token IS NULL OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  v_status := CASE
    WHEN COALESCE(p_requires_reconciliation, false) THEN 'reconciliation_required'
    ELSE 'failed'
  END;
  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'error_code', p_error_code,
    'error', trim(p_error_message)
  );

  UPDATE public.order_operations
  SET status = v_status,
      payload = (payload - ARRAY[
        'customer_cpf', 'customer_name', 'customer_email', 'customer_phone'
      ]) || jsonb_build_object(
        'customer_cpf_last4', right(COALESCE(payload->>'customer_cpf', ''), 4)
      ),
      external_result = COALESCE(p_external_result, '{}'::JSONB),
      result = v_result,
      last_error = trim(p_error_message),
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_operation.id;

  RETURN v_result;
END;
$$;


REVOKE ALL ON FUNCTION public.prepare_order_charge_creation(
  TEXT, UUID, TEXT, DATE, INTEGER, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_charge_creation(
  UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_order_charge_creation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_order_charge_creation(
  TEXT, UUID, TEXT, DATE, INTEGER, TEXT, TEXT, TEXT, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_charge_creation(
  UUID, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_order_charge_creation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) TO service_role;

COMMENT ON FUNCTION public.prepare_order_charge_creation(
  TEXT, UUID, TEXT, DATE, INTEGER, TEXT, TEXT, TEXT, UUID
) IS 'Reserves an idempotent Asaas charge operation and returns its immutable financial snapshot.';
COMMENT ON FUNCTION public.complete_order_charge_creation(
  UUID, UUID, JSONB
) IS 'Atomically links an Asaas charge, its installments, sale state, and audit trail.';
COMMENT ON FUNCTION public.finalize_order_charge_creation_failure(
  UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB
) IS 'Closes a failed charge attempt or blocks it for manual reconciliation.';

