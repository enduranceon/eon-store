-- Campos de perfil adicionais no cliente
ALTER TABLE presale_customers
  ADD COLUMN IF NOT EXISTS gender     text,
  ADD COLUMN IF NOT EXISTS birth_date date;

-- Leitura anônima dos planos/modalidades/coaches/formas-de-pagamento ativos
CREATE POLICY "anon_read_active_plans"
  ON assessment_plans FOR SELECT TO anon
  USING (active = true);

CREATE POLICY "anon_read_active_modalities"
  ON assessment_modalities FOR SELECT TO anon
  USING (active = true);

CREATE POLICY "anon_read_active_coaches"
  ON assessment_coaches FOR SELECT TO anon
  USING (active = true);

CREATE POLICY "anon_read_payment_methods"
  ON payment_methods FOR SELECT TO anon
  USING (active = true);

-- Cadastro anônimo de cliente (formulário público de adesão)
CREATE POLICY "anon_insert_customers"
  ON presale_customers FOR INSERT TO anon
  WITH CHECK (true);

-- Criação anônima de contrato somente como rascunho
CREATE POLICY "anon_insert_draft_contracts"
  ON assessment_contracts FOR INSERT TO anon
  WITH CHECK (status = 'draft');
