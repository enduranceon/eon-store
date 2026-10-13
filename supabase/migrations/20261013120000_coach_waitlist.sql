-- Lista de espera por coach. Quando o coach está cheio ou não quer novos alunos
-- agora, o site mostra um formulário curto no lugar do cadastro; a equipe entra
-- em contato, consulta o coach, oferece outro coach ou transforma a pessoa em
-- prospect. Nada aqui cria contrato ou cobrança.

-- Coach recebe novos alunos? --------------------------------------------------

ALTER TABLE public.assessment_coaches
  ADD COLUMN accepting_new_students boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.assessment_coaches.accepting_new_students IS
  'Falso: coach cheio ou sem novos alunos agora. O site troca o cadastro pela lista de espera; a venda interna continua liberada.';

-- Pessoas na lista de espera --------------------------------------------------

CREATE TABLE public.assessment_coach_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL
    REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  modality_id uuid
    REFERENCES public.assessment_modalities(id) ON DELETE SET NULL,
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 3 AND 160),
  whatsapp text NOT NULL CHECK (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  email text CHECK (email IS NULL OR length(email) <= 180),
  region text CHECK (region IS NULL OR region IN ('florianopolis', 'online')),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  source text NOT NULL DEFAULT 'internal'
    CHECK (source IN ('site', 'internal')),
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'contacted', 'asking_coach', 'converted', 'closed')),
  closed_reason text CHECK (closed_reason IS NULL OR length(closed_reason) <= 500),
  prospect_contract_id uuid
    REFERENCES public.assessment_contracts(id) ON DELETE SET NULL,
  request_id uuid UNIQUE,
  landing_page text CHECK (landing_page IS NULL OR length(landing_page) <= 500),
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assessment_coach_waitlist_coach_idx
  ON public.assessment_coach_waitlist (coach_id, status, created_at);
CREATE INDEX assessment_coach_waitlist_prospect_idx
  ON public.assessment_coach_waitlist (prospect_contract_id)
  WHERE prospect_contract_id IS NOT NULL;
-- Uma pessoa fica uma vez só na fila aberta de cada coach.
CREATE UNIQUE INDEX assessment_coach_waitlist_open_person_key
  ON public.assessment_coach_waitlist (coach_id, whatsapp)
  WHERE status IN ('waiting', 'contacted', 'asking_coach');

COMMENT ON TABLE public.assessment_coach_waitlist IS
  'Lista de espera de cada coach (site ou cadastro interno). Contato e decisão são da equipe; virar aluno passa pelo quadro de Prospects.';

CREATE OR REPLACE FUNCTION eon_private.guard_coach_waitlist()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.modality_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.modality_id IS DISTINCT FROM OLD.modality_id
          OR NEW.coach_id IS DISTINCT FROM OLD.coach_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.assessment_coaches AS coach
       WHERE coach.id = NEW.coach_id AND NEW.modality_id = ANY (coach.modality_ids)
     ) THEN
    RAISE EXCEPTION 'O coach não atende esta modalidade' USING ERRCODE = '22023';
  END IF;

  IF NEW.status IN ('waiting', 'contacted', 'asking_coach')
     AND (TG_OP = 'INSERT'
          OR OLD.status NOT IN ('waiting', 'contacted', 'asking_coach')
          OR NEW.coach_id IS DISTINCT FROM OLD.coach_id
          OR NEW.whatsapp IS DISTINCT FROM OLD.whatsapp)
     AND EXISTS (
       SELECT 1 FROM public.assessment_coach_waitlist AS entry
       WHERE entry.coach_id = NEW.coach_id
         AND entry.whatsapp = NEW.whatsapp
         AND entry.status IN ('waiting', 'contacted', 'asking_coach')
         AND entry.id IS DISTINCT FROM NEW.id
     ) THEN
    RAISE EXCEPTION 'Esta pessoa já está na lista de espera deste coach' USING ERRCODE = '22023';
  END IF;

  IF NEW.status <> 'closed' THEN
    NEW.closed_reason := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Origem e dados do envio do site não mudam depois.
    NEW.source := OLD.source;
    NEW.request_id := OLD.request_id;
    NEW.landing_page := OLD.landing_page;
    NEW.utm := OLD.utm;
    NEW.created_at := OLD.created_at;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.status_changed_at := now();
    ELSE
      NEW.status_changed_at := OLD.status_changed_at;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_coach_waitlist
  BEFORE INSERT OR UPDATE ON public.assessment_coach_waitlist
  FOR EACH ROW EXECUTE FUNCTION eon_private.guard_coach_waitlist();

