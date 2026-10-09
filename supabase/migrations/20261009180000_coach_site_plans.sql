-- Planos que cada coach vende no site: um plano por modalidade e duração
-- (mensal, trimestral, semestral...). Vale só para o formulário público; a
-- venda interna continua podendo usar qualquer plano. Coach sem plano escolhido
-- numa modalidade segue com os planos gerais do site, como antes.

CREATE TABLE public.assessment_coach_site_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL
    REFERENCES public.assessment_coaches(id) ON DELETE CASCADE,
  modality_id uuid NOT NULL
    REFERENCES public.assessment_modalities(id) ON DELETE CASCADE,
  period_months integer NOT NULL CHECK (period_months BETWEEN 1 AND 120),
  plan_id uuid NOT NULL
    REFERENCES public.assessment_plans(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_coach_site_plans_slot_key
    UNIQUE (coach_id, modality_id, period_months)
);

CREATE INDEX assessment_coach_site_plans_plan_idx
  ON public.assessment_coach_site_plans (plan_id);

COMMENT ON TABLE public.assessment_coach_site_plans IS
  'Plano que o coach vende no site em cada modalidade e duração. Só o formulário público lê; a venda interna escolhe qualquer plano.';

-- O plano escolhido precisa ser ativo, da mesma modalidade e da mesma duração.
CREATE OR REPLACE FUNCTION eon_private.guard_coach_site_plan()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_plan record;
BEGIN
  SELECT plan.modality_id, plan.period_months, plan.active
    INTO v_plan
    FROM public.assessment_plans AS plan
   WHERE plan.id = NEW.plan_id;
  IF NOT FOUND OR NOT COALESCE(v_plan.active, false) THEN
    RAISE EXCEPTION 'Escolha um plano ativo' USING ERRCODE = '22023';
  END IF;
  IF v_plan.modality_id IS DISTINCT FROM NEW.modality_id THEN
    RAISE EXCEPTION 'O plano escolhido é de outra modalidade' USING ERRCODE = '22023';
  END IF;
  IF v_plan.period_months IS DISTINCT FROM NEW.period_months THEN
    RAISE EXCEPTION 'O plano escolhido é de outra duração' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_coach_site_plan
  BEFORE INSERT OR UPDATE ON public.assessment_coach_site_plans
  FOR EACH ROW EXECUTE FUNCTION eon_private.guard_coach_site_plan();

REVOKE ALL ON FUNCTION eon_private.guard_coach_site_plan() FROM PUBLIC, anon, authenticated;

-- Acesso: painel admin lê; escrita só pelo backend -----------------------------

ALTER TABLE public.assessment_coach_site_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_coach_site_plans
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_coach_site_plans
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_coach_site_plans FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assessment_coach_site_plans FROM authenticated;
GRANT SELECT ON public.assessment_coach_site_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_coach_site_plans TO service_role;

-- Cadastro pelo site: aceita também o plano escolhido para o coach -------------
-- (mesma função de 20261008233000, só a conferência do plano mudou)

