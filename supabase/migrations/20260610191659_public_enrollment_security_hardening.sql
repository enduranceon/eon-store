
-- 1. Remove política anon desnecessária em payment_methods
DROP POLICY IF EXISTS "anon_read_payment_methods" ON public.payment_methods;

-- 2. Tighten INSERT de clientes: exige active = true
DROP POLICY IF EXISTS "anon_insert_customers" ON public.presale_customers;
CREATE POLICY "anon_insert_customers" ON public.presale_customers
  FOR INSERT TO anon
  WITH CHECK (active = true);

-- 3. Função SECURITY DEFINER para lookup de CPF
--    Anon recebe apenas o UUID do cliente — sem acesso a nome, telefone, etc.
CREATE OR REPLACE FUNCTION public.find_customer_id_by_cpf(p_cpf text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM presale_customers WHERE cpf = p_cpf LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_customer_id_by_cpf(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_customer_id_by_cpf(text) TO anon;
GRANT EXECUTE ON FUNCTION public.find_customer_id_by_cpf(text) TO authenticated;
;
