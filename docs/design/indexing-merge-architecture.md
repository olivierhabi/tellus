# Indexing merge: architecture for scale

**Status:** proposed — awaiting approval before implementation
**Context:** Phase 0/1 incident on PaySIM `Transaction` (6,362,620 rows)
**Evidence:** `~/indexing-diagnostics/20261006-002732/`

Every number below is labelled with the code path it was measured on. Evidence
from one path does not transfer to another — that mistake cost us a wasted cycle
in Phase 1 (see "Guard interaction").

## The measured problem

| Path | Workload | Result | Measured on |
|---|---|---|---|
| Funnel merge (in-process `duckdb.node`) | same SQL, same input | **hung**, 90+ min, never completed | API process, Node 24, `duckdb` 1.4.4 |
| Funnel merge (standalone DuckDB **CLI** 1.4.4) | **identical SQL + settings + parquet** | **61.1 s**, peak spill 4.08 GiB | separate process |
| Datasource reindex (`objectMap` in JS heap) | 6.36M rows | **V8 OOM at 4.02 GiB — killed the API** | API process |

Standalone per-statement timings: `changes` 2.1 s · `changes_seq` (**the global
wide-row sort**) 46.2 s · `drop` 1.9 s · `per_pk_last_delete` 1.1 s ·
`effective_rows` 9.9 s.

**The engine is not the defect.** Same version, same settings, same bytes, ~90×
faster out of process. The defect is the in-process binding/integration layer.
Phase 0 captured all 7 DuckDB task-scheduler workers parked in
`semaphore_wait_trap` while the executor waited on a condvar in
`Executor::WaitForTask` — a lost-task state in the Node binding, not a slow sort.

Two contributing facts: `duckdb` npm is **deprecated and at its final release**
(no 1.5.x), and `duckdb-node-neo#325` documents `connect()` hanging and blocking
all Node operations when `UV_THREADPOOL_SIZE` is exhausted, on Node 24 — our
exact runtime. Our Phase 0 sample shows the query running on a **libuv worker
thread**, which is that mechanism.

**Also measured:** the changelog parquet is *already* deduplicated —
`rows == count(DISTINCT primary_key) == 6,362,620`. The merge's `changes_seq`
global sort **removes zero rows** while costing 46 s and 4 GiB of spill. The
dedup is not needed for the first index of a fully-scanned single contribution.

## 1. Fast path — skip dedup when it is provably unnecessary

Conditions, all required:

1. exactly one contribution (no cross-contribution fold);
2. a cheap DuckDB precheck (measured 2.2 s on 6.36M rows, 0 spill) returns
   `total == count(DISTINCT pk)` with zero null and zero empty PKs.

Then skip the dedup/fold (`changes_seq` global sort, `per_pk_last_delete`,
`effective_rows`) and project `source_state` straight from the changelog rows;
step 8 (edit tables) and everything downstream runs unchanged.

Full-vs-incremental scan is deliberately NOT a condition (correction made
during implementation): `source_state` is built from the changelog alone
either way, and the downstream existing-load + `merged_result` overlay onto
`object_instances` is unchanged, so incrementality is preserved by the stages
the fast path keeps.

**Correctness:** equivalent, not approximate. The general path's only effect on
such input is to drop duplicate rows; the precheck proves there are none, and
`glob_seq` ordering is irrelevant when every PK has exactly one row. The fast
build reproduces the general output column-for-column on such input: tombstoned
covers DELETE *and* NULL operation (the general `<> 'DELETE'` filters NULLs
too), properties COALESCE to `'{}'`, markings use the same SQL trim/distinct/
sort expression, source ids/timestamp are the row's own values. Proven by the
fast-vs-general equivalence test, not by inspection. PaySIM `Transaction`
meets both conditions today.

The precheck is mandatory and re-run per run, never cached — it is the thing that
makes skipping safe.

## 2. General path — narrow-key dedup, hash-partitioned

For input with duplicates or multiple contributions:

1. **Narrow-key winner selection.** Partition by PK over narrow columns only
   (`primary_key`, `__seq`, `row_id`), then `QUALIFY row_number() OVER
   (PARTITION BY primary_key ORDER BY __seq DESC) = 1`. Join back to the wide
   rows by `row_id` for full columns. Sort cost drops from "6.36M rows carrying a
   JSON blob" to "6.36M (pk, seq) pairs".
2. **Hash buckets.** `hash(pk) % N`, `N` configurable, default targeting ~1M rows
   per bucket. Each bucket writes its own parquet and records
   `(bucket_id, status, row_count, checksum)` in a run-state table. Restart skips
   completed buckets; a failure costs one bucket.
3. **Tie-breaks are unchanged** and must be asserted by tests: last-wins by
   `__seq` (file order) within a contribution; contributions fold in array order
   (`contrib_idx`); post-DELETE rows accumulate forward by `glob_seq` rather than
   collapsing to the last row (existing documented data-loss guard).

