-- Adiciona created_by com auto-fill via auth.uid() nas tabelas críticas
ALTER TABLE assessment_contracts        ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE stock_orders                ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE presale_orders              ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE assessment_plans            ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE assessment_leaves           ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE contract_renewal_actions    ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE discount_log                ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;;
