-- Keep the resend behavior aligned with assessment contracts and event registrations.
-- An overdue charge remains overdue after a reminder; only payment changes its status.

CREATE OR REPLACE FUNCTION public.mark_order_payment_message_sent(
  p_order_type text,
  p_order_id uuid,
  p_external_payment_link text,
  p_due_date date,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_payment_status text;
  v_charge_id text;
  v_payment_link text;
  v_pix_copy text;
  v_existing_external_link text;
  v_previous_status text;
  v_next_status text;
  v_external_link text := nullif(trim(p_external_payment_link), '');
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_order_type NOT IN ('presale', 'stock') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;
  IF v_external_link IS NOT NULL AND (
    char_length(v_external_link) > 2000 OR v_external_link !~* '^https://[^[:space:]]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Link externo inválido';
  END IF;

  IF p_order_type = 'presale' THEN
    SELECT payment_status, asaas_charge_id, asaas_payment_link,
           asaas_pix_copy, external_payment_link
      INTO v_payment_status, v_charge_id, v_payment_link,
           v_pix_copy, v_existing_external_link
    FROM public.presale_orders
    WHERE id = p_order_id
    FOR UPDATE;
  ELSE
    SELECT payment_status, asaas_charge_id, asaas_payment_link,
           asaas_pix_copy, external_payment_link
      INTO v_payment_status, v_charge_id, v_payment_link,
           v_pix_copy, v_existing_external_link
    FROM public.stock_orders
    WHERE id = p_order_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;
  IF v_payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pedido não aceita envio de cobrança neste estado';
  END IF;
  IF nullif(v_charge_id, '') IS NULL
     AND nullif(v_payment_link, '') IS NULL
     AND nullif(v_pix_copy, '') IS NULL
     AND coalesce(v_external_link, nullif(v_existing_external_link, '')) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Gere uma cobrança ou informe um link externo antes de efetivar a venda';
  END IF;
  IF nullif(v_charge_id, '') IS NULL AND p_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a data de vencimento da cobrança externa';
  END IF;

  v_previous_status := v_payment_status;
  v_next_status := CASE
    WHEN v_payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
    ELSE v_payment_status
  END;

  IF p_order_type = 'presale' THEN
    UPDATE public.presale_orders o
    SET payment_message_sent_at = now(),
        external_payment_link = CASE
          WHEN nullif(v_charge_id, '') IS NULL THEN coalesce(v_external_link, v_existing_external_link)
          ELSE external_payment_link
        END,
        due_date = CASE
          WHEN nullif(v_charge_id, '') IS NULL THEN p_due_date
          ELSE due_date
        END,
        payment_status = v_next_status,
        updated_date = now()
    WHERE o.id = p_order_id
    RETURNING to_jsonb(o) INTO v_result;
  ELSE
    UPDATE public.stock_orders o
    SET payment_message_sent_at = now(),
        external_payment_link = CASE
          WHEN nullif(v_charge_id, '') IS NULL THEN coalesce(v_external_link, v_existing_external_link)
          ELSE external_payment_link
        END,
        due_date = CASE
          WHEN nullif(v_charge_id, '') IS NULL THEN p_due_date
          ELSE due_date
        END,
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
      WHEN v_previous_status IN ('charge_sent', 'overdue') THEN 'Cobrança reenviada'
      ELSE 'Cobrança enviada'
    END,
    jsonb_build_object(
      'action', CASE
        WHEN v_previous_status IN ('charge_sent', 'overdue') THEN 'charge_resent'
        ELSE 'charge_sent'
      END,
      'channel', 'whatsapp',
      'via', CASE
        WHEN nullif(v_charge_id, '') IS NOT NULL THEN 'asaas'
        WHEN coalesce(v_external_link, nullif(v_existing_external_link, '')) IS NOT NULL THEN 'external_link'
        ELSE 'message_only'
      END,
      'due_date', p_due_date
    ),
    p_actor_id
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_order_payment_message_sent(text, uuid, text, date, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_order_payment_message_sent(text, uuid, text, date, uuid)
  TO service_role;

COMMENT ON FUNCTION public.mark_order_payment_message_sent(text, uuid, text, date, uuid) IS
  'Server-only: registra envio ou reenvio de cobrança, preservando o status vencido quando aplicável.';