## 3. Execution isolation

**Run merges out of process — CLI subprocess, not `@duckdb/node-api`.** Chosen
because Step B isolates the defect to the Node binding layer: keeping the engine
work in Node re-enters the code path that failed. The CLI is a separate binary
that can be `SIGKILL`ed without touching the API, has no V8 involvement, and has
a working `.timer`. `@duckdb/node-api` remains the migration target for
*interactive* queries, where in-process is desirable.

Properties: hard timeout (default 30 min, configurable), progress watchdog, and
cancellation that kills the child and reclaims the lease. The API never shares a
DuckDB `Database` with a heavy merge.

## 4. Postgres writes

`COPY` into a per-run staging table (`object_instances_stage_<run_id>`),
idempotent (`ON CONFLICT (primary_key) DO UPDATE`, or staging-table swap). Live
`object_instances` is promoted **only** after post-run checks pass. A failed run
never leaves the live table half-loaded — the property that made the Phase 0
crash survivable.

## 5. Datasource path

**Recommendation: make it refuse, and route large types to the funnel.** Do not
rewrite it to stream.

It is a whole-dataset `Map` + `Set` by design (~356 B/row measured on this
object type). Streaming it would mean reimplementing the merge semantics a second
time, in TypeScript, with a third dedup implementation to keep consistent with
the funnel's. The funnel path is the one we must make correct anyway. So: keep
the guard at 2,000,000, return a clean `4xx` naming the object type, the count and
the funnel route, and remove the ability to raise the guard past the heap.

**Guard interaction (measured, datasource path):** in the production-mode compose
profile `NODE_OPTIONS` caps the heap at **512 MB** while the guard is unset
(code default 2,000,000). At 356 B/row the heap dies at ~1.51M rows, so the
window **1.51M–2.00M rows OOM-crashes the API instead of erroring.** P0; the
guard must be lowered to ~1.2M *for that profile* or the heap raised — this is
the one config change that makes a currently-unreachable failure reachable.

## 6. Locks: lease + progress watchdog + boot reconciler

Three separate signals, because they fail differently:

1. **Lease with heartbeat** (refresh `updated_at`) — detects a **dead process**.
   Phase 0 proved this is necessary and insufficient: the heartbeat lives on the
   JS main thread, which stayed responsive through the deadlock.
2. **`last_progress_at` watchdog** on rows/bytes actually advancing — detects a
   **stuck process**. Default 10 min, configurable, marks the run `STALLED`,
   saves diagnostics, releases the lease.
3. **Boot reconciler** — idempotent, logged: mark `funnel_run` rows stuck at
   `running` with a dead owner as `failed` with a reason, and release their locks.
   Today 8 object types have been stuck in `indexing` for up to 25 days; one of
   those locks was leaked by *our own* Phase 1 crash.

Current `force=true` steal logic trusts `funnel_state.updated_at`, which during
the deadlocked merge stayed pinned at run start — so it could neither distinguish
dead from stuck nor protect a live run.

## 7. Node / Temporal

- **Production runs Node 24** (`Dockerfile` `node:24-bookworm-slim`, `engines
  24.x`, `.nvmrc 24.12.0`).
- `@temporalio/*` declares `node >= 20.3.0` / `>= 20.0.0`, so **Node 24 is inside
  the supported range.** `new Connection()` failing on Node 24 with
  `Object.entries(workflowService) → undefined` is therefore a **bug, not an
  unsupported runtime.**
- Concrete suspect: **version skew** — `@temporalio/client` and `workflow` are
  `1.16.0` while `worker`/`common` are `1.23.0`. Aligning client/workflow to
  1.23.x is the first thing to try, and it also unblocks programmatic workflow
  cancel (today the only cancel path is `SIGKILL`).
- Recommendation: pin `@temporalio/*` to one version, keep Node 24 (it is
  supported and already deployed), and open/track an upstream issue for the
  `Connection` construction failure. Do **not** downgrade Node to work around a
  client bug.

## 8. Acceptance tests and benchmarks

Correctness (mandatory, run fails if any fail):
- indexed count == `count(DISTINCT pk)` in source, per object type;
- checksum over sorted `(pk, key columns)` matches source ↔ `object_instances`;
- 1,000-record random field-by-field spot check against source;
- fast-path and general-path outputs compared on a dataset where both are valid.

Unit: tie-break semantics, bucket assignment, idempotent upsert, resume after a
failed bucket, watchdog trigger, lease expiry, precheck gating.

Integration: full funnel run on a synthetic dataset with injected duplicates and
conflicting versions; results must equal the **old** merge on a size the old path
can still handle.

