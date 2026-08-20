
ALTER TABLE presale_orders
  ADD COLUMN IF NOT EXISTS manual_payment boolean NOT NULL DEFAULT false;

ALTER TABLE stock_orders
  ADD COLUMN IF NOT EXISTS manual_payment boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN presale_orders.manual_payment IS 'TRUE quando o pagamento foi registrado manualmente (fora do Asaas).';
COMMENT ON COLUMN stock_orders.manual_payment IS 'TRUE quando o pagamento foi registrado manualmente (fora do Asaas).';
;
