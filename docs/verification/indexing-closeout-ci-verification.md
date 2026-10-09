# Indexing close-out — CI production verification (PR #85)

How each close-out checklist row is proven automatically on every PR.

| Row | What is verified | Where |
|---|---|---|
| 4.1 | Malformed `#foundry-dataset:` marker fails the changelog loudly; object_instances untouched | `tests/unit/funnel/foundry-marker-loader-unit.test.ts`, `tests/funnel/integration/indexing-closeout-e2e-integration.test.ts` |
| 1.7 | Registration refuses a malformed locator with `DATASOURCE_MARKER_INVALID` and writes nothing (reachable: Postgres accepts a hyphenless uuid id); a normal registration yields a locator the changelog parser and the invariant checker accept | `tests/funnel/integration/indexing-closeout-registration-integration.test.ts` |
| 4.3 | `REINDEX_TOO_LARGE` returns 413 (not 500) | `tests/unit/funnel/reindex-too-large-route-unit.test.ts` |
| 1.10 | Migrations 192–195 in the ledger; forward idempotent; `.down.sql` reverses (idempotently); forward re-applies — inside a rolled-back transaction | `tests/funnel/integration/indexing-closeout-migrations-integration.test.ts` |
| §2/§3 (lite) | Real CSV in MinIO → changelog → merge → object_instances: distinct-key counts, last-wins duplicates, dataset provenance, no staging leftovers, idempotent re-run, updates/inserts, fast / general / bucketed merge shapes, unreachable object, zero-row gate | `tests/funnel/integration/indexing-closeout-e2e-integration.test.ts` |
| Merge staging | Staging sample comparison is jsonb key-order independent (regression: every CSV whose header was not in jsonb key order failed with "properties differ") | `tests/unit/funnel/merge-staging-canonical-json-unit.test.ts` + e2e above |
| 5.3 | Stage stall budget and merge-CLI timeout/stall are versioned per profile; retired env knobs are ignored | `tests/unit/funnel/{stage-progress,merge-cli-runner,funnel-runtime-config}-unit.test.ts` |
| Prod image | DuckDB CLI v1.4.4 (SHA-256 pinned) bundled at `/usr/local/bin/duckdb`; under `NODE_ENV=production` the compiled runner selects the out-of-process merge and drives the real CLI as the non-root user | `Dockerfile`, `ci.yml` docker-build, `scripts/ci/docker-merge-cli-smoke.cjs` |
| 5.1 | gitleaks over every commit on every ref; reviewed historical false positives pinned by exact fingerprint in `.gitleaksignore` | `ci.yml` `secret-scan-history` |

| Merge strategy | MERGE_* env knobs retired; strategy is versioned config; every variant yields identical rows; `merge_path` recorded per snapshot | `docs/adr/2026-10-09-funnel-merge-strategy-config.md`, merge-* unit tests, e2e above |
| Duplicate PKs (phase 1) | CSV duplicate-PK collapse is measured into `summary_json.source_quality` (Palantir fails these; enforcement is phase 2) | `docs/adr/2026-10-09-funnel-duplicate-primary-keys.md`, e2e above |
| Fleet (replaces tellus_db) | Simulated fleet with one object type per production failure mode; read-only invariant checker must report exactly the planted violations | `scripts/sim/tellusFleetSim.ts`, `src/services/funnel/funnelInvariants.ts`, `tests/funnel/integration/funnel-fleet-sim.lane.test.ts`, `docs/adr/2026-10-09-funnel-fleet-simulation.md` |
| O1 | Full + incremental benchmark with exact counts/last-wins vs `budgets.json` (100k per PR; 1M/5M/10M nightly) | `tests/funnel/scale/o1-benchmark.scale.test.ts`, `.github/workflows/funnel-scale.yml` |
| O2 | Bucketed OOP merge with duplicates; DuckDB CLI SIGKILLed mid-bucket ⇒ live unchanged; same runKey resumes skipping completed buckets | `tests/funnel/scale/o2-bucket-kill.scale.test.ts` |
| O3 | Merge worker process SIGKILLed during the staging load ⇒ live unchanged; fresh-process retry promotes exactly once; duplicate delivery is a no-op | `tests/funnel/scale/o3-kill-resume.scale.test.ts` |
| Promote at scale | Promote DELETE no longer plans a quadratic nested loop over stale stats (found by O2/O3: 90k rows hit the 60 s statement_timeout) | `src/services/funnel/mergeStaging.ts`, `tests/unit/funnel/merge-staging-unit.test.ts` |
| OOP lane | All of the above run on the production profile (`TELLUS_DEPLOYMENT_STRICT=1`, `TELLUS_EXPECT_OOP_MERGE=1`) with Postgres 16 + MinIO + the pinned DuckDB CLI | `ci.yml` job `funnel-oop`, `vitest.funnel-oop.config.ts` |
| Process | CODEOWNERS on funnel + migration paths; rollout/rollback runbook | `.github/CODEOWNERS`, `docs/runbooks/funnel-indexing-rollout.md` |

## Real deployments (not CI)

CI databases start empty, so real data is checked at deploy time instead:
`./run.sh` runs `node dist/funnelInvariants.js --probe-storage` inside the
deployed `app` container after every full deploy and stores the report in
`reports/` (`RUN_INVARIANTS=warn` default, `strict` to gate the deploy). The
ghost run `cfb7b070` matches the `GHOST_INDEXED_EMPTY` signature and should
appear in the first report. Budgets stay provisional until 7 nightly
`funnel-scale` reports exist.
