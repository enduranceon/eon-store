BEGIN;
SET LOCAL lock_timeout = '5s';

-- Fluxo de mensagens da proposta (docs/fluxos-de-mensagens.md, seção 2).
-- O prospect recebe um primeiro contato sem link e o quadro guarda a resposta:
-- "Aguardando resposta" e "Tirando dúvidas" são etapas novas antes da proposta.
-- O envio continua manual; as datas abaixo só alimentam o relógio da tela
-- (lembrete no dia 2, encerramento no dia 5, encerramento do link 5 dias depois
-- do vencimento e prazo final de 2 dias). Nada é arquivado sozinho.

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS prospect_first_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_last_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_followup_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_payment_reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_closing_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS prospect_close_deadline date;

COMMENT ON COLUMN public.assessment_contracts.prospect_first_contact_at IS
  'Primeiro contato da proposta, sem link, registrado pelo operador.';
COMMENT ON COLUMN public.assessment_contracts.prospect_last_contact_at IS
  'Início do relógio atual de lembrete e encerramento: primeiro contato, resposta com dúvidas ou conversa registrada.';
COMMENT ON COLUMN public.assessment_contracts.prospect_followup_sent_at IS
  'Lembrete enviado no relógio atual; volta a nulo quando a conversa recomeça.';
COMMENT ON COLUMN public.assessment_contracts.prospect_payment_reminder_sent_at IS
  'Último lembrete de pagamento (reenvio do link) registrado.';
COMMENT ON COLUMN public.assessment_contracts.prospect_closing_sent_at IS
  'Mensagem de encerramento com prazo final enviada para quem recebeu o link e não pagou.';
COMMENT ON COLUMN public.assessment_contracts.prospect_close_deadline IS
  'Último dia em que o link fica ativo depois do encerramento; depois disso a tela sugere arquivar.';

ALTER TABLE public.assessment_contracts
  DROP CONSTRAINT IF EXISTS assessment_contracts_prospect_stage_check;
ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_prospect_stage_check
  CHECK (
    prospect_stage IS NULL OR prospect_stage IN (
      'new', 'awaiting_reply', 'clarifying', 'proposal_ready',
      'payment_link_sent', 'converted', 'lost'
    )
  );

ALTER TABLE public.assessment_contracts
  DROP CONSTRAINT IF EXISTS assessment_contracts_prospect_loss_reason_check;
ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_prospect_loss_reason_check
  CHECK (
    prospect_loss_reason_code IS NULL OR prospect_loss_reason_code IN (
      'price', 'no_response', 'changed_mind', 'chose_competitor',
      'coach_availability', 'invalid_contact', 'other_service', 'other'
    )
  );

ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_prospect_contact_dates_check
  CHECK (
    prospect_stage IS NULL
    OR prospect_stage NOT IN ('awaiting_reply', 'clarifying')
    OR prospect_last_contact_at IS NOT NULL
  );

