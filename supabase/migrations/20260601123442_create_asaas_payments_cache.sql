
-- Tabela cache das parcelas Asaas. Fonte de verdade para fluxo de caixa real
-- e relatórios financeiros — substitui inferência via total_value/installments.
-- Alimentada por webhook (asaas-webhook) e por sync manual (sync-asaas-payments).

CREATE TABLE IF NOT EXISTS asaas_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asaas_payment_id      text NOT NULL UNIQUE,          -- ID único do pagamento no Asaas
  asaas_customer_id     text,                          -- cliente no Asaas
  installment_group_id  text,                          -- grupo de parcelamento (NULL se 1x)
  installment_number    integer,                       -- 1..N
  total_installments    integer,                       -- N total
  billing_type          text,                          -- PIX | BOLETO | CREDIT_CARD
  status                text NOT NULL,                 -- RECEIVED | CONFIRMED | PENDING | OVERDUE | REFUNDED | …
  value                 numeric NOT NULL,              -- valor bruto da parcela
  net_value             numeric,                       -- líquido após taxa Asaas
  due_date              date,
  payment_date          date,                          -- quando foi pago
  credit_date           date,                          -- quando cai na conta (Asaas)
  description           text,
  external_reference    text,                          -- contract_number ou order_number

  -- Vínculo com pedido/contrato local
  order_id              uuid,                          -- aponta para presale_orders, stock_orders ou assessment_contracts
  order_type            text,                          -- 'presale' | 'stock' | 'contract'

  raw                   jsonb,                         -- payload bruto do Asaas
  last_synced_at        timestamptz DEFAULT now(),
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE asaas_payments IS
  'Cache local das parcelas individuais no Asaas. Atualizado por webhook em tempo real e por sync manual (backfill/reconciliação).';

CREATE INDEX IF NOT EXISTS idx_asaas_payments_order
  ON asaas_payments(order_id, order_type);

CREATE INDEX IF NOT EXISTS idx_asaas_payments_credit_date
  ON asaas_payments(credit_date)
  WHERE status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH');

CREATE INDEX IF NOT EXISTS idx_asaas_payments_status
  ON asaas_payments(status);

CREATE INDEX IF NOT EXISTS idx_asaas_payments_group
  ON asaas_payments(installment_group_id);

-- Trigger pra manter updated_at
CREATE OR REPLACE FUNCTION touch_asaas_payments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_asaas_payments ON asaas_payments;
CREATE TRIGGER trg_touch_asaas_payments
  BEFORE UPDATE ON asaas_payments
  FOR EACH ROW
  EXECUTE FUNCTION touch_asaas_payments_updated_at();

-- RLS: padrão atual do projeto (authenticated faz tudo)
ALTER TABLE asaas_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_full ON asaas_payments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
;
