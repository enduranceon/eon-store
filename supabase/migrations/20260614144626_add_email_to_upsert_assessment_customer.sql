
CREATE OR REPLACE FUNCTION public.upsert_assessment_customer(
  p_full_name  text,
  p_whatsapp   text DEFAULT NULL,
  p_cpf        text DEFAULT NULL,
  p_gender     text DEFAULT NULL,
  p_birth_date date DEFAULT NULL,
  p_email      text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_cpf IS NOT NULL AND p_cpf <> '' THEN
    SELECT id INTO v_id FROM presale_customers WHERE cpf = p_cpf LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO presale_customers (full_name, whatsapp, cpf, gender, birth_date, email, active)
    VALUES (p_full_name, p_whatsapp, p_cpf, p_gender, p_birth_date, p_email, true)
    RETURNING id INTO v_id;
  ELSE
    -- Atualiza email se veio preenchido e ainda está vazio
    UPDATE presale_customers
    SET email = COALESCE(email, p_email)
    WHERE id = v_id AND p_email IS NOT NULL AND p_email <> '';
  END IF;

  RETURN v_id;
END;
$$;
;
