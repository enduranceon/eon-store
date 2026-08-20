do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='presale_orders' and policyname='public_insert_orders'
  ) then
    create policy "public_insert_orders"
    on public.presale_orders
    as permissive
    for insert
    to public
    with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='presale_orders' and policyname='public_select_orders'
  ) then
    create policy "public_select_orders"
    on public.presale_orders
    as permissive
    for select
    to public
    using (true);
  end if;
end
$$;;
