begin;

-- A politica app_admin_only e RESTRICTIVE. Ela limita o acesso aos admins,
-- mas precisa de uma politica PERMISSIVE para que SELECT possa retornar linhas.
-- As escritas do navegador continuam bloqueadas por grants e pela API JWT.
do $$
declare
  table_record record;
begin
  for table_record in
    select distinct tablename
    from pg_policies
    where schemaname = 'public'
      and policyname = 'app_admin_only'
  loop
    execute format(
      'drop policy if exists app_admin_read on public.%I',
      table_record.tablename
    );
    execute format(
      'create policy app_admin_read on public.%I as permissive for select to authenticated using ((select eon_private.is_app_admin()))',
      table_record.tablename
    );
  end loop;
end
$$;

commit;
