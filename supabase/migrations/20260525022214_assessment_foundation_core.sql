
-- ============================================================
-- ASSESSMENT FOUNDATION — Modalities, Plans, Coaches, Students
-- ============================================================

-- Modalidades
CREATE TABLE IF NOT EXISTS assessment_modalities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

INSERT INTO assessment_modalities (name) VALUES ('corrida'), ('triathlon')
ON CONFLICT (name) DO NOTHING;

-- Planos
CREATE TABLE IF NOT EXISTS assessment_plans (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  modality_id      uuid        NOT NULL REFERENCES assessment_modalities(id) ON DELETE RESTRICT,
  period           text        NOT NULL CHECK (period IN ('mensal','trimestral','semestral')),
  price_monthly    numeric     NOT NULL CHECK (price_monthly > 0),
  price_total      numeric     NOT NULL CHECK (price_total > 0),
  max_installments int         NOT NULL DEFAULT 1 CHECK (max_installments >= 1),
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE (modality_id, period)
);

-- Seed planos
WITH m AS (SELECT id, name FROM assessment_modalities WHERE name IN ('corrida','triathlon'))
INSERT INTO assessment_plans (modality_id, period, price_monthly, price_total, max_installments)
SELECT (SELECT id FROM m WHERE name='corrida'),   'mensal',     240, 240,  1
UNION ALL SELECT (SELECT id FROM m WHERE name='corrida'),   'trimestral', 220, 660,  3
UNION ALL SELECT (SELECT id FROM m WHERE name='corrida'),   'semestral',  200, 1200, 6
UNION ALL SELECT (SELECT id FROM m WHERE name='triathlon'), 'mensal',     380, 380,  1
UNION ALL SELECT (SELECT id FROM m WHERE name='triathlon'), 'trimestral', 360, 1080, 3
UNION ALL SELECT (SELECT id FROM m WHERE name='triathlon'), 'semestral',  340, 2040, 6
ON CONFLICT (modality_id, period) DO NOTHING;

-- Coaches
CREATE TABLE IF NOT EXISTS assessment_coaches (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  phone         text,
  active        boolean     NOT NULL DEFAULT true,
  role          text        NOT NULL CHECK (role IN ('junior','pleno','senior')),
  leader_id     uuid        REFERENCES assessment_coaches(id) ON DELETE SET NULL,
  co_leader_ids uuid[]      NOT NULL DEFAULT '{}',
  auth_user_id  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaches_leader   ON assessment_coaches(leader_id);
CREATE INDEX IF NOT EXISTS idx_coaches_auth_user ON assessment_coaches(auth_user_id);

-- Alunos
CREATE TABLE IF NOT EXISTS assessment_students (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  email      text,
  phone      text        NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_students_phone ON assessment_students(phone);
CREATE INDEX IF NOT EXISTS idx_students_email ON assessment_students(email) WHERE email IS NOT NULL;

-- RLS
ALTER TABLE assessment_modalities ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_coaches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_students   ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_full ON assessment_modalities FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON assessment_plans      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON assessment_coaches    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auth_full ON assessment_students   FOR ALL TO authenticated USING (true) WITH CHECK (true);
;
