# CI pipeline

Tiered CI: fast feedback on every PR, the full suite only where it pays for
itself. Branch protection should require **one** check: `ci-gate`.

| Tier | Trigger | What runs | Target wall clock |
|---|---|---|---|
| 1 | every PR, merge queue, push, nightly | lint + SAST, typecheck, unit (+ coverage gate, ghost-pass gate, CVE scan, secret scan), integration **smoke** | < 10 min |
| 2 | `pull_request` | integration tests **selected by changed paths** | ≈ 8–12 min |
| 3 | `merge_group` (and push to `main`/`master`/`develop`) | full integration suite in 8 shards + E2E, perf, `test:all`, Docker build, quarantine (non-blocking) | ≈ 12–15 min |
| 4 | nightly 01:30 UTC + manual | full suite **unsharded**, E2E/perf/`test:all`, in-process load runner, AI contract, quarantine | ≈ 45–60 min |
| 5 | PR label `run-full-ci`, or `workflow_dispatch` with `run_full` | same as Tier 3 on demand | as Tier 3 |

## Files

| File | Role |
|---|---|
| `.github/workflows/ci.yml` | Entry point for PR / merge queue / push / dispatch. Planner, matrix, `ci-gate`. |
| `.github/workflows/_tier1.yml` | Reusable: lint, typecheck, unit (JUnit + Codecov). |
| `.github/workflows/_integration.yml` | Reusable: one ephemeral integration lane (smoke / selected / shard / quarantine). |
| `.github/workflows/_extended.yml` | Reusable: E2E, perf, `test:all` (moved unchanged from the old `ci.yml`). |
| `.github/workflows/coverage-gate.yml`, `cve-scan.yml` | Now reusable (`workflow_call`), invoked from `ci.yml` / `nightly.yml`; `cve-scan` keeps its daily schedule. |
| `.github/workflows/nightly.yml` | Tier 4 + failure issue. |
| `.github/workflows/ci-effectiveness.yml` | Weekly selection-quality report. |
| `.github/actions/setup-pnpm` | Composite: pnpm + Node 24.12.0 + pnpm-store cache + frozen install. |
| `.github/actions/start-lane-deps` | Composite: Temporal / MinIO / Keycloak docker-run deps for a lane. |
| `.github/ci/test-selection.json` | **Single source of truth** for smoke list, quarantine, path → test groups, run-all triggers, shard count. |
| `scripts/ci/plan-tests.mjs` | Planner: builds the paths-filter config and the test matrix. Zero dependencies. |
| `scripts/ci/ci-effectiveness.mjs` | Weekly report (uses `gh api`). |
| `vitest.ci.config.ts` | `vitest.config.ts` + JUnit output + quarantine exclusion. No test logic changes. |

## How test selection works (Tier 2)

1. `plan` turns `test-selection.json` into a [dorny/paths-filter] config with one
   filter per category (`run_all`, `no_tests`, `test_files`, `docker`,
   `group_<name>`) and lists the changed files of each.
2. `plan-tests.mjs plan` classifies **every** changed file:
   * matches `run_all` (shared core: `src/db*`, `src/middleware`, `src/utils`,
     `src/lib`, `src/config`, `src/types`, `src/models`, migrations, schemas,
     lockfile, `package.json`, `tsconfig*`, `vitest*.ts`, Dockerfiles,
     docker-compose, `.github/**`, `scripts/**`, `packages/**`, `infra/**`,
     shared test harness `tests/*.ts` / `tests/helpers` …) → **full suite**;
   * matches `no_tests` (docs, markdown, runbooks…) → ignored;
   * matches a group's `paths`, or lives under one of the group's test
     prefixes → that group's tests run (`tests` are vitest file filters);
   * a changed `*.test.ts` outside every group → that file runs directly;
   * **anything else → full suite** (fail-safe: selection never silently
     skips a file the config does not know about).
3. Only docs changed → no integration jobs (Tier 1 + smoke still run).

Why paths-filter instead of an affected-graph tool: this is a single Node
package (no Nx/Turborepo/workspaces), and the integration suites are HTTP
black-box tests against a spawned server, so `vitest --changed`'s import graph
cannot see which tests exercise a changed route. An explicit, reviewable
mapping with a run-everything fallback is safer.

### Adding a new area

Add a group to `.github/ci/test-selection.json`:

