-- Guarda link de cobrança externo (Stone/PagSeguro/outro) e o último envio
-- de mensagem de cobrança, para permitir reenvio a partir da central financeira.

ALTER TABLE presale_orders
  ADD COLUMN IF NOT EXISTS external_payment_link TEXT,
  ADD COLUMN IF NOT EXISTS payment_message_sent_at TIMESTAMPTZ;

ALTER TABLE stock_orders
  ADD COLUMN IF NOT EXISTS external_payment_link TEXT,
  ADD COLUMN IF NOT EXISTS payment_message_sent_at TIMESTAMPTZ;

ALTER TABLE assessment_contracts
  ADD COLUMN IF NOT EXISTS external_payment_link TEXT,
  ADD COLUMN IF NOT EXISTS payment_message_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN presale_orders.external_payment_link IS
  'Link de cobrança criado fora do sistema, usado para reenviar mensagens de cobrança.';
COMMENT ON COLUMN stock_orders.external_payment_link IS
  'Link de cobrança criado fora do sistema, usado para reenviar mensagens de cobrança.';
COMMENT ON COLUMN assessment_contracts.external_payment_link IS
  'Link de cobrança criado fora do sistema, usado para reenviar mensagens de cobrança.';

COMMENT ON COLUMN presale_orders.payment_message_sent_at IS
  'Último envio manual de mensagem de cobrança ao cliente.';
COMMENT ON COLUMN stock_orders.payment_message_sent_at IS
  'Último envio manual de mensagem de cobrança ao cliente.';
COMMENT ON COLUMN assessment_contracts.payment_message_sent_at IS
  'Último envio manual de mensagem de cobrança ao aluno.';
