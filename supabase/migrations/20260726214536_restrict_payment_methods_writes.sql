-- A configuração de métodos de pagamento passa a ser gravada somente pela
-- Edge Function autenticada. O painel ainda mantém SELECT direto para o
-- diagnóstico administrativo durante a transição dos demais módulos.

drop policy if exists auth_full on public.payment_methods;

-- `app_admin_only` é RESTRICTIVE e, sozinho, não concede acesso. Esta policy
-- PERMISSIVE mantém o SELECT usado pelo diagnóstico, ainda limitado pela
-- interseção com `app_admin_only` à allowlist administrativa.
drop policy if exists payment_methods_admin_select on public.payment_methods;
create policy payment_methods_admin_select
  on public.payment_methods
  as permissive
  for select
  to authenticated
  using (eon_private.is_app_admin());

revoke all privileges
  on table public.payment_methods
  from anon;

revoke insert, update, delete, truncate, references, trigger
  on table public.payment_methods
  from authenticated;

grant select
  on table public.payment_methods
  to authenticated;

grant select, insert, update, delete
  on table public.payment_methods
  to service_role;
