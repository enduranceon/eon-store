-- Colunas de desconto manual nas 3 tabelas de venda
ALTER TABLE stock_orders         ADD COLUMN IF NOT EXISTS manual_discount numeric DEFAULT 0;
ALTER TABLE stock_orders         ADD COLUMN IF NOT EXISTS discount_reason text;

ALTER TABLE presale_orders       ADD COLUMN IF NOT EXISTS manual_discount numeric DEFAULT 0;
ALTER TABLE presale_orders       ADD COLUMN IF NOT EXISTS discount_reason text;

ALTER TABLE assessment_contracts ADD COLUMN IF NOT EXISTS manual_discount numeric DEFAULT 0;
ALTER TABLE assessment_contracts ADD COLUMN IF NOT EXISTS discount_reason text;

-- Log de auditoria de desconto
CREATE TABLE IF NOT EXISTS discount_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text NOT NULL,                       -- 'stock_order' | 'presale_order' | 'assessment_contract'
  entity_id      uuid NOT NULL,
  previous_value numeric DEFAULT 0,
  new_value      numeric NOT NULL,
  reason         text,
  created_at     timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discount_log_entity ON discount_log(entity_type, entity_id);

ALTER TABLE discount_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_full ON discount_log;
CREATE POLICY auth_full ON discount_log FOR ALL TO authenticated USING (true) WITH CHECK (true);;
