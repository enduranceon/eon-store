-- Corrige o tamanho cadastrado como XG para XGG, preservando uma cópia dos
-- registros afetados antes da mudança para eventual auditoria/restauração.

create schema if not exists eon_private;

create table if not exists eon_private.product_size_label_correction_backups (
  correction_key text primary key,
  captured_at timestamptz not null default now(),
  snapshot jsonb not null
);

create or replace function eon_private.rename_xg_variation_label(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_value = 'XG' then 'XGG'
    when p_value like '% - XG' then left(p_value, length(p_value) - 2) || 'XGG'
    else p_value
  end;
$$;

create or replace function eon_private.rename_xg_variation_sku(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(p_value, '(^|-)XG(-|$)', E'\\1XGG\\2', 'g');
$$;

create or replace function eon_private.rename_xg_variation_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'array' then
      select coalesce(
        jsonb_agg(eon_private.rename_xg_variation_json(entry.value) order by entry.ordinality),
        '[]'::jsonb
      )
      into result
      from jsonb_array_elements(p_value) with ordinality as entry(value, ordinality);
      return result;
    when 'object' then
      select coalesce(
        jsonb_object_agg(
          entry.key,
          case
            when jsonb_typeof(entry.value) = 'string'
              and entry.key in ('size', 'variation', 'variation_name', 'name')
              then to_jsonb(eon_private.rename_xg_variation_label(entry.value #>> '{}'))
            when jsonb_typeof(entry.value) = 'string'
              and entry.key in ('sku', 'old_sku')
              then to_jsonb(eon_private.rename_xg_variation_sku(entry.value #>> '{}'))
            else eon_private.rename_xg_variation_json(entry.value)
          end
        ),
        '{}'::jsonb
      )
      into result
      from jsonb_each(p_value) as entry(key, value);
      return result;
    else
      return p_value;
  end case;
end;
$$;

revoke all on function eon_private.rename_xg_variation_label(text) from public;
revoke all on function eon_private.rename_xg_variation_sku(text) from public;
revoke all on function eon_private.rename_xg_variation_json(jsonb) from public;

-- A comparação anterior usava IS NOT DISTINCT FROM dentro de um FULL JOIN,
-- combinação que o PostgreSQL não aceita. Variações sem nome continuam
-- equivalentes entre si, mas a condição passa a ser merge/hash-joinable.
create or replace function eon_private.record_stock_product_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_variations jsonb;
  v_current_variations jsonb;
  v_movement record;
  v_delta integer;
  v_movement_type text;
  v_reason text;
  v_actor_id uuid;
  v_context_movement_type text;
  v_context_reason text;
  v_context_actor_id text;
begin
  v_previous_variations := case
    when tg_op = 'INSERT' then '[]'::jsonb
    when jsonb_typeof(coalesce(old.variations, '[]'::jsonb)) = 'array'
      then coalesce(old.variations, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_current_variations := case
    when jsonb_typeof(coalesce(new.variations, '[]'::jsonb)) = 'array'
      then coalesce(new.variations, '[]'::jsonb)
    else '[]'::jsonb
  end;

  v_context_movement_type := nullif(current_setting('eon.stock_movement_type', true), '');
  if v_context_movement_type not in (
    'stock_entry', 'inventory_adjustment', 'order_reserved', 'order_cancelled',
    'order_refunded', 'order_item_cancelled', 'order_returned'
  ) then
    v_context_movement_type := null;
  end if;
  v_context_reason := nullif(current_setting('eon.stock_movement_reason', true), '');
  v_context_actor_id := nullif(current_setting('eon.stock_movement_actor_id', true), '');

  if v_context_actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_actor_id := v_context_actor_id::uuid;
  else
    begin
      v_actor_id := auth.uid();
    exception when others then
      v_actor_id := null;
    end;
  end if;

  if jsonb_array_length(v_previous_variations) > 0
     or jsonb_array_length(v_current_variations) > 0 then
    for v_movement in
      with previous_variations as (
        select
          eon_private.stock_variation_name(value) as variation,
          sum(eon_private.stock_variation_quantity(value))::integer as quantity
        from jsonb_array_elements(v_previous_variations)
        group by eon_private.stock_variation_name(value)
      ), current_variations as (
        select
          eon_private.stock_variation_name(value) as variation,
          sum(eon_private.stock_variation_quantity(value))::integer as quantity
        from jsonb_array_elements(v_current_variations)
        group by eon_private.stock_variation_name(value)
      )
      select
        coalesce(current_variations.variation, previous_variations.variation) as variation,
        coalesce(previous_variations.quantity, 0) as quantity_before,
        coalesce(current_variations.quantity, 0) as quantity_after
      from previous_variations
      full join current_variations
        on coalesce(current_variations.variation, '') = coalesce(previous_variations.variation, '')
    loop
      v_delta := v_movement.quantity_after - v_movement.quantity_before;
      if v_delta = 0 then
        continue;
      end if;

      v_movement_type := coalesce(
        v_context_movement_type,
        case when v_delta > 0 then 'stock_entry' else 'inventory_adjustment' end
      );
      v_reason := coalesce(
        v_context_reason,
        case when v_delta > 0 then 'Entrada ou ajuste de estoque' else 'Ajuste de estoque' end
      );

      insert into public.stock_movements (
        stock_product_id, product_id, variation, movement_type,
        quantity_delta, quantity_before, quantity_after, reason, actor_id, metadata
      )
      values (
        new.id, new.product_id, v_movement.variation, v_movement_type,
        v_delta, v_movement.quantity_before, v_movement.quantity_after,
        v_reason, v_actor_id,
        jsonb_build_object('source', 'stock_product_trigger', 'transaction_id', txid_current()::text)
      );
    end loop;
  else
    v_delta := coalesce(new.quantity, 0) - case
      when tg_op = 'INSERT' then 0
      else coalesce(old.quantity, 0)
    end;

    if v_delta <> 0 then
      insert into public.stock_movements (
        stock_product_id, product_id, movement_type,
        quantity_delta, quantity_before, quantity_after, reason, actor_id, metadata
      )
      values (
        new.id, new.product_id,
        coalesce(v_context_movement_type, case when v_delta > 0 then 'stock_entry' else 'inventory_adjustment' end),
        v_delta,
        case when tg_op = 'INSERT' then 0 else coalesce(old.quantity, 0) end,
        coalesce(new.quantity, 0),
        coalesce(v_context_reason, case when v_delta > 0 then 'Entrada ou ajuste de estoque' else 'Ajuste de estoque' end),
        v_actor_id,
        jsonb_build_object('source', 'stock_product_trigger', 'transaction_id', txid_current()::text)
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function eon_private.record_stock_product_movement() from public;

insert into eon_private.product_size_label_correction_backups (correction_key, snapshot)
select
  'xg_to_xgg_20260811',
  jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.products where variations::text like '%XG%') row
    ), '[]'::jsonb),
    'stock_products', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.stock_products where variations::text like '%XG%') row
    ), '[]'::jsonb),
    'presale_products', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.presale_products where variations::text like '%XG%') row
    ), '[]'::jsonb),
    'stock_orders', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.stock_orders where items::text like '%XG%') row
    ), '[]'::jsonb),
    'presale_orders', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.presale_orders where items::text like '%XG%') row
    ), '[]'::jsonb),
    'stock_movements', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.stock_movements where variation = 'XG' or metadata::text like '%XG%') row
    ), '[]'::jsonb),
    'order_returns', coalesce((
      select jsonb_agg(to_jsonb(row))
      from (select * from public.order_returns where variation = 'XG') row
    ), '[]'::jsonb)
  )
on conflict (correction_key) do nothing;

update public.products
set variations = eon_private.rename_xg_variation_json(variations)
where variations::text like '%XG%';

update public.stock_products
set variations = eon_private.rename_xg_variation_json(variations)
where variations::text like '%XG%';

update public.presale_products
set variations = eon_private.rename_xg_variation_json(variations)
where variations::text like '%XG%';

update public.stock_orders
set items = eon_private.rename_xg_variation_json(items)
where items::text like '%XG%';

update public.presale_orders
set items = eon_private.rename_xg_variation_json(items)
where items::text like '%XG%';

update public.stock_movements
set
  variation = eon_private.rename_xg_variation_label(variation),
  metadata = eon_private.rename_xg_variation_json(metadata)
where variation = 'XG' or metadata::text like '%XG%';

update public.order_returns
set variation = eon_private.rename_xg_variation_label(variation)
where variation = 'XG';
;
