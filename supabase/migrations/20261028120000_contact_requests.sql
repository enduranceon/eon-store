-- Contatos do site: mensagens enviadas pelo formulário de contato do site da EON.
-- A equipe vê a mensagem no painel, conversa com a pessoa e, se ela quiser
-- treinar, cria o prospect a partir do contato (nome, WhatsApp, e-mail e a
-- mensagem seguem para o "Novo prospect"). Nada aqui cria contrato, cobrança ou
-- mensagem automática. O texto que a pessoa escreveu fica como foi recebido.

CREATE TABLE public.assessment_contact_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 3 AND 160),
  whatsapp text NOT NULL CHECK (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  email text CHECK (email IS NULL OR length(email) <= 180),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 120),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 10 AND 1500),
  source text NOT NULL DEFAULT 'site' CHECK (source IN ('site')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'converted', 'closed')),
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

CREATE INDEX assessment_contact_requests_status_idx
  ON public.assessment_contact_requests (status, created_at);
CREATE INDEX assessment_contact_requests_prospect_idx
  ON public.assessment_contact_requests (prospect_contract_id)
  WHERE prospect_contract_id IS NOT NULL;

COMMENT ON TABLE public.assessment_contact_requests IS
  'Mensagens do formulário de contato do site. Contato e decisão são da equipe; virar aluno passa pelo quadro de Prospects.';

-- Nome no padrão do sistema (iniciais maiúsculas), como nos demais cadastros.
CREATE TRIGGER format_person_name
  BEFORE INSERT OR UPDATE OF full_name ON public.assessment_contact_requests
  FOR EACH ROW EXECUTE FUNCTION eon_private.format_person_name_column('full_name');

CREATE OR REPLACE FUNCTION eon_private.guard_contact_request()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'closed' THEN
    NEW.closed_reason := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- O envio do site não muda depois: o que a pessoa escreveu fica como foi recebido.
    NEW.source := OLD.source;
    NEW.request_id := OLD.request_id;
    NEW.landing_page := OLD.landing_page;
    NEW.utm := OLD.utm;
    NEW.subject := OLD.subject;
    NEW.message := OLD.message;
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

CREATE TRIGGER guard_contact_request
  BEFORE INSERT OR UPDATE ON public.assessment_contact_requests
  FOR EACH ROW EXECUTE FUNCTION eon_private.guard_contact_request();

REVOKE ALL ON FUNCTION eon_private.guard_contact_request() FROM PUBLIC, anon, authenticated;

-- Acesso: painel admin lê; escrita só pelo backend -----------------------------

ALTER TABLE public.assessment_contact_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_contact_requests
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_contact_requests
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_contact_requests FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assessment_contact_requests FROM authenticated;
GRANT SELECT ON public.assessment_contact_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_contact_requests TO service_role;

-- Envio pelo site ---------------------------------------------------------------
-- Chamado só pela Edge Function public-contact-request (service_role), depois do
-- Turnstile. Mesmo limite de tentativas do cadastro do site e da lista de espera.

CREATE OR REPLACE FUNCTION public.submit_public_contact_request(
  p_request_id uuid,
  p_full_name text,
  p_whatsapp text,
  p_email text,
  p_subject text,
  p_message text,
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
  v_entry public.assessment_contact_requests%ROWTYPE;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Identificador do envio inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('public-contact-request:' || p_request_id::text, 0)
  );

  SELECT * INTO v_entry
  FROM public.assessment_contact_requests
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_entry.full_name IS DISTINCT FROM eon_private.format_person_name(p_full_name)
       OR v_entry.whatsapp IS DISTINCT FROM p_whatsapp
       OR v_entry.subject IS DISTINCT FROM btrim(p_subject)
       OR v_entry.message IS DISTINCT FROM btrim(p_message) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Esta chave de envio já foi usada com outros dados';
    END IF;
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'request_id', p_request_id,
      'submitted_at', v_entry.created_at
    );
  END IF;

  IF coalesce(length(btrim(p_full_name)), 0) < 3
     OR coalesce(p_whatsapp, '') !~ '^\+[1-9][0-9]{7,14}$'
     OR coalesce(length(btrim(p_subject)), 0) NOT BETWEEN 3 AND 120
     OR coalesce(length(btrim(p_message)), 0) NOT BETWEEN 10 AND 1500 THEN
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

  -- A mesma pessoa mandando a mesma mensagem de novo (outro envio) enquanto a
  -- equipe ainda não respondeu: não duplica.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('contact-request:' || p_whatsapp, 0)
  );
  SELECT * INTO v_entry
  FROM public.assessment_contact_requests
  WHERE whatsapp = p_whatsapp
    AND message = btrim(p_message)
    AND status IN ('new', 'contacted')
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'request_id', p_request_id,
      'submitted_at', v_entry.created_at
    );
  END IF;

  INSERT INTO public.assessment_contact_requests (
    full_name, whatsapp, email, subject, message, source, request_id, landing_page, utm
  ) VALUES (
    btrim(p_full_name), p_whatsapp, nullif(btrim(coalesce(p_email, '')), ''),
    btrim(p_subject), btrim(p_message), 'site', p_request_id,
    nullif(p_landing_page, ''), coalesce(p_utm, '{}'::jsonb)
  )
  RETURNING * INTO v_entry;

  RETURN jsonb_build_object(
    'status', 'created',
    'request_id', p_request_id,
    'submitted_at', v_entry.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_public_contact_request(
  uuid, text, text, text, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_public_contact_request(
  uuid, text, text, text, text, text, text, jsonb, text, text
) TO service_role;
