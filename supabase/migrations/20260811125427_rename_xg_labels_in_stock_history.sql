-- Completa a correção nos rótulos compostos do histórico, como
-- "Feminino - XG", preservando as linhas originais em backup privado.

insert into eon_private.product_size_label_correction_backups (correction_key, snapshot)
select
  'xg_to_xgg_20260811_stock_movement_labels',
  coalesce(jsonb_agg(to_jsonb(movement)), '[]'::jsonb)
from public.stock_movements as movement
where movement.variation ~ 'XG([^G]|$)'
on conflict (correction_key) do nothing;

update public.stock_movements
set variation = eon_private.rename_xg_variation_label(variation)
where variation ~ 'XG([^G]|$)';
