-- Workshop B03 — module versioning + publish.
-- Spec: tasks/workshop/workshop-tasks.md §B03.
-- Decisions: D-04 (in-process resolve cache via Postgres LISTEN/NOTIFY for
-- now; Redis swap is one method change away).
--
-- workshop_module_version is APPEND-ONLY. Once a (rid, semver) row is
-- written it is never updated or deleted. Republishing an older semver
-- creates a new row with a fresh `published_at` so audit can reconstruct
-- the rollback timeline (and `published_semver` on workshop_module flips
-- to the older tag).

CREATE TABLE IF NOT EXISTS workshop_module_version (
  rid               TEXT        NOT NULL,
  semver            TEXT        NOT NULL,
  schema_version    INT         NOT NULL,
  -- Frozen JSON definition at publish time.
  definition        JSONB       NOT NULL,
  -- Compiled artifact (varGraph + widgetTree) computed by B02 at publish
  -- time. Snapshotting this means readers don't have to recompile per
  -- read, and protects against B02 evolving its compiled shape later.
  compiled          JSONB       NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by      TEXT        NOT NULL,
  -- Each version row is keyed by `(rid, semver, published_at)` because the
  -- spec allows republishing an older semver (rollback). The PK is on
  -- (rid, published_at) which is naturally unique per row; (rid, semver)
  -- is NOT a primary key because rollback creates a new row with the same
  -- (rid, semver) pair but a later published_at.
  PRIMARY KEY (rid, published_at)
);

CREATE INDEX IF NOT EXISTS idx_workshop_module_version_rid
  ON workshop_module_version(rid, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_workshop_module_version_semver
  ON workshop_module_version(rid, semver, published_at DESC);

-- Add `published_semver` to workshop_module so resolve/latest is a single
-- index lookup. This column is updated by the publish RPC under the same
-- transaction that inserts the version row.
ALTER TABLE workshop_module
  ADD COLUMN IF NOT EXISTS published_semver TEXT,
  ADD COLUMN IF NOT EXISTS published_at     TIMESTAMPTZ;