CREATE OR REPLACE FUNCTION public.submit_public_assessment_prospect(
  p_request_id uuid,
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_cpf text,
  p_plan_id uuid,
  p_coach_id uuid,
  p_region text,
  p_address_zip text,
  p_address_street text,
  p_address_number text,
  p_address_complement text,
  p_address_neighborhood text,
  p_address_city text,
  p_address_state text,
  p_terms_accepted_at timestamptz,
  p_landing_page text,
  p_utm jsonb,
  p_ip_hash text,
  p_phone_hash text,
  p_user_agent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_customer public.presale_customers%ROWTYPE;
  v_contract public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_coach public.assessment_coaches%ROWTYPE;
  v_submission public.assessment_prospect_submissions%ROWTYPE;
  v_existing_submission public.assessment_prospect_submissions%ROWTYPE;
  v_customer_count integer;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_months integer;
  v_end_date date;
  v_notes text;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Identificador do envio inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('public-assessment-prospect:' || p_request_id::text, 0)
  );

  SELECT * INTO v_existing_submission
  FROM public.assessment_prospect_submissions
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_existing_submission.submitted_full_name IS DISTINCT FROM p_full_name
       OR v_existing_submission.submitted_whatsapp IS DISTINCT FROM p_whatsapp
       OR coalesce(v_existing_submission.submitted_email, '')
          IS DISTINCT FROM coalesce(p_email, '')
       OR v_existing_submission.submitted_cpf IS DISTINCT FROM p_cpf
       OR v_existing_submission.plan_id IS DISTINCT FROM p_plan_id
       OR v_existing_submission.coach_id IS DISTINCT FROM p_coach_id
       OR coalesce(v_existing_submission.region, '')
          IS DISTINCT FROM coalesce(p_region, '')
       OR coalesce(v_existing_submission.submitted_address_zip, '')
          IS DISTINCT FROM coalesce(p_address_zip, '')
       OR coalesce(v_existing_submission.submitted_address_street, '')
          IS DISTINCT FROM coalesce(p_address_street, '')
       OR coalesce(v_existing_submission.submitted_address_number, '')
          IS DISTINCT FROM coalesce(p_address_number, '')
       OR coalesce(v_existing_submission.submitted_address_complement, '')
          IS DISTINCT FROM coalesce(p_address_complement, '')
       OR coalesce(v_existing_submission.submitted_address_neighborhood, '')
          IS DISTINCT FROM coalesce(p_address_neighborhood, '')
       OR coalesce(v_existing_submission.submitted_address_city, '')
          IS DISTINCT FROM coalesce(p_address_city, '')
       OR coalesce(v_existing_submission.submitted_address_state, '')
          IS DISTINCT FROM coalesce(p_address_state, '') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Esta chave de envio já foi usada com outros dados';
    END IF;

    SELECT * INTO v_contract
    FROM public.assessment_contracts
    WHERE id = v_existing_submission.contract_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'O comprovante deste envio não está disponível';
    END IF;

    RETURN jsonb_build_object(
      'status', 'duplicate',
      'customer_id', v_existing_submission.customer_id,
      'contract_id', v_existing_submission.contract_id,
      'contract_number', v_contract.contract_number,
      'submission_id', v_existing_submission.id,
      'request_id', v_existing_submission.request_id,
      'submitted_at', v_existing_submission.submitted_at
    );
  END IF;

  IF p_terms_accepted_at IS NULL OR p_terms_accepted_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Aceite dos termos inválido';
  END IF;
  IF coalesce(length(btrim(p_full_name)), 0) < 3
     OR coalesce(length(p_cpf), 0) <> 11
     OR coalesce(length(p_address_zip), 0) <> 8
     OR coalesce(btrim(p_address_number), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados obrigatórios inválidos';
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

  -- Plano geral do site ou o plano escolhido para este coach no site.
  SELECT * INTO v_plan
  FROM public.assessment_plans AS plan
  WHERE plan.id = p_plan_id
    AND plan.active IS TRUE
    AND (
      plan.available_online IS TRUE
      OR EXISTS (
        SELECT 1
        FROM public.assessment_coach_site_plans AS site
        WHERE site.coach_id = p_coach_id
          AND site.plan_id = plan.id
      )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano indisponível';
  END IF;

  SELECT * INTO v_coach
  FROM public.assessment_coaches
  WHERE id = p_coach_id
    AND active IS TRUE
    AND public_visible IS TRUE
    AND v_plan.modality_id = ANY(modality_ids);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Treinador indisponível para este plano no site';
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
  -- Never overwrite identity/contact data only because a public sender knows
  -- the CPF. The submitted values remain in the auditable submission row.
  IF NOT FOUND THEN
    INSERT INTO public.presale_customers(
      full_name, whatsapp, email, cpf, coach_id, address_zip, address_street,
      address_number, address_complement, address_neighborhood, address_city,
      address_state
    ) VALUES (
      p_full_name, p_whatsapp, nullif(p_email, ''), p_cpf, p_coach_id,
      p_address_zip, nullif(p_address_street, ''), p_address_number,
      nullif(p_address_complement, ''), nullif(p_address_neighborhood, ''),
      nullif(p_address_city, ''), nullif(p_address_state, '')
    ) RETURNING * INTO v_customer;
  END IF;

  v_months := coalesce(v_plan.period_months, 1);
  v_end_date := (v_today + make_interval(months => v_months))::date;
  v_notes := concat_ws(' ',
    'Pré-matrícula enviada pelo site Endurance On.',
    CASE WHEN nullif(p_region, '') IS NOT NULL
      THEN 'Região: ' || p_region || '.' END,
    'Plano selecionado: ' ||
      coalesce(v_plan.name, v_plan.period, v_plan.id::text) || '.',
    'Treinador escolhido: ' || v_coach.name || '.'
  );

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE customer_id = v_customer.id
    AND status = 'draft'
    AND parent_contract_id IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- A repeated public submission never mutates an existing prospect.
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
        'enrollment_fee', v_plan.enrollment_fee,
        'max_installments', v_plan.max_installments,
        'period_months', v_months,
        'snapshot_at', now(),
        'snapshot_source', 'enduranceon_site'
      ),
      'draft', 'pending', v_today, v_end_date, v_end_date, 'pix_boleto',
      greatest(1, least(coalesce(v_plan.max_installments, 1), v_months)),
      coalesce(v_plan.enrollment_fee, 0), false, v_notes
    ) RETURNING * INTO v_contract;
  END IF;

  INSERT INTO public.assessment_prospect_submissions(
    request_id, customer_id, contract_id, plan_id, coach_id,
    submitted_full_name, submitted_whatsapp, submitted_email, submitted_cpf,
    submitted_address_zip, submitted_address_street, submitted_address_number,
    submitted_address_complement, submitted_address_neighborhood,
    submitted_address_city, submitted_address_state,
    source, region, landing_page, utm, terms_accepted_at, ip_hash, user_agent
  ) VALUES (
    p_request_id, v_customer.id, v_contract.id, p_plan_id, p_coach_id,
    p_full_name, p_whatsapp, nullif(p_email, ''), p_cpf,
    p_address_zip, nullif(p_address_street, ''), p_address_number,
    nullif(p_address_complement, ''), nullif(p_address_neighborhood, ''),
    nullif(p_address_city, ''), nullif(p_address_state, ''),
    'enduranceon_site', nullif(p_region, ''), nullif(p_landing_page, ''),
    coalesce(p_utm, '{}'::jsonb), p_terms_accepted_at, p_ip_hash,
    nullif(left(p_user_agent, 500), '')
  )
  RETURNING * INTO v_submission;

  RETURN jsonb_build_object(
    'status', 'created',
    'customer_id', v_customer.id,
    'contract_id', v_contract.id,
    'contract_number', v_contract.contract_number,
    'submission_id', v_submission.id,
    'request_id', v_submission.request_id,
    'submitted_at', v_submission.submitted_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_public_assessment_prospect(
  uuid, text, text, text, text, uuid, uuid, text, text, text, text, text,
  text, text, text, timestamptz, text, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_public_assessment_prospect(
  uuid, text, text, text, text, uuid, uuid, text, text, text, text, text,
  text, text, text, timestamptz, text, jsonb, text, text, text
) TO service_role;
