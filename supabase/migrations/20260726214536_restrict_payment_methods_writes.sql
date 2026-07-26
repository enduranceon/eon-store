-- A configuração de métodos de pagamento passa a ser gravada somente pela
-- Edge Function autenticada. O painel ainda mantém SELECT direto para o
-- diagnóstico administrativo durante a transição dos demais módulos.

drop policy if exists auth_full on public.payment_methods;

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
