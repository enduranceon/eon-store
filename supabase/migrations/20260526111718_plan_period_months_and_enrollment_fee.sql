
-- Adiciona período em meses (1-12) e taxa de matrícula nos planos
ALTER TABLE assessment_plans
  ADD COLUMN IF NOT EXISTS period_months integer,
  ADD COLUMN IF NOT EXISTS enrollment_fee decimal(10,2) NOT NULL DEFAULT 0;

-- Migra períodos nomeados para número de meses
UPDATE assessment_plans SET period_months = CASE
  WHEN period = 'mensal'      THEN 1
  WHEN period = 'trimestral'  THEN 3
  WHEN period = 'semestral'   THEN 6
  WHEN period = 'anual'       THEN 12
  ELSE 1
END WHERE period_months IS NULL;

-- Taxa de matrícula nos contratos (valor cobrado na assinatura)
ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS enrollment_fee decimal(10,2) NOT NULL DEFAULT 0;
;
