-- ════════════════════════════════════════════════════════════════════════════
-- CRÍTICO: remove os 2 triggers antigos duplicados (decrementavam estoque 2x!)
-- ════════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS on_stock_order_created ON stock_orders;
DROP TRIGGER IF EXISTS on_stock_order_updated ON stock_orders;
DROP FUNCTION IF EXISTS handle_stock_order_insert() CASCADE;
DROP FUNCTION IF EXISTS handle_stock_order_cancel() CASCADE;


-- ════════════════════════════════════════════════════════════════════════════
-- Adiciona índices para FKs recém-criadas (created_by + revenue_center)
-- Melhora performance de queries e JOIN
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_created_by         ON assessment_contracts(created_by);
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_parent_contract_id ON assessment_contracts(parent_contract_id);
CREATE INDEX IF NOT EXISTS idx_assessment_leaves_created_by            ON assessment_leaves(created_by);
CREATE INDEX IF NOT EXISTS idx_assessment_plans_created_by             ON assessment_plans(created_by);
CREATE INDEX IF NOT EXISTS idx_assessment_plans_modality_id            ON assessment_plans(modality_id);
CREATE INDEX IF NOT EXISTS idx_assessment_plans_revenue_center_id      ON assessment_plans(revenue_center_id);
CREATE INDEX IF NOT EXISTS idx_contract_renewal_actions_created_by     ON contract_renewal_actions(created_by);
CREATE INDEX IF NOT EXISTS idx_discount_log_created_by                 ON discount_log(created_by);
CREATE INDEX IF NOT EXISTS idx_presale_orders_created_by               ON presale_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_presale_orders_customer_id              ON presale_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_presale_orders_campaign_id              ON presale_orders(campaign_id);
CREATE INDEX IF NOT EXISTS idx_presale_products_campaign_id            ON presale_products(campaign_id);
CREATE INDEX IF NOT EXISTS idx_presale_products_revenue_center_id      ON presale_products(revenue_center_id);
CREATE INDEX IF NOT EXISTS idx_presale_products_supplier_id            ON presale_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_orders_created_by                 ON stock_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_stock_products_revenue_center_id        ON stock_products(revenue_center_id);


-- ════════════════════════════════════════════════════════════════════════════
-- Consolida policies duplicadas em presale_orders (públicas vs anon)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS public_insert_orders ON presale_orders;
DROP POLICY IF EXISTS public_select_orders ON presale_orders;
-- Mantém apenas anon_insert_orders, anon_select_recent_orders, auth_all_orders


-- ════════════════════════════════════════════════════════════════════════════
-- Fixa SECURITY DEFINER + search_path nas funções que eu criei
-- (advisor lint: function_search_path_mutable)
-- ════════════════════════════════════════════════════════════════════════════
ALTER FUNCTION sync_stock_on_order_change() SET search_path = public, pg_temp;


-- ════════════════════════════════════════════════════════════════════════════
-- Verificação final
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  trigger_count INT;
BEGIN
  SELECT COUNT(*) INTO trigger_count
  FROM pg_trigger
  WHERE NOT tgisinternal
    AND tgrelid = 'stock_orders'::regclass
    AND tgname IN ('on_stock_order_created', 'on_stock_order_updated');

  IF trigger_count > 0 THEN
    RAISE EXCEPTION 'Triggers antigos AINDA EXISTEM!';
  END IF;
  RAISE NOTICE 'Limpeza OK. Triggers duplicados removidos.';
END;
$$;;
