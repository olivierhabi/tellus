-- ---------------------------------------------------------------------------
-- 009 — TimescaleDB extension for ontology time-series properties.
--
-- Spec equivalent:
--   • Time series properties (#13): (timestamp, value) pairs with history.
--
-- The extension is a no-op if not installed in the running Postgres image
-- (e.g. the plain `postgres:16-alpine`). Use the
-- `timescale/timescaledb-ha:pg16` image to get it. The migration
-- swallows extension-not-available errors so it remains idempotent across
-- environments.
-- ---------------------------------------------------------------------------

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