```json
"billing": {
  "paths": ["src/services/billing/**", "src/routes/billing*"],
  "tests": ["tests/integration/billing/", "tests/unit/billing/"],
  "shards": 1
}
```

Until you do, changes under `src/services/billing/` trigger the full suite.
Test locally: `node scripts/ci/plan-tests.mjs filters` prints the generated
filters.

## Smoke tests

Listed in `test-selection.json` → `smoke` (no vitest tags needed):

| Test | Covers |
|---|---|
| `tests/smoke/db-connectivity-smoke-integration.test.ts` | DB reachable + sealed lane environment, `/health` |
| `tests/tuesday/integration/global-auth-integration.test.ts` | auth |
| `tests/wednesday/integration/query-basic-integration.test.ts` | core read API |
| `tests/tuesday/integration/action-validate-integration.test.ts` | core action API |

They run on a *minimal* stack (Postgres, OpenSearch, MinIO, Keycloak — no
Kafka/ClickHouse/Temporal).

## Sharding

Full runs use `vitest --shard=N/8` (`fullShards`). Each shard is a separate
job with its **own** services and its own spawned server; nothing is shared.
Groups with more tests set `shards` > 1 (`code-repos`, `foundry`). To
rebalance, change `fullShards` and check per-shard durations in the JUnit
artifacts.

## Quarantine (flaky tests)

`test-selection.json` → `quarantine` lists known-flaky files, each with a
tracking issue (label `flaky-test`). `vitest.ci.config.ts` excludes them from
every blocking lane; the **Quarantine (non-blocking)** job runs only them on
full runs and nightly, with `continue-on-error`, and is not a dependency of
`ci-gate`. To un-quarantine: fix the test, remove the entry, close the issue.

## `ci-gate`

Depends on every blocking job, runs with `if: always()`, fails if any result is
`failure` or `cancelled`, passes on `success`/`skipped`. Jobs skipped by the
planner (e.g. integration on a docs-only PR) therefore do not block, while a
cancelled or failed job always does. The planner itself must succeed.

## Caching

* pnpm store: `actions/setup-node` `cache: pnpm`, keyed on `pnpm-lock.yaml`
  (composite `setup-pnpm`).
* Docker layers: `docker/build-push-action` with `cache-from/to: type=gha`
  (scope `tellus-api`), `push: false`.

## Concurrency

`ci-<event>-<PR number | ref>`; `cancel-in-progress` only for `pull_request`.
Merge-queue, push and nightly runs are never cancelled. Label events other
than `run-full-ci` get a unique group so they never cancel an in-flight run.

## Nightly failures

`nightly.yml` keeps **one** open issue labelled `ci-nightly-failure`: created on
the first failure, commented on each further failure, commented + closed on
the next green run. The label is created automatically if missing.

## Effectiveness report

`ci-effectiveness.yml` (Mondays 06:00 UTC, or manual with `days`) writes a job
summary and a `ci-effectiveness` JSON artifact:

* failures per tier (PR, merge queue, post-merge push, nightly);
* **escaped-failure rate** — merge queue / post-merge runs that failed although
  the PR's head SHA had a green PR run, plus nightly failures on SHAs whose
  merge-queue/push run was green;
* share of PR runs that fell back to the full suite;
* recommendation: > 5 % escapes → selection too aggressive (widen groups /
  `run_all`); 0 escapes with > 50 % full fallbacks → too conservative.

## Security

* `permissions: contents: read` at the top of every workflow; jobs add only
  what they need (`pull-requests: read` for the planner, `pull-requests: write`
  for gitleaks, `issues: write` for the nightly notifier, `actions: read` for
  the report).
* All actions in the new/changed workflows are pinned to a full commit SHA.
* Only `pull_request` (never `pull_request_target`) — fork PRs receive no
  secrets; every secret has a CI-only fallback so fork runs still work.

## Required repository settings (manual)

1. Branch protection / ruleset on `main`: require only `ci-gate`
   (remove old checks: `Lint & SAST`, `TypeScript Typecheck`,
   `Unit Tests (no Docker)`, `Integration Tests`, `E2E Tests`, `coverage`,
   `ghost-pass-gate`, `scan`, `secret-scan`, …).
2. Enable the merge queue for `main`.
3. Labels `run-full-ci` and `ci-nightly-failure` (the latter is auto-created).

[dorny/paths-filter]: https://github.com/dorny/paths-filter
