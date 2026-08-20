-- Régua de renovação: regras editáveis + log de ações executadas
CREATE TABLE IF NOT EXISTS renewal_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  days_offset      integer NOT NULL,                    -- -10 = 10 dias antes, +1 = 1 dia depois
  action_type      text NOT NULL DEFAULT 'whatsapp',    -- 'whatsapp' | 'generate_charge_and_whatsapp'
  message_template text NOT NULL,
  icon             text DEFAULT '📨',
  color            text DEFAULT '#3b82f6',
  active           boolean DEFAULT true,
  order_index      integer DEFAULT 0,
  created_at       timestamp with time zone DEFAULT now(),
  updated_at       timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contract_renewal_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid REFERENCES assessment_contracts(id) ON DELETE CASCADE NOT NULL,
  rule_id      uuid REFERENCES renewal_rules(id) ON DELETE SET NULL,
  status       text DEFAULT 'done',                     -- 'done' | 'skipped'
  notes        text,
  executed_at  timestamp with time zone DEFAULT now(),
  created_at   timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_renewal_actions_contract ON contract_renewal_actions(contract_id);
CREATE INDEX IF NOT EXISTS idx_renewal_actions_rule ON contract_renewal_actions(rule_id);

ALTER TABLE renewal_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_renewal_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_full ON renewal_rules;
CREATE POLICY auth_full ON renewal_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS auth_full ON contract_renewal_actions;
CREATE POLICY auth_full ON contract_renewal_actions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Seed: 3 regras padrão (as 3 que voc^e marcou)
INSERT INTO renewal_rules (name, days_offset, action_type, message_template, icon, color, order_index) VALUES
('Pré-renovação',           -10, 'whatsapp',                     E'Oi, {nome}! 👋\n\nSeu plano *{plano}* vence em {dias_restantes} ({vencimento}).\n\nVamos renovar? Posso te enviar o link de pagamento agora! 🏃‍♂️\n\nQualquer dúvida, é só chamar.',                                              '📨', '#3b82f6', 1),
('Cobrança de renovação',    -5, 'generate_charge_and_whatsapp', E'Oi, {nome}!\n\nAqui está sua cobrança da renovação:\n\n📋 Plano: *{plano}*\n💰 Total: *{valor}*\n📅 Vencimento: {vencimento}\n\n{link_pagamento}\n\nQualquer dúvida, é só chamar! 💬',                              '💰', '#10b981', 2),
('Pós-vencimento',           1, 'whatsapp',                      E'Oi, {nome}!\n\nSeu plano *{plano}* venceu ontem. 😬\n\nQuer regularizar? Posso te enviar o link da cobrança agora ou, se preferir, vamos conversar sobre o que aconteceu.\n\n{link_pagamento}',                          '⚠️', '#ef4444', 3)
ON CONFLICT DO NOTHING;;
