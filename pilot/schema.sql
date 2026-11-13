-- Isolated prototype schema. Never apply to either production Supabase project.
CREATE SCHEMA IF NOT EXISTS eon_pilot;

CREATE TABLE IF NOT EXISTS eon_pilot.imports (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  snapshot_sha256 text NOT NULL,
  manifest_sha256 text NOT NULL,
  store_sha256 text,
  projection_sha256 text,
  projection_version integer,
  as_of date NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL,
  decisions jsonb NOT NULL,
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(decisions) = 'array')
);

-- Earlier rehearsal imports remain immutable, with unknown projection version.
-- A new projector output creates a new import instead of rewriting their rows.
ALTER TABLE eon_pilot.imports ADD COLUMN IF NOT EXISTS projection_sha256 text;
ALTER TABLE eon_pilot.imports ADD COLUMN IF NOT EXISTS projection_version integer;
ALTER TABLE eon_pilot.imports ADD COLUMN IF NOT EXISTS store_sha256 text;

-- Stable mapping survives subsequent snapshots; a source may never silently move
-- to another person. A different reconciliation requires an explicit migration.
CREATE TABLE IF NOT EXISTS eon_pilot.identities (
  system text NOT NULL CHECK (system IN ('store', 'hub')),
  kind text NOT NULL CHECK (kind IN ('customer', 'athlete')),
  source_id text NOT NULL,
  person_id uuid NOT NULL,
  PRIMARY KEY (system, kind, source_id)
);

CREATE TABLE IF NOT EXISTS eon_pilot.people (
  import_id text NOT NULL REFERENCES eon_pilot.imports(id),
  id uuid NOT NULL,
  name text NOT NULL,
  search_name text NOT NULL,
  category text NOT NULL CHECK (category IN ('commercial','team','partner','historical','review')),
  sports_status text CHECK (sports_status IN ('active','on_leave','cancelled')),
  active_student boolean NOT NULL,
  needs_athlete_profile boolean NOT NULL,
  display jsonb NOT NULL CHECK (jsonb_typeof(display) = 'object'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  PRIMARY KEY (import_id, id),
  CHECK (NOT active_student OR category = 'commercial')
);
CREATE INDEX IF NOT EXISTS people_category_idx ON eon_pilot.people(import_id, category);
CREATE INDEX IF NOT EXISTS people_status_idx ON eon_pilot.people(import_id, sports_status);

CREATE TABLE IF NOT EXISTS eon_pilot.source_links (
  import_id text NOT NULL,
  person_id uuid NOT NULL,
  system text NOT NULL,
  kind text NOT NULL,
  source_id text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('primary','alias')),
  source_name text,
  PRIMARY KEY (import_id, system, kind, source_id),
  FOREIGN KEY (import_id, person_id) REFERENCES eon_pilot.people(import_id,id),
  FOREIGN KEY (system,kind,source_id) REFERENCES eon_pilot.identities(system,kind,source_id)
);

CREATE TABLE IF NOT EXISTS eon_pilot.person_roles (
  import_id text NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('athlete','coach')),
  PRIMARY KEY (import_id,person_id,role),
  FOREIGN KEY (import_id, person_id) REFERENCES eon_pilot.people(import_id,id)
);

CREATE TABLE IF NOT EXISTS eon_pilot.memberships (
  import_id text NOT NULL,
  person_id uuid NOT NULL,
  ordinal integer NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (import_id,person_id,ordinal),
  FOREIGN KEY (import_id, person_id) REFERENCES eon_pilot.people(import_id,id)
);

CREATE TABLE IF NOT EXISTS eon_pilot.current_import (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  import_id text NOT NULL REFERENCES eon_pilot.imports(id)
);

-- The API must use this separate role. It cannot mutate any pilot or public data.
REVOKE ALL ON SCHEMA eon_pilot FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA eon_pilot FROM PUBLIC;
GRANT USAGE ON SCHEMA eon_pilot TO eon_pilot_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA eon_pilot FROM eon_pilot_reader;
GRANT SELECT (id,as_of,summary) ON eon_pilot.imports TO eon_pilot_reader;
GRANT SELECT (import_id,id,name,search_name,category,sports_status,active_student,needs_athlete_profile,display)
  ON eon_pilot.people TO eon_pilot_reader;
GRANT SELECT ON eon_pilot.current_import TO eon_pilot_reader;
