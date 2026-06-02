-- Create payment_methods table for standardizing payment method configurations
-- Supports both Asaas (automatic) and manual payment methods with customizable fees and installments

CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Basic info
  name TEXT NOT NULL,                          -- ex: "PIX via Asaas", "Dinheiro", "Cartão na máquina"
  internal_code TEXT UNIQUE NOT NULL,          -- ex: "pix_asaas", "pix_manual", "cash", "card_machine"
  description TEXT,                            -- optional description

  -- Payment source
  source TEXT NOT NULL DEFAULT 'manual',       -- 'asaas' | 'manual' | 'custom'
  kind TEXT,                                   -- 'pix' | 'boleto' | 'card' | 'bank_transfer' | 'cash' | etc

  -- Fee structure (either % or fixed amount)
  fee_percent NUMERIC(5, 2) DEFAULT 0,         -- percentage fee (ex: 2.99)
  fee_fixed NUMERIC(10, 2) DEFAULT 0,          -- fixed fee in R$ (ex: 0.10 for boleto)

  -- Installment configuration
  installments INTEGER DEFAULT 1,              -- number of installments (1, 3, 12, etc)
  credit_days_first INTEGER DEFAULT 1,         -- days until first credit (D+0, D+1, D+15, etc)
  credit_days_between INTEGER DEFAULT 30,      -- days between installments

  -- Display & management
  active BOOLEAN DEFAULT true,
  system_defined BOOLEAN DEFAULT false,        -- true = pre-defined (can't delete, only edit)
  display_order INTEGER DEFAULT 999,           -- for UI sorting

  -- Metadata
  group_name TEXT,                             -- for grouping in UI (ex: "Asaas", "Sem gateway", "Stone")
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX idx_payment_methods_internal_code ON payment_methods(internal_code);
CREATE INDEX idx_payment_methods_source ON payment_methods(source);
CREATE INDEX idx_payment_methods_active ON payment_methods(active);

-- Seed with pre-defined payment methods
INSERT INTO payment_methods
  (name, internal_code, description, source, kind, fee_percent, fee_fixed, installments, credit_days_first, credit_days_between, system_defined, display_order, group_name)
VALUES
  -- Asaas methods
  ('PIX via Asaas', 'pix_asaas', 'Recebimento via PIX pelo Asaas', 'asaas', 'pix', 0.99, 0, 1, 1, 0, true, 10, 'Asaas'),
  ('Boleto via Asaas', 'boleto_asaas', 'Recebimento via Boleto pelo Asaas', 'asaas', 'boleto', 3.00, 0, 1, 15, 0, true, 11, 'Asaas'),
  ('Cartão Asaas 3x', 'card_asaas_3x', 'Cartão de crédito 3 parcelas via Asaas', 'asaas', 'card', 2.99, 0, 3, 30, 30, true, 12, 'Asaas'),
  ('Cartão Asaas 12x', 'card_asaas_12x', 'Cartão de crédito 12 parcelas via Asaas', 'asaas', 'card', 3.65, 0, 12, 30, 30, true, 13, 'Asaas'),

  -- Manual methods (no gateway)
  ('PIX Manual', 'pix_manual', 'PIX recebido manualmente (sem Asaas)', 'manual', 'pix', 0, 0, 1, 1, 0, true, 20, 'Sem gateway'),
  ('Dinheiro', 'cash', 'Dinheiro recebido em mão', 'manual', 'cash', 0, 0, 1, 0, 0, true, 21, 'Sem gateway'),
  ('Transferência Bancária', 'bank_transfer', 'Transferência bancária', 'manual', 'bank_transfer', 0, 0, 1, 1, 0, true, 22, 'Sem gateway');

-- Add comment for documentation
COMMENT ON TABLE payment_methods IS 'Payment method configurations with fee structures and installment options. Supports both gateway (Asaas) and manual payment tracking.';
