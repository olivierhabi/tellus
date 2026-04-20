-- ---------------------------------------------------------------------------
-- Migration 031 — PB-B4 literal: output_snapshot_id NOT NULL invariant on
-- succeeded Iceberg deploys + PB-B1 idempotency_key deprecation lift.
--
-- PB-B4 spec literal: "`pipeline_deployments.output_snapshot_id BIGINT NOT
-- NULL` records the produced snapshot". We can't flip the column itself
-- to NOT NULL blindly because pre-PB-B4 rows (csv/parquet deploys) never
-- carry one, and running/failed/cancelled deploys never record one by
-- design. The actual invariant: any row with status='succeeded' AND
-- pipelines.output_format='iceberg' MUST carry a snapshot id. Postgres
-- CHECK constraints can't subquery another table, so we use a trigger.
--
-- PB-B1 spec literal: "idempotency_key is TEXT NOT NULL UNIQUE with a
-- partial-unique-index to allow nulls during the deprecation window".
-- Lift the deprecation here: back-fill legacy NULLs with a synthetic
-- fingerprint, then a BEFORE INSERT trigger rejects new NULLs without
-- breaking the nullable column (so a rollback of this migration is clean).
-- ---------------------------------------------------------------------------

-- 1. output_snapshot_id invariant ------------------------------------------

CREATE OR REPLACE FUNCTION pipeline_deployments_check_snapshot_invariant()
RETURNS TRIGGER AS $$
DECLARE
  fmt TEXT;
BEGIN
  IF NEW.status = 'succeeded' AND NEW.output_snapshot_id IS NULL THEN
    SELECT p.output_format INTO fmt
      FROM pipelines p
     WHERE p.id = NEW.pipeline_id;
    IF fmt = 'iceberg' THEN
      RAISE EXCEPTION
        'PB-B4 invariant: pipeline_deployments.output_snapshot_id must be set when status=succeeded AND pipelines.output_format=iceberg (deployment_id=%)',
        NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pipeline_deployments_snapshot_invariant
  ON pipeline_deployments;

CREATE TRIGGER trg_pipeline_deployments_snapshot_invariant
  BEFORE INSERT OR UPDATE OF status, output_snapshot_id ON pipeline_deployments
  FOR EACH ROW
  EXECUTE FUNCTION pipeline_deployments_check_snapshot_invariant();

-- 2. idempotency_key deprecation lift --------------------------------------

-- Back-fill remaining NULLs so new inserts are guaranteed to carry a key.
UPDATE pipeline_deployments
   SET idempotency_key = 'legacy-' || id::text
 WHERE idempotency_key IS NULL;

CREATE OR REPLACE FUNCTION pipeline_deployments_require_idempotency_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.idempotency_key IS NULL THEN
    RAISE EXCEPTION
      'pipeline_deployments.idempotency_key is required (PB-B1 deprecation window closed in migration 031)'
      USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pipeline_deployments_require_idempotency_key
  ON pipeline_deployments;

CREATE TRIGGER trg_pipeline_deployments_require_idempotency_key
  BEFORE INSERT ON pipeline_deployments
  FOR EACH ROW
  EXECUTE FUNCTION pipeline_deployments_require_idempotency_key();
