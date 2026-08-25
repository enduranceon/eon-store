-- Integra inscrições de eventos ao fluxo financeiro canônico:
-- /orders/event/... -> order_operations -> asaas_payments -> sales_status_events.

ALTER TABLE public.event_registrations
  ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT;

ALTER TABLE public.order_operations
  DROP CONSTRAINT IF EXISTS order_operations_order_type_check;
ALTER TABLE public.order_operations
  ADD CONSTRAINT order_operations_order_type_check
  CHECK (order_type IN ('presale', 'stock', 'contract', 'event'));

CREATE OR REPLACE FUNCTION public.prepare_event_charge_creation(
  p_order_id UUID,
  p_billing_type TEXT,
  p_due_date DATE,
  p_installments INTEGER,
  p_customer_cpf TEXT,
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
  v_event_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_manual_payment BOOLEAN;
  v_total NUMERIC;
  v_registration_number TEXT;
  v_customer_id UUID;
  v_customer_name TEXT;
  v_customer_email TEXT;
  v_customer_phone TEXT;
  v_current_cpf TEXT;
  v_customer_cpf TEXT;
  v_asaas_customer_id TEXT;
  v_event_name TEXT;
  v_type_name TEXT;
  v_description TEXT;
  v_operation_id UUID;
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
  v_original_cpf_hash TEXT;
  v_request_fingerprint TEXT;
  v_customer_reference TEXT;
  v_payment_reference TEXT;
BEGIN
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

  SELECT
    r.payment_status,
    e.status,
    r.asaas_charge_id,
    r.external_payment_link,
    r.manual_payment,
    round(COALESCE(rt.price, 0), 2),
    r.registration_number,
    r.customer_id,
    c.full_name,
    c.email,
    c.whatsapp,
    c.cpf,
    r.asaas_customer_id,
    e.name,
    rt.name
  INTO
    v_payment_status, v_event_status, v_charge_id, v_external_link,
    v_manual_payment, v_total, v_registration_number, v_customer_id,
    v_customer_name, v_customer_email, v_customer_phone, v_current_cpf,
    v_asaas_customer_id, v_event_name, v_type_name
  FROM public.event_registrations r
  JOIN public.event_registration_types rt ON rt.id = r.registration_type_id
  JOIN public.events e ON e.id = r.event_id
  JOIN public.presale_customers c ON c.id = r.customer_id
  WHERE r.id = p_order_id
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  v_customer_cpf := regexp_replace(
    COALESCE(NULLIF(p_customer_cpf, ''), v_current_cpf, ''),
    '[^0-9]',
    '',
    'g'
  );
  v_original_cpf_hash := pg_catalog.encode(
    extensions.digest(regexp_replace(COALESCE(v_current_cpf, ''), '[^0-9]', '', 'g'), 'sha256'),
    'hex'
  );
  v_description := 'Inscrição ' || COALESCE(v_registration_number, p_order_id::TEXT) ||
    ' - ' || COALESCE(v_event_name, 'Evento') ||
    COALESCE(' - ' || NULLIF(v_type_name, ''), '');
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'billing_type', p_billing_type,
        'due_date', p_due_date,
        'installments', p_installments,
        'customer_cpf', v_customer_cpf,
        'source', 'order_detail'
      )::TEXT,
      'sha256'
    ),
    'hex'
  );

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'create_charge'
    AND operation_key = p_idempotency_key
    AND order_type = 'event'
    AND order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.payload->>'request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A chave de idempotência já foi usada com outros dados';
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
         OR COALESCE(v_payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
         OR v_event_status = 'cancelled'
         OR v_total IS DISTINCT FROM (v_operation.payload->>'total_value')::NUMERIC
         OR v_customer_id IS DISTINCT FROM NULLIF(v_operation.payload->>'local_customer_id', '')::UUID
         OR v_original_cpf_hash IS DISTINCT FROM v_operation.payload->>'original_customer_cpf_hash'
         OR NULLIF(v_asaas_customer_id, '') IS DISTINCT FROM NULLIF(v_operation.payload->>'original_asaas_customer_id', '')
       ) THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          payload = (payload - ARRAY['customer_cpf', 'customer_name', 'customer_email', 'customer_phone'])
            || jsonb_build_object('customer_cpf_last4', right(COALESCE(payload->>'customer_cpf', ''), 4)),
          last_error = 'O estado financeiro da inscrição mudou antes da retomada da cobrança',
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

  IF COALESCE(v_payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente inscrições ainda não pagas aceitam nova cobrança';
  END IF;
  IF v_event_status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este evento foi cancelado';
  END IF;
  IF NULLIF(v_charge_id, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição já possui cobrança Asaas';
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
  IF EXISTS (
    SELECT 1
    FROM public.asaas_payments payment
    WHERE payment.order_type = 'event'
      AND payment.order_id = p_order_id
      AND payment.source = 'asaas'
      AND COALESCE(payment.status, '') NOT IN ('CANCELLED', 'CANCELED', 'REFUNDED', 'DELETED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição possui uma cobrança Asaas ativa no fluxo financeiro';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.order_operations operation
    WHERE operation.order_type = 'event'
      AND operation.order_id = p_order_id
      AND operation.status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outra operação financeira pendente para esta inscrição';
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
    'event',
    p_order_id,
    'prepared',
    p_actor_id,
    'Criação de cobrança Asaas para inscrição de evento',
    jsonb_build_object(
      'payment_status', v_payment_status,
      'record_status', v_event_status,
      'order_number', v_registration_number,
      'total_value', v_total,
      'billing_type', p_billing_type,
      'due_date', p_due_date,
      'installments', p_installments,
      'customer_cpf', v_customer_cpf,
      'customer_name', trim(v_customer_name),
      'customer_email', NULLIF(trim(v_customer_email), ''),
      'customer_phone', NULLIF(regexp_replace(COALESCE(v_customer_phone, ''), '[^0-9]', '', 'g'), ''),
      'local_customer_id', v_customer_id,
      'original_customer_cpf_hash', v_original_cpf_hash,
      'asaas_customer_id', v_asaas_customer_id,
      'original_asaas_customer_id', v_asaas_customer_id,
      'customer_external_reference', v_customer_reference,
      'payment_external_reference', v_payment_reference,
      'description', v_description,
      'source', 'order_detail',
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
    'installments', p_installments,
    'total_value', v_total,
    'customer_cpf', v_customer_cpf,
    'customer_name', trim(v_customer_name),
    'customer_email', NULLIF(trim(v_customer_email), ''),
    'customer_phone', NULLIF(regexp_replace(COALESCE(v_customer_phone, ''), '[^0-9]', '', 'g'), ''),
    'asaas_customer_id', v_asaas_customer_id,
    'customer_external_reference', v_customer_reference,
    'payment_external_reference', v_payment_reference,
    'description', v_description,
    'source', 'order_detail',
    'result', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_event_charge_creation(
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
  v_event_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_manual_payment BOOLEAN;
  v_total NUMERIC;
  v_customer_id UUID;
  v_current_cpf TEXT;
  v_current_cpf_hash TEXT;
  v_current_asaas_customer_id TEXT;
  v_payment_id TEXT;
  v_provider_customer_id TEXT;
  v_payments JSONB;
  v_payment JSONB;
  v_primary_payment JSONB;
  v_expected_installments INTEGER;
  v_expected_total_cents BIGINT;
  v_sum_cents BIGINT := 0;
  v_effective_provider_status TEXT;
  v_effective_payment_status TEXT;
  v_effective_payment_date DATE;
  v_effective_due_date DATE;
  v_payment_method TEXT;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'create_charge'
    AND order_type = 'event';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cobrança não encontrada';
  END IF;

  SELECT
    r.payment_status,
    e.status,
    r.asaas_charge_id,
    r.external_payment_link,
    r.manual_payment,
    round(COALESCE(rt.price, 0), 2),
    r.customer_id,
    c.cpf,
    r.asaas_customer_id
  INTO
    v_payment_status, v_event_status, v_charge_id, v_external_link,
    v_manual_payment, v_total, v_customer_id, v_current_cpf,
    v_current_asaas_customer_id
  FROM public.event_registrations r
  JOIN public.event_registration_types rt ON rt.id = r.registration_type_id
  JOIN public.events e ON e.id = r.event_id
  JOIN public.presale_customers c ON c.id = r.customer_id
  WHERE r.id = v_operation.order_id
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'create_charge'
    AND order_type = 'event'
  FOR UPDATE;

  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status = 'reconciliation_required' THEN
    RETURN jsonb_build_object('operation_id', v_operation.id, 'status', v_operation.status, 'error', v_operation.last_error);
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

  v_expected_installments := (v_operation.payload->>'installments')::INTEGER;
  v_expected_total_cents := round((v_operation.payload->>'total_value')::NUMERIC * 100)::BIGINT;
  v_payment_id := NULLIF(p_external_result->>'payment_id', '');
  v_provider_customer_id := NULLIF(p_external_result->>'customer_id', '');
  v_payments := p_external_result->'payments';

  IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
     OR COALESCE(p_external_result->>'outcome', '') NOT IN ('created', 'recovered')
     OR p_external_result->>'source' IS DISTINCT FROM 'order_detail'
     OR v_payment_id IS NULL
     OR v_provider_customer_id IS NULL
     OR COALESCE(p_external_result->>'requested_total_value', '') !~ '^[0-9]+([.][0-9]+)?$'
     OR round((p_external_result->>'requested_total_value')::NUMERIC * 100)::BIGINT IS DISTINCT FROM v_expected_total_cents
     OR COALESCE(p_external_result->>'total_installments', '') !~ '^[0-9]+$'
     OR (p_external_result->>'total_installments')::INTEGER IS DISTINCT FROM v_expected_installments
     OR jsonb_typeof(v_payments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(COALESCE(v_payments, '[]'::JSONB)) IS DISTINCT FROM v_expected_installments THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
  END IF;

  FOR v_payment IN SELECT value FROM jsonb_array_elements(v_payments)
  LOOP
    IF jsonb_typeof(v_payment) IS DISTINCT FROM 'object'
       OR NULLIF(v_payment->>'payment_id', '') IS NULL
       OR v_payment->>'customer_id' IS DISTINCT FROM v_provider_customer_id
       OR v_payment->>'billing_type' IS DISTINCT FROM v_operation.payload->>'billing_type'
       OR COALESCE(v_payment->>'status', '') NOT IN ('PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
       OR v_payment->>'external_reference' IS DISTINCT FROM v_operation.payload->>'payment_external_reference'
       OR COALESCE(v_payment->>'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR COALESCE(v_payment->>'value', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR (v_payment->>'value')::NUMERIC <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela retornada pelo Asaas é inválida';
    END IF;

    v_sum_cents := v_sum_cents + round((v_payment->>'value')::NUMERIC * 100)::BIGINT;
    IF v_payment->>'payment_id' = v_payment_id THEN
      v_primary_payment := v_payment;
    END IF;
  END LOOP;

  IF v_primary_payment IS NULL OR v_sum_cents IS DISTINCT FROM v_expected_total_cents THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Conjunto de parcelas retornado pelo Asaas é inválido';
  END IF;

  v_current_cpf_hash := pg_catalog.encode(
    extensions.digest(regexp_replace(COALESCE(v_current_cpf, ''), '[^0-9]', '', 'g'), 'sha256'),
    'hex'
  );

  IF v_charge_id IS NOT NULL AND v_charge_id IS DISTINCT FROM v_payment_id THEN
    v_error := 'Outra cobrança foi vinculada à inscrição durante a operação';
  ELSIF NULLIF(v_external_link, '') IS NOT NULL THEN
    v_error := 'Uma cobrança externa foi vinculada à inscrição durante a operação';
  ELSIF COALESCE(v_manual_payment, false) THEN
    v_error := 'Um pagamento manual foi registrado durante a operação';
  ELSIF COALESCE(v_payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    v_error := 'O pagamento da inscrição foi concluído durante a operação';
  ELSIF v_event_status = 'cancelled' THEN
    v_error := 'O evento foi cancelado durante a operação';
  ELSIF v_total IS DISTINCT FROM (v_operation.payload->>'total_value')::NUMERIC THEN
    v_error := 'O valor da inscrição mudou durante a operação';
  ELSIF v_customer_id IS DISTINCT FROM NULLIF(v_operation.payload->>'local_customer_id', '')::UUID THEN
    v_error := 'O cliente da inscrição mudou durante a operação';
  ELSIF v_current_cpf_hash IS DISTINCT FROM v_operation.payload->>'original_customer_cpf_hash' THEN
    v_error := 'O CPF cadastrado mudou durante a operação';
  ELSIF NULLIF(v_current_asaas_customer_id, '') IS DISTINCT FROM NULLIF(v_operation.payload->>'original_asaas_customer_id', '') THEN
    v_error := 'O vínculo do cliente no Asaas mudou durante a operação';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        payload = (payload - ARRAY['customer_cpf', 'customer_name', 'customer_email', 'customer_phone'])
          || jsonb_build_object('customer_cpf_last4', right(COALESCE(payload->>'customer_cpf', ''), 4)),
        external_result = p_external_result,
        last_error = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object('operation_id', v_operation.id, 'status', 'reconciliation_required', 'error', v_error);
  END IF;

  FOR v_payment IN SELECT value FROM jsonb_array_elements(v_payments)
  LOOP
    INSERT INTO public.asaas_payments AS cached (
      asaas_payment_id, asaas_customer_id, installment_group_id,
      installment_number, total_installments, billing_type, status, value,
      net_value, due_date, payment_date, credit_date, description,
      external_reference, order_id, order_type, raw, source, last_synced_at,
      updated_at
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
      'event',
      v_payment,
      'asaas',
      now(),
      now()
    )
    ON CONFLICT (asaas_payment_id) DO UPDATE
    SET asaas_customer_id = EXCLUDED.asaas_customer_id,
        installment_group_id = EXCLUDED.installment_group_id,
        installment_number = EXCLUDED.installment_number,
        total_installments = EXCLUDED.total_installments,
        billing_type = EXCLUDED.billing_type,
        status = CASE
          WHEN cached.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN cached.status
          ELSE EXCLUDED.status
        END,
        value = EXCLUDED.value,
        net_value = COALESCE(EXCLUDED.net_value, cached.net_value),
        due_date = EXCLUDED.due_date,
        payment_date = COALESCE(EXCLUDED.payment_date, cached.payment_date),
        credit_date = COALESCE(EXCLUDED.credit_date, cached.credit_date),
        description = COALESCE(EXCLUDED.description, cached.description),
        external_reference = EXCLUDED.external_reference,
        order_id = EXCLUDED.order_id,
        order_type = EXCLUDED.order_type,
        raw = EXCLUDED.raw,
        source = 'asaas',
        last_synced_at = now(),
        updated_at = now()
    WHERE cached.source = 'asaas'
      AND (
        (cached.order_id IS NULL AND cached.order_type IS NULL)
        OR (cached.order_id = EXCLUDED.order_id AND cached.order_type IS NOT DISTINCT FROM EXCLUDED.order_type)
      );
  END LOOP;

  SELECT payment.status, payment.payment_date, payment.due_date
  INTO v_effective_provider_status, v_effective_payment_date, v_effective_due_date
  FROM public.asaas_payments payment
  WHERE payment.asaas_payment_id = v_payment_id;

  v_effective_payment_status := CASE
    WHEN v_effective_provider_status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN 'paid'
    WHEN v_effective_provider_status = 'OVERDUE' THEN 'overdue'
    ELSE 'charge_sent'
  END;
  v_payment_method := CASE v_operation.payload->>'billing_type'
    WHEN 'CREDIT_CARD' THEN 'card_' || (v_operation.payload->>'installments') || 'x'
    WHEN 'BOLETO' THEN 'boleto'
    ELSE 'pix'
  END;

  IF v_effective_payment_status = 'paid' THEN
    DELETE FROM public.asaas_payments
    WHERE order_id = v_operation.order_id
      AND order_type = 'event'
      AND source = 'manual';
  END IF;

  UPDATE public.event_registrations
  SET asaas_customer_id = v_provider_customer_id,
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
      updated_at = now()
  WHERE id = v_operation.order_id;

  UPDATE public.presale_customers
  SET cpf = v_operation.payload->>'customer_cpf',
      updated_date = now()
  WHERE id = v_customer_id
    AND (cpf IS NULL OR regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') = '');

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    'event',
    v_operation.order_id,
    v_operation.payload->>'payment_status',
    v_effective_payment_status,
    CASE
      WHEN v_effective_payment_status = 'paid' THEN 'Cobrança Asaas gerada e pagamento confirmado'
      WHEN v_effective_payment_status = 'overdue' THEN 'Cobrança Asaas gerada já vencida'
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

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'order_id', v_operation.order_id,
    'order_type', 'event',
    'charge_id', v_payment_id,
    'asaas_charge_id', v_payment_id,
    'payment_link', NULLIF(p_external_result->>'payment_link', ''),
    'pix_copy', NULLIF(p_external_result->>'pix_copy', ''),
    'due_date', COALESCE(v_effective_due_date, (v_operation.payload->>'due_date')::DATE),
    'payment_method', v_payment_method,
    'payment_status', v_effective_payment_status,
    'source', 'order_detail',
    'installments', (v_operation.payload->>'installments')::INTEGER,
    'total_value', (v_operation.payload->>'total_value')::NUMERIC
  );

  UPDATE public.order_operations
  SET status = 'completed',
      payload = (payload - ARRAY['customer_cpf', 'customer_name', 'customer_email', 'customer_phone'])
        || jsonb_build_object('customer_cpf_last4', right(COALESCE(v_operation.payload->>'customer_cpf', ''), 4)),
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

CREATE OR REPLACE FUNCTION public.api_record_event_manual_payment(
  p_order_id UUID,
  p_payment_method_id UUID,
  p_payment_date DATE,
  p_total NUMERIC,
  p_installments JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_method public.payment_methods%ROWTYPE;
  v_previous_status TEXT;
  v_total NUMERIC;
  v_registration_number TEXT;
  v_asaas_charge_id TEXT;
  v_manual_payment BOOLEAN;
  v_fee NUMERIC;
  v_installment_count INTEGER;
  v_item JSONB;
  v_number INTEGER;
  v_due_date DATE;
  v_credit_date DATE;
  v_value NUMERIC;
  v_allocated_value NUMERIC := 0;
  v_method_code TEXT;
  v_expected_number INTEGER := 1;
  v_existing_count INTEGER;
  v_existing_total NUMERIC;
  v_existing_method_matches BOOLEAN;
  v_existing_date_matches BOOLEAN;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_order_id IS NULL OR p_payment_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do pagamento são inválidos';
  END IF;
  IF p_payment_date > (now() AT TIME ZONE 'America/Sao_Paulo')::DATE THEN
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

  SELECT round(COALESCE(rt.price, 0), 2), r.payment_status, r.registration_number,
         r.asaas_charge_id, r.manual_payment
  INTO v_total, v_previous_status, v_registration_number, v_asaas_charge_id,
       v_manual_payment
  FROM public.event_registrations r
  JOIN public.event_registration_types rt ON rt.id = r.registration_type_id
  WHERE r.id = p_order_id
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_previous_status IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Não é possível registrar pagamento nesta inscrição';
  END IF;
  IF v_previous_status = 'paid' AND NOT COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição já foi paga por outro fluxo';
  END IF;
  IF NULLIF(v_asaas_charge_id, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cancele a cobrança Asaas antes de registrar pagamento por fora';
  END IF;
  IF abs(round(COALESCE(v_total, 0), 2) - round(p_total, 2)) > 0.009 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Pagamento parcial ainda não está habilitado. Informe o valor integral.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.asaas_payments
    WHERE order_id = p_order_id
      AND order_type = 'event'
      AND source = 'asaas'
      AND status IN ('PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe uma cobrança Asaas ativa. Cancele ou estorne antes de registrar pagamento por fora.';
  END IF;

  v_installment_count := GREATEST(1, LEAST(12, COALESCE(v_method.installments, 1)));
  IF jsonb_typeof(p_installments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_installments) <> v_installment_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Projeção de parcelas inválida';
  END IF;

  SELECT count(*)::INTEGER, COALESCE(sum(value), 0),
         COALESCE(bool_and(payment_method_id = v_method.id), false),
         COALESCE(bool_and(payment_date = p_payment_date), false)
  INTO v_existing_count, v_existing_total, v_existing_method_matches, v_existing_date_matches
  FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = 'event'
    AND source = 'manual'
    AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH');

  IF v_previous_status = 'paid'
     AND COALESCE(v_manual_payment, false)
     AND v_existing_count = v_installment_count
     AND round(v_existing_total, 2) = round(p_total, 2)
     AND v_existing_method_matches
     AND v_existing_date_matches THEN
    RETURN jsonb_build_object(
      'installments', v_installment_count,
      'total_gross', round(p_total, 2),
      'total_fee', round((p_total * COALESCE(v_method.fee_percent, 0) / 100) + COALESCE(v_method.fee_fixed, 0), 2),
      'total_net', round(p_total, 2),
      'value_per_installment', round(p_total / v_installment_count, 2),
      'already_recorded', true
    );
  END IF;

  v_fee := round((p_total * COALESCE(v_method.fee_percent, 0) / 100) + COALESCE(v_method.fee_fixed, 0), 2);
  v_method_code := COALESCE(NULLIF(v_method.internal_code, ''), v_method.kind);

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = 'event'
    AND source = 'manual';

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_installments)
    ORDER BY (value->>'number')::INTEGER
  LOOP
    v_number := (v_item->>'number')::INTEGER;
    v_due_date := (v_item->>'due_date')::DATE;
    v_credit_date := (v_item->>'credit_date')::DATE;
    IF v_number IS NULL OR v_number <> v_expected_number
       OR v_due_date IS NULL OR v_credit_date IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela inválida';
    END IF;

    IF v_number = v_installment_count THEN
      v_value := round(p_total, 2) - v_allocated_value;
    ELSE
      v_value := round(p_total / v_installment_count, 2);
    END IF;

    INSERT INTO public.asaas_payments(
      asaas_payment_id, source, payment_method_id, installment_number,
      total_installments, billing_type, status, value, net_value, due_date,
      credit_date, payment_date, description, external_reference, order_id,
      order_type, raw, last_synced_at
    )
    VALUES (
      'manual_' || p_order_id::TEXT || '_' || v_number || '_' || replace(gen_random_uuid()::TEXT, '-', ''),
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
      'Pagamento manual - ' || v_method.name ||
        CASE WHEN v_installment_count > 1 THEN ' (parcela ' || v_number || '/' || v_installment_count || ')' ELSE '' END,
      v_registration_number,
      p_order_id,
      'event',
      NULL,
      now()
    );

    v_allocated_value := v_allocated_value + v_value;
    v_expected_number := v_expected_number + 1;
  END LOOP;

  UPDATE public.event_registrations
  SET payment_status = 'paid',
      payment_method = v_method_code,
      payment_date = p_payment_date,
      manual_payment = true,
      updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    'event',
    p_order_id,
    v_previous_status,
    'paid',
    CASE WHEN v_previous_status = 'paid' THEN 'manual_payment_reconciled' ELSE 'manual_payment_recorded' END,
    jsonb_build_object(
      'payment_method_id', v_method.id,
      'payment_method', v_method_code,
      'payment_date', p_payment_date,
      'total', round(p_total, 2),
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

CREATE OR REPLACE FUNCTION public.api_reopen_event_manual_payment(
  p_order_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status TEXT;
  v_manual_payment BOOLEAN;
  v_asaas_charge_id TEXT;
  v_payment_method TEXT;
  v_removed INTEGER := 0;
BEGIN
  IF p_actor_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;

  SELECT payment_status, manual_payment, asaas_charge_id, payment_method
  INTO v_payment_status, v_manual_payment, v_asaas_charge_id, v_payment_method
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_payment_status = 'awaiting_charge' AND NOT COALESCE(v_manual_payment, false) THEN
    RETURN jsonb_build_object('reopened', true, 'already_reopened', true, 'payment_status', 'awaiting_charge', 'manual_payments_removed', 0);
  END IF;
  IF v_payment_status <> 'paid' OR NOT COALESCE(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente pagamentos manuais confirmados podem ser reabertos';
  END IF;
  IF NULLIF(v_asaas_charge_id, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição possui uma cobrança Asaas vinculada e precisa de conferência';
  END IF;

  DELETE FROM public.asaas_payments
  WHERE order_id = p_order_id
    AND order_type = 'event'
    AND source = 'manual';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  UPDATE public.event_registrations
  SET payment_status = 'awaiting_charge',
      payment_date = NULL,
      payment_method = NULL,
      manual_payment = false,
      updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    'event',
    p_order_id,
    v_payment_status,
    'awaiting_charge',
    'manual_payment_reopened',
    jsonb_build_object(
      'payment_method_before', v_payment_method,
      'manual_payments_removed', v_removed
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('reopened', true, 'already_reopened', false, 'payment_status', 'awaiting_charge', 'manual_payments_removed', v_removed);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_event_payment_message_sent_with_metadata(
  p_order_id UUID,
  p_external_payment_link TEXT,
  p_due_date DATE,
  p_metadata JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status TEXT;
  v_charge_id TEXT;
  v_payment_link TEXT;
  v_pix_copy TEXT;
  v_existing_external_link TEXT;
  v_previous_status TEXT;
  v_external_link TEXT := NULLIF(trim(p_external_payment_link), '');
  v_result JSONB;
BEGIN
  IF p_actor_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
     OR pg_column_size(p_metadata) > 32768 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Metadados da comunicação inválidos';
  END IF;
  IF v_external_link IS NOT NULL AND (
    char_length(v_external_link) > 2000 OR v_external_link !~* '^https://[^[:space:]]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Link externo inválido';
  END IF;

  SELECT payment_status, asaas_charge_id, asaas_payment_link, asaas_pix_copy,
         external_payment_link
  INTO v_payment_status, v_charge_id, v_payment_link, v_pix_copy,
       v_existing_external_link
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição não aceita envio de cobrança neste estado';
  END IF;
  IF NULLIF(v_charge_id, '') IS NULL
     AND NULLIF(v_payment_link, '') IS NULL
     AND NULLIF(v_pix_copy, '') IS NULL
     AND COALESCE(v_external_link, NULLIF(v_existing_external_link, '')) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Gere uma cobrança ou informe um link externo antes de enviar';
  END IF;
  IF NULLIF(v_charge_id, '') IS NULL AND p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a data de vencimento da cobrança externa';
  END IF;

  v_previous_status := v_payment_status;

  UPDATE public.event_registrations r
  SET payment_message_sent_at = now(),
      external_payment_link = CASE
        WHEN NULLIF(v_charge_id, '') IS NULL THEN COALESCE(v_external_link, v_existing_external_link)
        ELSE external_payment_link
      END,
      due_date = CASE
        WHEN NULLIF(v_charge_id, '') IS NULL THEN p_due_date
        ELSE due_date
      END,
      payment_status = CASE
        WHEN payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
        ELSE payment_status
      END,
      updated_at = now()
  WHERE r.id = p_order_id
  RETURNING to_jsonb(r) INTO v_result;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'event', p_order_id, v_previous_status,
    CASE WHEN v_previous_status IN ('pending', 'awaiting_charge') THEN 'charge_sent' ELSE v_previous_status END,
    CASE WHEN v_previous_status = 'charge_sent' THEN 'Cobrança reenviada' ELSE 'Cobrança enviada' END,
    jsonb_build_object(
      'action', CASE WHEN v_previous_status = 'charge_sent' THEN 'charge_resent' ELSE 'charge_sent' END,
      'channel', 'whatsapp',
      'via', CASE
        WHEN NULLIF(v_charge_id, '') IS NOT NULL THEN 'asaas'
        WHEN COALESCE(v_external_link, NULLIF(v_existing_external_link, '')) IS NOT NULL THEN 'external_link'
        ELSE 'message_only'
      END,
      'due_date', p_due_date
    ) || p_metadata,
    p_actor_id
  );

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_event_due_date_change(
  p_order_id UUID,
  p_due_date DATE,
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
  v_charge_id TEXT;
  v_registration_number TEXT;
  v_due_date DATE;
  v_updated_at TIMESTAMPTZ;
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
  v_result JSONB;
BEGIN
  IF p_order_id IS NULL OR p_actor_id IS NULL OR p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da alteração de vencimento são inválidos';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  SELECT payment_status, asaas_charge_id, registration_number, due_date, updated_at
  INTO v_payment_status, v_charge_id, v_registration_number, v_due_date, v_updated_at
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'change_due_date'
    AND operation_key = p_idempotency_key
    AND order_type = 'event'
    AND order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.payload->>'target_due_date' IS DISTINCT FROM p_due_date::TEXT THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A chave de idempotência já foi usada com outro vencimento';
    END IF;
    IF v_operation.status = 'prepared'
       AND COALESCE(v_payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          last_error = 'O estado da inscrição mudou antes da retomada da operação',
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
          lease_expires_at = now() + INTERVAL '60 seconds',
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
      v_lease_acquired := true;
    END IF;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'order_id', v_operation.order_id,
      'order_type', v_operation.order_type,
      'payment_status', v_operation.payload->>'payment_status',
      'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
      'previous_due_date', v_operation.payload->>'previous_due_date',
      'target_due_date', v_operation.payload->>'target_due_date',
      'lease_acquired', v_lease_acquired,
      'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
      'lease_expires_at', v_operation.lease_expires_at,
      'result', v_operation.result,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error
    );
  END IF;

  IF v_payment_status IS NULL
     OR v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente inscrições ainda não pagas podem ter o vencimento alterado';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.order_operations
    WHERE order_type = 'event'
      AND order_id = p_order_id
      AND status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outra operação financeira pendente para esta inscrição';
  END IF;

  v_result := CASE
    WHEN NULLIF(v_charge_id, '') IS NULL AND v_due_date IS NOT DISTINCT FROM p_due_date
      THEN jsonb_build_object(
        'order_id', p_order_id,
        'order_type', 'event',
        'due_date', p_due_date,
        'already_current', true,
        'external_result', jsonb_build_object('provider', 'none', 'outcome', 'not_required')
      )
    ELSE NULL
  END;

  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, external_result, result, lease_token,
    lease_expires_at
  )
  VALUES (
    'change_due_date',
    p_idempotency_key,
    'event',
    p_order_id,
    CASE WHEN v_result IS NULL THEN 'prepared' ELSE 'completed' END,
    p_actor_id,
    'Alteração de vencimento para ' || p_due_date::TEXT,
    jsonb_build_object(
      'payment_status', v_payment_status,
      'asaas_charge_id', v_charge_id,
      'order_number', v_registration_number,
      'previous_due_date', v_due_date,
      'target_due_date', p_due_date,
      'row_updated_at', v_updated_at
    ),
    CASE WHEN v_result IS NULL THEN NULL ELSE v_result->'external_result' END,
    v_result,
    CASE WHEN v_result IS NULL THEN gen_random_uuid() ELSE NULL END,
    CASE WHEN v_result IS NULL THEN now() + INTERVAL '60 seconds' ELSE NULL END
  )
  RETURNING * INTO v_operation;

  v_lease_acquired := v_operation.status = 'prepared';

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', v_operation.payload->>'payment_status',
    'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
    'previous_due_date', v_operation.payload->>'previous_due_date',
    'target_due_date', v_operation.payload->>'target_due_date',
    'lease_acquired', v_lease_acquired,
    'lease_token', CASE WHEN v_lease_acquired THEN v_operation.lease_token ELSE NULL END,
    'lease_expires_at', v_operation.lease_expires_at,
    'result', v_operation.result,
    'error_code', v_operation.result->>'error_code',
    'error', v_operation.last_error
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_event_due_date_change(
  p_operation_id UUID,
  p_lease_token UUID,
  p_external_result JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_payment_status TEXT;
  v_charge_id TEXT;
  v_due_date DATE;
  v_expected_charge_id TEXT;
  v_expected_due_date DATE;
  v_target_due_date DATE;
  v_cached_payments INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'change_due_date'
    AND order_type = 'event';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de vencimento não encontrada';
  END IF;

  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');
  v_expected_due_date := NULLIF(v_operation.payload->>'previous_due_date', '')::DATE;
  v_target_due_date := NULLIF(v_operation.payload->>'target_due_date', '')::DATE;

  SELECT payment_status, asaas_charge_id, due_date
  INTO v_payment_status, v_charge_id, v_due_date
  FROM public.event_registrations
  WHERE id = v_operation.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'change_due_date'
    AND order_type = 'event'
  FOR UPDATE;

  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status = 'reconciliation_required' THEN
    RETURN jsonb_build_object('operation_id', v_operation.id, 'status', v_operation.status, 'error', v_operation.last_error);
  END IF;
  IF p_lease_token IS NULL OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  IF v_expected_charge_id IS NULL THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'none'
       OR p_external_result->>'outcome' IS DISTINCT FROM 'not_required' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
    END IF;
  ELSIF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
        OR NOT (COALESCE(p_external_result->>'outcome', '') = ANY (ARRAY['updated', 'already_current']))
        OR p_external_result->>'payment_id' IS DISTINCT FROM v_expected_charge_id
        OR p_external_result->>'due_date' IS DISTINCT FROM v_target_due_date::TEXT
        OR NULLIF(p_external_result->>'status_after', '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
  END IF;

  IF v_charge_id IS DISTINCT FROM v_expected_charge_id THEN
    v_error := 'A cobrança vinculada à inscrição mudou durante a alteração de vencimento';
  ELSIF COALESCE(v_payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'O pagamento foi concluído durante a alteração de vencimento';
  ELSIF v_expected_charge_id IS NOT NULL
        AND p_external_result->>'status_after' NOT IN ('PENDING', 'OVERDUE')
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'A cobrança mudou para um estado não ajustável durante a alteração';
  ELSIF v_due_date IS DISTINCT FROM v_expected_due_date
        AND v_due_date IS DISTINCT FROM v_target_due_date THEN
    v_error := 'O vencimento local mudou para uma terceira data durante a alteração';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        external_result = p_external_result,
        last_error = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object('operation_id', v_operation.id, 'status', 'reconciliation_required', 'error', v_error);
  END IF;

  IF v_due_date IS DISTINCT FROM v_target_due_date THEN
    UPDATE public.event_registrations
    SET due_date = v_target_due_date,
        updated_at = now()
    WHERE id = v_operation.order_id;
  END IF;

  IF v_expected_charge_id IS NOT NULL THEN
    UPDATE public.asaas_payments
    SET due_date = v_target_due_date,
        status = COALESCE(NULLIF(p_external_result->>'status_after', ''), status),
        last_synced_at = now(),
        updated_at = now()
    WHERE asaas_payment_id = v_expected_charge_id;
    GET DIAGNOSTICS v_cached_payments = ROW_COUNT;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    'event',
    v_operation.order_id,
    v_payment_status,
    v_payment_status,
    'Vencimento alterado',
    jsonb_build_object(
      'action', CASE
        WHEN v_expected_due_date IS NOT DISTINCT FROM v_target_due_date THEN 'due_date_reconciled'
        ELSE 'due_date_changed'
      END,
      'from', v_expected_due_date,
      'to', v_target_due_date,
      'source', 'api_v1_financial_open_sales',
      'operation_id', v_operation.id,
      'external_result', p_external_result
    ),
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'order_id', v_operation.order_id,
    'order_type', 'event',
    'due_date', v_target_due_date,
    'previous_due_date', v_expected_due_date,
    'already_converged', v_due_date IS NOT DISTINCT FROM v_target_due_date,
    'asaas_cache_rows_updated', v_cached_payments,
    'external_result', p_external_result
  );

  UPDATE public.order_operations
  SET status = 'completed',
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

CREATE OR REPLACE FUNCTION public.prepare_event_charge_cancellation(
  p_order_id UUID,
  p_reason TEXT,
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
  v_charge_id TEXT;
  v_external_link TEXT;
  v_registration_number TEXT;
  v_operation public.order_operations%ROWTYPE;
  v_lease_token UUID;
  v_lease_acquired BOOLEAN := false;
BEGIN
  IF p_order_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do cancelamento são inválidos';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Motivo de cancelamento inválido';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;

  SELECT payment_status, asaas_charge_id, external_payment_link, registration_number
  INTO v_payment_status, v_charge_id, v_external_link, v_registration_number
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'cancel_charge'
    AND operation_key = p_idempotency_key
    AND order_type = 'event'
    AND order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.reason IS DISTINCT FROM trim(p_reason) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A chave de idempotência já foi usada com outro motivo';
    END IF;
    IF v_operation.status = 'prepared'
       AND COALESCE(v_payment_status, '') IN ('paid', 'refunded') THEN
      UPDATE public.order_operations
      SET status = 'reconciliation_required',
          last_error = 'O pagamento foi concluído antes da retomada do cancelamento',
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
    END IF;
    IF v_operation.status IN ('prepared', 'failed')
       AND (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at <= now()) THEN
      v_lease_token := gen_random_uuid();
      UPDATE public.order_operations
      SET status = 'prepared',
          result = NULL,
          last_error = NULL,
          lease_token = v_lease_token,
          lease_expires_at = now() + INTERVAL '90 seconds',
          updated_at = now()
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
      v_lease_acquired := true;
    END IF;
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'order_id', v_operation.order_id,
      'order_type', v_operation.order_type,
      'payment_status', v_operation.payload->>'payment_status',
      'asaas_charge_id', v_operation.payload->>'asaas_charge_id',
      'had_external_link', COALESCE((v_operation.payload->>'had_external_link')::BOOLEAN, false),
      'lease_acquired', v_lease_acquired,
      'lease_token', CASE WHEN v_lease_acquired THEN v_lease_token ELSE NULL END,
      'lease_expires_at', v_operation.lease_expires_at,
      'external_result', v_operation.external_result,
      'result', v_operation.result,
      'error_code', v_operation.result->>'error_code',
      'error', v_operation.last_error
    );
  END IF;

  IF v_payment_status IS NULL
     OR v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente cobranças ainda não pagas podem ser canceladas';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.order_operations
    WHERE order_type = 'event'
      AND order_id = p_order_id
      AND status IN ('prepared', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existe outra operação financeira pendente para esta inscrição';
  END IF;

  v_lease_token := gen_random_uuid();
  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, lease_token, lease_expires_at
  )
  VALUES (
    'cancel_charge', p_idempotency_key, 'event', p_order_id, 'prepared',
    p_actor_id, trim(p_reason),
    jsonb_build_object(
      'payment_status', v_payment_status,
      'asaas_charge_id', v_charge_id,
      'had_external_link', NULLIF(v_external_link, '') IS NOT NULL,
      'external_link_fingerprint', CASE
        WHEN NULLIF(v_external_link, '') IS NULL THEN NULL
        ELSE pg_catalog.md5(v_external_link)
      END,
      'order_number', v_registration_number
    ),
    v_lease_token,
    now() + INTERVAL '90 seconds'
  )
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'order_id', v_operation.order_id,
    'order_type', v_operation.order_type,
    'payment_status', v_payment_status,
    'asaas_charge_id', v_charge_id,
    'had_external_link', NULLIF(v_external_link, '') IS NOT NULL,
    'lease_acquired', true,
    'lease_token', v_lease_token,
    'lease_expires_at', v_operation.lease_expires_at,
    'external_result', NULL,
    'result', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_event_charge_cancellation(
  p_operation_id UUID,
  p_lease_token UUID,
  p_external_result JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_operation public.order_operations%ROWTYPE;
  v_payment_status TEXT;
  v_charge_id TEXT;
  v_external_link TEXT;
  v_expected_charge_id TEXT;
  v_expected_external_fingerprint TEXT;
  v_had_external_link BOOLEAN;
  v_deleted_payments INTEGER := 0;
  v_result JSONB;
  v_error TEXT;
BEGIN
  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE id = p_operation_id
    AND operation_type = 'cancel_charge'
    AND order_type = 'event'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Operação de cancelamento não encontrada';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN v_operation.result;
  END IF;
  IF v_operation.status = 'reconciliation_required' THEN
    RETURN jsonb_build_object('operation_id', v_operation.id, 'status', v_operation.status, 'error', v_operation.last_error);
  END IF;
  IF p_lease_token IS NULL OR v_operation.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A operação está sendo processada por outra requisição';
  END IF;

  v_expected_charge_id := NULLIF(v_operation.payload->>'asaas_charge_id', '');
  v_had_external_link := COALESCE((v_operation.payload->>'had_external_link')::BOOLEAN, false);
  v_expected_external_fingerprint := NULLIF(v_operation.payload->>'external_link_fingerprint', '');

  IF v_expected_charge_id IS NOT NULL THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'asaas'
       OR NOT (COALESCE(p_external_result->>'outcome', '') = ANY (ARRAY['deleted', 'already_missing', 'already_cancelled']))
       OR p_external_result->>'payment_id' IS DISTINCT FROM v_expected_charge_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado do Asaas inválido';
    END IF;
  ELSIF v_had_external_link THEN
    IF p_external_result->>'provider' IS DISTINCT FROM 'external_link'
       OR p_external_result->>'outcome' IS DISTINCT FROM 'detached' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
    END IF;
  ELSIF p_external_result->>'provider' IS DISTINCT FROM 'none'
        OR p_external_result->>'outcome' IS DISTINCT FROM 'not_required' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado externo inválido';
  END IF;

  SELECT payment_status, asaas_charge_id, external_payment_link
  INTO v_payment_status, v_charge_id, v_external_link
  FROM public.event_registrations
  WHERE id = v_operation.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  IF v_charge_id IS NOT NULL AND v_charge_id IS DISTINCT FROM v_expected_charge_id THEN
    v_error := 'A cobrança vinculada à inscrição mudou durante o cancelamento';
  ELSIF NULLIF(v_external_link, '') IS NOT NULL
        AND (
          NOT v_had_external_link
          OR pg_catalog.md5(v_external_link) IS DISTINCT FROM v_expected_external_fingerprint
        ) THEN
    v_error := 'O link externo vinculado à inscrição mudou durante o cancelamento';
  ELSIF COALESCE(v_payment_status, '') IN ('paid', 'refunded') THEN
    v_error := 'O pagamento foi concluído durante o cancelamento';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.order_operations
    SET status = 'reconciliation_required',
        external_result = p_external_result,
        last_error = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = v_operation.id;
    RETURN jsonb_build_object('operation_id', v_operation.id, 'status', 'reconciliation_required', 'error', v_error);
  END IF;

  UPDATE public.event_registrations
  SET payment_status = 'awaiting_charge',
      payment_method = NULL,
      payment_date = NULL,
      due_date = NULL,
      external_payment_link = NULL,
      asaas_charge_id = NULL,
      asaas_payment_link = NULL,
      asaas_pix_qrcode = NULL,
      asaas_pix_copy = NULL,
      payment_message_sent_at = NULL,
      updated_at = now()
  WHERE id = v_operation.order_id;

  DELETE FROM public.asaas_payments
  WHERE order_id = v_operation.order_id
    AND order_type = 'event'
    AND source = 'asaas';
  GET DIAGNOSTICS v_deleted_payments = ROW_COUNT;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'event',
    v_operation.order_id,
    v_operation.payload->>'payment_status',
    'awaiting_charge',
    v_operation.reason,
    jsonb_build_object(
      'action', 'charge_cancelled',
      'operation_id', v_operation.id,
      'had_asaas_charge', v_expected_charge_id IS NOT NULL,
      'had_external_link', v_had_external_link,
      'external_result', p_external_result
    ),
    v_operation.requested_by
  );

  v_result := jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'order_id', v_operation.order_id,
    'order_type', 'event',
    'payment_status', 'awaiting_charge',
    'asaas_cache_rows_deleted', v_deleted_payments,
    'external_result', p_external_result
  );

  UPDATE public.order_operations
  SET status = 'completed',
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

CREATE OR REPLACE FUNCTION public.create_event_registration(
  p_event_id UUID,
  p_registration_type_id UUID,
  p_customer_id UUID,
  p_form_answers JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_type public.event_registration_types%ROWTYPE;
  v_event_status TEXT;
  v_customer_coach_id UUID;
  v_active_count INTEGER;
  v_field JSONB;
  v_key TEXT;
  v_answer JSONB;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF p_customer_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cliente e operador são obrigatórios';
  END IF;

  SELECT status INTO v_event_status FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Evento não encontrado';
  END IF;
  IF v_event_status NOT IN ('draft', 'open') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este evento não está aceitando inscrições';
  END IF;

  SELECT coach_id INTO v_customer_coach_id
  FROM public.presale_customers
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente não encontrado';
  END IF;

  SELECT * INTO v_type
  FROM public.event_registration_types
  WHERE id = p_registration_type_id AND event_id = p_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Tipo de inscrição não encontrado para este evento';
  END IF;
  IF NOT v_type.active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este tipo de inscrição não está mais disponível';
  END IF;

  IF v_type.max_quantity IS NOT NULL THEN
    SELECT count(*) INTO v_active_count
    FROM public.event_registrations
    WHERE registration_type_id = p_registration_type_id
      AND payment_status <> 'cancelled';
    IF v_active_count >= v_type.max_quantity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Vagas esgotadas para este tipo de inscrição';
    END IF;
  END IF;

  IF NOT jsonb_typeof(COALESCE(p_form_answers, '{}'::jsonb)) = 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Respostas do formulário inválidas';
  END IF;

  FOR v_field IN SELECT * FROM jsonb_array_elements(COALESCE(v_type.form_fields, '[]'::jsonb))
  LOOP
    IF COALESCE((v_field->>'required')::boolean, false) THEN
      v_key := v_field->>'key';
      v_answer := p_form_answers -> v_key;
      IF v_answer IS NULL
         OR jsonb_typeof(v_answer) = 'null'
         OR (jsonb_typeof(v_answer) = 'string' AND trim(v_answer #>> '{}') = '') THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Campo obrigatório não preenchido: ' || COALESCE(v_field->>'label', v_key);
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.event_registrations (
    event_id, registration_type_id, customer_id, coach_id, form_answers,
    due_date, created_by
  ) VALUES (
    p_event_id, p_registration_type_id, p_customer_id, v_customer_coach_id,
    COALESCE(p_form_answers, '{}'::jsonb),
    CASE WHEN v_type.price > 0 THEN current_date ELSE NULL END,
    p_actor_id
  )
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  )
  VALUES (
    'event',
    v_registration.id,
    NULL,
    v_registration.payment_status,
    'Inscrição criada pelo admin',
    jsonb_build_object(
      'action', 'event_registration_created',
      'via', 'admin',
      'event_id', p_event_id,
      'registration_type_id', p_registration_type_id,
      'customer_id', p_customer_id,
      'coach_id', v_customer_coach_id
    ),
    p_actor_id
  );

  RETURN to_jsonb(v_registration);
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_event_charge_creation(UUID, TEXT, DATE, INTEGER, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_event_charge_creation(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_record_event_manual_payment(UUID, UUID, DATE, NUMERIC, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_reopen_event_manual_payment(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_event_payment_message_sent_with_metadata(UUID, TEXT, DATE, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_event_due_date_change(UUID, DATE, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_event_due_date_change(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_event_charge_cancellation(UUID, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_event_charge_cancellation(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_event_registration(UUID, UUID, UUID, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_event_charge_creation(UUID, TEXT, DATE, INTEGER, TEXT, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_charge_creation(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.api_record_event_manual_payment(UUID, UUID, DATE, NUMERIC, JSONB, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.api_reopen_event_manual_payment(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_event_payment_message_sent_with_metadata(UUID, TEXT, DATE, JSONB, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_event_due_date_change(UUID, DATE, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_due_date_change(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_event_charge_cancellation(UUID, TEXT, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_charge_cancellation(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_event_registration(UUID, UUID, UUID, JSONB, UUID)
  TO service_role;

COMMENT ON FUNCTION public.prepare_event_charge_creation(UUID, TEXT, DATE, INTEGER, TEXT, TEXT, UUID) IS
  'Prepara cobrança Asaas de inscrição de evento usando o ledger financeiro canônico.';
COMMENT ON FUNCTION public.complete_event_charge_creation(UUID, UUID, JSONB) IS
  'Vincula cobrança Asaas, parcelas, inscrição de evento e histórico financeiro em uma transação.';
COMMENT ON FUNCTION public.api_record_event_manual_payment(UUID, UUID, DATE, NUMERIC, JSONB, UUID) IS
  'Registra pagamento manual de inscrição de evento no mesmo cache do fluxo de caixa.';
COMMENT ON FUNCTION public.mark_event_payment_message_sent_with_metadata(UUID, TEXT, DATE, JSONB, UUID) IS
  'Marca envio de cobrança de inscrição de evento e grava histórico com metadados.';
