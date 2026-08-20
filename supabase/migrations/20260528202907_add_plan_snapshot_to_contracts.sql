
-- 1) Adiciona snapshot do plano ao contrato
ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb;

COMMENT ON COLUMN assessment_contracts.plan_snapshot IS
  'Snapshot dos campos relevantes do plano no momento da criação do contrato. Preserva o histórico financeiro mesmo que o plano seja editado depois.';

-- 2) Backfill: contratos existentes recebem snapshot a partir do plano atual
UPDATE assessment_contracts ac
SET plan_snapshot = jsonb_build_object(
  'plan_id',          p.id,
  'name',             p.name,
  'modality_id',      p.modality_id,
  'price_total',      p.price_total,
  'price_monthly',    p.price_monthly,
  'enrollment_fee',   p.enrollment_fee,
  'max_installments', p.max_installments,
  'period_months',    p.period_months,
  'period',           p.period,
  'revenue_center_id', p.revenue_center_id,
  'snapshot_at',      to_jsonb(ac.created_at),
  'snapshot_source',  'backfill'
)
FROM assessment_plans p
WHERE ac.plan_id = p.id
  AND ac.plan_snapshot IS NULL;
;
