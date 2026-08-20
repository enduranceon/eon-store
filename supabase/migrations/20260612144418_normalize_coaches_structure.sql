
-- 1. CREATE MISSING COACHES IN assessment_coaches
INSERT INTO assessment_coaches (id, name, email, role, active, co_leader_ids)
VALUES
  (gen_random_uuid(), 'Thais Prando', 'thais.prando@enduranceon.com.br', 'pleno', true, '{}'),
  (gen_random_uuid(), 'Bruno Jeremias', 'bruno.jeremias@enduranceon.com.br', 'pleno', true, '{}'),
  (gen_random_uuid(), 'Elinai Freitas', 'elinai.freitas@enduranceon.com.br', 'pleno', true, '{}'),
  (gen_random_uuid(), 'Denis Santana', 'denis.santana@enduranceon.com.br', 'pleno', true, '{}'),
  (gen_random_uuid(), 'Jéssica Vieira', 'jessica.vieira@enduranceon.com.br', 'pleno', true, '{}')
ON CONFLICT DO NOTHING;

-- 2. ADD coach_id COLUMN TO presale_customers
ALTER TABLE presale_customers
ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES assessment_coaches(id) ON DELETE SET NULL;

-- 3. ADD coach_id COLUMNS TO presale_orders
ALTER TABLE presale_orders
ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES assessment_coaches(id) ON DELETE SET NULL;

-- 4. MIGRATE DATA: presale_customers (exact name match)
UPDATE presale_customers pc
SET coach_id = ac.id
FROM assessment_coaches ac
WHERE pc.coach_id IS NULL
  AND pc.trainer IS NOT NULL
  AND LOWER(TRIM(ac.name)) = LOWER(TRIM(pc.trainer));

-- 5. MIGRATE DATA: presale_orders.trainer (exact name match)
UPDATE presale_orders po
SET coach_id = ac.id
FROM assessment_coaches ac
WHERE po.coach_id IS NULL
  AND po.trainer IS NOT NULL
  AND LOWER(TRIM(ac.name)) = LOWER(TRIM(po.trainer));

-- 6. MIGRATE DATA: presale_orders.checkout_trainer (exact name match)
UPDATE presale_orders po
SET coach_id = ac.id
FROM assessment_coaches ac
WHERE po.coach_id IS NULL
  AND po.checkout_trainer IS NOT NULL
  AND LOWER(TRIM(ac.name)) = LOWER(TRIM(po.checkout_trainer));

-- 7. HANDLE ABBREVIATED NAMES
UPDATE presale_customers pc
SET coach_id = ac.id
FROM assessment_coaches ac
WHERE pc.coach_id IS NULL
  AND pc.trainer IS NOT NULL
  AND (
    (LOWER(TRIM(pc.trainer)) = 'thais' AND ac.name = 'Thais Prando') OR
    (LOWER(TRIM(pc.trainer)) = 'bruno' AND ac.name = 'Bruno Jeremias')
  );

UPDATE presale_orders po
SET coach_id = ac.id
FROM assessment_coaches ac
WHERE po.coach_id IS NULL
  AND po.trainer IS NOT NULL
  AND (
    (LOWER(TRIM(po.trainer)) = 'thais' AND ac.name = 'Thais Prando') OR
    (LOWER(TRIM(po.trainer)) = 'bruno' AND ac.name = 'Bruno Jeremias')
  );

UPDATE presale_orders po
SET coach_id = ac.id
FROM assessment_coaches ac
WHERE po.coach_id IS NULL
  AND po.checkout_trainer IS NOT NULL
  AND (
    (LOWER(TRIM(po.checkout_trainer)) = 'thais' AND ac.name = 'Thais Prando') OR
    (LOWER(TRIM(po.checkout_trainer)) = 'bruno' AND ac.name = 'Bruno Jeremias')
  );
;
