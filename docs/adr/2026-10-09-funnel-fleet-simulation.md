# ADR — Replace the shared `tellus_db` with a simulated fleet + invariant checker

Date: 2026-10-09
Status: **Accepted** (PR #85)
Scope: `scripts/sim/`, `src/services/funnel/funnelInvariants.ts`,
`tests/funnel/{integration,scale}/`, CI jobs `funnel-oop` and `funnel-scale`.

## Context

The close-out checklist had items that could only be checked "against
tellus_db": ghost runs (indexed with 0 objects while the source had rows),
`properties differ` merge failures, stale leases, orphan staging rows, count
drift. That shared database has been retired, so nobody has a real
production snapshot to test against. Pointing tests at whatever environment
happens to exist would also break the isolation rule (FUNN-ISO-1:
destructive tests only ever touch `tellus_tests`).

Palantir runs Funnel as a managed service: transient job failures are retried
automatically (about 5 min), terminal failures only retry on new data, and
health is observed through monitoring views and propagation-delay rules
rather than ad-hoc database inspection.
Sources: <https://www.palantir.com/docs/foundry/object-indexing/faq/>,
<https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/>.

## Decision

1. **Simulate, don't borrow.** `scripts/sim/tellusFleetSim.ts` seeds one
   object type per production failure mode into the isolated lane: healthy
   (dup-heavy, non-jsonb key order, full + 5 %/1 % incremental pass),
   wide/unicode/quoted CSV, legacy ghost, malformed marker, dangling locator,
   header-only, dead lease, stalled progress, orphan staging, null provenance,
   count drift, historical `properties differ` (replayed and not). Healthy
   types go through the real changelog → merge activities and are checked
   against an independent JS model.
2. **One read-only checker for simulation and production.**
   `checkFunnelInvariants` (CLI `scripts/funnel-invariants.ts`) is SELECT-only
   plus optional S3 probes, uses the same `funnelRuntime` thresholds as the
   watchdogs, and exits non-zero on errors. The integration test requires it
   to report **exactly** the planted violations — no misses, no false
   positives on healthy, replayed or legitimately empty types.
3. **Scale and crash behaviour come from synthetic data at size** (O1–O3):
   deterministic DuckDB-generated CSVs (1M/5M/10M nightly, 100k on PRs),
   SIGKILL of the DuckDB CLI mid-bucket and of the whole merge worker
   mid staging-load, with exact last-wins verification.
4. Real deployments are checked at deploy time, not in CI: `./run.sh` runs
   the compiled checker (`dist/funnelInvariants.js`) inside the deployed
   `app` container after every full deploy, report in `reports/`; `warn` by
   default so legacy state never blocks the deploy that fixes it, `strict`
   once the baseline is clean.

## Consequences

- Each failure mode the close-out fixed now has a reproducible fixture in CI.
- The simulation only covers states we know about. Unknown production states
  still need the checker run against real data after deploy — this is the
  first step of the rollout runbook.
- Synthetic distributions (uniform keys, fixed widths) won't reproduce every
  real skew; budgets are provisional until nightly history exists.
