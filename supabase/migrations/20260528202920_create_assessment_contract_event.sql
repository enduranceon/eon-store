
-- Auditoria genérica do ciclo de vida do contrato
CREATE TABLE IF NOT EXISTS assessment_contract_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES assessment_contracts(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  payload     jsonb DEFAULT '{}'::jsonb,
  notes       text,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE assessment_contract_event IS
  'Registro de eventos do ciclo de vida do contrato: created, coach_changed, plan_changed, discount_applied, leave_started, leave_ended, renewed, cancelled, refund_requested, refund_completed, charge_generated, payment_received, etc.';

CREATE INDEX IF NOT EXISTS idx_assessment_contract_event_contract
  ON assessment_contract_event(contract_id, created_at DESC);

-- RLS aberto pra authenticated (mesmo padrão das outras tabelas)
ALTER TABLE assessment_contract_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_full ON assessment_contract_event
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
;
