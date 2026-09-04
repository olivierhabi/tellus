-- Foundry parity — Datasets v2 storage model for foundry_datasets:
-- every build commits a transaction (SNAPSHOT/APPEND/UPDATE) on a branch,
-- and every dataset has a default `master` branch.
--
-- Doc: "A default branch - `master` for most enrollments - will be created
-- on the Dataset." (Datasets v2 • Create Dataset)
-- Errors implemented against this table: TransactionNotFound (404),
-- BranchAlreadyExists (409 CONFLICT).

CREATE TABLE IF NOT EXISTS foundry_dataset_branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id  UUID NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, branch_name)
);

-- Every existing dataset gains its default `master` branch.
INSERT INTO foundry_dataset_branches (dataset_id, branch_name, is_default)
SELECT id, 'master', true FROM foundry_datasets
ON CONFLICT (dataset_id, branch_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS foundry_dataset_transactions (
  transaction_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id       UUID NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
  branch_name      TEXT NOT NULL DEFAULT 'master',
  transaction_type TEXT NOT NULL
                   CHECK (transaction_type IN ('SNAPSHOT', 'APPEND', 'UPDATE')),
  status           TEXT NOT NULL DEFAULT 'committed'
                   CHECK (status IN ('open', 'committed', 'aborted')),
  -- The build that produced this transaction (Datasets v2 ties jobs/builds
  -- to transactions).
  deployment_id    UUID,
  file_path        TEXT,
  file_size_bytes  BIGINT,
  row_count        BIGINT,
  column_count     INTEGER,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at     TIMESTAMPTZ
);

-- Branch transaction history, ordered newest first (Datasets v2
-- List Transactions / Get Branch Transaction History shape).
CREATE INDEX IF NOT EXISTS idx_fdt_dataset_branch_committed
  ON foundry_dataset_transactions (dataset_id, branch_name, committed_at DESC NULLS LAST)
  WHERE status = 'committed';
CREATE INDEX IF NOT EXISTS idx_fdt_dataset
  ON foundry_dataset_transactions (dataset_id);

-- Referential tie between a branch row and the transactions claiming it:
-- enforce at insert time by the writer (no FK over composite natural keys);
-- the UNIQUE constraint above + BranchAlreadyExists make branching explicit.
