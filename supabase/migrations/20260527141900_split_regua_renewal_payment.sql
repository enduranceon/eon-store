-- Adiciona tipo de régua (renovação vs pagamento)
ALTER TABLE renewal_rules
  ADD COLUMN IF NOT EXISTS rule_type text DEFAULT 'renewal';

ALTER TABLE contract_renewal_actions
  ADD COLUMN IF NOT EXISTS rule_type text DEFAULT 'renewal';

-- Garante que regras existentes ficam como 'renewal'
UPDATE renewal_rules SET rule_type = 'renewal' WHERE rule_type IS NULL;
UPDATE contract_renewal_actions SET rule_type = 'renewal' WHERE rule_type IS NULL;

-- Seed: 4 regras padrão de PAGAMENTO
INSERT INTO renewal_rules (name, rule_type, days_offset, action_type, message_template, icon, color, order_index) VALUES
('Lembrete de pagamento',  'payment', -3, 'whatsapp',
 E'Oi, {nome}! 👋\n\nLembrando que sua cobrança do plano *{plano}* vence em 3 dias ({vencimento}).\n\nTudo certo pra pagar? Se precisar do link de novo, é só me chamar! 💬',
 '📨', '#3b82f6', 10),

('Vence hoje',              'payment', 0, 'whatsapp',
 E'Oi, {nome}!\n\nSua cobrança de *{valor}* do plano *{plano}* vence HOJE!\n\n{link_pagamento}\n\nQualquer coisa, é só falar comigo! 💬',
 '⏰', '#f59e0b', 11),

('Atrasou',                 'payment', 1, 'whatsapp',
 E'Oi, {nome}!\n\nVi que sua cobrança de *{valor}* venceu ontem e ainda não foi paga.\n\nAconteceu algo? Posso te enviar o link de novo:\n\n{link_pagamento}\n\nQuer conversar sobre? 💬',
 '⚠️', '#ef4444', 12),

('Em atraso há dias',       'payment', 7, 'whatsapp',
 E'Oi, {nome}!\n\nSua cobrança de *{valor}* está em atraso há mais de 7 dias.\n\nSeu acesso ao plano pode ser suspenso. Vamos resolver isso?\n\n{link_pagamento}',
 '🔴', '#dc2626', 13)
ON CONFLICT DO NOTHING;;
