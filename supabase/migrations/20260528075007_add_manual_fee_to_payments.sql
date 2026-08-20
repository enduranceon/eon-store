-- Taxa cobrada no pagamento manual (maquininha, gateway alternativo, etc.)
-- Quando NULL, usa o cálculo padrão de calcGatewayFee(payment_method)
ALTER TABLE assessment_contracts ADD COLUMN IF NOT EXISTS manual_fee numeric;
ALTER TABLE stock_orders         ADD COLUMN IF NOT EXISTS manual_fee numeric;
ALTER TABLE presale_orders       ADD COLUMN IF NOT EXISTS manual_fee numeric;;
