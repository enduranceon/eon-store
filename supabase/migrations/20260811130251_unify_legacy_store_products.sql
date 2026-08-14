-- Unifica os cadastros antigos criados diretamente no estoque em um perfil
-- base de produto. O registro de estoque mantém o mesmo ID, quantidade,
-- pedidos e movimentações; apenas passa a apontar para o catálogo.

create schema if not exists eon_private;

create table if not exists eon_private.legacy_store_product_unification_backups (
  migration_key text primary key,
  captured_at timestamptz not null default now(),
  snapshot jsonb not null
);

insert into eon_private.legacy_store_product_unification_backups (migration_key, snapshot)
select
  'unify_legacy_store_products_20260811',
  jsonb_build_object(
    'stock_products', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.name)
      from (
        select sp.*
        from public.stock_products sp
        where sp.product_id is null
           or not exists (select 1 from public.products p where p.id = sp.product_id)
      ) row
    ), '[]'::jsonb),
    'presale_products', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.name)
      from (
        select pp.*
        from public.presale_products pp
        where pp.product_id is null
           or not exists (select 1 from public.products p where p.id = pp.product_id)
      ) row
    ), '[]'::jsonb)
  )
on conflict (migration_key) do nothing;

do $$
declare
  source_stock record;
  source_presale record;
  target_product_id uuid;
begin
  for source_stock in
    select sp.*
    from public.stock_products sp
    where sp.product_id is null
       or not exists (select 1 from public.products p where p.id = sp.product_id)
    order by sp.created_date, sp.id
  loop
    select p.id
      into target_product_id
      from public.products p
     where (
       source_stock.product_number is not null
       and p.product_number = source_stock.product_number
     )
        or lower(trim(p.name)) = lower(trim(source_stock.name))
     order by case
       when source_stock.product_number is not null
        and p.product_number = source_stock.product_number then 0
       else 1
     end,
     p.created_date
     limit 1;

    if target_product_id is null then
      insert into public.products (
        name,
        description,
        category,
        subcategory,
        images,
        sale_price,
        regular_price,
        cost_price,
        supplier,
        supplier_id,
        notes,
        status,
        variations,
        extras,
        product_number
      )
      values (
        coalesce(nullif(trim(source_stock.name), ''), 'Produto sem nome'),
        source_stock.description,
        source_stock.category,
        source_stock.subcategory,
        coalesce(source_stock.images, '[]'::jsonb),
        source_stock.sale_price,
        source_stock.regular_price,
        source_stock.cost_price,
        source_stock.supplier,
        source_stock.supplier_id,
        source_stock.notes,
        case when source_stock.status = 'active' then 'active' else 'inactive' end,
        coalesce(source_stock.variations, '[]'::jsonb),
        coalesce(source_stock.extras, '[]'::jsonb),
        case
          when source_stock.product_number is not null
           and not exists (
             select 1
             from public.products p
             where p.product_number = source_stock.product_number
           )
          then source_stock.product_number
          else nextval('public.products_number_seq'::regclass)
        end
      )
      returning id into target_product_id;
    end if;

    update public.stock_products sp
       set product_id = target_product_id,
           product_number = coalesce(
             sp.product_number,
             (select p.product_number from public.products p where p.id = target_product_id)
           )
     where id = source_stock.id;
  end loop;

  for source_presale in
    select pp.*
    from public.presale_products pp
    where pp.product_id is null
       or not exists (select 1 from public.products p where p.id = pp.product_id)
    order by pp.created_date, pp.id
  loop
    select p.id
      into target_product_id
      from public.products p
     where (
       source_presale.product_number is not null
       and p.product_number = source_presale.product_number
     )
        or lower(trim(p.name)) = lower(trim(source_presale.name))
     order by case
       when source_presale.product_number is not null
        and p.product_number = source_presale.product_number then 0
       else 1
     end,
     p.created_date
     limit 1;

    if target_product_id is null then
      insert into public.products (
        name,
        description,
        category,
        subcategory,
        images,
        sale_price,
        regular_price,
        cost_price,
        supplier,
        supplier_id,
        notes,
        status,
        variations,
        extras,
        product_number
      )
      values (
        coalesce(nullif(trim(source_presale.name), ''), 'Produto sem nome'),
        source_presale.description,
        source_presale.category,
        source_presale.subcategory,
        coalesce(source_presale.images, '[]'::jsonb),
        source_presale.sale_price,
        source_presale.regular_price,
        source_presale.cost_price,
        source_presale.supplier,
        source_presale.supplier_id,
        source_presale.notes,
        case when source_presale.status = 'active' then 'active' else 'inactive' end,
        coalesce(source_presale.variations, '[]'::jsonb),
        coalesce(source_presale.extras, '[]'::jsonb),
        case
          when source_presale.product_number is not null
           and not exists (
             select 1
             from public.products p
             where p.product_number = source_presale.product_number
           )
          then source_presale.product_number
          else nextval('public.products_number_seq'::regclass)
        end
      )
      returning id into target_product_id;
    end if;

    update public.presale_products pp
       set product_id = target_product_id,
           product_number = coalesce(
             pp.product_number,
             (select p.product_number from public.products p where p.id = target_product_id)
           )
     where id = source_presale.id;
  end loop;
end;
$$;
