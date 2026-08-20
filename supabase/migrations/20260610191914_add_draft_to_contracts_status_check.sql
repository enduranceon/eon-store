
ALTER TABLE public.assessment_contracts
  DROP CONSTRAINT assessment_contracts_status_check;

ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_status_check
  CHECK (status = ANY (ARRAY['active','overdue','cancelled','finished','on_leave','draft']));
;
