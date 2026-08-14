-- A troca de rótulo XG -> XGG não é movimentação física. O gatilho de estoque
-- registrou pares compensatórios durante a primeira execução da correção;
-- preservamos essas linhas no backup privado e removemos apenas esse lote.

insert into eon_private.product_size_label_correction_backups (correction_key, snapshot)
select
  'xg_to_xgg_20260811_artifact_movements',
  coalesce(jsonb_agg(to_jsonb(movement)), '[]'::jsonb)
from public.stock_movements as movement
where movement.created_at = (
  select captured_at
  from eon_private.product_size_label_correction_backups
  where correction_key = 'xg_to_xgg_20260811'
)
  and movement.metadata->>'source' = 'stock_product_trigger'
on conflict (correction_key) do nothing;

delete from public.stock_movements as movement
where movement.created_at = (
  select captured_at
  from eon_private.product_size_label_correction_backups
  where correction_key = 'xg_to_xgg_20260811'
)
  and movement.metadata->>'source' = 'stock_product_trigger';
