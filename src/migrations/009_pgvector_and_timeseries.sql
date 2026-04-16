-- ---------------------------------------------------------------------------
-- 009 — pgvector + TimescaleDB extensions for ontology vector & time-series
-- properties.
--
-- Spec equivalents:
--   • Vector properties (#12): up to 2048-d float arrays for KNN search.
--   • Time series properties (#13): (timestamp, value) pairs with history.
--
-- Both extensions are no-ops if not installed in the running Postgres image
-- (e.g. the plain `postgres:16-alpine`). Use the `pgvector/pgvector:pg16`
-- or `timescale/timescaledb-ha:pg16` image to get them. The migration
-- swallows extension-not-available errors so it remains idempotent across
-- environments.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector extension not available — vector property storage will fall back to JSONB';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector install skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  ELSE
    RAISE NOTICE 'timescaledb extension not available — time-series properties will use a plain table';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb install skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- vector_property_value
-- One row per (object_type, primary_key, property_api_name) — value is a
-- 1536-d vector by default. The dimension can be lifted to 2048 (the spec
-- max) by altering the column when an extension supports it; we ship 1536
-- as a safe default that matches OpenAI ada-002 and Anthropic Voyage 3.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vector_property_value (
  object_type_api_name   text NOT NULL,
  property_api_name      text NOT NULL,
  primary_key_value      text NOT NULL,
  embedding              jsonb NOT NULL,  -- pgvector type swap-in below
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type_api_name, property_api_name, primary_key_value)
);

-- Hot-swap the column type when pgvector is loaded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      ALTER TABLE vector_property_value
        ALTER COLUMN embedding TYPE vector(1536) USING NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'vector column promote skipped: %', SQLERRM;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- time_series_property_value
-- One row per sample. Promoted to a TimescaleDB hypertable when the
-- extension is loaded so range scans can use chunk pruning.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_series_property_value (
  object_type_api_name   text NOT NULL,
  property_api_name      text NOT NULL,
  primary_key_value      text NOT NULL,
  ts                     timestamptz NOT NULL,
  value_double           double precision,
  value_string           text
);

CREATE INDEX IF NOT EXISTS time_series_property_value_lookup_idx
  ON time_series_property_value (object_type_api_name, property_api_name, primary_key_value, ts DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      PERFORM create_hypertable('time_series_property_value', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'create_hypertable skipped: %', SQLERRM;
    END;
  END IF;
END $$;
