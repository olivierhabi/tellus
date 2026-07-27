-- ===========================================================================
-- 121_transform_incremental_state.sql
--
-- Phase 4 — Real incremental state tracking for Python transforms.
--
-- Spec source of truth:
--   https://www.palantir.com/docs/foundry/transforms-python/incremental-overview/
--   https://www.palantir.com/docs/foundry/transforms-python/incremental-usage/
--
-- Before this change the existing Tellus transform_build pipeline computed
-- is_incremental as a one-shot boolean per build from the existence of a prior
-- committed output transaction (buildService.ts), and the @incremental Python
-- decorator was metadata-only (pythonRuntime.ts:437). This fell short of
-- Palantir's @incremental semantics in three ways:
--
--   1. Per-transform identity: Palantir records the transform's code/version
--      identity and the previous successful run's input transactions so the
--      next build can decide SAFE-incremental vs SNAPSHOT-recompute (semantic
--      version bump, snapshot-input list, etc.) WITHOUT exhausting the
--      output's history.
--   2. Per-input read modes: Palantir's mode="added" / "current" / "previous"
--      demands the build know WHICH input file (the prior-build view or the
--      newly-replaced view) to feed into each input binding — keyed by the
--      input RID (the build-branch-agnostic identity) AND a "last consumed
--      transaction id" pointer.
--   3. Real abort-vs-fail semantics (Phase 6): a successful abort leaves the
--      last committed transaction untouched; the incremental state table
--      tracks "last committed output transaction" so an aborted build does
--      NOT advance the high-water mark — the next build reprocesses the same
--      uncommitted input changes.
--
-- This migration introduces a single persistent state row per
-- (transform_identity, repository_rid, branch, output_dataset_id) quad. The
-- transform_identity is an opaque hash the build service computes from the
-- transform's source file path + entry-point function (chronologically tied
-- to the code version via the commit_sha the transform was discovered at) —
-- distinct identities land in distinct rows, which means a refactored rename
-- starts a fresh incremental history (matches Palantir's TLLV behavior where
-- the transform's identity includes the module + dependency graph).
--
-- Search key: (transform_identity, repository_rid, branch, output_dataset_id)
--   → at most one row, with the snapshot_inputs + semantic_version + last
--   consumed input transactions + last committed output transaction.
--
-- Repeatable + idempotent: uses CREATE TABLE IF NOT EXISTS, ADD COLUMN IF
-- NOT EXISTS, DROP INDEX / CREATE INDEX IF NOT EXISTS (matches the style of
-- the existing migration 120 + the inline ALTERs in src/migrate.ts).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. transform_incremental_state — the persistent per-(transform, output)
--    state row. The build service upserts here at scheduling time and updates
--    after a scheduled successful build (or leaves the row unchanged for an
--    aborted build, per spec §6 / "never allow only a subset of outputs to
--    abort").
--
-- Keyed by (transform_identity, repository_rid, branch, output_dataset_id)
-- which is unique UI-wide; the partial unique index below enforces that.
-- `output_dataset_id` is the dataset.dataset_id for the resolved output RID
-- (resolves catalog paths to canonical RID via the Phase 3 resolver; the
-- dataset.dataset_id is the FK target and is itself branch-independent).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transform_incremental_state (
  state_id                  BIGSERIAL PRIMARY KEY,
  -- The transform's stable identity: a SHA-256 hash of (source_path +
  -- entry_point). Set at buildService.ts scheduling time from the discovered
  -- DiscoveredTransform. Two transforms with identical identity: the
  -- migration's partial unique index below rejects duplicates per
  -- (repository_rid, branch, output_dataset_id) — i.e. an output dataset is
  -- produced by EXACTLY ONE transform on a given branch (and a renamed
  -- transform gets a fresh state row, mirroring TLLV under renaming).
  transform_identity        TEXT NOT NULL,
  repository_rid            TEXT NOT NULL,
  branch                    TEXT NOT NULL,
  -- The output dataset the transform writes (dataset.dataset_id; resolved
  -- from the discovered output_rid through the Phase 3 catalog resolver).
  -- Multiple outputs from a multi-output @transform.using are stored as ONE
  -- row per output (the unique index below is on the (transform_identity,
  -- repo, branch, output_dataset_id) quad so each output gets its own row).
  output_dataset_id         UUID NOT NULL REFERENCES dataset(dataset_id) ON DELETE CASCADE,

  -- The transform's entry-point function name + source path snapshot at the
  -- last successful build — for diagnostics, NOT a key (transform_identity
  -- is the key). Updated on each upsert.
  entry_point               TEXT NOT NULL,
  source_path               TEXT NOT NULL,

  -- Persisted incremental configuration parse-out from the @incremental(...)
  -- decorator. NULL when the transform has no @incremental decorator (the
  -- build service treats a NULL row as a non-incremental transform: every
  -- build is a SNAPSHOT, is_incremental = false).
  require_incremental       BOOLEAN NOT NULL DEFAULT false,
  semantic_version          INTEGER NOT NULL DEFAULT 1,
  snapshot_inputs           JSONB   NOT NULL DEFAULT '[]'::jsonb,  -- array of binding names (Phase 5)
  allow_retention           BOOLEAN NOT NULL DEFAULT false,
  strict_append             BOOLEAN NOT NULL DEFAULT false,
  v2_semantics              BOOLEAN NOT NULL DEFAULT false,

  -- The semantic_version persisted on the LAST committed build. When the
  -- build service notices current_semantic_version <> last_semantic_version,
  -- the next build runs NON-incrementally (per Palantir spec §4
  -- "semantic_version"). After that snapshot build commits, the
  -- last_semantic_version is bumped up to match.
  last_semantic_version     INTEGER NOT NULL DEFAULT 1,

  -- The last build_rid + status snapshot for diagnostics + Palantir's
  -- "next build reads previous-state provenance" requirement. The
  -- last_build_status 'aborted' case leaves the rest of this row unchanged
  -- (the abort commits nothing — per spec §6), unlike 'committed' which
  -- advances last_committed_output_transaction_id + last_consumed_*.
  last_build_rid            TEXT,
  last_build_status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (last_build_status IN ('pending','running','committed','aborted','failed')),

  -- The high-water mark: the dataset_transaction.transaction_id (UUID) the
  -- last COMMITTED build read from each input dataset. Captured at
  -- pre-execute time into input_transaction_state; advanced to the latest
  -- seen transaction only AFTER a successful commit. On an abort this map
  -- remains the pre-build pointer so the next build reprocesses the same
  -- uncommitted input changes.
  --
  -- JSONB shape: { "<input_dataset_id>": "<consumed_transaction_id>" }.
  -- (resolved Dataset IDs are used as keys — Phase 3 ensures catalog paths
  -- are pre-resolved, so the Java/TS build service can hash by canonical ID.)
  input_transaction_state  JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The output's last committed dataset_transaction.transaction_id (UUID)
  -- assigned by datasetStore.materializeOutput on the prior successful build.
  -- Used by Output.pandas(mode='previous') reads at runtime + by is_incremental
  -- existence checks (buildService.ts).
  last_committed_output_transaction_id UUID,

  -- Code-version snapshot — the commit_sha the last-committed build ran
  -- against (for TLLV-style staleness checks on the next build). When
  -- the build service schedules a new build, it reads the discovered
  -- transforms' commit_sha; if it differs from last_commit_sha the build
  -- is performed but the post-commit upsert advances this column.
  last_commit_sha           TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Per-(transform+output+branch) uniqueness — a transform's identity maps
  -- to exactly ONE incremental state row on a given (repo, branch). A
  -- renamed transform (different source_path / entry_point hash) lands in a
  -- distinct row → its first build is a non-incremental snapshot (matches
  -- Palantir's "convert existing transform → reset incremental state to 1"
  -- behavior).
  CONSTRAINT transform_incremental_state_unique UNIQUE
    (transform_identity, repository_rid, branch, output_dataset_id)
);

-- Lookups:
--   by (repo, branch, output_dataset_id) — materializeOutput completing a
--   build locates the state row to upsert.
CREATE INDEX IF NOT EXISTS transform_incremental_state_output_idx
  ON transform_incremental_state (repository_rid, branch, output_dataset_id);
--   by (repo, branch, transform_identity) — scheduling reads the prior row
--   for a given discovered transform.
CREATE INDEX IF NOT EXISTS transform_incremental_state_identity_idx
  ON transform_incremental_state (repository_rid, branch, transform_identity);

-- Ensure the shared set_updated_at() trigger function exists BEFORE the
-- trigger below references it. Some DBs (fresh installs, or those that
-- never ran the add-repo migration that originally defined it) don't have
-- this function yet — the CREATE TRIGGER would fail with
-- "function set_updated_at() does not exist". Defensive idempotent
-- create-if-not-exists, run first.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE FUNCTION set_updated_at() RETURNS trigger AS $f$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql;
  END IF;
END $$;

-- updated_at trigger: keep the row's updated_at column in sync with the
-- latest upsert. Idempotent drop+create so re-running the migration is safe.
DROP TRIGGER IF EXISTS transform_incremental_state_updated_at_trg
  ON transform_incremental_state;
CREATE TRIGGER transform_incremental_state_updated_at_trg
  BEFORE UPDATE ON transform_incremental_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Down migration (manual application; see 121_transform_incremental_state.down.sql):
--   DROP TABLE IF EXISTS transform_incremental_state;
-- ===========================================================================
