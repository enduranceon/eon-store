-- Executar somente depois de api-v1 e frontend desta versão estarem em
-- produção. O navegador passa a ser somente leitura nas tabelas públicas;
-- entradas públicas continuam pelas funções SECURITY DEFINER allowlisted.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon, authenticated;

-- Remove políticas permissivas mantidas apenas para o rollout gradual. As
-- políticas app_admin_only permanecem como autorização de leitura do painel.
DROP POLICY IF EXISTS auth_full ON public.asaas_payments;
DROP POLICY IF EXISTS auth_full ON public.assessment_coach_repasse;
DROP POLICY IF EXISTS auth_full ON public.assessment_coaches;
DROP POLICY IF EXISTS auth_full ON public.assessment_contract_coach_history;
DROP POLICY IF EXISTS auth_full ON public.assessment_contract_event;
DROP POLICY IF EXISTS auth_full ON public.assessment_contracts;
DROP POLICY IF EXISTS auth_full ON public.assessment_growth_tiers;
DROP POLICY IF EXISTS auth_full ON public.assessment_leaves;
DROP POLICY IF EXISTS auth_full ON public.assessment_modalities;
DROP POLICY IF EXISTS auth_full ON public.assessment_plans;
DROP POLICY IF EXISTS auth_full ON public.communication_rules;
DROP POLICY IF EXISTS auth_full ON public.communication_settings;
DROP POLICY IF EXISTS auth_full ON public.contract_renewal_actions;
DROP POLICY IF EXISTS auth_full_access_uses ON public.coupon_uses;
DROP POLICY IF EXISTS auth_full_access ON public.coupons;
DROP POLICY IF EXISTS auth_full ON public.discount_log;
DROP POLICY IF EXISTS authenticated_full_access ON public.order_returns;
DROP POLICY IF EXISTS auth_full ON public.payout_growth_tiers;
DROP POLICY IF EXISTS auth_full ON public.payout_monthly_closings;
DROP POLICY IF EXISTS auth_full ON public.payout_monthly_statement_items;
DROP POLICY IF EXISTS auth_full ON public.payout_pending_repasse;
DROP POLICY IF EXISTS auth_full ON public.payout_role_modality_rates;
DROP POLICY IF EXISTS auth_all_campaigns ON public.presale_campaigns;
DROP POLICY IF EXISTS auth_all_customers ON public.presale_customers;
DROP POLICY IF EXISTS auth_all_orders ON public.presale_orders;
DROP POLICY IF EXISTS auth_all_products ON public.presale_products;
DROP POLICY IF EXISTS auth_all_products ON public.products;
DROP POLICY IF EXISTS auth_full ON public.renewal_rules;
DROP POLICY IF EXISTS auth_full ON public.sales_status_events;
DROP POLICY IF EXISTS auth_all_stock_orders ON public.stock_orders;
DROP POLICY IF EXISTS auth_all_stock_products ON public.stock_products;
