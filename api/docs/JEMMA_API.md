# Jemma API (B6)

**Mount prefix:** *(not mounted on the live server — available as a module)*
**Status:** **Module-ready** — `createJemmaAdminApp({ pool, scheduler })` from `src/services/jemma/admin/app.ts`. Wire by adding `app.use("/api/v1/jemma", createJemmaAdminApp({ pool, scheduler }))` to `src/server.ts` once a real Kubernetes worker adapter is wired.
**Source:** `src/services/jemma/`
**Migrations applied:** `054_b6_jemma`.

Jemma is the CI/CD execution plane. Each push triggers a `jemma_run` that
moves through the lifecycle `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT`.
A run has 5 ordered stages (`fetch → install → test → build → publish`).
The scheduler enforces a per-repo capacity cap of 4 concurrent runs and a
per-`(repo, ref)` singleton (cancel-in-flight on second push to same ref).

## Endpoints

### `POST /runs`

Enqueue a run. Idempotency-required.

```http
POST /api/v1/jemma/runs
Idempotency-Key: <uuid>
Content-Type: application/json

{
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "ref":           "refs/heads/main",
  "commitSha":     "0123abcd…",
  "triggerKind":   "PUSH",
  "image":         "tellus-ci-runner:2.4.0"
}
```

**201 Created**

```json
{
  "runRid":     "ri.jemma.main.run.<uuid>",
  "state":      "QUEUED",
  "stages":     [
    { "name": "fetch",   "state": "PENDING" },
    { "name": "install", "state": "PENDING" },
    { "name": "test",    "state": "PENDING" },
    { "name": "build",   "state": "PENDING" },
    { "name": "publish", "state": "PENDING" }
  ],
  "queuedAt":   "2026-05-03T12:35:00.000Z"
}
```

`triggerKind ∈ {"PUSH","PR","TAG","MANUAL"}`. `commitSha` matches `^[0-9a-f]{7,64}$`.

**Cancel-in-flight** — a second `POST /runs` with the same `(repositoryRid, ref)`
while a run is QUEUED or RUNNING cancels the prior run (graceful 30s SIGTERM
window) and returns a 201 for the new run.

### `GET /runs/:rid`

Returns the full run + stages + timestamps + failure reason if terminal.

```json
{
  "runRid":      "ri.jemma.main.run.<uuid>",
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "ref":         "refs/heads/main",
  "commitSha":   "0123abcd…",
  "triggerKind": "PUSH",
  "state":       "SUCCEEDED",
  "stages":      [ /* 5 stage rows with state + startedAt + finishedAt */ ],
  "queuedAt":    "2026-05-03T12:35:00.000Z",
  "startedAt":   "2026-05-03T12:35:02.000Z",
  "finishedAt":  "2026-05-03T12:36:48.000Z"
}
```

### `POST /runs/:rid:cancel`

Issues a cancel signal. Idempotent. ETag-guarded.

- QUEUED → CANCELLED with all stages SKIPPED.
- RUNNING → CANCELLED; running stage gets SIGTERM (30s grace), pending stages
  SKIPPED, succeeded stages stay SUCCEEDED.
- Terminal states → 200 with `replayed=true` (cancel is a no-op).

### `GET /runs?repositoryRid=…&state=…&pageSize=20&pageToken=…`

Cursor-paginated list. Filterable by `repositoryRid`, `ref`, `state`,
`triggerKind`. Cursor is opaque base64url, ≥30-day stable.

### `GET /runs/:rid/logs/chunks?stage=test&offset=0&limit=200`

Paginated log chunks for a single stage. Each chunk:

```json
{
  "stage": "test",
  "seq":   42,
  "stream": "stdout",
  "ts":    "2026-05-03T12:35:30.123Z",
  "line":  "PASS  src/foo.spec.ts (1.4s)"
}
```

### `GET /runs/:rid/logs` *(SSE — wave-12 follow-up)*

