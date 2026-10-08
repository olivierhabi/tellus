-- 195_merge_staging_instances.sql
--
-- Per-run staging area for the merge PG tail. The tail loads the merged
-- result here (batched, idempotent per object type), runs count + distinct
-- + null/empty + sample checks, and only then promotes into the live
-- object_instances inside ONE transaction. A failed run leaves the live
-- table unchanged; the staging rows are dropped on success (or kept for
-- forensics when the versioned config retains them on failure).

CREATE TABLE IF NOT EXISTS merge_staging_instances (
  staging_run_id uuid NOT NULL,
  ontology_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  object_type_api_name text NOT NULL,
  primary_key text NOT NULL,
  operation text NOT NULL DEFAULT 'upsert',
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  markings text[] NOT NULL DEFAULT '{}'::text[],
  source_datasource_id uuid,
  source_transaction_id uuid,
  staged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merge_staging_instances_pk
    PRIMARY KEY (staging_run_id, ontology_id, branch_id, object_type_api_name, primary_key)
);

CREATE INDEX IF NOT EXISTS idx_merge_staging_instances_owner
  ON merge_staging_instances(ontology_id, object_type_api_name, staging_run_id);
