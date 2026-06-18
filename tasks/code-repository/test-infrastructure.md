# Code Repositories — Test Infrastructure Plan

> Per the brief's Starting Protocol §5: stand the harness up before B1 so
> integration and chaos tests are testable. This file specifies the harness
> contract; the harness is invoked from each `tests/integration/<service>/setup.ts`.

---

## 1. Container fleet (per-suite)

| Service | Library | Image | Notes |
|---|---|---|---|
| Postgres 16 | `@testcontainers/postgresql` (already in this repo) | `postgres:16-alpine` | One DB per service; isolated schemas. SERIALIZABLE isolation default for B7 (D-2026-05-01-003). |
| Kafka 3.7 | `@testcontainers/kafka` | `confluentinc/cp-kafka:7.6.0` | KRaft mode; auto-create topics. |
| Redis 7 | `@testcontainers/redis` | `redis:7-alpine` | For session caches (B9), idempotency replay store (G-C-21). |
| MinIO | `@testcontainers/minio` (or `GenericContainer` with `minio/minio`) | `minio/minio:latest` | S3-compatible blob; bucket per task. |
| Kubernetes | `kind` via shell driver (`tests/integration/setup-kind.sh`) | `kindest/node:v1.30.0` | One 3-node cluster shared across the B6/B9 suites; brought up once per `vitest run`. |
| Real `git` CLI | system `git` | n/a | Used as the test client against Stemma in B1 chaos. |

## 2. Owned-vs-mocked policy

The brief's Forbidden Behavior #1: "Mocking services you own (Stemma, Code
Repository, Jemma, etc.) in another task's integration tests."

| Service in test | Real (testcontainer / live in-process) | Mock |
|---|---|---|
| B1 Stemma | YES — real binary running against testcontainer Postgres | NO |
| B2 Code Repository | YES | NO |
| B3 Templates | YES | NO |
| B4 Imports | YES | NO |
| B5 OSDK Generator | YES | NO |
| B6 Jemma | YES — real pods on `kind` | NO |
| B7 JobSpec | YES | NO |
| B8 Functions Registry | YES | NO |
| B9 Live Preview | YES | NO |
| B10 Stemma Events | YES | NO |
| Compass (external) | live in-process testcontainer if available, else | recorded-fixture mock |
| Multipass | live testcontainer (Keycloak realm) | NO |
| OMS | live testcontainer (existing Tellus OMS) | NO |
| OSv2 / OSS | live testcontainer | NO |
| Funnel | recorded-fixture mock until needed | YES (no edges from this drive) |

## 3. Conjure contract test rig

- IR generated per service from `api/<service>.conjure.yml` (added per service).
- Client generated from IR via `conjure-typescript`.
- One contract test file per task at `tests/contract/<service>/<task>.contract.test.ts` driving the generated client against the live service (testcontainer).
- Tests are tagged with `@contract` and run as a separate vitest project.

## 4. Idempotency replay rig

`tests/contract/_helpers/idempotency.ts` provides:

```ts
async function replayIsExact(client, request, key) { /* G-C-22 */ }
async function replayConflicts(client, requestA, requestB, key) { /* G-C-23 */ }
```

Every POST that requires `Idempotency-Key` gets one of each pair.

## 5. Chaos rig

| Scenario | Driver | Spec citation |
|---|---|---|
| B1 N=50 push race | `tests/chaos/stemma/concurrent-push.chaos.test.ts` spawning 50 `git push` child procs against the running container | B1-C-50 |
| B6 push twice within 1 s | concurrent `B6.startRun` calls, polling for cancellation of first | B6-C-09, B6-C-34 |
| B7 two repos race output | two parallel `B7.publishJobSpecs` for same `(output, branch)` | B7-C-15 |
| B8 two CI pods race tag | two parallel `B8.publishVersion` with same key | B8-C-30 |
| B5 user push collides with auto-commit | concurrent `B5.generate` + Stemma push at same SHA | B5-C-14 |
| B10 1000-event burst | post-receive event injector flooding 1000 events | B10-C-15 |

## 6. Load rig

`k6` (binary, `brew install k6`) or `vegeta`. One `tests/load/<task>/k6.js` per
task. Recorded SLO sampled into `tasks/code-repository/progress/T-XX.md` SLO
table per the brief's Output Cadence.

The brief requires **two consecutive 30-min windows** per task per the spec
§6.3. The harness `tests/load/run-window.sh <task> <minutes=30>` runs one
window; the load suite gate runs two back-to-back and asserts both pass.

## 7. Audit verification rig

`tests/integration/_helpers/audit.ts` provides:

```ts
async function expectExactlyOneAuditRow(target_rid, action, principal_sub) { /* G-C-51 */ }
async function killAuditDbMidCall(call: () => Promise<unknown>) { /* G-C-52 */ }
async function expectBeforeAfterHashesDiffer(target_rid) { /* G-C-54 */ }
```

Every mutating endpoint integration test calls `expectExactlyOneAuditRow`.
Per the brief: response must fail when audit DB is killed mid-call.

## 8. Demo Flow E2E rig

`tests/e2e/demo-flow.spec.ts` is a single Playwright test that drives F3 → F6 →
F2 → F7 → F4 → F5 → F8 against a real, freshly-spawned cluster (containers +
kind). It runs against:

- A fresh Compass + Multipass realm seeded with one user `gena@tellus`.
- An OMS preloaded with `[Gena] Clinic` and `[Gena] Financial` object types.
- An OSS preloaded with one `Clinic` instance whose computation yields
  `40.51` for the test-fixture `calculateDaysSalesOutstanding`.

The Demo Flow Gate requires three consecutive passing runs with no flake.

## 9. Wiring location

- Backend setup: `tests/integration/_setup/setup.ts` orchestrates container
  startup. Per-task `tests/integration/<service>/setup.ts` consumes the global
  fixture.
- Frontend setup: `tellus-fe/tests/e2e/_setup/setup.ts` boots Next dev + the
  backend cluster reference.
- Vitest projects: one `vitest.<layer>.config.ts` per layer (unit, integration,
  contract, chaos, load, e2e). The aggregate `pnpm test:all` orchestrates.

This plan is implemented progressively as each wave is started; B1's
`progress/B1.md` includes the harness pieces it needs first.
