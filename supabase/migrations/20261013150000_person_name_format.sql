-- Nomes de pessoas no mesmo padrão em todo o sistema: iniciais maiúsculas e
-- "da", "de", "do", "das", "dos" e "e" minúsculos ("CAIO DOS SANTOS" vira
-- "Caio dos Santos"). Vale para alunos e clientes, coaches, treinadores da
-- loja, lista de espera e arquivo do Tecnofit, venha o nome do site, do painel
-- ou de uma importação. O envio original do site
-- (assessment_prospect_submissions) e o nome digitado no pedido da loja ficam
-- como foram recebidos.

CREATE OR REPLACE FUNCTION eon_private.format_person_name(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_word text;
  v_out text[] := ARRAY[]::text[];
  v_formatted text;
  v_position integer := 0;
BEGIN
  IF p_name IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_name) = '' THEN
    RETURN btrim(p_name);
  END IF;
  FOREACH v_word IN ARRAY regexp_split_to_array(btrim(regexp_replace(p_name, '\s+', ' ', 'g')), ' ') LOOP
    v_position := v_position + 1;
    v_word := lower(v_word);
    IF v_position > 1 AND v_word IN ('da', 'de', 'do', 'das', 'dos', 'e') THEN
      v_out := v_out || v_word;
    ELSIF v_word IN ('ii', 'iii', 'iv') THEN
      v_out := v_out || upper(v_word);
    ELSE
      -- Maiúscula no começo da palavra e depois de hífen, apóstrofo ou ponto
      -- (Maria-Clara, D'Ávila, J.P.).
      v_formatted := '';
      FOR i IN 1..length(v_word) LOOP
        IF i = 1 OR substr(v_word, i - 1, 1) IN ('-', '''', '’', '.') THEN
          v_formatted := v_formatted || upper(substr(v_word, i, 1));
        ELSE
          v_formatted := v_formatted || substr(v_word, i, 1);
        END IF;
      END LOOP;
      v_out := v_out || v_formatted;
    END IF;
  END LOOP;
  RETURN array_to_string(v_out, ' ');
END;
$$;

REVOKE ALL ON FUNCTION eon_private.format_person_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eon_private.format_person_name(text) TO anon, authenticated, service_role;

-- Gatilho genérico: o argumento é o nome da coluna.
CREATE OR REPLACE FUNCTION eon_private.format_person_name_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_value text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF v_value IS NOT NULL THEN
    NEW := jsonb_populate_record(
      NEW,
      jsonb_build_object(TG_ARGV[0], eon_private.format_person_name(v_value))
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.format_person_name_column() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eon_private.format_person_name_column() TO anon, authenticated, service_role;

CREATE TRIGGER format_person_name
  BEFORE INSERT OR UPDATE OF full_name ON public.presale_customers
  FOR EACH ROW EXECUTE FUNCTION eon_private.format_person_name_column('full_name');
CREATE TRIGGER format_person_name
  BEFORE INSERT OR UPDATE OF name ON public.assessment_coaches
  FOR EACH ROW EXECUTE FUNCTION eon_private.format_person_name_column('name');
CREATE TRIGGER format_person_name
  BEFORE INSERT OR UPDATE OF name ON public.presale_trainers
  FOR EACH ROW EXECUTE FUNCTION eon_private.format_person_name_column('name');
CREATE TRIGGER format_person_name
  BEFORE INSERT OR UPDATE OF full_name ON public.assessment_coach_waitlist
  FOR EACH ROW EXECUTE FUNCTION eon_private.format_person_name_column('full_name');
CREATE TRIGGER format_person_name
  BEFORE INSERT OR UPDATE OF full_name ON public.tecnofit_archive_clients
  FOR EACH ROW EXECUTE FUNCTION eon_private.format_person_name_column('full_name');

-- Cópia dos nomes antes da troca, para desfazer se precisar.
CREATE TABLE eon_private.person_name_format_backup_20261013 (
  table_name text NOT NULL,
  row_id text NOT NULL,
  old_name text NOT NULL,
  new_name text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id)
);
REVOKE ALL ON eon_private.person_name_format_backup_20261013 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON eon_private.person_name_format_backup_20261013 TO service_role;

INSERT INTO eon_private.person_name_format_backup_20261013 (table_name, row_id, old_name, new_name)
SELECT 'presale_customers', id::text, full_name, eon_private.format_person_name(full_name)
FROM public.presale_customers
WHERE full_name IS DISTINCT FROM eon_private.format_person_name(full_name)
UNION ALL
SELECT 'assessment_coaches', id::text, name, eon_private.format_person_name(name)
FROM public.assessment_coaches
WHERE name IS DISTINCT FROM eon_private.format_person_name(name)
UNION ALL
SELECT 'presale_trainers', id::text, name, eon_private.format_person_name(name)
FROM public.presale_trainers
WHERE name IS DISTINCT FROM eon_private.format_person_name(name)
UNION ALL
SELECT 'assessment_coach_waitlist', id::text, full_name, eon_private.format_person_name(full_name)
FROM public.assessment_coach_waitlist
WHERE full_name IS DISTINCT FROM eon_private.format_person_name(full_name)
UNION ALL
SELECT 'tecnofit_archive_clients', tecnofit_code::text, full_name, eon_private.format_person_name(full_name)
FROM public.tecnofit_archive_clients
WHERE full_name IS DISTINCT FROM eon_private.format_person_name(full_name);

-- A troca só mexe no nome; datas de atualização ficam como estavam.
UPDATE public.presale_customers AS target SET full_name = backup.new_name
FROM eon_private.person_name_format_backup_20261013 AS backup
WHERE backup.table_name = 'presale_customers' AND backup.row_id = target.id::text;
UPDATE public.assessment_coaches AS target SET name = backup.new_name
FROM eon_private.person_name_format_backup_20261013 AS backup
WHERE backup.table_name = 'assessment_coaches' AND backup.row_id = target.id::text;
UPDATE public.presale_trainers AS target SET name = backup.new_name
FROM eon_private.person_name_format_backup_20261013 AS backup
WHERE backup.table_name = 'presale_trainers' AND backup.row_id = target.id::text;
UPDATE public.assessment_coach_waitlist AS target SET full_name = backup.new_name
FROM eon_private.person_name_format_backup_20261013 AS backup
WHERE backup.table_name = 'assessment_coach_waitlist' AND backup.row_id = target.id::text;
UPDATE public.tecnofit_archive_clients AS target SET full_name = backup.new_name
FROM eon_private.person_name_format_backup_20261013 AS backup
WHERE backup.table_name = 'tecnofit_archive_clients' AND backup.row_id = target.tecnofit_code::text;

-- Lista de espera pelo site: o nome gravado já vem formatado, então o reenvio
-- do mesmo formulário compara com o nome formatado.
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
       OR v_entry.full_name IS DISTINCT FROM eon_private.format_person_name(p_full_name)
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
