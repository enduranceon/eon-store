
-- Cria a sequence inicializando no valor atual + 1
CREATE SEQUENCE IF NOT EXISTS assessment_contract_number_seq;

-- Sincroniza a sequence com o maior número já existente
SELECT setval(
  'assessment_contract_number_seq',
  COALESCE(
    MAX(SUBSTRING(contract_number FROM 5)::int), 0
  )
)
FROM assessment_contracts
WHERE contract_number ~ '^ASS-[0-9]+$';

-- Atualiza a função para usar a sequence (sem race condition)
CREATE OR REPLACE FUNCTION generate_assessment_contract_number()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contract_number IS NULL THEN
    NEW.contract_number := 'ASS-' || LPAD(nextval('assessment_contract_number_seq')::text, 6, '0');
  END IF;
  IF NEW.original_end_date IS NULL THEN
    NEW.original_end_date := NEW.end_date;
  END IF;
  RETURN NEW;
END;
$$;
;
