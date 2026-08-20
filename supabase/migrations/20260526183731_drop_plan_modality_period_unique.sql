-- Remove constraint UNIQUE antiga (modality_id, period) que impede múltiplos planos com mesma duração
-- Agora planos são identificados por NOME, então pode existir "Corrida · Mensal Básico" e "Corrida · Mensal Premium"
ALTER TABLE assessment_plans DROP CONSTRAINT IF EXISTS assessment_plans_modality_id_period_key;;
