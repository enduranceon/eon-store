
-- Recria a tabela com a estrutura correta
DROP TABLE assessment_growth_tiers;

CREATE TABLE assessment_growth_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_name TEXT NOT NULL UNIQUE,
  min_students INTEGER NOT NULL,
  incremento NUMERIC(10,2) NOT NULL DEFAULT 0,
  bonus_lider NUMERIC(10,2) NOT NULL DEFAULT 0,
  bonus_co_lider NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dados corretos da tela de configuração
INSERT INTO assessment_growth_tiers (tier_name, min_students, incremento, bonus_lider, bonus_co_lider)
VALUES
  ('base',    0,    0.00, 3.00, 1.50),
  ('bronze',  300,  3.00, 3.50, 1.75),
  ('silver',  500,  5.00, 4.00, 2.00),
  ('gold',    700,  7.00, 4.50, 2.25),
  ('diamond', 1000, 9.00, 5.00, 2.50);
;
