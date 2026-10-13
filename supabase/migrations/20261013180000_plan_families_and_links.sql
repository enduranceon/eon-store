-- Planos agrupados e link do plano para WhatsApp.
--
-- Um grupo ("Corrida - Essencial") reúne as durações do mesmo plano (mensal,
-- trimestral, semestral). Cada duração continua sendo o registro de
-- assessment_plans que contratos, renovações, trocas e a matriz já usam; o
-- grupo só organiza a tela e dá o link que a equipe manda no WhatsApp. Quem
-- preenche o link vira prospect no quadro, como o cadastro do site.

CREATE TABLE public.assessment_plan_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modality_id uuid NOT NULL
    REFERENCES public.assessment_modalities(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  active boolean NOT NULL DEFAULT true,
  link_enabled boolean NOT NULL DEFAULT true,
  -- Parte secreta do link: quem não recebeu o link não acha o formulário.
  -- O link sem matrícula tem o próprio segredo, para ninguém tirar a taxa
  -- mexendo no endereço.
  link_token text NOT NULL UNIQUE
    DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 20)
    CHECK (link_token ~ '^[a-z0-9]{16,40}$'),
  link_token_no_fee text NOT NULL UNIQUE
    DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 20)
    CHECK (link_token_no_fee ~ '^[a-z0-9]{16,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (link_token <> link_token_no_fee)
);

CREATE UNIQUE INDEX assessment_plan_families_name_key
  ON public.assessment_plan_families (modality_id, lower(btrim(name)));

COMMENT ON TABLE public.assessment_plan_families IS
  'Grupo de durações do mesmo plano (mensal, trimestral, semestral) e o link do plano para WhatsApp.';

ALTER TABLE public.assessment_plans
  ADD COLUMN family_id uuid
    REFERENCES public.assessment_plan_families(id) ON DELETE SET NULL;

CREATE INDEX assessment_plans_family_idx
  ON public.assessment_plans (family_id) WHERE family_id IS NOT NULL;

CREATE OR REPLACE FUNCTION eon_private.touch_plan_family()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  NEW.name := btrim(regexp_replace(NEW.name, '\s+', ' ', 'g'));
  IF TG_OP = 'UPDATE' THEN
    NEW.modality_id := OLD.modality_id;
    NEW.link_token := OLD.link_token;
    NEW.link_token_no_fee := OLD.link_token_no_fee;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_plan_family
  BEFORE INSERT OR UPDATE ON public.assessment_plan_families
  FOR EACH ROW EXECUTE FUNCTION eon_private.touch_plan_family();