Server-sent-events stream of new chunks; emits `[DONE]` on terminal state.
Reconnect via `Last-Event-Id` for cursor resumption.

## Lifecycle invariants

- **At most one ACTIVE run per `(repository_rid, ref)`** — partial unique
  index `WHERE state IN ('QUEUED','RUNNING')`. Many TERMINAL rows can coexist
  on the same ref.
- **Lifecycle CHECK constraint** —
  - `QUEUED`: `started_at IS NULL AND finished_at IS NULL`
  - `RUNNING`: `started_at IS NOT NULL AND finished_at IS NULL`
  - terminal (`SUCCEEDED|FAILED|CANCELLED|TIMED_OUT`): `started_at IS NOT NULL AND finished_at IS NOT NULL`
- **Per-repo capacity cap = 4** — scheduler picks at most 4 concurrent RUNNING
  runs per `repository_rid`; excess stay QUEUED.
- **Stage advancement is monotonic** — once `fetch` finishes, no stage before
  it can transition.

## State machine (pure-logic)

8 events:

| Event kind | From | To |
|---|---|---|
| `scheduler-picked` | QUEUED | RUNNING |
| `stage-started` | RUNNING | RUNNING (+ stage marked) |
| `stage-succeeded` | RUNNING | RUNNING |
| `all-stages-succeeded` | RUNNING | SUCCEEDED |
| `stage-failed` | RUNNING | FAILED + subsequent stages SKIPPED |
| `cancel` | QUEUED \| RUNNING | CANCELLED |
| `timeout` (`scope=run\|stage`) | RUNNING | TIMED_OUT (reason: timeout-run \| timeout-stage) |
| `image-unavailable` | QUEUED | FAILED (reason: image-unavailable) |

Terminal states absorb every event kind; transitions throw
`IllegalRunTransition` with `code = "ILLEGAL_RUN_TRANSITION"`.

## Error names

| `errorName` | HTTP | When |
|---|---|---|
| `Jemma:RunNotFound` | 404 | Unknown run RID. |
| `Jemma:InvalidArgument` | 400 | Validation failure (bad SHA, unknown trigger kind). |
| `Jemma:RateLimitExceeded` | 429 | Per-repo capacity exhausted; retry with backoff. |
| `Jemma:Internal` | 500 | Scheduler internal error. |
| `Jemma:WorkerUnavailable` | 503 | Kubernetes / worker adapter unreachable. |
| `Jemma:Unauthenticated` | 401 | Missing principal. |

## Schema highlights (migration 054)

- `jemma_run (run_rid PK, repository_rid FK, ref, commit_sha CHECK regex, trigger_kind CHECK, state CHECK, image, principal_sub UUID, queued_at, started_at, finished_at, failure_reason, …)`
- `jemma_run_stage (run_rid FK CASCADE, stage_name CHECK, state CHECK, started_at, finished_at, exit_code, …, PRIMARY KEY (run_rid, stage_name))`
- Partial unique index `(repository_rid, ref) WHERE state IN ('QUEUED','RUNNING')`.

## Test coverage

- `tests/unit/code-repos/jemma/state-machine-unit.test.ts` — 25 cases
- `tests/unit/code-repos/jemma/errors-unit.test.ts` — 9 cases
- `tests/integration/code-repos/jemma/run-store-integration.test.ts`
- `tests/integration/code-repos/jemma/scheduler-integration.test.ts`
- `tests/integration/code-repos/jemma/admin-routes-integration.test.ts`
- `tests/integration/code-repos/migrations/054-b6-jemma-roundtrip-integration.test.ts` — 12 cases

## Open work for full B6 DoD

- Real Kubernetes worker adapter (kind/k3d) — current adapter is in-memory test mode
- 1000-event burst chaos test
- Concurrency chaos: 2 pushes within 1s on same ref → first cancelled, second runs
- Load test: queue-to-start P95 < 5s warm
- SSE log streaming P95 < 1s
- Runbook
