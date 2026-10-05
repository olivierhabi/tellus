# Incident 3ec397d5 — duplicate dataset registration (2026-10-05)

## Timeline (UTC, server = UTC+2/CAT in raw logs; converted)

- 14:24:03 — Deploy `3ec397d5` (full, 4 outputs) starts on pipeline
  `0e798720` (PaySim AML).
- 14:24:21 — `mule_chains` leg fails at registration after an 18s build:
  `The name "mule_chains" is already in use by another dataset
  (c56e5ea9…) in folder "MobileMoneyDemo"`.
- 14:25:08 / :23 / :43 — the other three legs each INSERT **two**
  `foundry_datasets` rows 1–3 ms apart (`transactions_clean` 621fe03f +
  28a5d498, `mule_chain_metrics` db1e6b7a + b5523af4, `accounts` f4d60701 +
  8993b1b8). Deploy marked `failed` (one leg failed).
- 14:31:53 — Retry deploy `9e64224f` succeeds; updates one row of each
  pair with fresh builds (14:32–33 files). The sibling rows remain as
  orphaned duplicates.
- Later — Adopt-by-name workaround unblocked retries; investigation found
  the dual-executor mechanism below.

## Root cause (three compounding defects)

1. **No DB-level uniqueness.** `foundry_datasets` had zero unique
   constraints. "One name per folder" lived only in
   `assertFolderNameAvailable` (SELECT-then-INSERT across pooled
   connections) — decorative under concurrency.
2. **Execution not idempotent.** `startDeployment` unconditionally does
   BOTH: enqueue a PG `pipeline_signal` (consumed by the PG dispatcher →
   `executeDeploymentById`) AND start Temporal `pipelineDeployWorkflow`
   when connected (activity `pbRunDeployment` → the same
   `executeDeploymentById`, registered on the shared worker). The
   dispatcher's documented "Temporal preferred, handoff-only" protocol
   was never implemented in `tick()` — no branch, no handoff. Both
   executors ran the deployment concurrently. The old
   `status !== 'running'` re-check is non-atomic (both read 'running' at
   start). Deterministic DuckDB build times kept the two executors in
   lockstep, so each output's check-then-insert pair landed ms apart.
3. **Partial failure poisons retries.** The failed deploy left 7 rows;
   the retry collided with the leftovers ("already in use").

Ruled out: duplicate output nodes (4 exist, correctly bound), sequential
double-insert, engine-fallback path.

## Second writer (item 5) — concluded with code evidence