-- Duração no grupo: mesma modalidade e uma duração ativa por grupo.
CREATE OR REPLACE FUNCTION eon_private.guard_plan_family()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.family_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.assessment_plan_families AS family
    WHERE family.id = NEW.family_id AND family.modality_id = NEW.modality_id
  ) THEN
    RAISE EXCEPTION 'O grupo é de outra modalidade' USING ERRCODE = '22023';
  END IF;
  IF NEW.active AND EXISTS (
    SELECT 1 FROM public.assessment_plans AS other
    WHERE other.family_id = NEW.family_id
      AND other.active
      AND other.period_months IS NOT DISTINCT FROM NEW.period_months
      AND other.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'Este plano já tem uma duração ativa com esses meses' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_plan_family
  BEFORE INSERT OR UPDATE OF family_id, modality_id, period_months, active
  ON public.assessment_plans
  FOR EACH ROW EXECUTE FUNCTION eon_private.guard_plan_family();

REVOKE ALL ON FUNCTION eon_private.touch_plan_family() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.guard_plan_family() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.assessment_plan_families ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_plan_families
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_plan_families
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_plan_families FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assessment_plan_families FROM authenticated;
GRANT SELECT ON public.assessment_plan_families TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_plan_families TO service_role;

-- Agrupa os planos ativos de hoje pelo nome: "Corrida - Essencial - Mensal",
-- "... - Trimestral" e "... - Semestral" viram o grupo "Corrida - Essencial".
-- Planos desativados (sistema antigo) ficam sem grupo, como histórico.
CREATE FUNCTION eon_private.plan_family_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_name ~* '\s-\s*(mensal|trimestral|semestral|anual)\s*$' THEN
    regexp_replace(
      btrim(regexp_replace(p_name, '\s*-\s*(mensal|trimestral|semestral|anual)\s*$', '', 'i')),
      '^(\S+) (Essencial|Premium)$', '\1 - \2'
    )
  END
$$;

INSERT INTO public.assessment_plan_families (modality_id, name)
SELECT DISTINCT plan.modality_id, eon_private.plan_family_name(plan.name)
FROM public.assessment_plans AS plan
WHERE plan.active AND eon_private.plan_family_name(plan.name) IS NOT NULL;

UPDATE public.assessment_plans AS plan
SET family_id = family.id
FROM public.assessment_plan_families AS family
WHERE plan.active
  AND family.modality_id = plan.modality_id
  AND family.name = eon_private.plan_family_name(plan.name);

DROP FUNCTION eon_private.plan_family_name(text);

-- Envio pelo link: o coach só precisa estar ativo e atender a modalidade (o
-- link é mandado pela equipe, inclusive com coach que não aparece no site).
CREATE OR REPLACE FUNCTION eon_private.enforce_public_submission_coach()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  SELECT c.active IS TRUE
     AND (c.public_visible IS TRUE OR NEW.source = 'plan_link')
     AND p.modality_id = ANY(c.modality_ids)
  INTO v_allowed
  FROM public.assessment_coaches c
  JOIN public.assessment_plans p ON p.id = NEW.plan_id
  WHERE c.id = NEW.coach_id;

  IF v_allowed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Treinador indisponível para este plano no site';
  END IF;

  RETURN NEW;
END;
$$;

-- Cadastro pelo link do plano. Chamado só pela Edge Function public-plan-link
-- (service_role). Mesmo cuidado do cadastro do site: chave de envio, limite de
-- tentativas, CPF repetido vai para atendimento manual e cliente existente não
-- tem os dados trocados (o que a pessoa digitou fica no envio).
CREATE OR REPLACE FUNCTION public.submit_plan_link_prospect(
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
  p_user_agent text
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

  PERFORM pg_advisory_xact_lock(hashtextextended('plan-link:' || p_request_id::text, 0));

  SELECT * INTO v_existing
  FROM public.assessment_prospect_submissions
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.submitted_full_name IS DISTINCT FROM p_full_name
       OR v_existing.submitted_whatsapp IS DISTINCT FROM p_whatsapp
       OR v_existing.submitted_cpf IS DISTINCT FROM p_cpf
       OR v_existing.plan_id IS DISTINCT FROM p_plan_id
       OR v_existing.coach_id IS DISTINCT FROM p_coach_id THEN
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
    source, region, landing_page, utm, terms_accepted_at, ip_hash, user_agent
  ) VALUES (
    p_request_id, v_customer.id, v_contract.id, p_plan_id, p_coach_id,
    p_full_name, p_whatsapp, nullif(p_email, ''), p_cpf,
    p_address_zip, nullif(p_address_street, ''), p_address_number,
    nullif(p_address_complement, ''), nullif(p_address_neighborhood, ''),
    nullif(p_address_city, ''), nullif(p_address_state, ''),
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
  text, text, text, timestamptz, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_plan_link_prospect(
  text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text,
  text, text, text, timestamptz, text, text, text
) TO service_role;

-- O que a página do link mostra: nome do plano, durações ativas com preço e o
-- coach do link (ou os coaches da modalidade, se o link não tiver coach).
CREATE OR REPLACE FUNCTION public.get_plan_link(p_token text, p_coach_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_family public.assessment_plan_families%ROWTYPE;
  v_coach jsonb;
  v_no_fee boolean;
BEGIN
  SELECT * INTO v_family
  FROM public.assessment_plan_families
  WHERE (link_token = p_token OR link_token_no_fee = p_token) AND active AND link_enabled;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_no_fee := v_family.link_token_no_fee = p_token;

  IF p_coach_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', coach.id, 'name', coach.name) INTO v_coach
    FROM public.assessment_coaches AS coach
    WHERE coach.id = p_coach_id AND coach.active
      AND v_family.modality_id = ANY(coach.modality_ids);
  END IF;

  RETURN jsonb_build_object(
    'family', jsonb_build_object(
      'name', v_family.name,
      'modality', (SELECT modality.name FROM public.assessment_modalities AS modality
                   WHERE modality.id = v_family.modality_id)
    ),
    'options', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'plan_id', plan.id,
        'period_months', plan.period_months,
        'price_monthly', plan.price_monthly,
        'price_total', plan.price_total,
        'max_installments', plan.max_installments,
        'enrollment_fee', CASE WHEN v_no_fee THEN 0 ELSE plan.enrollment_fee END
      ) ORDER BY plan.period_months)
      FROM public.assessment_plans AS plan
      WHERE plan.family_id = v_family.id AND plan.active
    ), '[]'::jsonb),
    'no_enrollment_fee', v_no_fee,
    'coach', v_coach,
    'coaches', CASE WHEN v_coach IS NULL THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', coach.id, 'name', coach.name) ORDER BY coach.name)
      FROM public.assessment_coaches AS coach
      WHERE coach.active AND v_family.modality_id = ANY(coach.modality_ids)
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_plan_link(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_plan_link(text, uuid) TO service_role;
