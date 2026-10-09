# Indexing close-out — row-by-row evidence (PR #85)

Every row cites code at the PR head, the test that proves it, and — for each
fix — a **mutation proof**: the fix was reverted locally and the named test
went red. CI links: the PR's latest `ci-gate` run.

## Row 0 — commit list (#79 → main)

#79 was closed and superseded by #83 (merged as `efe3fe6`). All 8 #79 commits are
on `main`, verified with `git range-diff`:

| #79 commit | On main as | Result |
|---|---|---|
| `fd6e4b4` REINDEX_MAX_MERGED_OBJECTS memory guard | `1d127ef` | patch-identical (`=`) |
| `38ed4d9` merge prefix out of process | `60bc01c` | patch-identical (`=`) |
| `6833054` lease heartbeat + progress watchdog | `07d8158` | patch-identical (`=`) |
| `dea392a` fast-path precheck | `a7d661e` | patch-identical (`=`) |
| `2505b2c` design note | `a054b10` | patch-identical (`=`) |
| `12cb2d0` narrow-key dedup + hash buckets | `fe609d7` | patch-identical (`=`) |
| `e0401b1` watchdog onProgress guard | squashed into `59ad047` (#83) | content present (merge-cli-runner + test) |
| `dfae23f` close-out | squashed into `59ad047` (#83) | same 28 files; only rebase context differs |

Reproduce: `git range-diff fd6e4b4~1..dfae23f 1d127ef~1..fe609d7` and
`git range-diff 12cb2d0..dfae23f 3db18c7..59ad047`.

## Rows 1.x

| Row | Evidence (PR head) |
|---|---|
| 1.1 | `src/config/funnelRuntime.ts` L75/L94/L113 `indexingStallAfterMs: 600_000` in all three profiles; profile chosen only from `NODE_ENV` / `TELLUS_DEPLOYMENT_STRICT` / environment id (L134). |
| 1.2 | `indexingLease.ts` heartbeat L137–146 writes only `lease_heartbeat_at`; progress L150–158; stall sweep L180+ reads `last_progress_at` only; dead sweep L286+ reads `lease_heartbeat_at` only with `NOT EXISTS … 'running'`. |
| 1.3 | `activities.ts` timer L268–269 (heartbeat only); `onRowsAdvanced` L408; zero-row gate L415. Gate can no longer be bypassed (4.1 + lookup fail-closed). **Mutation:** gate disabled → 1 unit test red. |
| 1.4 | `changelogStage.ts` L238–244: every 5 000 rows, inside try/catch. |
| 1.5 | **Single writer.** `promoteMergeStaging` (`mergeStaging.ts` L203) is the only funnel writer to `object_instances`. The pure-TS path now commits via `commitMergedRowsViaStaging` (`mergeStage.ts` L475 → L668: stage → verify → `assertStagedTail` → promote, one transaction). Guard: `tests/unit/funnel/single-live-writer-unit.test.ts`; equivalence vs the SQL contract: `indexing-closeout-provenance-integration.test.ts`. **Mutation:** pure-TS back to `bulkUpsertInstances` → 2 red; helper skips promote → 2 red. |
| 1.6 | `mergeStage.ts` stage L1621/L1655 → `assertStagedTail` L1675 + `verifyStagedSample` L1676 → promote L1683 in one transaction; `batchDeleteInstances` 0 hits. |
| 1.7 | `datasetDatasourceService.ts` L668 `DATASOURCE_MARKER_INVALID`; real-DB test `indexing-closeout-registration-integration.test.ts`. |
| 1.8 | `funnelDispatcher.ts` L142–143 tick calls both sweeps. |
| 1.9 | `routes/reindex.ts` L154–158 and `funnelStateProjection.ts` L536–537 stamp both columns. |
| 1.10 | `indexing-closeout-migrations-integration.test.ts`: ledger + forward/down/forward, rolled back. Also run locally on Postgres 16: 3/3 pass. |

## Rows 4.x / 5.x / 6.x

| Row | Evidence | Mutation proof |
|---|---|---|
| 4.1 | `parseFoundryMarker` outside the lookup catch (`activities.ts` L1099). **Lookup failure now fails closed:** 3 attempts with backoff, then throws (L1040+); never `null`. | marker back inside catch-all → 3 red; lookup error → `null` → 1 red; no retry → 2 red |
| 4.2 | Zero-row gate exercised end-to-end (`indexing-closeout-e2e-integration.test.ts`). | gate disabled → red |
| 4.3 | `routes/reindex.ts` L407 passthrough → 413 (`queryErrors.ts` L111, `responseFormatter.ts` L410). | passthrough removed → 1 red |
| 4.4 | `merge-cli-runner-unit.test.ts` in CI + Docker OOP merge smoke. | CLI timeout read from env → 1 red |
| 5.1 | `.env` untracked; `secret-scan-history` (fetch-depth 0) green. | — |
| 5.2 | All five knobs RETIRED in `.env.example` (L288, L582, L589, L603, L612). | — |
| 5.3 | 0 env reads in `src/` of any retired knob (incl. `FUNNEL_STAGE_STALL_AFTER_MS`, `MERGE_*`, `FUNNEL_MERGE_CLI_TIMEOUT_MS`). | stage stall read from env → 2 red |
| Provenance | Promote and `bulkUpsertInstances` `COALESCE` a NULL / non-uuid incoming id with the live value (`mergeStaging.ts` L225, `objectInstance.ts` L180); unchanged content stays a no-op. Real-DB test `indexing-closeout-provenance-integration.test.ts` (6/6 locally on Postgres 16). | promote COALESCE removed → 2 red; upsert COALESCE removed → 1 red |
| Canonical JSON | `merge-staging-canonical-json-unit.test.ts` | raw stringify → 2 red |
| Promote at scale | `merge-staging-unit.test.ts` nested-loop guard | guard removed → 1 red |
| 6.x | All CI checks green on the PR head. | — |

## Needs people or environments outside CI (not claimed here)

- **2.x / 3.x on real data:** first staging deploy with `RUN_INVARIANTS=strict`; attach `reports/funnel-invariants-*.json` (expect `GHOST_INDEXED_EMPTY` for `cfb7b070`, then zero error-level after remediation).
- **Scale budgets:** 7 nightly `funnel-scale` runs at 1M/5M/10M.
- **Rollback drill:** run `docs/runbooks/funnel-indexing-rollout.md` rollback + roll-forward on staging.
- **Independent review:** CODEOWNERS approval by someone other than the author; second-person review of the 15 `.gitleaksignore` fingerprints.
