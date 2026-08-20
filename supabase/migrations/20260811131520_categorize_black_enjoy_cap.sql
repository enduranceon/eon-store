-- Padroniza a categoria dos dois bonés da linha Enjoy the Process.
update public.products
set category = 'Boné'
where id = 'ed8a01d6-bf84-474d-a41a-6f0d22409fe3'::uuid
  and category is null;
;
