-- CNPJ opcional da pessoa, para quem paga a assessoria ou a loja pela empresa.
-- O CPF continua sendo a identidade do cadastro (único, usado pelo site e pelos
-- links); o CNPJ não é único (uma empresa pode pagar por mais de uma pessoa) e
-- serve para a conferência das faturas do Asaas reconhecer o pagamento.
ALTER TABLE public.presale_customers
  ADD COLUMN IF NOT EXISTS cnpj text;

ALTER TABLE public.presale_customers
  DROP CONSTRAINT IF EXISTS presale_customers_cnpj_format;
ALTER TABLE public.presale_customers
  ADD CONSTRAINT presale_customers_cnpj_format
  CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$');

COMMENT ON COLUMN public.presale_customers.cnpj IS
  'CNPJ opcional (só dígitos) para cobranças pagas pela empresa da pessoa. A identidade continua sendo o CPF.';
