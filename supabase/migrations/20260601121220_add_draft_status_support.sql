
-- Status 'draft' já é aceito (coluna é TEXT). Vamos só:
--  1) Adicionar índice composto para a edge function buscar candidatos rápido
--  2) Comentário documentando os status válidos
--  3) Garantir que o trigger normalize_contract_on_cancel não dispara para drafts

CREATE INDEX IF NOT EXISTS idx_contracts_status_end_date
  ON assessment_contracts(status, end_date)
  WHERE status IN ('active','on_leave','finished','draft');

COMMENT ON COLUMN assessment_contracts.status IS
  'Estados válidos: draft (rascunho de renovação aguardando aprovação), active, on_leave, finished, cancelled';

-- O trigger atual só age quando passa para 'cancelled' — drafts não disparam.
-- OK do jeito que está.
;
