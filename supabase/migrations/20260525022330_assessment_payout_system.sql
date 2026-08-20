
-- ============================================================
-- PAYOUT — Rates, Growth Tiers, Monthly Closings, Statements
-- ============================================================

-- Tabela de valor base por papel × modalidade
CREATE TABLE IF NOT EXISTS payout_role_modality_rates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role         text        NOT NULL CHECK (role IN ('junior','pleno','senior')),
  modality_id  uuid        NOT NULL REFERENCES assessment_modalities(id) ON DELETE CASCADE,
  rate         numeric     NOT NULL CHECK (rate >= 0),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (role, modality_id)
);

-- Seed dos rates
WITH m AS (SELECT id, name FROM assessment_modalities)
INSERT INTO payout_role_modality_rates (role, modality_id, rate)
SELECT 'junior', (SELECT id FROM m WHERE name='corrida'),   50
UNION ALL SELECT 'junior', (SELECT id FROM m WHERE name='triathlon'), 100
UNION ALL SELECT 'pleno',  (SELECT id FROM m WHERE name='corrida'),   70
UNION ALL SELECT 'pleno',  (SELECT id FROM m WHERE name='triathlon'), 130
UNION ALL SELECT 'senior', (SELECT id FROM m WHERE name='corrida'),   80
UNION ALL SELECT 'senior', (SELECT id FROM m WHERE name='triathlon'), 160
ON CONFLICT (role, modality_id) DO NOTHING;

-- Faixas de crescimento
CREATE TABLE IF NOT EXISTS payout_growth_tiers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL UNIQUE,
  min_athletes          int         NOT NULL,
  increment_per_athlete numeric     NOT NULL DEFAULT 0,
  leadership_bonus      numeric     NOT NULL DEFAULT 0,
  co_leadership_bonus   numeric     NOT NULL DEFAULT 0,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

INSERT INTO payout_growth_tiers (name, min_athletes, increment_per_athlete, leadership_bonus, co_leadership_bonus)
VALUES
  ('Base',    0,    0,    3.00, 1.50),
  ('Bronze',  300,  3.00, 3.50, 1.75),
  ('Silver',  500,  5.00, 4.00, 2.00),
  ('Gold',    700,  7.00, 4.50, 2.25),
  ('Diamond', 1000, 9.00, 5.00, 2.50)
ON CONFLICT (name) DO NOTHING;

-- Fechamentos mensais
CREATE TABLE IF NOT EXISTS payout_monthly_closings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  competence   date        NOT NULL UNIQUE,
  status       text        NOT NULL DEFAULT 'pending_approval'
                           CHECK (status IN ('pending_approval','approved','paid')),
  generated_at timestamptz DEFAULT now(),
  approved_at  timestamptz,
  approved_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  notes        text
);

-- Itens do extrato
CREATE TABLE IF NOT EXISTS payout_monthly_statement_items (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_id     uuid        NOT NULL REFERENCES payout_monthly_closings(id) ON DELETE CASCADE,
  coach_id       uuid        NOT NULL REFERENCES assessment_coaches(id) ON DELETE RESTRICT,
  source_type    text        NOT NULL CHECK (source_type IN (
                  'athlete_repasse','direct_leadership','co_leadership','manual_adjustment'
                )),
  contract_id    uuid        REFERENCES assessment_contracts(id) ON DELETE SET NULL,
  description    text,
  amount         numeric     NOT NULL,
  valid_days     int,
  month_days     int,
  prorata_factor numeric,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_statement_closing ON payout_monthly_statement_items(closing_id);
CREATE INDEX IF NOT EXISTS idx_statement_coach   ON payout_monthly_statement_items(coach_id);

-- RLS
ALTER TABLE payout_role_modality_rates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_growth_tiers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_monthly_closings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_monthly_statement_items  ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_full ON payout_role_modality_rates     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON payout_growth_tiers            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON payout_monthly_closings        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON payout_monthly_statement_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
;
