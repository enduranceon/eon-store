
-- Revoga execução de sync_coupon_uses_count() do anon e authenticated.
-- Função é utilitário interno — não deve ser chamável via REST por qualquer um.
REVOKE EXECUTE ON FUNCTION public.sync_coupon_uses_count() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_coupon_uses_count() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_coupon_uses_count() FROM public;
-- Mantém pra service_role (edge functions) e postgres
;
