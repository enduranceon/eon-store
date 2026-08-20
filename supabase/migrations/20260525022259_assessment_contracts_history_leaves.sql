
-- ============================================================
-- CONTRACTS + COACH HISTORY + LEAVES (com triggers)
-- ============================================================

CREATE TABLE IF NOT EXISTS assessment_contracts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number     text        UNIQUE,
  student_id          uuid        NOT NULL REFERENCES assessment_students(id) ON DELETE RESTRICT,
  coach_id            uuid        NOT NULL REFERENCES assessment_coaches(id) ON DELETE RESTRICT,
  plan_id             uuid        NOT NULL REFERENCES assessment_plans(id) ON DELETE RESTRICT,
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','overdue','cancelled','finished','on_leave')),
  start_date          date        NOT NULL,
  end_date            date        NOT NULL,
  original_end_date   date        NOT NULL,
  installments        int         NOT NULL DEFAULT 1 CHECK (installments >= 1),
  payment_method      text        CHECK (payment_method IN ('pix','boleto','credit_card')),
  payment_status      text        NOT NULL DEFAULT 'pending'
                                  CHECK (payment_status IN ('pending','paid','overdue','refunded','partially_refunded')),
  credit_balance      numeric     NOT NULL DEFAULT 0,
  asaas_charge_id     text,
  asaas_payment_link  text,
  asaas_pix_copy      text,
  asaas_pix_qrcode    text,
  renewal_generated   boolean     NOT NULL DEFAULT false,
  cancellation_fee    numeric,
  cancellation_reason text,
  parent_contract_id  uuid        REFERENCES assessment_contracts(id) ON DELETE SET NULL,
  notes               text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_student   ON assessment_contracts(student_id);
CREATE INDEX IF NOT EXISTS idx_contracts_coach     ON assessment_contracts(coach_id);
CREATE INDEX IF NOT EXISTS idx_contracts_plan      ON assessment_contracts(plan_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status    ON assessment_contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_end_date  ON assessment_contracts(end_date);
CREATE INDEX IF NOT EXISTS idx_contracts_asaas     ON assessment_contracts(asaas_charge_id) WHERE asaas_charge_id IS NOT NULL;

-- Gerador de número + inicialização do original_end_date
CREATE OR REPLACE FUNCTION generate_assessment_contract_number()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_num int;
BEGIN
  IF NEW.contract_number IS NULL THEN
    SELECT COALESCE(MAX(SUBSTRING(contract_number FROM 5)::int), 0) + 1
      INTO next_num FROM assessment_contracts;
    NEW.contract_number := 'ASS-' || LPAD(next_num::text, 6, '0');
  END IF;
  -- Garante original_end_date preenchido
  IF NEW.original_end_date IS NULL THEN
    NEW.original_end_date := NEW.end_date;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assessment_contract_number ON assessment_contracts;
CREATE TRIGGER trg_assessment_contract_number
BEFORE INSERT ON assessment_contracts
FOR EACH ROW EXECUTE FUNCTION generate_assessment_contract_number();

-- ============================================================
-- HISTÓRICO DE COACH
-- ============================================================
CREATE TABLE IF NOT EXISTS assessment_contract_coach_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid        NOT NULL REFERENCES assessment_contracts(id) ON DELETE CASCADE,
  coach_id    uuid        NOT NULL REFERENCES assessment_coaches(id) ON DELETE RESTRICT,
  started_at  date        NOT NULL,
  ended_at    date,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_history_contract ON assessment_contract_coach_history(contract_id);
CREATE INDEX IF NOT EXISTS idx_coach_history_coach    ON assessment_contract_coach_history(coach_id);
CREATE INDEX IF NOT EXISTS idx_coach_history_active   ON assessment_contract_coach_history(contract_id) WHERE ended_at IS NULL;

-- Trigger: cria registro inicial no INSERT, e fecha+abre novo no UPDATE de coach_id
CREATE OR REPLACE FUNCTION sync_coach_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, NEW.start_date);
  ELSIF TG_OP = 'UPDATE' AND NEW.coach_id IS DISTINCT FROM OLD.coach_id THEN
    UPDATE assessment_contract_coach_history
       SET ended_at = CURRENT_DATE
     WHERE contract_id = NEW.id AND ended_at IS NULL;
    INSERT INTO assessment_contract_coach_history (contract_id, coach_id, started_at)
    VALUES (NEW.id, NEW.coach_id, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_coach_history_insert ON assessment_contracts;
CREATE TRIGGER trg_coach_history_insert
AFTER INSERT ON assessment_contracts
FOR EACH ROW EXECUTE FUNCTION sync_coach_history();

DROP TRIGGER IF EXISTS trg_coach_history_update ON assessment_contracts;
CREATE TRIGGER trg_coach_history_update
AFTER UPDATE OF coach_id ON assessment_contracts
FOR EACH ROW EXECUTE FUNCTION sync_coach_history();

-- ============================================================
-- LICENÇAS — estendem o end_date do contrato automaticamente
-- ============================================================
CREATE TABLE IF NOT EXISTS assessment_leaves (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid        NOT NULL REFERENCES assessment_contracts(id) ON DELETE CASCADE,
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  days        int         NOT NULL,
  reason      text,
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_leaves_contract  ON assessment_leaves(contract_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status    ON assessment_leaves(status);

-- Trigger: calcula days, estende contrato e ajusta status
CREATE OR REPLACE FUNCTION handle_leave_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.days := (NEW.end_date - NEW.start_date) + 1;
    UPDATE assessment_contracts
       SET end_date = end_date + (NEW.days || ' days')::interval,
           status   = 'on_leave'
     WHERE id = NEW.contract_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'finished' AND OLD.status = 'active' THEN
    -- Encerra licença → contrato volta a 'active' se nenhuma outra licença ativa
    IF NOT EXISTS (
      SELECT 1 FROM assessment_leaves
       WHERE contract_id = NEW.contract_id
         AND status = 'active'
         AND id <> NEW.id
    ) THEN
      UPDATE assessment_contracts
         SET status = 'active'
       WHERE id = NEW.contract_id
         AND status = 'on_leave';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_handle ON assessment_leaves;
CREATE TRIGGER trg_leave_handle
BEFORE INSERT OR UPDATE ON assessment_leaves
FOR EACH ROW EXECUTE FUNCTION handle_leave_change();

-- RLS
ALTER TABLE assessment_contracts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_contract_coach_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_leaves                    ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_full ON assessment_contracts              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON assessment_contract_coach_history FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON assessment_leaves                 FOR ALL TO authenticated USING (true) WITH CHECK (true);
;
