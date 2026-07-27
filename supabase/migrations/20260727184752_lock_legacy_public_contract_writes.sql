-- Run only after the public enrollment frontend is live on the validated API.
-- This closes the former browser-to-table paths without creating downtime
-- during the backend/frontend deployment sequence.

DROP POLICY IF EXISTS "anon_insert_draft_contracts"
  ON public.assessment_contracts;
DROP POLICY IF EXISTS "anon_insert_customers"
  ON public.presale_customers;

REVOKE INSERT ON TABLE public.assessment_contracts FROM anon;
REVOKE INSERT ON TABLE public.presale_customers FROM anon;

REVOKE ALL ON FUNCTION public.upsert_assessment_customer(
  text, text, text, text, date
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_assessment_customer(
  text, text, text, text, date, text
) FROM PUBLIC, anon, authenticated;
