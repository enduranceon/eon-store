
ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS auto_renewal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN assessment_contracts.auto_renewal IS
  'Se true, o painel processa automaticamente a renovação ao vencer';
;
