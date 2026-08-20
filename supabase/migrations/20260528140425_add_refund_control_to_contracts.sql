
ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS refund_status  TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount  NUMERIC,
  ADD COLUMN IF NOT EXISTS refund_date    DATE,
  ADD COLUMN IF NOT EXISTS refund_notes   TEXT;

COMMENT ON COLUMN assessment_contracts.refund_status IS 'null = sem estorno, pending = aguardando, done = realizado';
COMMENT ON COLUMN assessment_contracts.refund_amount IS 'Valor líquido a estornar ao aluno (após multa)';
COMMENT ON COLUMN assessment_contracts.refund_date   IS 'Data em que o estorno foi realizado';
COMMENT ON COLUMN assessment_contracts.refund_notes  IS 'Observações sobre o estorno (número da transação, etc.)';
;
