# ADR — Quiver B4: Versioning + Working-State Autosave

- **Status**: Accepted
- **Date**: 2026-05-04
- **Task**: T-03 (B4)
- **Spec**: `tasks/quiver/quiver-tasks.md` §B4; contracts `tasks/quiver/contracts.md` §B4 C-01..C-14

## Context

B4 implements two persistence concerns layered on top of B1's analysis storage:

1. **Immutable named/auto saves** (`quiver_analysis_version`) — monotonic
   `version` per `(rid, branch)`; named saves require a non-empty
   `message`; revert allocates a new version and rewrites the live
   document.
2. **Ephemeral per-user working state** (`quiver_working_state`) —
   24-hour TTL keyed by a 10-char base36 URL fragment.

## Decisions

- **TTL via `expires_at` column + sweeper function**, not Cassandra-style
  row TTL. Postgres has no native row TTL; a `quiver_purge_expired_working_states()`
  function plus an admin POST endpoint (`/_admin/purge-working-states`) replaces
  the spec's "weekly Cassandra TTL job." External cron triggers the purge.
- **Branch scoping is mandatory** on every read/write of versions and
  working states. Same `(rid, stateId)` on different branches isolates
  state — see B4 C-14 integration test.
- **State ID generation**: 64 bits of crypto-random → base36, padded/truncated
  to 10 chars. Insert retries up to 5 times on PK collision; collision
  probability is ~2⁻²² for 10⁻⁵ writes/sec, well below "any practical lifetime."
- **Save semantics**: a save snapshots `(cards, canvases, parameters,
  notebookMetadata)`. The analysis row's `etag` is **not** invalidated by
  a save (it tracks metadata only); revert mutates the analysis row and
  *does* bump the etag.
- **Diff utility**: minimal RFC 6902 emitter — JSON Patch ops for object
  keys, single `replace` op for arrays (no element-wise identity tracking).
  Stable & symmetric (added/removed swap on argument flip).
- **Revert is non-destructive**: it allocates a new version row referencing
  the restored snapshot via `parent_version`; no history is lost.
- **Audit**: emits `QUIVER_ANALYSIS_VERSION_SAVED` and `QUIVER_ANALYSIS_REVERTED`
  through the existing `emitQuiverAudit` indirection (G-10).

## Consequences

- The `:revert` URL suffix uses Express's escaped colon
  (`/versions/:version\\:revert`); no other route in the tree uses
  `:action` syntax — documented in the runbook so future contributors
  recognize the pattern.
- The TTL purge is triggered externally; in production we'll wire it
  to a cluster-cron health-check on the API itself. The metric
  `tellus_quiver_working_state_ttl_purges_total` exposes purge counts
  to alerting.
- A future "Phase 2 sweeper" task can graduate the `_admin` endpoint
  to an internal scheduler (out of scope for B4).

## Decisions Logged

- D-2026-05-04 D-20: TTL via column + sweeper (vs. Postgres extension);
  rationale: zero new dependencies.
- D-2026-05-04 D-21: revert allocates a new version (vs. truncating
  later versions); rationale: auditability and reversibility.
- D-2026-05-04 D-22: state-ID retry limit = 5; rationale: collision
  rate is negligible; failing fast is better than infinite retry.

## Verification

`scripts/quiver-verify.sh` exits 0 with **162 tests / 21 files** after
B4 lands. All 14 B4 contracts referenced; SLO bounds (1 s save / 500 ms
revert) measured under integration load.
