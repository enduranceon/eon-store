
-- Helper: converte um número BR legado em E.164. Idempotente.
CREATE OR REPLACE FUNCTION normalize_phone_br_e164(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits text;
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN
    RETURN NULL;
  END IF;
  IF p ~ '^\+' THEN
    RETURN p; -- já está em formato internacional
  END IF;
  digits := regexp_replace(p, '\D', '', 'g');
  IF length(digits) BETWEEN 10 AND 11 THEN
    RETURN '+55' || digits;
  ELSIF length(digits) BETWEEN 12 AND 13 AND left(digits, 2) = '55' THEN
    RETURN '+' || digits;
  ELSE
    -- formato estranho — não toca (alguém revisa manualmente depois)
    RETURN p;
  END IF;
END;
$$;

UPDATE presale_customers  SET whatsapp           = normalize_phone_br_e164(whatsapp)            WHERE whatsapp IS NOT NULL AND whatsapp !~ '^\+';
UPDATE presale_suppliers  SET whatsapp           = normalize_phone_br_e164(whatsapp)            WHERE whatsapp IS NOT NULL AND whatsapp !~ '^\+';
UPDATE presale_trainers   SET whatsapp           = normalize_phone_br_e164(whatsapp)            WHERE whatsapp IS NOT NULL AND whatsapp !~ '^\+';
UPDATE assessment_coaches SET phone              = normalize_phone_br_e164(phone)               WHERE phone IS NOT NULL AND phone !~ '^\+';
UPDATE presale_orders     SET checkout_whatsapp  = normalize_phone_br_e164(checkout_whatsapp)   WHERE checkout_whatsapp IS NOT NULL AND checkout_whatsapp !~ '^\+';
UPDATE presale_orders     SET customer_whatsapp  = normalize_phone_br_e164(customer_whatsapp)   WHERE customer_whatsapp IS NOT NULL AND customer_whatsapp !~ '^\+';
UPDATE stock_orders       SET customer_whatsapp  = normalize_phone_br_e164(customer_whatsapp)   WHERE customer_whatsapp IS NOT NULL AND customer_whatsapp !~ '^\+';
;
