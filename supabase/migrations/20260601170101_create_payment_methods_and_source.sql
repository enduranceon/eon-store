
-- 1) Tabela de métodos de pagamento configuráveis
CREATE TABLE IF NOT EXISTS payment_methods (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name            text NOT NULL,                   -- "Asaas", "Sem gateway", "Stone", etc.
  name                  text NOT NULL,                   -- "PIX", "Cartão 4x", "Boleto"
  kind                  text NOT NULL,                   -- 'pix' | 'boleto' | 'credit' | 'cash' | 'transfer' | 'other'
  fee_percent           numeric DEFAULT 0,               -- taxa em %
  fee_fixed             numeric DEFAULT 0,               -- taxa fixa em R$ (ex: boleto)
  credit_days_first     integer NOT NULL DEFAULT 1,      -- dias até cair a 1ª parcela
  credit_days_between   integer NOT NULL DEFAULT 30,     -- dias entre parcelas subsequentes
  installments          integer NOT NULL DEFAULT 1,      -- número de parcelas (1, 4, 6, 12...)
  active                boolean NOT NULL DEFAULT true,
  system                boolean NOT NULL DEFAULT false,  -- TRUE = padrão do sistema (não pode deletar)
  order_index           integer NOT NULL DEFAULT 0,
  internal_code         text,                            -- código interno (ex: pix, boleto, card_4x) — usado nos campos payment_method
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  UNIQUE (group_name, name)
);

COMMENT ON TABLE payment_methods IS
  'Métodos de pagamento configuráveis com taxas e prazos. Usados no modal de pagamento manual para projetar parcelas no fluxo de caixa.';

CREATE INDEX IF NOT EXISTS idx_payment_methods_active
  ON payment_methods(active, order_index);

CREATE INDEX IF NOT EXISTS idx_payment_methods_group
  ON payment_methods(group_name);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION touch_payment_methods_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_payment_methods ON payment_methods;
CREATE TRIGGER trg_touch_payment_methods
  BEFORE UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION touch_payment_methods_updated_at();

-- RLS padrão
ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_full ON payment_methods FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2) Coluna source em asaas_payments pra distinguir Asaas real vs parcelas manuais projetadas
ALTER TABLE asaas_payments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'asaas',
  ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES payment_methods(id);

COMMENT ON COLUMN asaas_payments.source IS
  'asaas = pagamento real do gateway Asaas. manual = parcela projetada de pagamento registrado manualmente.';

-- Permitir asaas_payment_id null pra parcelas manuais
ALTER TABLE asaas_payments
  ALTER COLUMN asaas_payment_id DROP NOT NULL;

-- 3) Seed: grupo Asaas (espelha o lib/payment-methods.js)
INSERT INTO payment_methods (group_name, name, kind, fee_percent, fee_fixed, credit_days_first, credit_days_between, installments, system, internal_code, order_index) VALUES
  ('Asaas', 'PIX (via Asaas)',    'pix',     0.99, 0,    1,  30, 1,  TRUE, 'pix',         1),
  ('Asaas', 'Boleto',              'boleto',  0,    3.49, 3,  30, 1,  TRUE, 'boleto',      2),
  ('Asaas', 'Cartão crédito 1x',   'credit',  2.99, 0,    30, 30, 1,  TRUE, 'credit_card', 3),
  ('Asaas', 'Cartão crédito 2x',   'credit',  3.49, 0,    30, 30, 2,  TRUE, 'card_2x',     4),
  ('Asaas', 'Cartão crédito 3x',   'credit',  3.99, 0,    30, 30, 3,  TRUE, 'card_3x',     5),
  ('Asaas', 'Cartão crédito 4x',   'credit',  4.49, 0,    30, 30, 4,  TRUE, 'card_4x',     6),
  ('Asaas', 'Cartão crédito 5x',   'credit',  4.99, 0,    30, 30, 5,  TRUE, 'card_5x',     7),
  ('Asaas', 'Cartão crédito 6x',   'credit',  5.49, 0,    30, 30, 6,  TRUE, 'card_6x',     8),
  ('Asaas', 'Cartão crédito 7x',   'credit',  5.99, 0,    30, 30, 7,  TRUE, 'card_7x',     9),
  ('Asaas', 'Cartão crédito 8x',   'credit',  6.49, 0,    30, 30, 8,  TRUE, 'card_8x',    10),
  ('Asaas', 'Cartão crédito 9x',   'credit',  6.99, 0,    30, 30, 9,  TRUE, 'card_9x',    11),
  ('Asaas', 'Cartão crédito 10x',  'credit',  7.49, 0,    30, 30, 10, TRUE, 'card_10x',   12),
  ('Asaas', 'Cartão crédito 11x',  'credit',  7.99, 0,    30, 30, 11, TRUE, 'card_11x',   13),
  ('Asaas', 'Cartão crédito 12x',  'credit',  8.49, 0,    30, 30, 12, TRUE, 'card_12x',   14)
ON CONFLICT (group_name, name) DO NOTHING;

-- 4) Seed: grupo Sem gateway
INSERT INTO payment_methods (group_name, name, kind, fee_percent, fee_fixed, credit_days_first, credit_days_between, installments, system, internal_code, order_index) VALUES
  ('Sem gateway', 'PIX manual',        'pix',      0, 0, 1, 30, 1, TRUE, 'pix_manual',    1),
  ('Sem gateway', 'Dinheiro',          'cash',     0, 0, 0, 30, 1, TRUE, 'cash',          2),
  ('Sem gateway', 'Transferência',     'transfer', 0, 0, 1, 30, 1, TRUE, 'bank_transfer', 3)
ON CONFLICT (group_name, name) DO NOTHING;
;
