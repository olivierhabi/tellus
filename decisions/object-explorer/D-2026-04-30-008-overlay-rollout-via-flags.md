# D-2026-04-30-008 — Overlay branch-key migration as a 4-phase env-flag rollout

## Status
Accepted.

## Ambiguity

T-04 demands branch-aware overlay isolation. Strict interpretation: rename
the keyspace from `overlay:<ot>:<pk>` to `overlay:<branch>:<ot>:<pk>` and
require all writes/reads to carry a `branchId`. But the existing keyspace
is in production with live records and a 180s TTL. A flag-day cutover would
either (a) drop in-flight overlays at deploy time, breaking the 1-second
edit-visibility SLO during the rollout window, or (b) require draining the
overlay (stop writes, wait for TTL), which is a 3-minute service-degraded
window.

## Options considered

1. **Flag-day cutover.** Cleanest end-state. Worst observability during
   transition. Violates the "preserves auditability and reversibility"
   priority in the Decision Protocol.
2. **Add `branchId` field, keep one keyspace, post-filter on read.** Cheap
   to ship; inconsistent with the spec (a SCAN over `overlay:Orders:*`
   in mid-rollout would mix branches at the storage layer); cannot revert
   per-branch independently.
3. **Two-keyspace dual-write rollout** (chosen). New keyspace for
   branch-aware writes/reads; legacy keyspace retained for a TTL window
   so existing overlays remain visible to `_main` reads; phases gated by
   env flags so the rollout can be paused or reverted at any phase.

## Chosen option

Option 3 — phased rollout via two env flags:

| Phase | OVERLAY_DUAL_WRITE | OVERLAY_READ_LEGACY | Behaviour                                                                  |
|-------|--------------------|---------------------|----------------------------------------------------------------------------|
| 0     | true               | true                | Writes to both keyspaces (only for `_main`); reads new key, falls back to legacy on `_main`. Branch writes go ONLY to new keyspace. |
| 1     | true               | true                | Same as Phase 0 — bake window for the legacy-fallback path.                |
| 2     | false              | true                | Writes only to new key; reads still tolerate legacy on `_main`. Bake the “only new keyspace populates” invariant. |
| 3     | false              | false               | Final state. Legacy keys neither written nor read. Their TTL expires them. |

The flags are read on every call, so flipping them is a runtime config change;
no redeploy needed. Defaults are `true` (Phase 0–1) so a fresh deploy lands
in the safe state.

## Rationale

- **Production safety**: at every phase, every read that succeeded before
  T-04 still succeeds. The only behaviour change at Phase 3 is the closure
  of the legacy fallback path, which by then has had ≥ 3 × 180s of TTL to
  drain.
- **Reversibility**: any phase can roll back by flipping flags. No
  destructive migration.
- **Auditability**: `tellus_overlay_legacy_hits_total` reports legacy
  fallback frequency in real time. Phase 3 readiness is a pre-condition
  alarm: that counter must reach zero before the operator flips
  `OVERLAY_READ_LEGACY=false`. Branch isolation defence: a non-`_main`
  read that hits ONLY a legacy key is suppressed and counted in
  `tellus_overlay_branch_mismatch_total` — that counter MUST be zero in
  Phase 3, and it bounds the blast radius of a misconfiguration.
- **Consistency with surrounding Tellus code**: matches the env-flag
  pattern used by F-P3 (`OVERLAY_READ_LEGACY`-style toggles already exist
  for branch-context migrations elsewhere in the repo).

## Evidence that would change the decision

- A measurement showing legacy keys never appear in the production
  overlay (e.g., a Redis `KEYS overlay:*` count by parsed prefix shows 0
  legacy entries during the bake window). Then Phase 3 can be entered
  without waiting for the TTL.
- A change in the overlay TTL contract that pushes the "no legacy keys
  remain" wait beyond the operator's deployment window. Then the rollout
  collapses to a flag-day cutover with explicit user-visible degradation
  (announced).

## Operational gates surfaced in FINAL_REPORT

- T-04 ships in **Phase 0** (defaults). Operators must drive Phases 1→3
  per a soak/runbook plan **outside this engineering work**:
  - Phase 1: 1 hr soak. Verify `tellus_overlay_writes_total` non-zero and
    `tellus_overlay_legacy_hits_total` decreasing.
  - Phase 2: flip `OVERLAY_DUAL_WRITE=false`. Soak ≥ 3 × overlay TTL
    (≈ 9 minutes given default 180s × 3). Verify no new legacy writes.
  - Phase 3: flip `OVERLAY_READ_LEGACY=false` only when
    `tellus_overlay_legacy_hits_total` rate is zero. Verify
    `tellus_overlay_branch_mismatch_total` remains zero.
