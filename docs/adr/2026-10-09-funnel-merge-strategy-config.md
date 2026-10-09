# ADR — Funnel merge strategy is versioned config, not operator env knobs

Date: 2026-10-09
Status: **Accepted** (PR #85, `fix/indexing-closeout-p0-marker-413`)
Scope: `src/config/funnelRuntime.ts`, `src/services/funnel/merge*.ts`, `.env.example`.

## Context

The merge stage had five independent `process.env` switches —
`MERGE_DELTA`, `MERGE_FAST_PATH`, `MERGE_NARROW_DEDUP`, `MERGE_BUCKET_ROWS`,
`MERGE_PROGRESS_TTL_SECONDS` — read at call time. Any deployment could run a
different merge algorithm than CI tested, and nothing recorded which one ran.
Turn-6 of the close-out already moved the stall/timeout budgets into the
versioned `funnelRuntime` profiles for the same reason.

Palantir's Funnel treats strategy selection as internal: batch pipelines are
incremental by default, switch to a full reindex automatically (>80 % of rows
changed, replacement pipeline, or explicit user request), and Funnel itself
"provisions replacement pipelines … for performance reasons based on various
heuristics". Operators observe pipelines (monitoring views, sync-propagation
delay rules); they do not choose the sort algorithm.
Source: <https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/>.

## Decision

1. All five settings are fields of `FunnelRuntimeConfig`, committed per
   profile (`development` / `test` / `production`): `mergeDelta`,
   `mergeFastPath`, `mergeNarrowDedup` = `true`, `mergeBucketTargetRows` =
   1 000 000, `mergeProgressTtlSeconds` = 3 600.
2. The `MERGE_*` env vars are **retired and ignored**. Unit tests assert that
   setting them changes nothing.
3. Tests vary strategy only through `setFunnelRuntimeOverridesForTesting`,
   which throws outside vitest. The e2e suite proves each variant (fast,
   general, bucketed, legacy wide sort, delta off) yields the same rows.
4. The strategy actually used is recorded per merged snapshot
   (`funnel_snapshot.summary_json.merge_path`). On the production profile
   every path that sorts runs in the DuckDB CLI child (`*_cli`); only the
   sort-free fast path (`duckdb_sql_fast`) stays in-process, and the O1
   benchmark's maxRSS budget bounds it. CI's OOP lane asserts exactly this.
5. Incident response = ship a config change (reviewed, versioned, CI-tested),
   not flip an env var on one pod.

## Consequences

- One code path per profile; CI runs exactly what production runs.
- Kill switches are slower to pull (a deploy instead of an env edit). Accepted:
  every switch has an equivalence test, so a revert is a one-line config PR.
- `.env.example` documents the knobs as RETIRED so operators do not keep
  setting dead values.
