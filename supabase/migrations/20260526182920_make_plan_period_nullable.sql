-- Remove NOT NULL da coluna `period` legada — agora usamos `period_months`
ALTER TABLE assessment_plans ALTER COLUMN period DROP NOT NULL;;
