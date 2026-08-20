-- Remove constraint check que aceitava apenas pix|boleto|credit_card.
-- Sistema usa muitos outros valores: pix_manual, cash, card_machine, bank_transfer,
-- card_1x, card_3x, etc. (todos definidos em src/lib/payment-methods.js).
-- Validação acontece no nível da aplicação.
ALTER TABLE assessment_contracts
  DROP CONSTRAINT IF EXISTS assessment_contracts_payment_method_check;;
