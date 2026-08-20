
ALTER TABLE assessment_students ADD COLUMN IF NOT EXISTS cpf text;
CREATE INDEX IF NOT EXISTS idx_students_cpf ON assessment_students(cpf) WHERE cpf IS NOT NULL;
;
