
-- ============================================================
-- UNIFICAÇÃO: presale_customers vira a base única de pessoas
-- assessment_students é eliminada; assessment_contracts aponta
-- direto pra presale_customers.
-- ============================================================

-- 1. Adiciona 'active' em presale_customers (clientes podem ser inativados)
ALTER TABLE presale_customers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- 2. Adiciona FK customer_id em assessment_contracts apontando pra presale_customers
ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES presale_customers(id) ON DELETE RESTRICT;

-- 3. Como contracts_count = 0 e students_count = 0, podemos trocar direto
--    Dropa o student_id e a tabela assessment_students
ALTER TABLE assessment_contracts DROP COLUMN IF EXISTS student_id;

DROP TABLE IF EXISTS assessment_students CASCADE;

-- 4. customer_id agora é obrigatório (todo contrato precisa de cliente)
ALTER TABLE assessment_contracts ALTER COLUMN customer_id SET NOT NULL;

-- 5. Index pra performance
CREATE INDEX IF NOT EXISTS idx_contracts_customer ON assessment_contracts(customer_id);
;
