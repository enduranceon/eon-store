
-- Default pra pedidos novos terem status_changed_at preenchido desde o início
ALTER TABLE presale_orders ALTER COLUMN status_changed_at SET DEFAULT now();
ALTER TABLE stock_orders   ALTER COLUMN status_changed_at SET DEFAULT now();
;
