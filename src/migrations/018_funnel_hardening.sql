-- ---------------------------------------------------------------------------
-- Funnel Hardening (FNL-H2, FNL-H3, FNL-H4)
--
-- Additive schema changes required by:
--   FNL-H2 — object_edits + link_edit lineage (correlation/causation/action).
--   FNL-H3 — pipelineDeployCompleted signal type + run-trigger tracking.
--   FNL-H4 — replacement pipeline target_type generalization.
--
-- Every change is guarded with IF NOT EXISTS; re-running is a no-op.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- FNL-H2 — correlation / causation / action_rid on object_edits
-- ---------------------------------------------------------------------------

ALTER TABLE object_edits
    ADD COLUMN IF NOT EXISTS correlation_id UUID;

ALTER TABLE object_edits
    ADD COLUMN IF NOT EXISTS causation_id UUID;

ALTER TABLE object_edits
    ADD COLUMN IF NOT EXISTS action_rid TEXT;

CREATE INDEX IF NOT EXISTS idx_object_edits_correlation
    ON object_edits (correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_object_edits_action_rid
    ON object_edits (action_rid)
    WHERE action_rid IS NOT NULL;

-- link_edit parity (columns already added by 017; add causation here).
ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS causation_id_uuid UUID;

-- ---------------------------------------------------------------------------
-- FNL-H3 — pipelineDeployCompleted signal type + run tracking
-- ---------------------------------------------------------------------------

-- funnel_signal.signal_type is typically TEXT with a CHECK constraint rather
-- than a native enum; support both shapes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'funnel_signal_signal_type_check'
  ) THEN
    ALTER TABLE funnel_signal DROP CONSTRAINT funnel_signal_signal_type_check;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- NOT VALID so historical rows that used older signal type names are not
-- retroactively rejected; new inserts are still enforced.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'funnel_signal') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'funnel_signal_signal_type_check'
    ) THEN
      EXECUTE $SQL$
        ALTER TABLE funnel_signal
          ADD CONSTRAINT funnel_signal_signal_type_check
          CHECK (signal_type IN (
            'sourceTransactionCommitted',
            'schemaChanged',
            'manualRun',
            'pipelineDeployCompleted'
          )) NOT VALID
      $SQL$;
    END IF;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- funnel_run trigger provenance
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'funnel_run') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'funnel_run' AND column_name = 'triggered_by_pipeline_deployment_id'
    ) THEN
      ALTER TABLE funnel_run ADD COLUMN triggered_by_pipeline_deployment_id UUID;
      CREATE INDEX idx_funnel_run_triggered_by_pipeline
        ON funnel_run (triggered_by_pipeline_deployment_id)
        WHERE triggered_by_pipeline_deployment_id IS NOT NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'funnel_run' AND column_name = 'triggered_by_pipeline_id'
    ) THEN
      ALTER TABLE funnel_run ADD COLUMN triggered_by_pipeline_id UUID;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- FNL-H4 — replacement pipeline generalized to link types
--
-- The existing table is `object_type_active_index_version`. Rather than
-- renaming (which breaks running consumers on rolling deploys), we add a
-- compatibility `active_index_version` VIEW and a `target_type` column on
-- the physical table. Writers accept `target_type='link_type'` rows.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'replacement_target_type') THEN
    CREATE TYPE replacement_target_type AS ENUM ('object_type', 'link_type');
  END IF;
END $$;

ALTER TABLE object_type_active_index_version
    ADD COLUMN IF NOT EXISTS target_type replacement_target_type NOT NULL DEFAULT 'object_type';

ALTER TABLE object_type_active_index_version
    ADD COLUMN IF NOT EXISTS target_api_name TEXT;

-- Backfill target_api_name = object_type_api_name on first run. Safe to
-- repeat.
UPDATE object_type_active_index_version
   SET target_api_name = object_type_api_name
 WHERE target_api_name IS NULL;

ALTER TABLE object_type_active_index_version
    ALTER COLUMN target_api_name SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_otaiv_target
    ON object_type_active_index_version (target_type, target_api_name);

-- Alias view used by LT-F10 / FNL-H4 code paths.
CREATE OR REPLACE VIEW active_index_version AS
  SELECT *
    FROM object_type_active_index_version;

-- replacement_diff_log: carry target_type too so SRE dashboards can slice
ALTER TABLE replacement_diff_log
    ADD COLUMN IF NOT EXISTS target_type replacement_target_type NOT NULL DEFAULT 'object_type';

ALTER TABLE replacement_diff_log
    ADD COLUMN IF NOT EXISTS target_api_name TEXT;

UPDATE replacement_diff_log
   SET target_api_name = object_type_api_name
 WHERE target_api_name IS NULL;
