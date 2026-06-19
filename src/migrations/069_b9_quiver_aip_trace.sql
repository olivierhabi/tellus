-- Quiver B9 — AIP reasoning trace persistence.
-- Each Generate/Configure/Assist call writes exactly one row.
CREATE TABLE IF NOT EXISTS quiver_aip_trace (
  rid              TEXT PRIMARY KEY,
  analysis_rid     TEXT NOT NULL,
  user_rid         TEXT NOT NULL,
  surface          TEXT NOT NULL CHECK (surface IN ('GENERATE', 'CONFIGURE', 'ASSIST')),
  prompt_sha256    TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  trace_blob_uri   TEXT,
  tool_invocations JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_tokens     INTEGER,
  cost_usd_micros  BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quiver_aip_trace_by_analysis
  ON quiver_aip_trace (analysis_rid, created_at DESC);

CREATE INDEX IF NOT EXISTS quiver_aip_trace_by_user
  ON quiver_aip_trace (user_rid, created_at DESC);
