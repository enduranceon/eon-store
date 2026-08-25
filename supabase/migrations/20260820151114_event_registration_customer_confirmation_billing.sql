-- Fecha a lacuna operacional do financeiro de eventos:
-- antes de gerar/cadastrar cobrança ou registrar pagamento, a inscrição precisa
-- ter o vínculo de cliente confirmado por um admin.

ALTER TABLE public.event_registrations
  ADD COLUMN IF NOT EXISTS customer_link_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_link_confirmed_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS external_invoice_number TEXT;

COMMENT ON COLUMN public.event_registrations.customer_link_confirmed_at IS
  'Confirmação operacional de que a inscrição foi vinculada ao cliente correto antes da cobrança.';
COMMENT ON COLUMN public.event_registrations.external_invoice_number IS
  'Identificador opcional de cobrança externa/Asaas criada fora da API.';

-- Inscrições criadas por admin já nasceram com cliente escolhido manualmente.
-- Inscrições públicas ficam sem confirmação até alguém revisar.
UPDATE public.event_registrations
SET customer_link_confirmed_at = COALESCE(customer_link_confirmed_at, created_at, now()),
    customer_link_confirmed_by = COALESCE(customer_link_confirmed_by, created_by)
WHERE customer_link_confirmed_at IS NULL
  AND created_by IS NOT NULL;

-- Se já existe cobrança/pagamento, preserva a operação existente como confirmada.
UPDATE public.event_registrations
SET customer_link_confirmed_at = COALESCE(customer_link_confirmed_at, updated_at, created_at, now()),
    customer_link_confirmed_by = COALESCE(customer_link_confirmed_by, created_by)
WHERE customer_link_confirmed_at IS NULL
  AND (
    NULLIF(asaas_charge_id, '') IS NOT NULL
    OR NULLIF(asaas_payment_link, '') IS NOT NULL
    OR NULLIF(asaas_pix_copy, '') IS NOT NULL
    OR NULLIF(external_payment_link, '') IS NOT NULL
    OR payment_message_sent_at IS NOT NULL
    OR manual_payment IS TRUE
    OR payment_status IN ('charge_sent', 'paid')
  );

CREATE OR REPLACE FUNCTION public.default_event_registration_customer_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.customer_link_confirmed_at IS NULL AND NEW.created_by IS NOT NULL THEN
    NEW.customer_link_confirmed_at := now();
    NEW.customer_link_confirmed_by := NEW.created_by;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS default_event_registration_customer_confirmation
  ON public.event_registrations;
CREATE TRIGGER default_event_registration_customer_confirmation
  BEFORE INSERT ON public.event_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.default_event_registration_customer_confirmation();

