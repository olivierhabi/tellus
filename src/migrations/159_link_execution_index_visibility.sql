-- ---------------------------------------------------------------------------
-- 159 — Sticky index-visibility verdict per execution (monotonic VISIBLE).
--
-- PROBLEM: `probeExecutionIndexVisibility` (src/actions/linkIndexAckHttp.ts)
-- probes per event_id against the versioned serving table, which is
-- `ReplacingMergeTree(event_version)` keyed by (scope, source_pk, target_pk).
-- A LATER mutation that re-adds the same edge with a higher event_version
-- causes a background merge to collapse the OLDER event_id row; the probe
-- then flips VISIBLE → PENDING. 202 is terminal (idempotency replays it
-- verbatim forever), and statusUrl is the client's ONLY catch-up signal
-- — a non-monotonic flip violates the resolution contract.
--
-- FIX: persist the FIRST VISIBLE verdict for an execution durably in PG.
-- The verdict is monotonic: once a row exists it is VISIBLE forever (no
-- UPDATE, no DELETE, no downgrade). The probe consults this table BEFORE
-- live-probing; a present row short-circuits to VISIBLE; absence falls
-- through to a live probe. The probe writes the row only after a REAL
-- confirmEdgeIndexVisibility round returned confirmed=true for EVERY
-- staged event — never fabricated.
--
-- Keying: execution_id (uuid PK) — per-execution, no cross-tenant bleed.
-- The table only grows (INSERT-only, ON CONFLICT DO NOTHING); a missing
-- row means "not yet confirmed" and the live probe runs as before.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS link_execution_index_visibility (
  execution_id  uuid        PRIMARY KEY,
  confirmed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE link_execution_index_visibility IS
  'Monotonic sticky verdict: presence of a row means the execution''s link events were confirmed visible in the serving index. probeExecutionIndexVisibility consults this before live-probing; INSERT-only — never downgraded.';
