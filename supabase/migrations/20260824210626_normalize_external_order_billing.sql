-- External charges for pre-sale and store orders used to be persisted only
-- when the WhatsApp message was marked as sent. Keep charge registration,
-- messaging, and payment receipt as independent, auditable operations.

ALTER TABLE public.presale_orders
  ADD COLUMN IF NOT EXISTS external_invoice_number text;

ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS external_invoice_number text;

CREATE OR REPLACE FUNCTION public.save_order_external_charge(
  p_order_type text,
  p_order_id uuid,
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
  v_payment_status text;
  v_payment_method text;
  v_due_date date;
  v_external_link text;
  v_invoice_number text;
  v_asaas_charge_id text;
  v_asaas_payment_link text;
  v_asaas_pix_copy text;
  v_asaas_pix_qrcode text;
  v_manual_payment boolean;
  v_total_value numeric;
  v_current_updated_at timestamptz;
  v_result jsonb;
  v_previous_status text;
  v_next_status text;
  v_had_external_link boolean;
  v_clean_invoice text := nullif(btrim(p_invoice_number), '');
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
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
  IF length(coalesce(v_clean_invoice, '')) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O número da cobrança é muito longo';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT
      o.payment_status,
      o.payment_method,
      o.due_date,
      o.external_payment_link,
      o.external_invoice_number,
      o.asaas_charge_id,
      o.asaas_payment_link,
      o.asaas_pix_copy,
      o.asaas_pix_qrcode,
      o.manual_payment,
      o.total_value,
      coalesce(o.updated_date, o.created_date),
      to_jsonb(o)
    INTO
      v_payment_status,
      v_payment_method,
      v_due_date,
      v_external_link,
      v_invoice_number,
      v_asaas_charge_id,
      v_asaas_payment_link,
      v_asaas_pix_copy,
      v_asaas_pix_qrcode,
      v_manual_payment,
      v_total_value,
      v_current_updated_at,
      v_result
    FROM public.presale_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT
      o.payment_status,
      o.payment_method,
      o.due_date,
      o.external_payment_link,
      o.external_invoice_number,
      o.asaas_charge_id,
      o.asaas_payment_link,
      o.asaas_pix_copy,
      o.asaas_pix_qrcode,
      o.manual_payment,
      o.total_value,
      coalesce(o.updated_date, o.created_date),
      to_jsonb(o)
    INTO
      v_payment_status,
      v_payment_method,
      v_due_date,
      v_external_link,
      v_invoice_number,
      v_asaas_charge_id,
      v_asaas_payment_link,
      v_asaas_pix_copy,
      v_asaas_pix_qrcode,
      v_manual_payment,
      v_total_value,
      v_current_updated_at,
      v_result
    FROM public.stock_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF coalesce(v_payment_status, 'awaiting_charge') NOT IN (
    'pending', 'awaiting_charge', 'charge_sent', 'overdue'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pedido não aceita nova cobrança neste estado';
  END IF;
  IF nullif(v_asaas_charge_id, '') IS NOT NULL
     OR nullif(v_asaas_payment_link, '') IS NOT NULL
     OR nullif(v_asaas_pix_copy, '') IS NOT NULL
     OR nullif(v_asaas_pix_qrcode, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este pedido já possui cobrança Asaas';
  END IF;
  IF coalesce(v_manual_payment, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Reabra o pagamento manual antes de cadastrar cobrança';
  END IF;
  IF coalesce(v_total_value, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O valor da cobrança precisa ser maior que zero';
  END IF;

  v_next_status := CASE
    WHEN coalesce(v_payment_status, 'awaiting_charge') IN ('pending', 'awaiting_charge')
      THEN 'charge_sent'
    ELSE v_payment_status
  END;
  v_had_external_link := nullif(v_external_link, '') IS NOT NULL;

  IF v_external_link = p_external_link
     AND v_due_date = p_due_date
     AND v_payment_method = p_payment_method
     AND v_invoice_number IS NOT DISTINCT FROM v_clean_invoice
     AND v_payment_status = v_next_status THEN
    RETURN jsonb_build_object(
      'order', v_result,
      'had_external_link', v_had_external_link,
      'unchanged', true
    );
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pedido foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_previous_status := v_payment_status;
  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET external_payment_link = p_external_link,
        external_invoice_number = v_clean_invoice,
        due_date = p_due_date,
        payment_method = p_payment_method,
        payment_status = v_next_status,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET external_payment_link = p_external_link,
        external_invoice_number = v_clean_invoice,
        due_date = p_due_date,
        payment_method = p_payment_method,
        payment_status = v_next_status,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    p_order_type,
    p_order_id,
    v_previous_status,
    v_next_status,
    CASE
      WHEN v_had_external_link THEN 'Cobrança externa atualizada'
      ELSE 'Cobrança externa cadastrada'
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
    'order', v_result,
    'had_external_link', v_had_external_link,
    'unchanged', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_order_external_charge(
  p_order_type text,
  p_order_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status text;
  v_external_link text;
  v_invoice_number text;
  v_asaas_charge_id text;
  v_asaas_payment_link text;
  v_asaas_pix_copy text;
  v_asaas_pix_qrcode text;
  v_current_updated_at timestamptz;
  v_result jsonb;
  v_next_status text;
  v_has_native boolean;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT
      o.payment_status,
      o.external_payment_link,
      o.external_invoice_number,
      o.asaas_charge_id,
      o.asaas_payment_link,
      o.asaas_pix_copy,
      o.asaas_pix_qrcode,
      coalesce(o.updated_date, o.created_date),
      to_jsonb(o)
    INTO
      v_payment_status,
      v_external_link,
      v_invoice_number,
      v_asaas_charge_id,
      v_asaas_payment_link,
      v_asaas_pix_copy,
      v_asaas_pix_qrcode,
      v_current_updated_at,
      v_result
    FROM public.presale_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT
      o.payment_status,
      o.external_payment_link,
      o.external_invoice_number,
      o.asaas_charge_id,
      o.asaas_payment_link,
      o.asaas_pix_copy,
      o.asaas_pix_qrcode,
      coalesce(o.updated_date, o.created_date),
      to_jsonb(o)
    INTO
      v_payment_status,
      v_external_link,
      v_invoice_number,
      v_asaas_charge_id,
      v_asaas_payment_link,
      v_asaas_pix_copy,
      v_asaas_pix_qrcode,
      v_current_updated_at,
      v_result
    FROM public.stock_orders o
    WHERE o.id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF coalesce(v_payment_status, '') IN ('paid', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A cobrança de um pedido encerrado não pode ser removida';
  END IF;
  IF nullif(v_external_link, '') IS NULL
     AND nullif(v_invoice_number, '') IS NULL THEN
    RETURN jsonb_build_object('order', v_result, 'unchanged', true);
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pedido foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_has_native := nullif(v_asaas_charge_id, '') IS NOT NULL
    OR nullif(v_asaas_payment_link, '') IS NOT NULL
    OR nullif(v_asaas_pix_copy, '') IS NOT NULL
    OR nullif(v_asaas_pix_qrcode, '') IS NOT NULL;
  v_next_status := CASE
    WHEN v_payment_status = 'charge_sent' AND NOT v_has_native THEN 'awaiting_charge'
    ELSE v_payment_status
  END;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET external_payment_link = NULL,
        external_invoice_number = NULL,
        payment_message_sent_at = NULL,
        payment_status = v_next_status,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET external_payment_link = NULL,
        external_invoice_number = NULL,
        payment_message_sent_at = NULL,
        payment_status = v_next_status,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  END IF;

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    p_order_type,
    p_order_id,
    v_payment_status,
    v_next_status,
    'Cobrança externa removida',
    jsonb_build_object(
      'action', 'external_charge_removed',
      'previous_external_payment_link', v_external_link,
      'previous_invoice_number', v_invoice_number,
      'payment_status_before', v_payment_status,
      'payment_status_after', v_next_status,
      'has_native_charge', v_has_native
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('order', v_result, 'unchanged', false);
END;
$$;

REVOKE ALL ON FUNCTION public.save_order_external_charge(
  text, uuid, text, date, text, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_order_external_charge(
  text, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_order_external_charge(
  text, uuid, text, date, text, text, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_order_external_charge(
  text, uuid, timestamptz, uuid
) TO service_role;

COMMENT ON FUNCTION public.save_order_external_charge(
  text, uuid, text, date, text, text, timestamptz, uuid
) IS 'Server-only: registra ou atualiza cobrança externa de pré-venda ou loja sem marcar o envio da mensagem.';
COMMENT ON FUNCTION public.remove_order_external_charge(
  text, uuid, timestamptz, uuid
) IS 'Server-only: remove cobrança externa de pré-venda ou loja sem alterar o histórico financeiro.';
