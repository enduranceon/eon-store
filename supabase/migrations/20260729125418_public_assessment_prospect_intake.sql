-- Public assessment prospect intake.
-- Browser requests terminate at the Edge Function. Only the service role may
-- call this function or write the supporting tables.

CREATE TABLE IF NOT EXISTS public.assessment_prospect_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES public.presale_customers(id),
  contract_id uuid NOT NULL REFERENCES public.assessment_contracts(id),
  plan_id uuid NOT NULL REFERENCES public.assessment_plans(id),
  coach_id uuid NOT NULL REFERENCES public.assessment_coaches(id),
  submitted_full_name text NOT NULL,
  submitted_whatsapp text NOT NULL,
  submitted_email text,
  submitted_cpf text NOT NULL,
  source text NOT NULL DEFAULT 'enduranceon_site',
  region text,
  landing_page text,
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms_accepted_at timestamptz NOT NULL,
  ip_hash text NOT NULL,
  user_agent text,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assessment_prospect_submissions_contract_idx
  ON public.assessment_prospect_submissions(contract_id, submitted_at DESC);

ALTER TABLE public.assessment_prospect_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_admin_only ON public.assessment_prospect_submissions;
CREATE POLICY app_admin_only ON public.assessment_prospect_submissions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));

DROP POLICY IF EXISTS app_admin_read ON public.assessment_prospect_submissions;
CREATE POLICY app_admin_read ON public.assessment_prospect_submissions
  FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

GRANT SELECT ON public.assessment_prospect_submissions TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assessment_prospect_submissions
  FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS eon_private.public_form_rate_limits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash text NOT NULL,
  phone_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_form_rate_limits_ip_idx
  ON eon_private.public_form_rate_limits(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS public_form_rate_limits_phone_idx
  ON eon_private.public_form_rate_limits(phone_hash, created_at DESC);

REVOKE ALL ON eon_private.public_form_rate_limits FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA eon_private TO service_role;
GRANT SELECT, INSERT, DELETE ON eon_private.public_form_rate_limits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE eon_private.public_form_rate_limits_id_seq TO service_role;

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
  v_existing_submission public.assessment_prospect_submissions%ROWTYPE;
  v_customer_count integer;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_months integer;
  v_end_date date;
  v_notes text;
BEGIN
  SELECT * INTO v_existing_submission
  FROM public.assessment_prospect_submissions
  WHERE request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'customer_id', v_existing_submission.customer_id,
      'contract_id', v_existing_submission.contract_id
    );
  END IF;

  IF p_terms_accepted_at IS NULL OR p_terms_accepted_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Aceite dos termos inválido';
  END IF;
  IF coalesce(length(btrim(p_full_name)), 0) < 3 OR coalesce(length(p_cpf), 0) <> 11
     OR coalesce(length(p_address_zip), 0) <> 8 OR coalesce(btrim(p_address_number), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados obrigatórios inválidos';
  END IF;

  DELETE FROM eon_private.public_form_rate_limits
  WHERE created_at < now() - interval '2 days';
  IF (SELECT count(*) FROM eon_private.public_form_rate_limits
      WHERE ip_hash = p_ip_hash AND created_at >= now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Muitas tentativas. Aguarde antes de enviar novamente';
  END IF;
  IF (SELECT count(*) FROM eon_private.public_form_rate_limits
      WHERE phone_hash = p_phone_hash AND created_at >= now() - interval '1 day') >= 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este telefone já enviou vários cadastros hoje';
  END IF;
  INSERT INTO eon_private.public_form_rate_limits(ip_hash, phone_hash)
  VALUES (p_ip_hash, p_phone_hash);

  SELECT * INTO v_plan FROM public.assessment_plans
  WHERE id = p_plan_id AND active IS TRUE AND available_online IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Plano indisponível';
  END IF;
  SELECT * INTO v_coach FROM public.assessment_coaches
  WHERE id = p_coach_id AND active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador indisponível';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_cpf, 0));
  SELECT count(*) INTO v_customer_count FROM public.presale_customers WHERE cpf = p_cpf;
  IF v_customer_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CPF duplicado no cadastro interno; atendimento manual necessário';
  END IF;

  SELECT * INTO v_customer FROM public.presale_customers WHERE cpf = p_cpf LIMIT 1;
  -- A public form must never overwrite an existing customer's identity or
  -- contact data merely because the sender knows the CPF. Submitted values are
  -- retained in the audit row for an administrator to compare manually.
  IF NOT FOUND THEN
    INSERT INTO public.presale_customers(
      full_name, whatsapp, email, cpf, coach_id, address_zip, address_street,
      address_number, address_complement, address_neighborhood, address_city, address_state
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
    CASE WHEN nullif(p_region, '') IS NOT NULL THEN 'Região: ' || p_region || '.' END,
    'Plano selecionado: ' || coalesce(v_plan.name, v_plan.period, v_plan.id::text) || '.',
    'Treinador escolhido: ' || v_coach.name || '.'
  );

  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE customer_id = v_customer.id AND status = 'draft' AND parent_contract_id IS NULL
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  -- Repeated public submissions never mutate an existing prospect. This keeps
  -- a caller who knows somebody else's CPF from changing their selected plan.
  IF NOT FOUND THEN
    INSERT INTO public.assessment_contracts(
      customer_id, coach_id, plan_id, plan_snapshot, status, payment_status,
      start_date, end_date, original_end_date, payment_method, installments,
      enrollment_fee, auto_renewal, notes
    ) VALUES (
      v_customer.id, p_coach_id, p_plan_id,
      jsonb_build_object(
        'plan_id', v_plan.id, 'name', v_plan.name, 'modality_id', v_plan.modality_id,
        'price_total', v_plan.price_total, 'price_monthly', v_plan.price_monthly,
        'enrollment_fee', v_plan.enrollment_fee, 'max_installments', v_plan.max_installments,
        'period_months', v_months, 'snapshot_at', now(), 'snapshot_source', 'enduranceon_site'
      ),
      'draft', 'pending', v_today, v_end_date, v_end_date, 'pix_boleto',
      greatest(1, least(coalesce(v_plan.max_installments, 1), v_months)),
      coalesce(v_plan.enrollment_fee, 0), false, v_notes
    ) RETURNING * INTO v_contract;
  END IF;

  INSERT INTO public.assessment_prospect_submissions(
    request_id, customer_id, contract_id, plan_id, coach_id,
    submitted_full_name, submitted_whatsapp, submitted_email, submitted_cpf,
    source, region,
    landing_page, utm, terms_accepted_at, ip_hash, user_agent
  ) VALUES (
    p_request_id, v_customer.id, v_contract.id, p_plan_id, p_coach_id,
    p_full_name, p_whatsapp, nullif(p_email, ''), p_cpf,
    'enduranceon_site', nullif(p_region, ''), nullif(p_landing_page, ''),
    coalesce(p_utm, '{}'::jsonb), p_terms_accepted_at, p_ip_hash,
    nullif(left(p_user_agent, 500), '')
  );

  RETURN jsonb_build_object(
    'status', 'created', 'customer_id', v_customer.id,
    'contract_id', v_contract.id, 'contract_number', v_contract.contract_number
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
