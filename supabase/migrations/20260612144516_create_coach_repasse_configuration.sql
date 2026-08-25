
-- Tabela de configuração de repasse base (papel × modalidade)
CREATE TABLE IF NOT EXISTS assessment_coach_repasse (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_role TEXT NOT NULL CHECK (coach_role = ANY (ARRAY['junior'::text, 'pleno'::text, 'senior'::text])),
  modality_id UUID NOT NULL REFERENCES assessment_modalities(id) ON DELETE CASCADE,
  repasse_value NUMERIC(10,2) NOT NULL CHECK (repasse_value >= 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(coach_role, modality_id)
);

-- Tabela de faixas de crescimento
CREATE TABLE IF NOT EXISTS assessment_growth_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_name TEXT NOT NULL UNIQUE,
  min_students INTEGER NOT NULL,
  max_students INTEGER,
  bonus_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (bonus_percentage >= 0 AND bonus_percentage <= 100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Inserir faixas padrão
INSERT INTO assessment_growth_tiers (tier_name, min_students, max_students, bonus_percentage)
VALUES
  ('base', 0, 2, 0),
  ('bronze', 3, 5, 5),
  ('silver', 6, 10, 10),
  ('gold', 11, 20, 15),
  ('diamond', 21, NULL, 20)
ON CONFLICT (tier_name) DO NOTHING;

-- Seed by modality name so a clean database does not depend on production UUIDs.
WITH repasse_defaults (modality_name, coach_role, repasse_value) AS (
  VALUES
    ('corrida', 'junior', 50::numeric),
    ('corrida', 'pleno', 70::numeric),
    ('corrida', 'senior', 80::numeric),
    ('triathlon', 'junior', 100::numeric),
    ('triathlon', 'pleno', 130::numeric),
    ('triathlon', 'senior', 160::numeric)
)
INSERT INTO assessment_coach_repasse (coach_role, modality_id, repasse_value)
SELECT rates.coach_role, modality.id, rates.repasse_value
FROM repasse_defaults rates
JOIN assessment_modalities modality ON modality.name = rates.modality_name
ON CONFLICT (coach_role, modality_id) DO NOTHING;
;
