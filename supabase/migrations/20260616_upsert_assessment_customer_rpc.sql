-- RPC para cadastro/atualização de cliente via formulário público de adesão.
-- Usa SECURITY DEFINER para contornar RLS e suportar usuários anônimos.
-- Fluxo:
--   1. Procura cliente existente pelo CPF (se informado)
--   2. Se encontrou: atualiza campos não nulos e retorna o id existente
--   3. Se não encontrou: cria novo cliente e retorna o novo id

CREATE OR REPLACE FUNCTION eon_private.upsert_assessment_customer(
  p_full_name  TEXT,
  p_whatsapp   TEXT    DEFAULT NULL,
  p_cpf        TEXT    DEFAULT NULL,
  p_gender     TEXT    DEFAULT NULL,
  p_birth_date DATE    DEFAULT NULL,
  p_email      TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Normaliza CPF (só dígitos, NULL se vazio)
  p_cpf := NULLIF(REGEXP_REPLACE(COALESCE(p_cpf, ''), '\D', '', 'g'), '');

  -- Tenta encontrar pelo CPF
  IF p_cpf IS NOT NULL THEN
    SELECT id INTO v_id FROM presale_customers WHERE cpf = p_cpf LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    -- Atualiza somente campos que chegaram preenchidos (preserva dado existente)
    UPDATE presale_customers SET
      full_name  = COALESCE(NULLIF(TRIM(p_full_name), ''), full_name),
      whatsapp   = COALESCE(NULLIF(p_whatsapp,   ''), whatsapp),
      gender     = COALESCE(NULLIF(p_gender,     ''), gender),
      birth_date = COALESCE(p_birth_date,             birth_date),
      email      = COALESCE(NULLIF(p_email,      ''), email),
      updated_at = now()
    WHERE id = v_id;
  ELSE
    -- Cria novo cliente
    INSERT INTO presale_customers (
      full_name, whatsapp, cpf, gender, birth_date, email
    ) VALUES (
      TRIM(p_full_name),
      NULLIF(p_whatsapp, ''),
      p_cpf,
      NULLIF(p_gender, ''),
      p_birth_date,
      NULLIF(LOWER(TRIM(COALESCE(p_email, ''))), '')
    )
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

-- Wrapper público chamado pelo frontend (supabase.rpc)
CREATE OR REPLACE FUNCTION public.upsert_assessment_customer(
  p_full_name  TEXT,
  p_whatsapp   TEXT    DEFAULT NULL,
  p_cpf        TEXT    DEFAULT NULL,
  p_gender     TEXT    DEFAULT NULL,
  p_birth_date DATE    DEFAULT NULL,
  p_email      TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT eon_private.upsert_assessment_customer(
    p_full_name, p_whatsapp, p_cpf, p_gender, p_birth_date, p_email
  );
$$;

-- Restringe execução direta da função privada
REVOKE ALL ON FUNCTION eon_private.upsert_assessment_customer(TEXT,TEXT,TEXT,TEXT,DATE,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eon_private.upsert_assessment_customer(TEXT,TEXT,TEXT,TEXT,DATE,TEXT) TO authenticated;

-- Permite que anon e authenticated chamem o wrapper público
REVOKE ALL ON FUNCTION public.upsert_assessment_customer(TEXT,TEXT,TEXT,TEXT,DATE,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_assessment_customer(TEXT,TEXT,TEXT,TEXT,DATE,TEXT) TO anon, authenticated;
