-- Hardening de segurança:
-- 1. Define search_path explícito em todas as funções (mitiga search_path
--    injection em SECURITY DEFINER e funções de trigger).
-- 2. Revoga execução pública de sync_coupon_uses_count (era chamável
--    por anon/authenticated via REST — utilitário interno).

ALTER FUNCTION public.block_modifications_on_closed_closing()         SET search_path = public, pg_temp;
ALTER FUNCTION public.enforce_closing_status_transitions()            SET search_path = public, pg_temp;
ALTER FUNCTION public.block_delete_approved_closing()                 SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_asaas_payments_on_order_cancel()        SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_asaas_payments_on_contract_status_cancel() SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_payment_methods_updated_at()              SET search_path = public, pg_temp;
ALTER FUNCTION public.set_order_number()                              SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_stock_order_number()                   SET search_path = public, pg_temp;
ALTER FUNCTION public.auto_sku_presale()                              SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_status_changed_at()                        SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_assessment_contract_number()           SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_coach_history()                            SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_leave_change()                           SET search_path = public, pg_temp;
ALTER FUNCTION public.normalize_contract_on_cancel()                  SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_asaas_payments_updated_at()               SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_coupon_uses_count()                        SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.sync_coupon_uses_count() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_coupon_uses_count() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_coupon_uses_count() FROM public;
