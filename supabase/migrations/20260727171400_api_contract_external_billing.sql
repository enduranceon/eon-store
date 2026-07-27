-- External contract billing and payment-message mutations are internal API RPCs.
-- They keep the contract update and its audit events in the same transaction.

CREATE OR REPLACE FUNCTION public.save_assessment_contract_external_charge(
  p_contract_id uuid,
  p_external_link text,
  p_due_date date,
  p_payment_method text,
  p_invoice_number text,
  p_source text,
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
  v_previous public.assessment_contracts%ROWTYPE;
  v_next_payment_status text;
  v_next_contract_status text;
  v_event_type text;
  v_method_label text;
  v_clean_invoice text := nullif(btrim(p_invoice_number), '');
BEGIN
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
  IF p_source NOT IN ('contract_detail', 'renewals_page') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Origem da cobrança inválida';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não aceita nova cobrança';
  END IF;
  IF v_contract.payment_status NOT IN (
    'pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O pagamento deste contrato já foi concluído';
  END IF;
  IF nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR nullif(v_contract.asaas_payment_link, '') IS NOT NULL
     OR nullif(v_contract.asaas_pix_copy, '') IS NOT NULL
     OR nullif(v_contract.asaas_pix_qrcode, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já possui cobrança Asaas';
  END IF;

  v_next_payment_status := CASE
    WHEN v_contract.payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
    ELSE v_contract.payment_status
  END;
  v_next_contract_status := CASE
    WHEN v_contract.status = 'draft'
         AND v_contract.start_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date
      THEN 'scheduled'
    WHEN v_contract.status = 'draft' THEN 'active'
    ELSE v_contract.status
  END;
  IF v_contract.external_payment_link = p_external_link
     AND v_contract.due_date = p_due_date
     AND v_contract.payment_method = p_payment_method
     AND v_contract.external_invoice_number IS NOT DISTINCT FROM v_clean_invoice
     AND v_contract.payment_status = v_next_payment_status
     AND v_contract.status = v_next_contract_status THEN
    RETURN jsonb_build_object(
      'contract', to_jsonb(v_contract),
      'had_external_link', true,
      'unchanged', true
    );
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_previous := v_contract;
  v_event_type := CASE
    WHEN nullif(v_contract.external_payment_link, '') IS NULL
      THEN 'external_charge_registered'
    ELSE 'external_charge_updated'
  END;
  v_method_label := CASE p_payment_method
    WHEN 'pix' THEN 'PIX'
    WHEN 'boleto' THEN 'Boleto'
    ELSE 'Cartão ' || substring(p_payment_method FROM 6)
  END;

  UPDATE public.assessment_contracts
  SET external_payment_link = p_external_link,
      due_date = p_due_date,
      payment_method = p_payment_method,
      external_invoice_number = v_clean_invoice,
      payment_status = v_next_payment_status,
      status = v_next_contract_status,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    p_contract_id,
    v_event_type,
    jsonb_build_object(
      'link', p_external_link,
      'due_date', p_due_date,
      'payment_method', p_payment_method,
      'method_label', v_method_label,
      'invoice_number', v_clean_invoice,
      'previous_invoice_number', v_previous.external_invoice_number,
      'previous_link', v_previous.external_payment_link,
      'previous_due_date', v_previous.due_date,
      'previous_payment_method', v_previous.payment_method,
      'source', p_source
    ),
    CASE WHEN p_source = 'renewals_page'
      THEN 'Cobrança externa da renovação registrada pela aba de Renovações'
      ELSE NULL END,
    p_actor_id
  );

  IF v_previous.status = 'draft' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, created_by
    ) VALUES (
      p_contract_id,
      CASE
        WHEN v_previous.parent_contract_id IS NOT NULL
             AND v_next_contract_status = 'scheduled' THEN 'renewal_scheduled'
        ELSE 'enrollment_activated'
      END,
      jsonb_build_object(
        'source', p_source,
        'status_after', v_next_contract_status,
        'start_date', v_contract.start_date
      ),
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'had_external_link', nullif(v_previous.external_payment_link, '') IS NOT NULL,
    'event_type', v_event_type
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_assessment_contract_external_charge(
  p_contract_id uuid,
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
  v_previous public.assessment_contracts%ROWTYPE;
  v_has_native boolean;
  v_next_payment_status text;
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished')
     OR v_contract.payment_status IN ('paid', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A cobrança de um contrato encerrado não pode ser removida';
  END IF;
  IF nullif(v_contract.external_payment_link, '') IS NULL
     AND nullif(v_contract.external_invoice_number, '') IS NULL THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_previous := v_contract;
  v_has_native := nullif(v_contract.asaas_charge_id, '') IS NOT NULL
    OR nullif(v_contract.asaas_payment_link, '') IS NOT NULL
    OR nullif(v_contract.asaas_pix_copy, '') IS NOT NULL
    OR nullif(v_contract.asaas_pix_qrcode, '') IS NOT NULL;
  v_next_payment_status := CASE
    WHEN v_contract.payment_status = 'charge_sent' AND NOT v_has_native THEN 'pending'
    ELSE v_contract.payment_status
  END;

  UPDATE public.assessment_contracts
  SET external_payment_link = NULL,
      external_invoice_number = NULL,
      payment_message_sent_at = NULL,
      payment_status = v_next_payment_status,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, created_by
  ) VALUES (
    p_contract_id,
    'external_charge_removed',
    jsonb_build_object(
      'previous_link', v_previous.external_payment_link,
      'previous_invoice_number', v_previous.external_invoice_number,
      'previous_due_date', v_previous.due_date,
      'previous_payment_method', v_previous.payment_method,
      'payment_status_before', v_previous.payment_status,
      'payment_status_after', v_next_payment_status,
      'has_native_charge', v_has_native
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_assessment_contract_payment_message_sent(
  p_contract_id uuid,
  p_source text,
  p_external_link text,
  p_due_date date,
  p_metadata jsonb,
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
  v_previous_status text;
  v_parent_contract_id uuid;
  v_has_native boolean;
  v_effective_link text;
  v_effective_due_date date;
  v_next_payment_status text;
  v_next_contract_status text;
  v_sent_at timestamptz := now();
  v_payload jsonb;
BEGIN
  IF p_source NOT IN ('contract_detail', 'communication_center', 'renewals_page') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Origem da mensagem inválida';
  END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
     OR pg_column_size(p_metadata) > 32768 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Metadados da mensagem inválidos';
  END IF;
  IF p_external_link IS NOT NULL AND (
    length(p_external_link) > 2048
    OR p_external_link !~ '^https://[^[:space:][:cntrl:]]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um link HTTPS válido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished')
     OR v_contract.payment_status IN ('paid', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não possui cobrança aberta para envio';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_has_native := nullif(v_contract.asaas_charge_id, '') IS NOT NULL
    OR nullif(v_contract.asaas_payment_link, '') IS NOT NULL
    OR nullif(v_contract.asaas_pix_copy, '') IS NOT NULL
    OR nullif(v_contract.asaas_pix_qrcode, '') IS NOT NULL;
  v_effective_link := CASE
    WHEN v_has_native THEN v_contract.external_payment_link
    ELSE coalesce(p_external_link, v_contract.external_payment_link)
  END;
  v_effective_due_date := CASE
    WHEN v_has_native THEN v_contract.due_date
    ELSE coalesce(p_due_date, v_contract.due_date)
  END;
  IF NOT v_has_native AND nullif(v_effective_link, '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cadastre a cobrança antes de marcar a mensagem como enviada';
  END IF;
  IF NOT v_has_native AND v_effective_due_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a data de vencimento';
  END IF;

  v_next_payment_status := CASE
    WHEN v_contract.payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
    ELSE v_contract.payment_status
  END;
  v_next_contract_status := CASE
    WHEN v_contract.status = 'draft'
         AND v_contract.start_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date
      THEN 'scheduled'
    WHEN v_contract.status = 'draft' THEN 'active'
    ELSE v_contract.status
  END;
  v_previous_status := v_contract.status;
  v_parent_contract_id := v_contract.parent_contract_id;

  UPDATE public.assessment_contracts
  SET payment_message_sent_at = v_sent_at,
      external_payment_link = v_effective_link,
      due_date = v_effective_due_date,
      payment_status = v_next_payment_status,
      status = v_next_contract_status,
      updated_at = v_sent_at
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  v_payload := p_metadata || jsonb_build_object(
    'source', p_source,
    'via', 'whatsapp',
    'has_asaas_link', v_has_native,
    'has_external_link', nullif(v_effective_link, '') IS NOT NULL,
    'due_date', v_effective_due_date,
    'external_payment_link', v_effective_link
  );
  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    p_contract_id,
    'payment_message_sent',
    v_payload,
    CASE WHEN p_source = 'communication_center'
      THEN 'Mensagem enviada pela Central de Comunicação'
      ELSE NULL END,
    p_actor_id
  );

  IF v_previous_status = 'draft' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, created_by
    ) VALUES (
      p_contract_id,
      CASE
        WHEN v_parent_contract_id IS NOT NULL
             AND v_next_contract_status = 'scheduled' THEN 'renewal_scheduled'
        ELSE 'enrollment_activated'
      END,
      jsonb_build_object(
        'source', p_source,
        'status_after', v_next_contract_status,
        'start_date', v_contract.start_date
      ),
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'sent_at', v_sent_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_assessment_contract_external_charge(
  uuid, text, date, text, text, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_assessment_contract_external_charge(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_assessment_contract_payment_message_sent(
  uuid, text, text, date, jsonb, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_assessment_contract_external_charge(
  uuid, text, date, text, text, text, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_assessment_contract_external_charge(
  uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_assessment_contract_payment_message_sent(
  uuid, text, text, date, jsonb, timestamptz, uuid
) TO service_role;
