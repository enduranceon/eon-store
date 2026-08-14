insert into public.presale_categories (name, subcategories)
select 'Acessório', array[]::text[]
where not exists (
  select 1
  from public.presale_categories
  where lower(name) = lower('Acessório')
);
