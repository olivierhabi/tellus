-- Quiver B3 — instruction log (T-10).
-- Append-only, monotonic per analysis. Per spec §B3 data model.
-- D-40: PRIMARY KEY (rid, seq) preserves insertion order; client_op_id is
-- unique-per-(rid, applied_by) so duplicate submissions are idempotent.

CREATE TABLE IF NOT EXISTS quiver_instruction_log (
  rid               TEXT NOT NULL,
  seq               BIGINT NOT NULL,
  instruction       JSONB NOT NULL,
  applied_by        TEXT NOT NULL,
  applied_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  client_op_id      TEXT NOT NULL,
  branch            TEXT NOT NULL DEFAULT 'trunk',
  PRIMARY KEY (rid, seq)
);

-- One row per logical operation per actor — enforces dedup at the
-- database layer (D-40). The same client may resubmit the same op_id;
-- the second insert raises 23505 and the route returns the original ack.
CREATE UNIQUE INDEX IF NOT EXISTS quiver_instruction_log_dedup
  ON quiver_instruction_log (rid, applied_by, client_op_id);

CREATE INDEX IF NOT EXISTS quiver_instruction_log_by_user
  ON quiver_instruction_log (applied_by);

CREATE INDEX IF NOT EXISTS quiver_instruction_log_by_rid_seq
  ON quiver_instruction_log (rid, seq DESC);