Benchmark at 1M / 5M / 10M wide rows on a production-sized container; record wall
time, peak RSS, spill bytes, Postgres write throughput; budget per million rows
and fail CI beyond +25%.

**Hang fixture (required):** a scale fixture that reproduces today's in-process
hang must either complete under budget **or** be killed by the watchdog within
threshold. A regression test that only passes when the bug is absent will not
catch a reintroduction.

Rollout: dev → staging at full scale → production behind a feature flag, old path
retained one release as fallback.

## 9. Close-out status, decisions, open items (2026-10-07)

**Status:** implemented on `pr/indexing-merge-clean` (Draft PR #79);
dev-scale evidence below; scale benchmarks ticketed.

**Decisions (implemented):**
- D1 — Two lock signals, not one (`src/services/funnel/indexingLease.ts`,
  migration 194): `lease_heartbeat_at` is written ONLY by the 5 s holder
  timer (`touchLeaseHeartbeat`); `last_progress_at` is written ONLY where
  rows/bytes actually advance (changelog 5 000-row milestones via
  `ComputeChangelogInput.onRowsAdvanced`, merge CLI prefix bytes, bucket
  completions, PG-tail batches). The stall sweep reads `last_progress_at`
  only; the dead-process sweep reads `lease_heartbeat_at` only and skips
  live runs. Claim-time reset (`last_progress_at = now(),
  lease_heartbeat_at = now()`) on every fresh claim
  (`src/services/funnel/funnelStateProjection.ts`,
  `src/routes/reindex.ts` `claimIndexingLock`).
- D2 — Staging + promote (`src/services/funnel/mergeStaging.ts`, migration
  195 `merge_staging_instances`): the SQL PG tail loads staging, runs
  count/distinct/null-empty + 1 000-row sample checks, then promotes
  atomically. Bulk loading keeps the chunked-unnest pattern (NOT raw
  `COPY`): `COPY` would need a server-visible file or a new copy-stream
  dependency, while chunked unnest stays under PG's bind ceiling with one
  round trip per 1 000-row chunk. Promotion is set-based in ONE transaction.
  The small-scale pure-TS `mergeChanges` path still writes live directly
  inside a single transaction (test/fallback scale only).
- D3 — Fail-closed sources (`src/services/funnel/temporal/activities.ts`
  `parseFoundryMarker` / `assertChangelogNonEmpty`,
  `src/services/datasetDatasourceService.ts`): malformed
  `#foundry-dataset:` locators throw at read AND at registration; a zero-row
  changelog for a non-empty source file throws instead of completing empty.
- D4 — Versioned runtime config (`src/config/funnelRuntime.ts`): the five
  non-secret funnel knobs (stall/boot/dead budgets, OOP flag, batch size,
  staging retention, DuckDB CLI path + memory, Lakekeeper container
  endpoint) are committed per profile (development/test/production); the
  corresponding `.env` names are retired (see `.env.example`). Stall stays
  10 min on every profile. Secrets (S3 creds, `LAKEKEEPER_PG_ENCRYPTION_KEY`)
  stay in gitignored env / secret manager.
- D5 — Lakekeeper container endpoint is the docker-internal name
  (`http://minio:9000`): a host loopback from inside the Lakekeeper
  container fails warehouse validation with a gzip-decompression error.

**Measured dev-scale evidence (code paths named):**
- Transaction 6 362 620 rows: source DISTINCT tx set == PG DISTINCT pk set,
  0 rows each side (`src-pks-synth.txt` sha256
  `daf8a349…f4171a1` vs `object_instances` via DuckDB `postgres_scanner`).
- Account 9 695 421 rows: source DISTINCT account set == PG DISTINCT pk set,
  0 rows each side (`accounts_synth.csv` sha256 `2e0f8aa7…3058f76`).
- Staging round-trip on a fresh DB: stage 3 → verify → promote → live has
  the 2 upserts, staging empty.
- Migrations 194/195: scratch-DB up/down verified; ledgered apply on dev.

**Open items (ticketed, not implied):**
- O1 — 1M/5M/10M benchmarks + CI budgets (§8): no full-scale benchmark has
  run against the staging design yet.
- O2 — Bucketed 5M synthetic with duplicates + SIGKILL mid-bucket through
  the wired OOP path (bucketed path never ran at scale; both gate datasets
  took the fast path).
- O3 — Kill/resume re-run against staging at scale (kill mid-load ⇒ live
  unchanged ⇒ resume promotes exactly once).
- O4 — Hang regression fixture (old wide in-process plan must be killed by
  the watchdog within threshold).
- O5 — Datasource-guard test at 2M+1 (clean 4xx naming type/count/route).
- O6 — DuckDB CLI in the image: pinned v1.4.4 + checksum + boot self-check.
- O7 — Follow-ups: compose-profile P0, Node/Temporal version alignment +
  HTTP cancel, merge tie-break determinism review.