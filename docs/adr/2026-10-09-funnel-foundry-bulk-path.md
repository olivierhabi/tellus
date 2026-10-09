# ADR — Foundry-style bulk data path for the funnel

Date: 2026-10-09
Status: **Accepted**
Scope: changelog parquet writer, merge PG tail (staging load), indexing
Kafka hand-off.

## Context

A 6.35M-row PaySim first load spent most of its wall time in three
row-at-a-time loops, not in the merge logic itself:

| Step | Pre-change shape | Cost (6.35M rows) |
|---|---|---|
| Changelog parquet write | 500-row SQL-literal `INSERT … VALUES` into a DuckDB temp table (~12.7k statements) | ~270 s prod |
| Merge staging load | DuckDB keyset page → `JSON.parse` → `JSON.stringify` → 1 000-row `unnest` INSERT, WAL-logged | 342 s prod |
| Indexing hand-off | one awaited Kafka produce per doc | ~22 min (4.7k docs/s local) |

Palantir Foundry's Funnel moves the same data as **bulk artifacts**: each
stage (changelog → merge → index → hydrate) reads and writes whole
datasets with vectorised/batch engines (Spark), never a per-row RPC, and
scratch outputs are not durably journaled.
Sources: <https://www.palantir.com/docs/foundry/object-indexing/funnel-batch-pipelines/>,
<https://www.palantir.com/docs/foundry/object-backend/overview/>.

## Decision

Keep Tellus' stages and guarantees; change only how bytes move between
engines:

1. **Changelog parquet (all-VARCHAR schemas):** spool rows as NDJSON and
   write the parquet in ONE DuckDB `COPY (SELECT … FROM read_json(...))`.
   Same NULL semantics (`null`/`undefined`/`""` → NULL), order, row-count
   check, ZSTD / 100k row groups. Typed schemas keep the generic path.
2. **Merge staging load:** DuckDB renders the merged tail parquet as a
   PG-ready CSV in one pass (before the PG transaction opens), then
   `COPY merge_staging_instances FROM STDIN` (pg-copy-streams) streams it in
   statements of ≤ `mergePromoteChunkRows` records inside ONE transaction.
   Value rules are byte-identical to the row path, except integers beyond
   2^53 in properties now keep their digits (no JS double round trip).
   Gated by the versioned `mergeStagingBulkCopy` (true in every profile);
   the row loop remains as the fallback.
3. **`merge_staging_instances` is UNLOGGED** (migration 196). It is scratch:
   a crash before promote already fails the verify gate and restages; after
   promote there is nothing to keep.
4. **Indexing:** merged docs go to Kafka in batched produce requests
   (`indexingPublishBatchSize` = 1 000 docs, ≤ 512 KiB uncompressed),
   flushed at reader-batch boundaries. `publishMergedDocs` returns the exact
   last offset per partition (baseOffset + messagesInPartition − 1, using
   the partitioner's real placement), so the Quickwit publish wait keeps the
   same target. Broker-failure semantics are unchanged.

Unchanged: verify gate, sample check, chunked promote, single live writer,
duplicate-PK handling (see 2026-10-09-funnel-duplicate-primary-keys.md —
Palantir's fail-on-duplicate is its phase 2).

## Consequences

- One new runtime dependency: `pg-copy-streams` (brianc, MIT).
- Staging contents are lost on a Postgres crash (by design).
- Per-row hot loops are gone from these three stages; the remaining
  merge cost is Postgres index maintenance in staging + promote.
