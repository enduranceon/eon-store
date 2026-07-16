-- Auditoria de segurança (2026-07-15): trava RPCs SECURITY DEFINER que estavam
-- executáveis por `anon`/`authenticated` sem necessidade.
--
-- Contexto: funções SECURITY DEFINER rodam com os privilégios do dono (ignoram
-- RLS). Expor EXECUTE delas ao `anon` cria superfície desnecessária. Aqui só
-- travamos as que NÃO são usadas pelo fluxo público.
--
-- INTENCIONALMENTE MANTIDO: public.upsert_assessment_customer(...) continua
-- executável por `anon` — é usado pelas páginas públicas de matrícula
-- (PublicModalityPlans.jsx / PublicPlanEnrollment.jsx) para criar/deduplicar o
-- cliente durante o checkout sem acesso direto à tabela. Revogar quebraria a
-- matrícula pública.

-- 1) Oráculo CPF -> UUID: nenhum cliente chama; era só enumeração de PII.
REVOKE EXECUTE ON FUNCTION public.find_customer_id_by_cpf(text)
  FROM anon, authenticated, public;

-- 2) Funções de TRIGGER: não precisam ser chamáveis via RPC. Revogar o EXECUTE
--    não afeta o disparo dos triggers (triggers rodam no contexto do owner,
--    independente de grants de EXECUTE).
REVOKE EXECUTE ON FUNCTION public.assign_presale_customer_code()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.generate_assessment_contract_number()
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.sync_coach_history()
  FROM anon, authenticated, public;

-- 3) Higiene: fixa search_path das funções utilitárias (advisor 0011).
ALTER FUNCTION public.br_easter_date(integer)        SET search_path = '';
ALTER FUNCTION public.br_is_holiday(date)            SET search_path = '';
ALTER FUNCTION public.br_next_business_day(date)     SET search_path = '';
ALTER FUNCTION public.normalize_phone_br_e164(text)  SET search_path = '';
