-- Remove policies legadas que davam acesso irrestrito a qualquer usuário
-- autenticado. As policies `app_admin_only`, já existentes nessas tabelas,
-- continuam sendo a única autorização para acessos diretos durante a migração
-- gradual do frontend para a Edge Function api-v1.

drop policy if exists auth_all_categories on public.presale_categories;
drop policy if exists auth_all_suppliers on public.presale_suppliers;
drop policy if exists auth_all_trainers on public.presale_trainers;
drop policy if exists auth_full on public.revenue_centers;
