-- Nascimento e gênero no cadastro pelo link do plano -------------------------
-- Segue o que o cadastro do site já faz (20261029120000): a página do link
-- passa a enviar a data de nascimento e o gênero (opcional).
--
-- - Os dois entram como opcionais no servidor, para a página já aberta antes da
--   publicação não quebrar no envio; a obrigatoriedade da data fica na página.
-- - O comprovante (assessment_prospect_submissions) guarda o que foi enviado.
-- - Cliente novo já nasce com nascimento e gênero em presale_customers; cliente
--   existente (mesmo CPF) nunca é alterado por envio público.
-- - Gênero aceito: masculino, feminino ou outro (vazio = não informado).
-- - O DROP evita duas versões da função (a chamada ficaria ambígua).

DROP FUNCTION public.submit_plan_link_prospect(
  text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text,
  text, text, text, timestamptz, text, text, text
);

CREATE FUNCTION public.submit_plan_link_prospect(
  p_token text,
  p_request_id uuid,
  p_plan_id uuid,
  p_coach_id uuid,
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_cpf text,
  p_region text,
  p_address_zip text,
  p_address_street text,
  p_address_number text,
  p_address_complement text,
  p_address_neighborhood text,
  p_address_city text,
  p_address_state text,
  p_confirmed_at timestamptz,
  p_ip_hash text,
  p_phone_hash text,
  p_user_agent text,
  p_birth_date date DEFAULT NULL,
  p_gender text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_family public.assessment_plan_families%ROWTYPE;
  v_customer public.presale_customers%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_submission public.assessment_prospect_submissions%ROWTYPE;
  v_existing public.assessment_prospect_submissions%ROWTYPE;
  v_customer_count integer;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_months integer;
  v_end_date date;
  v_no_fee boolean;
  v_enrollment_fee numeric;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Identificador do envio inválido';
  END IF;

  p_gender := nullif(lower(btrim(p_gender)), '');

  PERFORM pg_advisory_xact_lock(hashtextextended('plan-link:' || p_request_id::text, 0));

  SELECT * INTO v_existing
  FROM public.assessment_prospect_submissions
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.submitted_full_name IS DISTINCT FROM p_full_name
       OR v_existing.submitted_whatsapp IS DISTINCT FROM p_whatsapp
       OR v_existing.submitted_cpf IS DISTINCT FROM p_cpf
       OR v_existing.plan_id IS DISTINCT FROM p_plan_id
       OR v_existing.coach_id IS DISTINCT FROM p_coach_id
       OR v_existing.submitted_birth_date IS DISTINCT FROM p_birth_date
       OR v_existing.submitted_gender IS DISTINCT FROM p_gender THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Esta chave de envio já foi usada com outros dados';
    END IF;
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'contract_id', v_existing.contract_id,
      'request_id', v_existing.request_id,
      'submitted_at', v_existing.submitted_at
    );
  END IF;

  IF p_confirmed_at IS NULL OR p_confirmed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Confirmação dos dados inválida';
  END IF;
  IF coalesce(length(btrim(p_full_name)), 0) < 3
     OR coalesce(length(p_cpf), 0) <> 11
     OR coalesce(length(p_address_zip), 0) <> 8
     OR coalesce(btrim(p_address_number), '') = ''
     OR coalesce(p_whatsapp, '') !~ '^\+[1-9][0-9]{7,14}$'
     OR (p_region IS NOT NULL AND p_region NOT IN ('florianopolis', 'online')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados obrigatórios inválidos';
  END IF;
  IF p_birth_date IS NOT NULL
     AND (p_birth_date < DATE '1900-01-01' OR p_birth_date > v_today) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Data de nascimento inválida';
  END IF;
  IF p_gender IS NOT NULL AND p_gender NOT IN ('masculino', 'feminino', 'outro') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Gênero inválido';
  END IF;

  DELETE FROM eon_private.public_form_rate_limits
  WHERE created_at < now() - interval '2 days';
  IF (SELECT count(*) FROM eon_private.public_form_rate_limits
      WHERE ip_hash = p_ip_hash AND created_at >= now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Muitas tentativas. Aguarde antes de enviar novamente';
  END IF;
  IF (SELECT count(*) FROM eon_private.public_form_rate_limits
      WHERE phone_hash = p_phone_hash AND created_at >= now() - interval '1 day') >= 4 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Este telefone já enviou vários cadastros hoje';
  END IF;
  INSERT INTO eon_private.public_form_rate_limits(ip_hash, phone_hash)
  VALUES (p_ip_hash, p_phone_hash);

  SELECT * INTO v_family
  FROM public.assessment_plan_families
  WHERE (link_token = p_token OR link_token_no_fee = p_token) AND active AND link_enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Link indisponível';
  END IF;
  v_no_fee := v_family.link_token_no_fee = p_token;

  SELECT * INTO v_plan
  FROM public.assessment_plans
  WHERE id = p_plan_id AND family_id = v_family.id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano indisponível';
  END IF;

  SELECT * INTO v_coach
  FROM public.assessment_coaches
  WHERE id = p_coach_id
    AND active IS TRUE
    AND v_plan.modality_id = ANY(modality_ids);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador indisponível para este plano';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_cpf, 0));
  SELECT count(*) INTO v_customer_count
  FROM public.presale_customers
  WHERE cpf = p_cpf;
  IF v_customer_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CPF duplicado no cadastro interno; atendimento manual necessário';
  END IF;

  SELECT * INTO v_customer
  FROM public.presale_customers
  WHERE cpf = p_cpf
  LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.presale_customers(
      full_name, whatsapp, email, cpf, coach_id, address_zip, address_street,
      address_number, address_complement, address_neighborhood, address_city,
      address_state, birth_date, gender
    ) VALUES (
      p_full_name, p_whatsapp, nullif(p_email, ''), p_cpf, p_coach_id,
      p_address_zip, nullif(p_address_street, ''), p_address_number,
      nullif(p_address_complement, ''), nullif(p_address_neighborhood, ''),
      nullif(p_address_city, ''), nullif(p_address_state, ''),
      p_birth_date, p_gender
    ) RETURNING * INTO v_customer;
  END IF;

  v_months := coalesce(v_plan.period_months, 1);
  v_end_date := (v_today + make_interval(months => v_months))::date;
  v_enrollment_fee := CASE WHEN v_no_fee THEN 0 ELSE coalesce(v_plan.enrollment_fee, 0) END;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND status = 'draft'
    AND parent_contract_id IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- Um prospect que já existe não é alterado; o envio fica registrado nele.
  IF NOT FOUND THEN
    INSERT INTO public.assessment_contracts(
      customer_id, coach_id, plan_id, plan_snapshot, status, payment_status,
      start_date, end_date, original_end_date, payment_method, installments,
      enrollment_fee, auto_renewal, notes
    ) VALUES (
      v_customer.id, p_coach_id, p_plan_id,
      jsonb_build_object(
        'plan_id', v_plan.id,
        'name', v_plan.name,
        'modality_id', v_plan.modality_id,
        'price_total', v_plan.price_total,
        'price_monthly', v_plan.price_monthly,
        'enrollment_fee', v_enrollment_fee,
        'enrollment_fee_waived', v_no_fee AND coalesce(v_plan.enrollment_fee, 0) > 0,
        'max_installments', v_plan.max_installments,
        'period_months', v_months,
        'snapshot_at', now(),
        'snapshot_source', 'plan_link'
      ),
      'draft', 'pending', v_today, v_end_date, v_end_date, 'pix_boleto',
      greatest(1, least(coalesce(v_plan.max_installments, 1), v_months)),
      v_enrollment_fee, false,
      concat_ws(' ',
        'Pré-matrícula pelo link do plano ' || v_family.name || '.',
        CASE WHEN v_no_fee THEN 'Link sem taxa de matrícula.' END,
        CASE WHEN p_region IS NOT NULL
          THEN 'Região: ' || p_region || '.' END,
        'Plano escolhido: ' || coalesce(v_plan.name, v_plan.id::text) || '.',
        'Treinador: ' || v_coach.name || '.'
      )
    ) RETURNING * INTO v_contract;
  END IF;

  INSERT INTO public.assessment_prospect_submissions(
    request_id, customer_id, contract_id, plan_id, coach_id,
    submitted_full_name, submitted_whatsapp, submitted_email, submitted_cpf,
    submitted_address_zip, submitted_address_street, submitted_address_number,
    submitted_address_complement, submitted_address_neighborhood,
    submitted_address_city, submitted_address_state,
    submitted_birth_date, submitted_gender,
    source, region, landing_page, utm, terms_accepted_at, ip_hash, user_agent
  ) VALUES (
    p_request_id, v_customer.id, v_contract.id, p_plan_id, p_coach_id,
    p_full_name, p_whatsapp, nullif(p_email, ''), p_cpf,
    p_address_zip, nullif(p_address_street, ''), p_address_number,
    nullif(p_address_complement, ''), nullif(p_address_neighborhood, ''),
    nullif(p_address_city, ''), nullif(p_address_state, ''),
    p_birth_date, p_gender,
    'plan_link', p_region, NULL, '{}'::jsonb, p_confirmed_at, p_ip_hash,
    nullif(left(p_user_agent, 500), '')
  )
  RETURNING * INTO v_submission;

  RETURN jsonb_build_object(
    'status', 'created',
    'contract_id', v_contract.id,
    'request_id', v_submission.request_id,
    'submitted_at', v_submission.submitted_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_plan_link_prospect(
  text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text,
  text, text, text, timestamptz, text, text, text,
  date, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_plan_link_prospect(
  text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text,
  text, text, text, timestamptz, text, text, text,
  date, text
) TO service_role;
