BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(4);

-- Pessoas fictícias.
INSERT INTO public.presale_customers (id, full_name, cpf, cnpj)
VALUES ('88000000-0000-4000-a000-0000000000c1', 'Pessoa Com Empresa', '52998224725', '11222333000181');
SELECT is(
  (SELECT cnpj FROM public.presale_customers WHERE id = '88000000-0000-4000-a000-0000000000c1'),
  '11222333000181',
  'a customer keeps the CPF and an optional CNPJ'
);

-- O CNPJ não é identidade: outra pessoa pode usar a mesma empresa.
INSERT INTO public.presale_customers (id, full_name, cpf, cnpj)
VALUES ('88000000-0000-4000-a000-0000000000c2', 'Outra Pessoa Da Empresa', '11144477735', '11222333000181');
SELECT is(
  (SELECT count(*)::int FROM public.presale_customers WHERE cnpj = '11222333000181'),
  2,
  'two people can share the same company CNPJ'
);

SELECT throws_ok(
  $$UPDATE public.presale_customers SET cnpj = '11.222.333/0001-81' WHERE id = '88000000-0000-4000-a000-0000000000c1'$$,
  '23514',
  NULL,
  'the CNPJ is stored as 14 digits only'
);

UPDATE public.presale_customers SET cnpj = NULL WHERE id = '88000000-0000-4000-a000-0000000000c1';
SELECT is(
  (SELECT cnpj FROM public.presale_customers WHERE id = '88000000-0000-4000-a000-0000000000c1'),
  NULL,
  'the CNPJ can be removed'
);

SELECT * FROM finish();
ROLLBACK;
