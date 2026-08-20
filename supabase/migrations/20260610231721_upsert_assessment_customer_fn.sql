
CREATE OR REPLACE FUNCTION public.upsert_assessment_customer(
  p_full_name  text,
  p_whatsapp   text DEFAULT NULL,
  p_cpf        text DEFAULT NULL,
  p_gender     text DEFAULT NULL,
  p_birth_date date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Try to find existing customer by CPF
  IF p_cpf IS NOT NULL AND p_cpf <> '' THEN
    SELECT id INTO v_id FROM presale_customers WHERE cpf = p_cpf LIMIT 1;
  END IF;

  -- Create if not found
  IF v_id IS NULL THEN
    INSERT INTO presale_customers (full_name, whatsapp, cpf, gender, birth_date, active)
    VALUES (p_full_name, p_whatsapp, p_cpf, p_gender, p_birth_date, true)
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_assessment_customer(text, text, text, text, date) TO anon, authenticated;
;
