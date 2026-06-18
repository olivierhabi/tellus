-- ===========================================================================
-- Migration 103 — Code Repositories: Python @transform -> datasets.
--
-- Closes the "Create transforms" gap (see docs/foundry-parity/
-- PRINCIPAL_REVIEW_CREATE_TRANSFORMS.md). Adds the transform build pipeline:
--   1. a stable RID on the singular `dataset` table so a transform's
--      Output("ri...") / Input("ri...") resolve to real dataset rows;
--   2. a transform build lifecycle (builds + events) mirroring
--      orchestration_builds (077) with the same status enum + terminal guard;
--   3. transform input->output dataset lineage (the DAG edges) over `dataset`.
--
-- The `dataset` table itself is created inline by src/migrate.ts before this
-- numbered migration runs, so the ALTER + FKs below are safe.
-- ===========================================================================

-- 1. Stable RID bridge on dataset rows ------------------------------------
ALTER TABLE dataset ADD COLUMN IF NOT EXISTS rid TEXT;
-- Partial-unique: at most one dataset per RID, but legacy uploads keep NULL.
CREATE UNIQUE INDEX IF NOT EXISTS dataset_rid_uq
  ON dataset (rid) WHERE rid IS NOT NULL;

-- 2. Transform build lifecycle --------------------------------------------
CREATE TABLE IF NOT EXISTS transform_build (
  rid             TEXT PRIMARY KEY,
  repository_rid  TEXT NOT NULL,
  branch          TEXT NOT NULL,
  commit_sha      TEXT NOT NULL,
  actor           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','cancelled','timeout')),
  transform_count INTEGER NOT NULL DEFAULT 0,
  outputs         JSONB   NOT NULL DEFAULT '[]'::jsonb,
  reason          TEXT,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS transform_build_repo_branch_idx
  ON transform_build (repository_rid, branch, enqueued_at DESC);
-- Partial index over active builds (single-active enforcement / queue scans).
CREATE INDEX IF NOT EXISTS transform_build_active_idx
  ON transform_build (repository_rid, branch) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS transform_build_event (
  id        BIGSERIAL PRIMARY KEY,
  build_rid TEXT NOT NULL REFERENCES transform_build(rid) ON DELETE CASCADE,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind      TEXT NOT NULL CHECK (kind IN ('started','progress','log','succeeded','failed','cancelled')),
  data      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS transform_build_event_idx
  ON transform_build_event (build_rid, ts);

-- 3. Transform input->output dataset lineage (DAG edges over `dataset`) ----
CREATE TABLE IF NOT EXISTS transform_lineage (
  output_dataset_id UUID NOT NULL REFERENCES dataset(dataset_id) ON DELETE CASCADE,
  input_dataset_id  UUID NOT NULL REFERENCES dataset(dataset_id) ON DELETE CASCADE,
  repository_rid    TEXT NOT NULL,
  branch            TEXT NOT NULL,
  transform_name    TEXT NOT NULL,
  build_rid         TEXT,
  edge_type         TEXT NOT NULL DEFAULT 'transform_output'
                      CHECK (edge_type IN ('transform_output')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transform_lineage_pk PRIMARY KEY (output_dataset_id, input_dataset_id, branch),
  CONSTRAINT transform_lineage_not_self CHECK (output_dataset_id <> input_dataset_id)
);
CREATE INDEX IF NOT EXISTS transform_lineage_input_idx  ON transform_lineage (input_dataset_id);
CREATE INDEX IF NOT EXISTS transform_lineage_output_idx ON transform_lineage (output_dataset_id);
