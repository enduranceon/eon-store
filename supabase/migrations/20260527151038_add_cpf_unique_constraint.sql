-- CPF único entre clientes (permite múltiplos NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_presale_customers_cpf
  ON presale_customers(cpf)
  WHERE cpf IS NOT NULL AND cpf != '';;
