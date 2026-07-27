# Phase 5 — Durable Side-Effect Outbox + Worker + NotificationProvider

**Status:** complete and live-verified. Bug-risk surface covered by unit + live-e2e.
**Branches:** all changes additive; backward-compatible env-gated (`ACTION_SIDE_EFFECT_WORKER_ENABLED`).
**Migration surface:** reuse of Phase 1's migrations 127–132 (no new DDL).
**All file:line refs** are against `tellus/` at the head of this session (working tree).

---

## 1. Sub-phase inventory

| # | Sub-phase | Files | Status |
|---|-----------|-------|--------|
| 5.1 | BE model + insert path for `action_side_effect_job` (migration 131 schema already in DB) | `src/models/actionSideEffectJob.ts` | ✅ written in prior session; reused unchanged |
| 5.2 | BE — wire `actionExecutor` Stage 7 to INSERT the job rows inside `preCommitHook` (replaces fire-and-forget `fireActionWebhooks` + `sendNotifications`) | `src/actions/actionExecutor.ts` | ✅ |
| 5.3 | BE — `sideEffectWorker.ts` (SkipLocked claim, bounded backoff + jitter, retry/dead-letter, idempotency-key propagation, metrics) | `src/services/workers/sideEffectWorker.ts`, `src/services/funnel/metrics.ts` | ✅ |
| 5.4 | BE — `NotificationProvider` interface + InApp/Email/SlackCompatible providers (replace `mockSendNotification` path) | `src/actions/notificationProviders.ts` | ✅ |
| 5.5 | BE + FE unit tests + restart, final Phase 5 report | `tests/unit/actions/sideEffectJobExtractor-unit.test.ts`, `tests/unit/actions/actionSideEffectJob-unit.test.ts`, `tests/unit/services/sideEffectWorker-unit.test.ts`, `docs/phase5-durable-side-effect-outbox.md` | ✅ |

---

## 2. Architecture

```
┌────────────────────────┐                                ┌────────────────────────┐
│  actionExecutor.ts     │                                │  Side-effect Worker    │
│  Stage 7 (post-commit) │  (Phase 4 fire-and-forget      │  sideEffectWorker.ts   │
│  ─ fire webhooks       │   path retained when env flag  │  ─ runOnce / runWorkerLoop
│  ─ send notifications  │   is OFF)                      │  ─ retry policy        │
│                        │                                │  ─ metrics             │
│  preCommitHook (when   │                                │                        │
│  ACTION_SIDE_EFFECT_   │                                │  ┌────┐  ┌────┐         │
│  WORKER_ENABLED=1)     │                                │  │wb  │  │notif│         │
│  ─ INSERT job rows     │                                │  └─▲──┘  └─▲──┘         │
│    into action_side_   │                                │    │       │            │
│    effect_job          │   (atomic in apply txn)        │    │       │            │
└──────────┬─────────────┘                                │    │       │            │
           │                                              │    │       │            │
           └──────────────────────────────────────────────┼────┘       └──────→ NotificationProvider
                                                          │                   ├ inApp (stub log → Phase 6 inbox table + UI)
                              SELECT FOR UPDATE SKIP LOCKED │                   ├ email  (env-gated → real SMTP in Phase 6)
                              claimSideEffectJobs(limit)    │                   └ slack  (env-gated → real HTTP in Phase 6)
                                                          │
                                                          ▼
                                            ┌──────────────────────┐
                                            │ action_side_effect_  │
                                            │       job            │
                                            │  ─ pending / running │
                                            │  ─ retrying (next_)  │
                                            │    attempt_at        │
                                            │  ─ dead (operator-   │
                                            │    requeue able)     │
                                            │  ─ succeeded         │
                                            └──────────────────────┘
```

- **Atomicity.** Side-effect rows are INSERTed by the executor inside the same PG
  transaction as the audit row + ontology edits via `preCommitHook`. A worker
  crash mid-dispatch NEVER threatens the action commit. A side effect that
  fails later is recovered by the retry/dead-letter state machine.
- **Idempotency.** Each job carries an `idempotency_key` derived from
  `sha256(execution_id, attempt_count)` (`deriveIdempotencyKey` in
  `webhookSafeTransport`) so external systems de-duplicate retries safely.
- **Backward compat.** `ACTION_SIDE_EFFECT_WORKER_ENABLED` defaults to OFF.
  Existing deployments + integration tests keep using the legacy
  `fireActionWebhooks` + `sendNotifications` fire-and-forget path. The flag
  is env-only — no schema migration, no breaking route changes.

---

## 3. File inventory

### 3.1 Backend — new
- `src/actions/notificationProviders.ts` — `NotificationProvider` interface + 3
  initial providers + a process-local `getNotificationProvider` registry.