CREATE OR REPLACE FUNCTION public.require_event_customer_confirmation_for_billing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.customer_link_confirmed_at IS NULL
     AND (
       NULLIF(NEW.asaas_charge_id, '') IS NOT NULL
       OR NULLIF(NEW.asaas_payment_link, '') IS NOT NULL
       OR NULLIF(NEW.asaas_pix_copy, '') IS NOT NULL
       OR NULLIF(NEW.external_payment_link, '') IS NOT NULL
       OR NEW.payment_message_sent_at IS NOT NULL
       OR COALESCE(NEW.manual_payment, false)
       OR COALESCE(NEW.payment_status, '') IN ('charge_sent', 'paid')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Confirme o vínculo do cliente antes de criar cobrança ou registrar pagamento';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS require_event_customer_confirmation_for_billing
  ON public.event_registrations;
CREATE TRIGGER require_event_customer_confirmation_for_billing
  BEFORE UPDATE ON public.event_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.require_event_customer_confirmation_for_billing();

CREATE OR REPLACE FUNCTION public.require_event_customer_confirmation_for_operation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_confirmed_at TIMESTAMPTZ;
BEGIN
  IF NEW.order_type = 'event'
     AND NEW.operation_type = 'create_charge'
     AND NEW.status = 'prepared' THEN
    SELECT customer_link_confirmed_at
    INTO v_confirmed_at
    FROM public.event_registrations
    WHERE id = NEW.order_id;

    IF v_confirmed_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Confirme o vínculo do cliente antes de gerar cobrança';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS require_event_customer_confirmation_for_operation
  ON public.order_operations;
CREATE TRIGGER require_event_customer_confirmation_for_operation
  BEFORE INSERT OR UPDATE ON public.order_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.require_event_customer_confirmation_for_operation();

CREATE OR REPLACE FUNCTION public.confirm_event_registration_customer_link(
  p_registration_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF p_registration_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;

  SELECT * INTO v_registration
  FROM public.event_registrations
  WHERE id = p_registration_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_registration.customer_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Vincule um cliente antes de confirmar';
  END IF;

  UPDATE public.event_registrations
  SET customer_link_confirmed_at = now(),
      customer_link_confirmed_by = p_actor_id,
      updated_at = now()
  WHERE id = p_registration_id
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'event',
    p_registration_id,
    v_registration.payment_status,
    v_registration.payment_status,
    'Cliente da inscrição confirmado',
    jsonb_build_object(
      'action', 'event_customer_link_confirmed',
      'customer_id', v_registration.customer_id
    ),
    p_actor_id
  );

  RETURN to_jsonb(v_registration);
END;
$$;

CREATE OR REPLACE FUNCTION public.link_event_registration_customer(
  p_registration_id UUID,
  p_customer_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_registration public.event_registrations%ROWTYPE;
  v_previous_customer_id UUID;
  v_customer public.presale_customers%ROWTYPE;
  v_has_financial_activity BOOLEAN;
BEGIN
  IF p_registration_id IS NULL OR p_customer_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do vínculo são inválidos';
  END IF;

  SELECT * INTO v_registration
  FROM public.event_registrations
  WHERE id = p_registration_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT * INTO v_customer
  FROM public.presale_customers
  WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Cliente não encontrado';
  END IF;

  v_has_financial_activity :=
    NULLIF(v_registration.asaas_charge_id, '') IS NOT NULL
    OR NULLIF(v_registration.asaas_payment_link, '') IS NOT NULL
    OR NULLIF(v_registration.asaas_pix_copy, '') IS NOT NULL
    OR NULLIF(v_registration.external_payment_link, '') IS NOT NULL
    OR v_registration.payment_message_sent_at IS NOT NULL
    OR COALESCE(v_registration.manual_payment, false)
    OR COALESCE(v_registration.payment_status, '') NOT IN ('pending', 'awaiting_charge');

  IF v_registration.customer_id IS DISTINCT FROM p_customer_id
     AND v_has_financial_activity THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Troque o cliente antes de criar cobrança ou registrar pagamento';
  END IF;
  IF v_registration.payment_status IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta inscrição não aceita alteração de cliente';
  END IF;

  v_previous_customer_id := v_registration.customer_id;

  UPDATE public.event_registrations
  SET customer_id = p_customer_id,
      coach_id = COALESCE(coach_id, v_customer.coach_id),
      customer_link_confirmed_at = now(),
      customer_link_confirmed_by = p_actor_id,
      updated_at = now()
  WHERE id = p_registration_id
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'event',
    p_registration_id,
    v_registration.payment_status,
    v_registration.payment_status,
    CASE
      WHEN v_previous_customer_id IS DISTINCT FROM p_customer_id
        THEN 'Cliente da inscrição vinculado'
      ELSE 'Cliente da inscrição confirmado'
    END,
    jsonb_build_object(
      'action', CASE
        WHEN v_previous_customer_id IS DISTINCT FROM p_customer_id
          THEN 'event_customer_link_changed'
        ELSE 'event_customer_link_confirmed'
      END,
      'previous_customer_id', v_previous_customer_id,
      'customer_id', p_customer_id
    ),
    p_actor_id
  );

  RETURN to_jsonb(v_registration);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_event_external_charge(
  p_order_id UUID,
  p_external_link TEXT,
  p_due_date DATE,
  p_payment_method TEXT,
  p_invoice_number TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_registration public.event_registrations%ROWTYPE;
  v_previous_status TEXT;
  v_next_status TEXT;
  v_clean_invoice TEXT := NULLIF(btrim(p_invoice_number), '');
  v_total NUMERIC;
  v_event_status TEXT;
  v_had_external_link BOOLEAN;
BEGIN
  IF p_order_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
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
  IF length(COALESCE(v_clean_invoice, '')) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O número da cobrança é muito longo';
  END IF;

  SELECT * INTO v_registration
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT round(COALESCE(rt.price, 0), 2), e.status
  INTO v_total, v_event_status
  FROM public.event_registration_types rt
  JOIN public.events e ON e.id = v_registration.event_id
  WHERE rt.id = v_registration.registration_type_id;
  IF v_registration.customer_link_confirmed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Confirme o vínculo do cliente antes de cadastrar cobrança';
  END IF;
  IF v_event_status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este evento foi cancelado';
  END IF;
  IF COALESCE(v_registration.payment_status, '') NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição não aceita nova cobrança neste estado';
  END IF;
  IF NULLIF(v_registration.asaas_charge_id, '') IS NOT NULL
     OR NULLIF(v_registration.asaas_payment_link, '') IS NOT NULL
     OR NULLIF(v_registration.asaas_pix_copy, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta inscrição já possui cobrança Asaas';
  END IF;
  IF COALESCE(v_registration.manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Reabra o pagamento manual antes de cadastrar cobrança';
  END IF;
  IF COALESCE(v_total, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O valor da cobrança precisa ser maior que zero';
  END IF;

  v_next_status := CASE
    WHEN v_registration.payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
    ELSE v_registration.payment_status
  END;
  v_had_external_link := NULLIF(v_registration.external_payment_link, '') IS NOT NULL;

  IF v_registration.external_payment_link = p_external_link
     AND v_registration.due_date = p_due_date
     AND v_registration.payment_method = p_payment_method
     AND v_registration.external_invoice_number IS NOT DISTINCT FROM v_clean_invoice
     AND v_registration.payment_status = v_next_status THEN
    RETURN jsonb_build_object(
      'registration', to_jsonb(v_registration),
      'had_external_link', v_had_external_link,
      'unchanged', true
    );
  END IF;

  IF p_expected_updated_at IS NULL
     OR v_registration.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;

  v_previous_status := v_registration.payment_status;

  UPDATE public.event_registrations
  SET external_payment_link = p_external_link,
      external_invoice_number = v_clean_invoice,
      due_date = p_due_date,
      payment_method = p_payment_method,
      payment_status = v_next_status,
      updated_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'event',
    p_order_id,
    v_previous_status,
    v_next_status,
    CASE
      WHEN v_had_external_link THEN 'Cobrança externa da inscrição atualizada'
      ELSE 'Cobrança externa da inscrição cadastrada'
    END,
    jsonb_build_object(
      'action', CASE WHEN v_had_external_link THEN 'external_charge_updated' ELSE 'external_charge_registered' END,
      'external_payment_link', p_external_link,
      'due_date', p_due_date,
      'payment_method', p_payment_method,
      'invoice_number', v_clean_invoice
    ),
    p_actor_id
  );

  RETURN jsonb_build_object(
    'registration', to_jsonb(v_registration),
    'had_external_link', v_had_external_link,
    'unchanged', false
  );
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
  v_confirmed_at TIMESTAMPTZ;
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
         external_payment_link, customer_link_confirmed_at
  INTO v_payment_status, v_charge_id, v_payment_link, v_pix_copy,
       v_existing_external_link, v_confirmed_at
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_confirmed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Confirme o vínculo do cliente antes de enviar cobrança';
  END IF;
  IF v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição não aceita envio de cobrança neste estado';
  END IF;
  IF NULLIF(v_charge_id, '') IS NULL
     AND NULLIF(v_payment_link, '') IS NULL
     AND NULLIF(v_pix_copy, '') IS NULL
     AND NULLIF(v_existing_external_link, '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cadastre a cobrança externa antes de enviar a mensagem';
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

REVOKE ALL ON FUNCTION public.confirm_event_registration_customer_link(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_event_registration_customer(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_event_external_charge(UUID, TEXT, DATE, TEXT, TEXT, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_event_payment_message_sent_with_metadata(UUID, TEXT, DATE, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_event_registration_customer_link(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.link_event_registration_customer(UUID, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.save_event_external_charge(UUID, TEXT, DATE, TEXT, TEXT, TIMESTAMPTZ, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_event_payment_message_sent_with_metadata(UUID, TEXT, DATE, JSONB, UUID)
  TO service_role;
