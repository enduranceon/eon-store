-- 1. Centros de Receita (universal — usado por loja + assessoria + eventos)
CREATE TABLE IF NOT EXISTS revenue_centers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  color       text DEFAULT '#3b82f6',
  type        text DEFAULT 'general', -- 'assessoria' | 'loja' | 'eventos' | 'general'
  active      boolean DEFAULT true,
  created_at  timestamp with time zone DEFAULT now(),
  updated_at  timestamp with time zone DEFAULT now()
);

ALTER TABLE revenue_centers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_full ON revenue_centers;
CREATE POLICY auth_full ON revenue_centers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. Seed inicial — centros padrão
INSERT INTO revenue_centers (name, type, color) VALUES
  ('Assessoria · Mensalidades', 'assessoria', '#3b82f6'),
  ('Assessoria · Matrículas',   'assessoria', '#8b5cf6'),
  ('Loja · Lifestyle',          'loja',       '#10b981'),
  ('Loja · Equipamentos',       'loja',       '#06b6d4'),
  ('Eventos · Clínicas',        'eventos',    '#f59e0b')
ON CONFLICT DO NOTHING;

-- 3. Nome dos planos
ALTER TABLE assessment_plans
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS revenue_center_id uuid REFERENCES revenue_centers(id) ON DELETE SET NULL;

-- 4. Centro de receita nos produtos
ALTER TABLE presale_products
  ADD COLUMN IF NOT EXISTS revenue_center_id uuid REFERENCES revenue_centers(id) ON DELETE SET NULL;

ALTER TABLE stock_products
  ADD COLUMN IF NOT EXISTS revenue_center_id uuid REFERENCES revenue_centers(id) ON DELETE SET NULL;

-- 5. Link revenue_center_id default em planos existentes → "Assessoria · Mensalidades"
UPDATE assessment_plans
SET revenue_center_id = (SELECT id FROM revenue_centers WHERE name = 'Assessoria · Mensalidades' LIMIT 1)
WHERE revenue_center_id IS NULL;;
