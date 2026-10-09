# ADR — Duplicate primary keys within one source snapshot

Date: 2026-10-09
Status: **Accepted — phase 1 shipped in PR #85; phase 2 shipped as the per-object-type `indexing_data_policy` (see 2026-10-09-funnel-data-restrictions-and-incremental-indexing.md).**
Scope: foundry-bridged CSV/TSV reader (`buildFoundryBridgedReader`),
`changelogStage.ts`, data-health reporting.

## Context

Palantir's object-indexing contract: *"If there are duplicate primary keys
within a single transaction, indexing will fail and throw an error. If there
are duplicates across transactions, the later transaction wins."* Batch
violations fail indexing; empty-string, NaN and ±∞ values and some PK types
are not allowed.
Source: <https://www.palantir.com/docs/foundry/object-indexing/data-restrictions/>.

Tellus already follows this for Iceberg and pending-edit readers
(`computeChangelog` throws on a repeated PK within a transaction). The
foundry-bridged CSV reader instead **silently collapses** duplicates
last-wins by file order (`DISTINCT ON … ORDER BY rn DESC`). That was added
for OO7's 5.6 M-row upload with 949 181 duplicate `order_id`s, so switching
straight to "fail" would break existing object types without warning.

## Decision

Adopt Palantir semantics through a staged rollout:

- **Phase 1 (this PR) — measure, don't change behaviour.** The CSV reader
  runs one aggregate scan (`count`, null/empty-PK count, `count DISTINCT`)
  and records
  `summary_json.source_quality = {sourceRows, distinctPrimaryKeys,
  duplicatePkRows, nullOrEmptyPkRows, duplicatePkSamples[≤5]}` on the
  changelog snapshot, plus a structured warning. The e2e test pins the exact
  numbers (7 rows, 5 distinct, 2 duplicate rows, samples `["1","3"]`).
- **Phase 2 (separate PR) — enforce.** After a data-health report over
  `source_quality` shows which object types are affected and owners have
  fixed their sources, a duplicate PK within one snapshot fails the
  changelog with a clear error (count + samples), same as the Iceberg path.
  Across snapshots, later wins (already true).
- Null/empty PKs keep being skipped in phase 1 and are counted; phase 2
  fails on them too (Palantir disallows empty strings).

## Consequences

- One extra DuckDB scan per CSV changelog (seconds at 5 M rows; measured by
  the O1 benchmark).
- Until phase 2 ships, Tellus is knowingly more permissive than Palantir for
  CSV sources — but no longer silently so.