- `src/services/workers/sideEffectWorker.ts` — `runOnce`, `runWorkerLoop`,
  `DEFAULT_RETRY_POLICY`, `productionWebhookDispatch` (reuses `deliverOneWebhook`),
  `productionNotificationDispatch` (resolves provider via the registry),
  `productionDispatchForKind` (per-kind dispatcher).

### 3.2 Backend — edits
- `src/actions/actionExecutor.ts` —
  - imports added for `extractSideEffectJobs`, `SideEffectExecutionContext`,
    `enqueueSideEffectJobsInTransaction`;
  - `preCommitHook` extended: when `ACTION_SIDE_EFFECT_WORKER_ENABLED=1` and
    `actionType.side_effects != null`, extracts jobs via `extractSideEffectJobs`
    and INSERTs them via `enqueueSideEffectJobsInTransaction(pg, …)` inside the
    apply-commit PG transaction (atomic with the audit row + edits);
  - Stage 7 fire-and-forget retained as fallback when the env flag is OFF; gated
    by `process.env.ACTION_SIDE_EFFECT_WORKER_ENABLED !== "1"`.
- `src/actions/actionWebhooks.ts` — exported `deliverOneWebhook` (was private
  `deliverOne`) so the worker shares the legacy egress-guarded transport path.
- `src/models/actionType.ts` — added optional `definition_version` +
  `definition_hash` fields to `ActionTypeRow` (ledger for migration 132's
  columns so the BE-side SELECT * types align with reality).
- `src/services/funnel/metrics.ts` — added 4 new counter help strings, 1 new
  gauge help string, 1 histogram help string for P5 outbox.
- `src/server.ts` — spawned `runWorkerLoop` from boot when
  `ACTION_SIDE_EFFECT_WORKER_ENABLED=1`; AbortController-managed shutdown.

### 3.3 Backend — tests (3 suites, 29 new tests)
- `tests/unit/actions/sideEffectJobExtractor-unit.test.ts` — 9 tests:
  null/empty/[]/[]-webhooks/malformed webhook entries; webhook fanout (one row
  per spec); per-recipient notification split (one row per
  (spec, recipient)); empty-recipients drop; ordering guarantee (webhooks first
  then notifications); context propagation verbatim.
- `tests/unit/actions/actionSideEffectJob-unit.test.ts` — 12 tests:
  smart regex-driven DB mock that distinguishes BEGIN/COMMIT from SELECT/INSERT;
  enqueue (empty + 2 inserts + idempotency-key threading); claim (SkipLocked +
  UPDATE → empty short-circuit); markSucceeded (with + without external_receipt);
  markRetryOrDead (dead on maxAttempts reached, retrying under max, throws on
  missing row + ROLLBACK); requeueDeadSideEffectJob (UPDATE → pending + null
  when non-dead).
- `tests/unit/services/sideEffectWorker-unit.test.ts` — 8 tests:
  claim → dispatch → succeed; empty claim; retry → dead-letter (maxAttempts
  trip); mixed success+retry+dead-letter; dispatcher return value opacity
  (only throw triggers retry — `{ ok:false }` is a succeed because the
  contract is throw-on-failure); `limit` honored; operator requeue; requeue
  no-op on non-dead.

### 3.4 Frontend — none
All FE builder surface for writeback/side-effect combined builders is gated to
Phase 6 (the FE dialog today cannot compose a rule body + a writeback config
in one save — Phase 6 ships the combined builder that flips the persistence
gate off). This file is BE-only Phase 5.

---

## 4. Metrics surface

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `tellus_side_effect_claim_total` | counter | `kind` | jobs claimed per cycle |
| `tellus_side_effect_succeeded_total` | counter | `kind` | dispatches succeeded |
| `tellus_side_effect_retry_total` | counter | `kind`, `error_code` | dispatches retried |
| `tellus_side_effect_dead_total` | counter | `kind`, `error_code` | jobs dead-lettered |
| `tellus_side_effect_dispatch_duration_seconds` | histogram | `kind`, `outcome` | per-dispatch latency |
| `tellus_side_effect_queue_size` | gauge | `status` | queue depth by status (pending/running/succeeded/retrying/dead/failed) |

All help strings registered in `src/services/funnel/metrics.ts` so they
appear in the Prometheus scrape endpoint via `renderPrometheus()`.

---

## 5. Live-verified end-to-end (env flag ON)

```
$ ACTION_SIDE_EFFECT_WORKER_ENABLED=1 npx tsx src/server.ts
… Side-effect outbox worker started …
```

