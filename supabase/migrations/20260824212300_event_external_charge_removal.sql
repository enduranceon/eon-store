-- Keep event registrations aligned with contracts, pre-sale, and store orders:
-- removing an external charge never deletes payment history and is fully audited.

CREATE OR REPLACE FUNCTION public.remove_event_external_charge(
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
  v_registration public.event_registrations%ROWTYPE;
  v_previous_status text;
  v_previous_external_link text;
  v_previous_invoice_number text;
  v_has_native boolean;
  v_next_status text;
BEGIN
  IF p_order_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operação inválida';
  END IF;

  SELECT * INTO v_registration
  FROM public.event_registrations
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF coalesce(v_registration.payment_status, '') IN ('paid', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A cobrança de uma inscrição encerrada não pode ser removida';
  END IF;
  IF nullif(v_registration.external_payment_link, '') IS NULL
     AND nullif(v_registration.external_invoice_number, '') IS NULL THEN
    RETURN jsonb_build_object('registration', to_jsonb(v_registration), 'unchanged', true);
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_registration.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A inscrição foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;

  v_has_native := nullif(v_registration.asaas_charge_id, '') IS NOT NULL
    OR nullif(v_registration.asaas_payment_link, '') IS NOT NULL
    OR nullif(v_registration.asaas_pix_copy, '') IS NOT NULL
    OR nullif(v_registration.asaas_pix_qrcode, '') IS NOT NULL;
  v_next_status := CASE
    WHEN v_registration.payment_status = 'charge_sent' AND NOT v_has_native THEN 'awaiting_charge'
    ELSE v_registration.payment_status
  END;
  v_previous_status := v_registration.payment_status;
  v_previous_external_link := v_registration.external_payment_link;
  v_previous_invoice_number := v_registration.external_invoice_number;

  UPDATE public.event_registrations
  SET external_payment_link = NULL,
      external_invoice_number = NULL,
      payment_message_sent_at = NULL,
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
    'Cobrança externa da inscrição removida',
    jsonb_build_object(
      'action', 'external_charge_removed',
      'previous_external_payment_link', v_previous_external_link,
      'previous_invoice_number', v_previous_invoice_number,
      'payment_status_before', v_previous_status,
      'payment_status_after', v_next_status,
      'has_native_charge', v_has_native
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('registration', to_jsonb(v_registration), 'unchanged', false);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_event_external_charge(uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.remove_event_external_charge(uuid, timestamptz, uuid)
  TO service_role;

COMMENT ON FUNCTION public.remove_event_external_charge(uuid, timestamptz, uuid) IS
  'Server-only: removes an event external charge without removing payment history.';
