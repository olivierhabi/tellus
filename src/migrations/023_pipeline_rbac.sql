-- ---------------------------------------------------------------------------
-- Task PB-B7 — RBAC + Marking propagation.
--
-- pipeline_acl        per-pipeline Owner/Editor/Viewer grants. Falls
--                     back to project_members when no row matches the
--                     (pipeline_id, principal_id, principal_type) tuple.
-- foundry_datasets.markings
--                     marking codes present on the dataset. Union'd at
--                     deploy time into pipelines.input_markings and
--                     stamped on the output dataset.
-- pipelines.input_markings
--                     materialised union from the last deploy (audit).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_acl (
    pipeline_id     UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    principal_id    UUID        NOT NULL,
    principal_type  TEXT        NOT NULL CHECK (principal_type IN ('user', 'group')),
    role            TEXT        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    granted_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pipeline_id, principal_id, principal_type)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_acl_principal
    ON pipeline_acl (principal_id, principal_type);

ALTER TABLE foundry_datasets
    ADD COLUMN IF NOT EXISTS markings TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS input_markings TEXT[] NOT NULL DEFAULT '{}'::text[];

-- Backfill existing pipelines' creators as owners so deploys from the
-- pre-RBAC world keep working under RBAC_ENABLED=true.
INSERT INTO pipeline_acl (pipeline_id, principal_id, principal_type, role, granted_by)
SELECT p.id, p.created_by, 'user', 'owner', p.created_by
  FROM pipelines p
 WHERE p.created_by IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM pipeline_acl a
      WHERE a.pipeline_id = p.id
        AND a.principal_id = p.created_by
        AND a.principal_type = 'user'
   );
