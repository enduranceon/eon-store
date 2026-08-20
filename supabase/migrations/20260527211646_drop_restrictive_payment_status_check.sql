-- Mesma rationale do payment_method_check: enum restrito demais quebra fluxos legítimos.
-- Valores usados no sistema: pending, paid, overdue, refunded, partially_refunded,
-- charge_sent, awaiting_charge, message_sent, partially_paid, cancelled
-- A validação fica no nível da aplicação (constantes PAYMENT_STATUS).
ALTER TABLE assessment_contracts
  DROP CONSTRAINT IF EXISTS assessment_contracts_payment_status_check;;