The Temporal workflow activity + the PG dispatcher (both unconditional,
no mutual exclusion). Evidence: single deployment row; 1 ms pair gaps
with a sequential in-deploy loop (impossible single-pass); the
`mule_chains` refusal naming `c56e5ea9` (loser's check landed just after
the winner's commit); lockstep spacing matching deterministic build
durations. Server logs from the window do not survive
(`logs/dev.log.pre-restart` is Aug 28), so this rests on code-path proof,
which is airtight: two unconditional executors, one unguarded entry
point. The claim (item 2) fixes all candidate second writers regardless.

## Fixes (branch fix/duplicate-dataset-registration, one commit per item)

- **Item 1** — migration 190: unique index `(project_id, folder_id,
  name)` NULLS NOT DISTINCT (PG16) + pre-check DO block that fails loudly
  naming duplicate groups + typed 409 `DATASET_NAME_ALREADY_EXISTS`
  (base-AppError factory: the middleware duck-matches `name==='AppError'`).
  Deliberate deviations: no `deleted_at` predicate (column doesn't
  exist — deletes are hard); no CONCURRENTLY (both migrators wrap files
  in transactions; table is hundreds of rows).
- **Item 2** — migration 191 (claim columns + lease index +
  `pipeline_deploy_output_registrations` PK(deployment_id, node_id)) +
  atomic claim/heartbeat/fence in `executeDeploymentById` (single funnel
  for dispatcher/Temporal/inline) + explicit worker ids + fenced
  dispatcher crash-mark and orphan sweeper (never write terminal state
  over a live lease). INSERT stays `status='running'` (POST contract
  unchanged); NULL-claim rows are immediately claimable (stuck-deploy
  recovery).
- **Item 3** — `registerDataset()`: one transaction (row + columns +
  node rebind + savepoint-guarded exactly-once record) around a single
  INSERT..ON CONFLICT(column-list — infers the NND index; ON CONFLICT ON
  CONSTRAINT cannot name a standalone index, verified PG16). Loser adopts
  on lineage (own node or orphan) else 409. All three deploy sites,
  clone (adopt:false), uploads, renames (pre-check + index backstop),
  trash restores (suffix-and-warn, pipelines precedent), snapshot route
  (409), synced registry (contractual name_conflict). Verify scripts
  unchanged: atomicity covers them (synthetic deployment ids skip the
  record with a warning). Interim `adoptDatasetByName` removed (subsumed).
- **Lane+tests** — fixed pre-existing lane breakage (inline
  `idx_idempotency_key_principal` assumed the column file-migration 188
  adds; guarded on column existence). 12/12 green in the CI lane:
  claim race, settled idempotency, lease expiry/fencing, sweeper
  behavior; registration race (8 writers → 1 row), refuse-409s, retry
  adoption, cross-node 409, live/ghost bindings; 190 presence +
  pre-check clean + scratch-DB dirty/clean proof.
- Regressions: 258/258 unit (pipelines + deploy), 37/37 trash/dataset-txn.

## Item 4 — cleanup dry-run (APPROVAL GATE; nothing deleted)

Full per-row audit: `scripts/audit-duplicate-datasets.ts` (read-only).
14 groups, 97 rows: 74 ORPHAN, 16 NEEDS-DECISION, 7 KEEP.

Rule applied: **live `pipeline_nodes.dataset_id` binding wins** over
historical `build_results` mentions (a failed deploy's build_results is
history, not state). This resolves the brief's conflict note:
`db1e6b7a` is mentioned by 3ec397d5's build_results but bound to nothing
with a stale 8-col schema; `b5523af4` is node-bound with the current
16-col schema and the succeeded deploy → keep `b5523af4`.

Recommended KEEP (exactly one per group — the index demands it):
`8993b1b8` (accounts), `28a5d498` (transactions_clean),
`b5523af4` (mule_chain_metrics), `655d52e1` (tariff, bound+lineage),
`71def472` (vip_customers, bound), `e6ca076a` (action_audit_log_raw,
node-bound), newest-of-group for organization.csv / audit_case.csv /
users / users_raw / active_index_version_raw / CDC / action_type_raw /
New-Object-Type (pending owner decisions below).

Delete candidates: the 3 incident siblings (`f4d60701`, `621fe03f`,
`db1e6b7a` + their columns + their timestamped MinIO CSVs), 33×
action_audit_log_raw, 29–30× action_type_raw (keep 1), and the older
upload/system dupes per the per-group table in the report.

Open decisions for the owner:
1. User-uploaded groups (organization ×3, audit_case ×2, New-Object-Type
   ×5, vip/tariff orphans): keep-newest-and-delete-rest, or keep all but
   renamed? Any object-type-by-name references must be checked first for
   the New-Object-Type group.
2. System groups: keep-newest-each (recommended) — with the caveat that
   the sync registry's rid→uuid mapping must resolve to the survivor;
   first post-cleanup re-registration 409s loudly (not silently) if not.
3. Optional repair: `28a5d498` carries 34 dataset_columns for a 17-col
   output (both executors wrote columns). Recommend deduping to one
   ordinal set in the same window.
4. MinIO purge is idempotent delete-if-exists per recorded file_path;
   iceberg:// rows have no objects.

Execution (after approval): one transaction for DB deletes
(dataset_columns → versions → lineage → registrations → datasets),
then MinIO purge, then audit log of every removed id. Rollout order
after cleanup: apply 190/191 to dev, restart API.

## Follow-ups (not this incident, observed during)

- Legacy (non-DuckDB) engine path has no row-count guard: the next
  ineligible graph OOMs the same way this pipeline used to.
- `amount_key`-style float-derived join keys: verify integer-cents
  before larger builds (precision drift drops rows silently at scale).
- Dispatcher header still documents the handoff-only protocol; either
  implement the Temporal skip or correct the comment (claim makes both
  safe; the comment is now the only lie left).
