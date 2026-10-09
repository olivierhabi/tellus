# Indexing close-out — CI production verification (PR #85)

How each close-out checklist row is proven automatically on every PR.

| Row | What is verified | Where |
|---|---|---|
| 4.1 | Malformed `#foundry-dataset:` marker fails the changelog loudly; object_instances untouched | `tests/unit/funnel/foundry-marker-loader-unit.test.ts`, `tests/funnel/integration/indexing-closeout-e2e-integration.test.ts` |
| 4.3 | `REINDEX_TOO_LARGE` returns 413 (not 500) | `tests/unit/funnel/reindex-too-large-route-unit.test.ts` |
| 1.10 | Migrations 192–195 in the ledger; forward idempotent; `.down.sql` reverses (idempotently); forward re-applies — inside a rolled-back transaction | `tests/funnel/integration/indexing-closeout-migrations-integration.test.ts` |
| §2/§3 (lite) | Real CSV in MinIO → changelog → merge → object_instances: distinct-key counts, last-wins duplicates, dataset provenance, no staging leftovers, idempotent re-run, updates/inserts, fast / general / bucketed merge shapes, unreachable object, zero-row gate | `tests/funnel/integration/indexing-closeout-e2e-integration.test.ts` |
| Merge staging | Staging sample comparison is jsonb key-order independent (regression: every CSV whose header was not in jsonb key order failed with "properties differ") | `tests/unit/funnel/merge-staging-canonical-json-unit.test.ts` + e2e above |
| 5.3 | Stage stall budget and merge-CLI timeout/stall are versioned per profile; retired env knobs are ignored | `tests/unit/funnel/{stage-progress,merge-cli-runner,funnel-runtime-config}-unit.test.ts` |
| Prod image | DuckDB CLI v1.4.4 (SHA-256 pinned) bundled at `/usr/local/bin/duckdb`; under `NODE_ENV=production` the compiled runner selects the out-of-process merge and drives the real CLI as the non-root user | `Dockerfile`, `ci.yml` docker-build, `scripts/ci/docker-merge-cli-smoke.cjs` |
| 5.1 | gitleaks over every commit on every ref; reviewed historical false positives pinned by exact fingerprint in `.gitleaksignore` | `ci.yml` `secret-scan-history` |

## Not covered by CI (needs a production-shaped environment)

- Real `tellus_db` data and the ghost run (`cfb7b070`) investigation.
- Scale/soak rows (O1–O3): multi-million-row sources, spill and memory ceilings.
- The out-of-process merge end-to-end on the integration lane (the lane runs the
  `test` profile, which keeps the merge in-process; the CLI path is covered by the
  image smoke and was run locally against Postgres 16 + S3 with
  `TELLUS_DEPLOYMENT_STRICT=1`, `MERGE_FAST_PATH=0` and `MERGE_BUCKET_ROWS=2`).