-- Encerrar também quem está nas etapas novas, com os motivos novos.
CREATE OR REPLACE FUNCTION public.lose_assessment_prospect(
  p_contract_id uuid,
  p_reason_code text,
  p_reason_notes text,
  p_external_cancellation_confirmed boolean,
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
  v_notes text := nullif(btrim(p_reason_notes), '');
  v_now timestamptz := now();
BEGIN
  IF p_reason_code NOT IN (
    'price', 'no_response', 'changed_mind', 'chose_competitor',
    'coach_availability', 'invalid_contact', 'other_service', 'other'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione um motivo válido';
  END IF;
  IF length(coalesce(v_notes, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O detalhe da perda é muito longo';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     OR v_contract.prospect_stage NOT IN (
       'new', 'awaiting_reply', 'clarifying', 'proposal_ready', 'payment_link_sent'
     )
     OR v_contract.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Somente um prospect aberto pode ser marcado como não convertido';
  END IF;
  IF v_contract.payment_status = 'paid'
     OR coalesce(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR coalesce(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect possui movimentação financeira e não pode ser encerrado aqui';
  END IF;
  IF nullif(v_contract.external_payment_link, '') IS NOT NULL
     AND coalesce(p_external_cancellation_confirmed, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Confirme que o link externo foi cancelado antes de encerrar o prospect';
  END IF;

  UPDATE public.assessment_contracts
  SET status = 'voided',
      payment_status = 'cancelled',
      prospect_stage = 'lost',
      prospect_lost_at = v_now,
      prospect_loss_reason_code = p_reason_code,
      prospect_loss_notes = v_notes,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_lost',
    jsonb_build_object(
      'reason_code', p_reason_code,
      'reason_notes', v_notes,
      'stage_after', 'lost',
      'external_cancellation_confirmed', coalesce(p_external_cancellation_confirmed, false)
    ),
    'Prospect marcado como não convertido',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- A proposta com link pode vir depois do primeiro contato ou das dúvidas.
-- Uma proposta nova zera o lembrete de pagamento e o encerramento anteriores.
CREATE OR REPLACE FUNCTION public.prepare_assessment_prospect_proposal(
  p_contract_id uuid,
  p_enrollment_fee numeric,
  p_manual_discount numeric,
  p_external_payment_link text,
  p_due_date date,
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
  v_link text := nullif(btrim(p_external_payment_link), '');
  v_now timestamptz := now();
BEGIN
  IF p_enrollment_fee IS NULL OR p_enrollment_fee < 0 OR p_enrollment_fee > 1000000
     OR p_manual_discount IS NULL OR p_manual_discount < 0 OR p_manual_discount > 1000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Os valores da proposta são inválidos';
  END IF;
  IF v_link IS NULL OR length(v_link) > 2048
     OR v_link !~ '^https://[^[:space:][:cntrl:]]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um link HTTPS válido';
  END IF;
  IF p_due_date IS NULL
     OR p_due_date < (v_now AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um vencimento válido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     OR v_contract.prospect_stage NOT IN (
       'new', 'awaiting_reply', 'clarifying', 'proposal_ready', 'payment_link_sent'
     )
     OR v_contract.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect não aceita uma nova proposta';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent')
     OR coalesce(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR coalesce(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect já possui movimentação financeira';
  END IF;

  UPDATE public.assessment_contracts
  SET enrollment_fee = p_enrollment_fee,
      manual_discount = p_manual_discount,
      external_payment_link = v_link,
      due_date = p_due_date,
      payment_status = 'charge_sent',
      prospect_stage = 'proposal_ready',
      prospect_proposal_ready_at = v_now,
      prospect_message_sent_at = NULL,
      payment_message_sent_at = NULL,
      prospect_payment_reminder_sent_at = NULL,
      prospect_closing_sent_at = NULL,
      prospect_close_deadline = NULL,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_proposal_prepared',
    jsonb_build_object(
      'due_date', p_due_date,
      'enrollment_fee', p_enrollment_fee,
      'manual_discount', p_manual_discount,
      'stage_after', 'proposal_ready'
    ),
    'Proposta e link de pagamento preparados',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- O reenvio do link vira o lembrete de pagamento. Se a pessoa voltou a
-- conversar depois do encerramento, o reenvio também retira o prazo final.
CREATE OR REPLACE FUNCTION public.mark_assessment_prospect_message_sent(
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
  v_was_sent boolean;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.status <> 'draft'
     OR v_contract.prospect_stage NOT IN ('proposal_ready', 'payment_link_sent') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Prepare a proposta antes de registrar o envio';
  END IF;
  IF nullif(v_contract.external_payment_link, '') IS NULL
     AND nullif(v_contract.asaas_payment_link, '') IS NULL
     AND nullif(v_contract.asaas_pix_copy, '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect ainda não possui link de pagamento';
  END IF;

  v_was_sent := v_contract.prospect_message_sent_at IS NOT NULL;

  UPDATE public.assessment_contracts
  SET prospect_stage = 'payment_link_sent',
      prospect_message_sent_at = v_now,
      payment_message_sent_at = v_now,
      prospect_payment_reminder_sent_at = CASE
        WHEN v_was_sent THEN v_now ELSE prospect_payment_reminder_sent_at
      END,
      prospect_closing_sent_at = CASE WHEN v_was_sent THEN NULL ELSE prospect_closing_sent_at END,
      prospect_close_deadline = CASE WHEN v_was_sent THEN NULL ELSE prospect_close_deadline END,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_payment_message_sent',
    jsonb_build_object(
      'stage_after', 'payment_link_sent',
      'sent_at', v_now,
      'resent', v_was_sent
    ),
    'Mensagem com link de pagamento marcada como enviada',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

-- A troca de plano limpa a proposta antiga; com ela vão o lembrete de
-- pagamento e o encerramento. O primeiro contato continua registrado.
CREATE OR REPLACE FUNCTION eon_private.reset_prospect_pipeline_on_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.prospect_stage IN ('proposal_ready', 'payment_link_sent')
     AND NEW.prospect_stage = OLD.prospect_stage
     AND NEW.plan_id IS DISTINCT FROM OLD.plan_id
     AND NEW.payment_status IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue')
     AND NEW.payment_date IS NULL
     AND COALESCE(NEW.manual_payment, false) IS FALSE THEN
    NEW.prospect_stage := 'new';
    NEW.prospect_proposal_ready_at := NULL;
    NEW.prospect_message_sent_at := NULL;
    NEW.prospect_payment_reminder_sent_at := NULL;
    NEW.prospect_closing_sent_at := NULL;
    NEW.prospect_close_deadline := NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- Um prospect em conversa também impede abrir outro para a mesma pessoa.
CREATE OR REPLACE FUNCTION public.create_manual_assessment_prospect(
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_cpf text,
  p_plan_id uuid,
  p_coach_id uuid,
  p_installments integer,
  p_notes text,
  p_idempotency_key text,
  p_actor_id uuid,
  p_gender text,
  p_birth_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_plan public.assessment_plans%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_customer public.presale_customers%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_previous_contract public.assessment_contracts%ROWTYPE;
  v_operation public.assessment_contract_creation_operations%ROWTYPE;
  v_months integer;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_snapshot jsonb;
  v_fingerprint text;
  v_relationship text := 'new_customer';
  v_result jsonb;
  v_identity text;
  v_customer_ids uuid[];
BEGIN
  p_full_name := NULLIF(btrim(p_full_name), '');
  p_whatsapp := regexp_replace(COALESCE(public.normalize_phone_br_e164(p_whatsapp), ''), '[^0-9]', '', 'g');
  p_email := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  p_cpf := NULLIF(regexp_replace(COALESCE(p_cpf, ''), '[^0-9]', '', 'g'), '');
  p_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
  p_gender := NULLIF(lower(btrim(COALESCE(p_gender, ''))), '');

  IF p_actor_id IS NULL OR p_full_name IS NULL
     OR length(p_full_name) < 2 OR length(p_full_name) > 200
     OR p_whatsapp !~ '^[0-9]{10,13}$'
     OR (p_email IS NOT NULL AND (length(p_email) > 320 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
     OR (p_cpf IS NOT NULL AND p_cpf !~ '^[0-9]{11}$')
     OR p_plan_id IS NULL OR p_coach_id IS NULL
     OR p_installments IS NULL OR p_installments < 1 OR p_installments > 120
     OR length(COALESCE(p_notes, '')) > 2000
     OR p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados do prospect são inválidos';
  END IF;

  IF p_gender IS NOT NULL AND p_gender NOT IN ('masculino', 'feminino', 'outro') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Selecione um gênero válido';
  END IF;
  IF p_birth_date IS NOT NULL AND (p_birth_date < DATE '1900-01-01' OR p_birth_date > v_today) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe uma data de nascimento válida, entre 1900 e hoje';
  END IF;

  v_fingerprint := md5((jsonb_build_object(
    'full_name', p_full_name,
    'whatsapp', p_whatsapp,
    'email', p_email,
    'cpf', p_cpf,
    'plan_id', p_plan_id,
    'coach_id', p_coach_id,
    'installments', p_installments,
    'notes', p_notes
  ) || jsonb_strip_nulls(jsonb_build_object('gender', p_gender, 'birth_date', p_birth_date)))::text);
  INSERT INTO public.assessment_contract_creation_operations(
    operation_scope, operation_key, request_fingerprint, requested_by
  ) VALUES (
    'manual_prospect', p_idempotency_key, v_fingerprint, p_actor_id
  ) ON CONFLICT (operation_scope, operation_key) DO NOTHING;

  SELECT * INTO v_operation
  FROM public.assessment_contract_creation_operations
  WHERE operation_scope = 'manual_prospect'
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF v_operation.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta chave de criação já foi usada com outros dados';
  END IF;
  IF v_operation.result IS NOT NULL THEN
    RETURN v_operation.result;
  END IF;

  SELECT * INTO v_coach
  FROM public.assessment_coaches
  WHERE id = p_coach_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach ativo não encontrado';
  END IF;

  SELECT * INTO v_plan
  FROM public.assessment_plans
  WHERE id = p_plan_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano ativo não encontrado';
  END IF;
  IF p_installments > v_plan.max_installments THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Quantidade de parcelas acima do limite do plano';
  END IF;

  -- Lock every supplied identity in a stable order, including retries without CPF.
  FOR v_identity IN
    SELECT DISTINCT identity FROM unnest(ARRAY[
      'manual_prospect:cpf:' || p_cpf,
      'manual_prospect:phone:' || p_whatsapp,
      'manual_prospect:email:' || p_email
    ]) AS identities(identity)
    WHERE identity IS NOT NULL ORDER BY identity
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_identity));
  END LOOP;
  SELECT array_agg(id) INTO v_customer_ids
  FROM public.presale_customers
  WHERE (p_cpf IS NOT NULL AND regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') = p_cpf)
     OR regexp_replace(COALESCE(public.normalize_phone_br_e164(whatsapp), ''), '[^0-9]', '', 'g') = p_whatsapp
     OR (p_email IS NOT NULL AND lower(btrim(email)) = p_email);
  IF cardinality(v_customer_ids) > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Os contatos informados correspondem a clientes diferentes. Revise os cadastros antes de criar o prospect';
  END IF;
  SELECT * INTO v_customer
  FROM public.presale_customers
  WHERE id = v_customer_ids[1]
  FOR UPDATE;

  IF FOUND THEN
    IF p_cpf IS NOT NULL AND NULLIF(regexp_replace(COALESCE(v_customer.cpf, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
       AND regexp_replace(v_customer.cpf, '[^0-9]', '', 'g') <> p_cpf THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contato informado já pertence a um cliente com outro CPF. Revise o cadastro';
    END IF;
    IF (p_birth_date IS NOT NULL AND v_customer.birth_date IS NOT NULL AND p_birth_date <> v_customer.birth_date)
       OR (p_gender IS NOT NULL AND NULLIF(btrim(v_customer.gender), '') IS NOT NULL AND p_gender <> v_customer.gender) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Gênero ou nascimento divergem do cliente existente. Revise o cadastro do cliente';
    END IF;
    UPDATE public.presale_customers
    SET full_name = COALESCE(NULLIF(btrim(full_name), ''), p_full_name),
        whatsapp = COALESCE(NULLIF(btrim(whatsapp), ''), '+' || p_whatsapp),
        email = COALESCE(NULLIF(btrim(email), ''), p_email),
        cpf = COALESCE(NULLIF(btrim(cpf), ''), p_cpf),
        gender = COALESCE(NULLIF(btrim(gender), ''), p_gender),
        birth_date = COALESCE(birth_date, p_birth_date),
        updated_date = now()
    WHERE id = v_customer.id
    RETURNING * INTO v_customer;
  ELSE
    INSERT INTO public.presale_customers(full_name, whatsapp, email, cpf, gender, birth_date, active)
    VALUES (p_full_name, '+' || p_whatsapp, p_email, p_cpf, p_gender, p_birth_date, true)
    RETURNING * INTO v_customer;
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND status = 'draft'
    AND parent_contract_id IS NULL
    AND prospect_stage IN ('new', 'awaiting_reply', 'clarifying', 'proposal_ready', 'payment_link_sent')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este cliente já possui um prospect em negociação';
  END IF;

  SELECT * INTO v_previous_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND parent_contract_id IS NULL
    AND status IN ('active', 'scheduled', 'paused', 'cancelled', 'finished')
  ORDER BY CASE WHEN status IN ('active', 'scheduled', 'paused') THEN 0 ELSE 1 END,
           COALESCE(cancellation_date, end_date, updated_at::date, created_at::date) DESC,
           created_at DESC
  LIMIT 1;
  IF FOUND THEN
    v_relationship := CASE
      WHEN v_previous_contract.status IN ('active', 'scheduled', 'paused') THEN 'active_student'
      ELSE 'former_student'
    END;
  END IF;

  v_months := COALESCE(
    v_plan.period_months,
    CASE v_plan.period
      WHEN 'mensal' THEN 1
      WHEN 'trimestral' THEN 3
      WHEN 'semestral' THEN 6
      WHEN 'anual' THEN 12
      ELSE 1
    END
  );
  IF v_months < 1 OR v_months > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Período do plano inválido';
  END IF;
  v_snapshot := jsonb_build_object(
    'plan_id', v_plan.id,
    'name', v_plan.name,
    'modality_id', v_plan.modality_id,
    'price_total', v_plan.price_total,
    'price_monthly', v_plan.price_monthly,
    'enrollment_fee', v_plan.enrollment_fee,
    'max_installments', v_plan.max_installments,
    'period_months', v_months,
    'period', v_plan.period,
    'revenue_center_id', v_plan.revenue_center_id,
    'snapshot_at', now(),
    'snapshot_source', 'manual_prospect_api'
  );
  INSERT INTO public.assessment_contracts(
    customer_id, coach_id, plan_id, plan_snapshot,
    status, payment_status, start_date, end_date, original_end_date,
    installments, enrollment_fee, manual_discount, auto_renewal, notes,
    prospect_stage, prospect_customer_relationship, prospect_previous_contract_id,
    created_by
  ) VALUES (
    v_customer.id, v_coach.id, v_plan.id, v_snapshot,
    'draft', 'pending', v_today, v_today + make_interval(months => v_months),
    v_today + make_interval(months => v_months),
    p_installments, v_plan.enrollment_fee, 0, false, p_notes,
    'new', v_relationship,
    CASE WHEN v_relationship = 'new_customer' THEN NULL ELSE v_previous_contract.id END,
    p_actor_id
  ) RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_created_manually',
    jsonb_build_object(
      'source', 'manual_prospect_api',
      'plan_snapshot', v_snapshot,
      'coach_id', v_coach.id,
      'installments', p_installments,
      'customer_reused', v_customer.created_date < now() - interval '1 second',
      'relationship', v_relationship,
      'previous_contract_id', CASE WHEN v_relationship = 'new_customer' THEN NULL ELSE v_previous_contract.id END
    ),
    'Prospect incluído manualmente no funil comercial',
    p_actor_id
  );

  v_result := jsonb_build_object('contract', to_jsonb(v_contract));
  UPDATE public.assessment_contract_creation_operations
  SET result = v_result, updated_at = now()
  WHERE id = v_operation.id;
  RETURN v_result;
END;
$$;


-- Registro manual de cada passo da conversa, antes do link.
--   first_contact  primeiro contato (Novo -> Aguardando resposta)
--   follow_up      lembrete do relógio atual
--   has_questions  a pessoa respondeu com dúvidas (-> Tirando dúvidas)
--   conversation   conversa registrada em Tirando dúvidas; o relógio recomeça
--   closing        encerramento: sem link arquiva como "Não respondeu";
--                  com link deixa o link ativo por mais 2 dias
CREATE OR REPLACE FUNCTION public.register_assessment_prospect_contact(
  p_contract_id uuid,
  p_action text,
  p_external_cancellation_confirmed boolean,
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
  v_now timestamptz := now();
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_stage_before text;
  v_event text;
  v_note text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN (
    'first_contact', 'follow_up', 'has_questions', 'conversation', 'closing'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Ação de contato inválida';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     OR v_contract.status <> 'draft'
     OR v_contract.prospect_stage IS NULL
     OR v_contract.prospect_stage IN ('converted', 'lost') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect não está mais em negociação';
  END IF;
  IF v_contract.payment_status = 'paid' OR v_contract.payment_date IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect já tem pagamento registrado';
  END IF;
  v_stage_before := v_contract.prospect_stage;

  IF p_action = 'first_contact' THEN
    IF v_stage_before <> 'new' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O primeiro contato é só para prospects novos';
    END IF;
    UPDATE public.assessment_contracts
    SET prospect_stage = 'awaiting_reply',
        prospect_first_contact_at = coalesce(prospect_first_contact_at, v_now),
        prospect_last_contact_at = v_now,
        prospect_followup_sent_at = NULL,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event := 'prospect_first_contact_sent';
    v_note := 'Primeiro contato enviado, sem link';
  ELSIF p_action = 'follow_up' THEN
    IF v_stage_before NOT IN ('awaiting_reply', 'clarifying') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O lembrete é para quem está aguardando resposta ou tirando dúvidas';
    END IF;
    UPDATE public.assessment_contracts
    SET prospect_followup_sent_at = v_now,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event := 'prospect_follow_up_sent';
    v_note := 'Lembrete enviado';
  ELSIF p_action = 'has_questions' THEN
    IF v_stage_before NOT IN ('new', 'awaiting_reply', 'clarifying') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'As dúvidas são registradas antes da proposta com link';
    END IF;
    UPDATE public.assessment_contracts
    SET prospect_stage = 'clarifying',
        prospect_last_contact_at = v_now,
        prospect_followup_sent_at = NULL,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event := 'prospect_reply_registered';
    v_note := 'Respondeu com dúvidas';
  ELSIF p_action = 'conversation' THEN
    IF v_stage_before <> 'clarifying' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A conversa é registrada em “Tirando dúvidas”';
    END IF;
    UPDATE public.assessment_contracts
    SET prospect_last_contact_at = v_now,
        prospect_followup_sent_at = NULL,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event := 'prospect_conversation_registered';
    v_note := 'Conversa registrada';
  ELSIF v_stage_before IN ('awaiting_reply', 'clarifying') THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id,
      'prospect_closing_sent',
      jsonb_build_object('stage_before', v_stage_before, 'stage_after', 'lost', 'sent_at', v_now),
      'Mensagem de encerramento enviada; proposta arquivada sem resposta',
      p_actor_id
    );
    RETURN public.lose_assessment_prospect(
      v_contract.id,
      'no_response',
      'Mensagem de encerramento enviada sem resposta',
      p_external_cancellation_confirmed,
      v_contract.updated_at,
      p_actor_id
    );
  ELSIF v_stage_before = 'payment_link_sent' THEN
    UPDATE public.assessment_contracts
    SET prospect_closing_sent_at = v_now,
        prospect_close_deadline = v_today + 2,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event := 'prospect_closing_sent';
    v_note := 'Mensagem de encerramento enviada; link ativo até o prazo final';
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O encerramento é para quem não respondeu ou não pagou o link';
  END IF;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    v_event,
    jsonb_build_object(
      'action', p_action,
      'stage_before', v_stage_before,
      'stage_after', v_contract.prospect_stage,
      'sent_at', v_now,
      'close_deadline', v_contract.prospect_close_deadline
    ),
    v_note,
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

REVOKE ALL ON FUNCTION public.register_assessment_prospect_contact(
  uuid, text, boolean, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_assessment_prospect_contact(
  uuid, text, boolean, timestamptz, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.prepare_assessment_prospect_proposal(
  uuid, numeric, numeric, text, date, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_assessment_prospect_message_sent(
  uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lose_assessment_prospect(
  uuid, text, text, boolean, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.reset_prospect_pipeline_on_plan_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_assessment_prospect_proposal(
  uuid, numeric, numeric, text, date, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_assessment_prospect_message_sent(
  uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.lose_assessment_prospect(
  uuid, text, text, boolean, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.reset_prospect_pipeline_on_plan_change()
  TO service_role;
REVOKE ALL ON FUNCTION public.create_manual_assessment_prospect(
  text, text, text, text, uuid, uuid, integer, text, text, uuid, text, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_assessment_prospect(
  text, text, text, text, uuid, uuid, integer, text, text, uuid, text, date
) TO service_role;

COMMENT ON FUNCTION public.register_assessment_prospect_contact(
  uuid, text, boolean, timestamptz, uuid
) IS 'Registra o primeiro contato, o lembrete, as dúvidas, a conversa e o encerramento da proposta. Não cria nem cancela cobranças.';

COMMIT;