REVOKE ALL ON FUNCTION eon_private.guard_coach_waitlist() FROM PUBLIC, anon, authenticated;

-- Acesso: painel admin lê; escrita só pelo backend -----------------------------

ALTER TABLE public.assessment_coach_waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_coach_waitlist
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_coach_waitlist
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_coach_waitlist FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assessment_coach_waitlist FROM authenticated;
GRANT SELECT ON public.assessment_coach_waitlist TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_coach_waitlist TO service_role;

-- Envio pelo site ---------------------------------------------------------------
-- Chamado só pela Edge Function public-coach-waitlist (service_role), depois do
-- Turnstile. Mesmo limite de tentativas do cadastro do site. Aceita a fila de
-- qualquer coach visível; o site só mostra o formulário para quem está cheio.

CREATE OR REPLACE FUNCTION public.submit_public_coach_waitlist(
  p_request_id uuid,
  p_coach_id uuid,
  p_modality_id uuid,
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_region text,
  p_notes text,
  p_landing_page text,
  p_utm jsonb,
  p_ip_hash text,
  p_phone_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_entry public.assessment_coach_waitlist%ROWTYPE;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Identificador do envio inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('public-coach-waitlist:' || p_request_id::text, 0)
  );

  SELECT * INTO v_entry
  FROM public.assessment_coach_waitlist
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_entry.coach_id IS DISTINCT FROM p_coach_id
       OR v_entry.modality_id IS DISTINCT FROM p_modality_id
       OR v_entry.full_name IS DISTINCT FROM btrim(p_full_name)
       OR v_entry.whatsapp IS DISTINCT FROM p_whatsapp THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Esta chave de envio já foi usada com outros dados';
    END IF;
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'entry_id', v_entry.id,
      'request_id', p_request_id,
      'submitted_at', v_entry.created_at
    );
  END IF;

  IF coalesce(length(btrim(p_full_name)), 0) < 3
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

  IF NOT EXISTS (
    SELECT 1 FROM public.assessment_coaches AS coach
    WHERE coach.id = p_coach_id AND coach.active AND coach.public_visible
      AND (p_modality_id IS NULL OR p_modality_id = ANY (coach.modality_ids))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach indisponível';
  END IF;

  -- Já está na fila aberta deste coach: não duplica.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('coach-waitlist:' || p_coach_id::text || ':' || p_whatsapp, 0)
  );
  SELECT * INTO v_entry
  FROM public.assessment_coach_waitlist
  WHERE coach_id = p_coach_id AND whatsapp = p_whatsapp
    AND status IN ('waiting', 'contacted', 'asking_coach')
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'entry_id', v_entry.id,
      'request_id', p_request_id,
      'submitted_at', v_entry.created_at
    );
  END IF;

  INSERT INTO public.assessment_coach_waitlist (
    coach_id, modality_id, full_name, whatsapp, email, region, notes,
    source, request_id, landing_page, utm
  ) VALUES (
    p_coach_id, p_modality_id, btrim(p_full_name), p_whatsapp,
    nullif(btrim(coalesce(p_email, '')), ''), p_region,
    nullif(btrim(coalesce(p_notes, '')), ''), 'site', p_request_id,
    nullif(p_landing_page, ''), coalesce(p_utm, '{}'::jsonb)
  )
  RETURNING * INTO v_entry;

  RETURN jsonb_build_object(
    'status', 'created',
    'entry_id', v_entry.id,
    'request_id', p_request_id,
    'submitted_at', v_entry.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_public_coach_waitlist(
  uuid, uuid, uuid, text, text, text, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_public_coach_waitlist(
  uuid, uuid, uuid, text, text, text, text, text, text, jsonb, text, text
) TO service_role;
