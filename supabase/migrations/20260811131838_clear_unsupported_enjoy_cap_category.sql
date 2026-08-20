-- “Boné” descreve o tipo do item, mas não é uma categoria cadastrada.
-- Limpa o valor legado para que a lista use apenas categorias oficiais.
update public.products
set category = null
where name in (
  'BONÉ ENJOY THE PROCESS - BRANCO',
  'BONÉ ENJOY THE PROCESS - PRETO'
)
  and category = 'Boné';

update public.stock_products
set category = null
where name = 'BONÉ ENJOY THE PROCESS - BRANCO'
  and category = 'Boné';
;
