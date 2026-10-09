# ADR — OSv2 data restrictions per object type, and full vs incremental indexing

Date: 2026-10-09
Status: **Accepted**
Supersedes: phase 2 of `2026-10-09-funnel-duplicate-primary-keys.md`.
Scope: changelog stage (validation), merge stage (delta + plan), indexing
stage (mode + watermark), Force Reindex route. Migration 197.

## Context

Palantir enforces the OSv2 data restrictions during indexing, and for
**batch** datasources a violation fails the indexing job
(<https://www.palantir.com/docs/foundry/object-indexing/data-restrictions/>):

- duplicate primary keys within one transaction fail (across transactions the
  later one wins);
- primary keys may not be geopoint, geoshape, arrays, time series or real
  numbers (decimal, double, float);
- no NaN / ±Infinity, no empty strings, no nested arrays, no null elements in
  arrays;
- strings ≤ 12 MB, arrays ≤ 100,000 elements.

Funnel batch pipelines index **incrementally** by default and fall back to a
full reindex when more than 80% of the rows changed in a transaction, when the
schema changed (replacement pipeline), or when a user asks
(<https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/>).

Before this change Tellus measured duplicate PKs on the CSV path but kept
last-wins, checked none of the other rules, and its indexing stage always
re-published the **full** merged snapshot — and only when user edits were
pending, so source-only changes never reached the serving index from the
Temporal path.

## Decision

### 1. `object_type.indexing_data_policy` — `lenient` (default) | `strict`

- **strict** — any violation fails the changelog **before** the snapshot
  commits, as a non-retryable `IndexingDataRestrictionError` with per-code
  counts, columns and ≤ 5 samples. Nothing downstream sees the transaction.
- **lenient** — the run continues as before (duplicate PKs collapse
  last-wins, null/empty PKs skipped); every violation is recorded in
  `summary_json.source_quality.restrictions` plus a structured warning.

Existing object types default to lenient so nothing that indexes today starts
failing on deploy. Owners flip to strict once `source_quality` is clean; the
end state is strict everywhere.

Checks run where the data already flows, without a new pass:

| Reader | How |
|---|---|
| Foundry CSV/TSV (fast path) | Folded into the existing DuckDB aggregate scan: `strlen > 12 MB`, NaN/±Inf spellings on numeric-typed columns; strict fails before the dedup sort. DuckDB already turns `""` into NULL (the OSv1 conversion), so empty strings cannot reach the index here. |
| Foundry JSON, Iceberg, pending edits | `RestrictionTracker` in `computeChangelog`'s row stream (O(codes) memory). Duplicate PKs are counted from the dedup temp table (JSON) or still hard-fail (Iceberg/edits, unchanged). |
| All | Primary-key type checked from the ontology up front. |

### 2. Full vs incremental indexing

- **Merge** computes the delta vs the previous merged snapshot whenever one
  exists (previously only when the live-row count was unchanged), uploads it
  as `merged/<type>/<snapshot>.delta.parquet` and records
  `summary_json.indexing_plan = {mode, reason, totalRows, changedRows,
  changedFraction, baseSnapshotId, threshold}`. `mode = full` when there is no
  previous snapshot, the delta is unreadable, or `changedRows / totalRows >
  indexingFullReindexFraction` (0.8).
- **Indexing** publishes only the delta when the plan is incremental **and**
  `funnel_index_watermark` proves the serving index already holds the delta's
  base snapshot; otherwise full. A newly created Quickwit index is always
  full. Force Reindex clears the watermark (user-triggered full). The
  watermark advances only after Quickwit confirms the publish.
- Source-only runs now reach the serving index (previously gated on pending
  user edits).
- The PG-tail drift check now compares `object_instances` to the previous
  snapshot's live count, so runs that add or delete rows also get the
  O(changes) delta tail.

Kill switch: `funnelRuntime.indexingIncremental` (versioned, on).

## Consequences

- One `DESCRIBE` and a few extra `count(*) FILTER` aggregates on the CSV
  scan; sample queries only run when a check fires.
- First indexing pass after deploy is full per object type (no watermark).
- A full pass re-publishes every doc but does not purge docs for keys that
  vanished without a tombstone — unchanged from before; the replacement
  pipeline remains the way to rebuild an index from scratch.
- Not covered: type-coherence casts (e.g. "abc" in an integer column) and
  geopoint format validation — those stay with `typeConverter` at read time.
