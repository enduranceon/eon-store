
-- Restringe SELECT anônimo só pra pedidos recém-criados (necessário pro INSERT RETURNING funcionar)
-- Antes: qual=true permitia listar TODOS os pedidos da loja

DROP POLICY IF EXISTS "anon_select_orders" ON presale_orders;
CREATE POLICY "anon_select_recent_orders" ON presale_orders
  FOR SELECT TO anon
  USING (created_date > now() - interval '5 minutes');

DROP POLICY IF EXISTS "anon_select_stock_orders" ON stock_orders;
CREATE POLICY "anon_select_recent_stock_orders" ON stock_orders
  FOR SELECT TO anon
  USING (created_date > now() - interval '5 minutes');
;
