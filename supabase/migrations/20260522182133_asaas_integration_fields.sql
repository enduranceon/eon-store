
-- CPF no perfil do cliente (pré-venda)
ALTER TABLE presale_customers ADD COLUMN IF NOT EXISTS cpf TEXT;

-- Campos Asaas nos pedidos de pré-venda
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT;
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS asaas_charge_id    TEXT;
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS asaas_payment_link TEXT;
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS asaas_pix_qrcode   TEXT;
ALTER TABLE presale_orders ADD COLUMN IF NOT EXISTS asaas_pix_copy     TEXT;

-- CPF + campos Asaas nos pedidos da loja
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS customer_cpf         TEXT;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS asaas_customer_id    TEXT;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS asaas_charge_id      TEXT;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS asaas_payment_link   TEXT;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS asaas_pix_qrcode     TEXT;
ALTER TABLE stock_orders ADD COLUMN IF NOT EXISTS asaas_pix_copy       TEXT;
;