| Step | Command | Result |
|------|---------|--------|
| 1 | `POST /actionTypes phase5VerifyV1 (rules + sideEffects: webhook + email-notification)` | 201 persisted; `sideEffects` round-trips byte-equivalent through GET |
| 2 | `POST /actions/phase5VerifyV1/apply` with a real `OlivierOrder11` primary key | `result: "success"`, `affectedObjects: 1`, `executionId: 6a635b6e-f83f-4146-b582-871c01158643` |
| 3 | `SELECT status, kind, attempt_count FROM action_side_effect_job` | 2 rows inserted in the same txn as the audit row |
| 4 | watch queue for 30s | notification → `succeeded`, `external_receipt` populated; webhook → `retrying` × 4 attempts (bounded exp backoff + jitter), then `dead` (`attempt_count = 5`) |
| 5 | worker log | structured `console.warn` per failure (jobId, executionId, errorCode, attemptCountNext, nextStatus) + `side_effect_worker_cycle { claimed, succeeded, retrying, dead, durationMs }` |
| 6 | operator: `UPDATE … SET status='pending', attempt_count=0 WHERE status='dead'` then wait 7s | row re-claimed, dispatched, retried 2×; dead→pending → retrying path confirmed |

---

## 6. Test sweep used to verify no regression

| Suite | Command | Result |
|-------|---------|--------|
| BE unit tests (actions + services) | `npx vitest run --config vitest.unit.config.ts tests/unit/actions/ tests/unit/services/` | **472 passed / 33 files** |
| FE unit tests (actionBuilders + actionSemantics) | `npx vitest run tests/unit/actionBuilders.test.ts tests/unit/actionSemanticsFrontend.test.ts` (in `tellus-fe/`) | **33 passed / 2 files** |
| BE tsc | `npx tsc --noEmit` (excluding pre-existing `buildService.ts:906`) | clean |
| FE tsc | `npx tsc --noEmit` (excluding pre-existing `test24/`, `workshop/`, `projects/`) | clean |

---

## 7. Configuration reference

| Env var | Default | Effect |
|---------|---------|--------|
| `ACTION_SIDE_EFFECT_WORKER_ENABLED` | unset (legacy) | `=1` enables the durable outbox path (executor enqueues; worker drains); legacy fire-and-forget Stage 7 retained otherwise |
| `ACTION_SIDE_EFFECT_WORKER_INTERVAL_MS` | `2000` | Worker poll interval |
| `ACTION_SIDE_EFFECT_WORKER_BATCH` | `16` | Per-cycle claim limit (tunable to operator SLA + queue depth) |
| `EMAIL_PROVIDER_URL` | unset | When set, real email dispatch is wired (Phase 6 ships the SMTP/SendGrid adapter; today the provider stub-logs) |
| `SLACK_WEBHOOK_URL` | unset | When set, real Slack-compatible HTTP dispatch is wired (Phase 6 ships the safe-transport HTTP POST) |

---

## 8. Deferred to Phase 6 (none are Phase 5 blockers; tagged for clarity)

- Per-rule authorization + recipient data filter for notifications (drops
  recipients lacking visibility on the affected objects before dispatch).
- Real SMTP and Slack transport paths (env-gated stubs are in place today).
- `notification_inbox` table + FE inbox reader for in-app notifications.
- OpenTelemetry spans around each claim-dispatch-update cycle + queue stats
  traces (the metrics counters + the structured logs cover operations today;
  Phase 6 adds the per-cycle span).
- Operator UI for the dead-letter queue + manual retry + `requeueDeadSideEffectJob`
  CLI/admin surface (the model-layer API is in place).
- BE: thread `writebackOutputs` back into `compileRules.executionContext`
  (writeback runs AFTER compileRules in the current order — Phase 6 lands the
  Stage 3.5 placement or a two-pass compileRules).
- FE: combined rule-body + writeback/side-effect builder so the persistence
  gate flips OFF and the FE dialog can save both at once.

---

## 9. Operational zero-day runbook

| Symptom | First-action | Source of truth |
|---------|--------------|-----------------|
| Queue growing (pending > 100) | Check `tellus_side_effect_queue_size` gauge → finds new jobs faster than the worker claims them; bump `ACTION_SIDE_EFFECT_WORKER_BATCH` (or run multiple worker pods — `SELECT FOR UPDATE SKIP LOCKED` already supports this) | Prometheus scrape endpoint |
| Repeated `retry_total`+ tallies | Identify by `error_code` label → external endpoint 5xx or SSRF block | Worker structured log |
| `dead_total` rising | Operator inspects the row in `action_side_effect_job WHERE status='dead'`; runs `requeueDeadSideEffectJob(job_id)` after fixing the root cause | `idx_action_side_effect_job_dead` partial index |
| Notifications never delivered | Confirm `EMAIL_PROVIDER_URL` / `SLACK_WEBHOOK_URL` are set; check providers' stub-logged `console.info` lines | Worker structured log |
| Atomic enqueue failure | The executor's preCommitHook throws → applies the action's ROLLBACK → action returns 5xx AuditDurabilityError; no orphan side-effect rows possible | `actionExecutor.ts` Stage 7 |
