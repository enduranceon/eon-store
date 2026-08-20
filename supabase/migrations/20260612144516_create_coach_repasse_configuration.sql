
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

-- Inserir valores de repasse (corrida)
INSERT INTO assessment_coach_repasse (coach_role, modality_id, repasse_value)
VALUES
  ('junior', '13cbc183-5988-4aff-92cc-38d4a7ddfed5', 50),
  ('pleno', '13cbc183-5988-4aff-92cc-38d4a7ddfed5', 70),
  ('senior', '13cbc183-5988-4aff-92cc-38d4a7ddfed5', 80)
ON CONFLICT DO NOTHING;

-- Inserir valores de repasse (triathlon)
INSERT INTO assessment_coach_repasse (coach_role, modality_id, repasse_value)
VALUES
  ('junior', 'b93530eb-018c-4f79-948e-6775313a347a', 100),
  ('pleno', 'b93530eb-018c-4f79-948e-6775313a347a', 130),
  ('senior', 'b93530eb-018c-4f79-948e-6775313a347a', 160)
ON CONFLICT DO NOTHING;
;
