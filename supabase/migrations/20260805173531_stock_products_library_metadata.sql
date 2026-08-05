alter table public.stock_products
  add column if not exists subcategory text,
  add column if not exists supplier text,
  add column if not exists supplier_id uuid,
  add column if not exists product_number integer,
  add column if not exists variations jsonb not null default '[]'::jsonb,
  add column if not exists extras jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stock_products_variations_array'
      and conrelid = 'public.stock_products'::regclass
  ) then
    alter table public.stock_products
      add constraint stock_products_variations_array
      check (jsonb_typeof(variations) = 'array') not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'stock_products_extras_array'
      and conrelid = 'public.stock_products'::regclass
  ) then
    alter table public.stock_products
      add constraint stock_products_extras_array
      check (jsonb_typeof(extras) = 'array') not valid;
  end if;
end $$;

comment on column public.stock_products.product_id is
  'Optional link to the central product library row in public.products.';

comment on column public.stock_products.product_number is
  'Mirror of public.products.product_number for operator-facing SKU/code display.';

comment on column public.stock_products.variations is
  'Snapshot of library variations when the stock item is imported from public.products.';

comment on column public.stock_products.extras is
  'Snapshot of library extras when the stock item is imported from public.products.';

update public.stock_products sp
set
  subcategory = coalesce(sp.subcategory, p.subcategory),
  supplier = coalesce(sp.supplier, p.supplier),
  supplier_id = coalesce(sp.supplier_id, p.supplier_id),
  product_number = coalesce(sp.product_number, p.product_number),
  variations = case
    when sp.variations = '[]'::jsonb then coalesce(p.variations, '[]'::jsonb)
    else sp.variations
  end,
  extras = case
    when sp.extras = '[]'::jsonb then coalesce(p.extras, '[]'::jsonb)
    else sp.extras
  end,
  updated_date = now()
from public.products p
where sp.product_id = p.id;
