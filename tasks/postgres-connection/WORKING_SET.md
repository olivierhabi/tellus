# WORKING_SET — postgres-connection v2

Dependency-ordered execution plan per agent prompt §4.4 and spec §810–829.
Updated as tasks close. A task is **CLOSED** only when every §10 (prompt) / §833 (spec) item
is green; otherwise it is **IN-PROGRESS** with the specific failing step.

Legend: `[ ]` open, `[~]` in-progress, `[x]` closed-against-§10.

---

## Wave 0 — Planning + scaffolding (this session)

- [x] Read v2 spec end-to-end.
- [x] Audit existing `tellus` and `tellus-fe` repos for spec-named prerequisites.
- [x] Write `BLOCKERS.md`, `DEVIATIONS.md`, `DECISIONS.md`, `WORKING_SET.md` (this file).

## Wave 1 — B1

- [~] **B1** Connectivity module skeleton, Zod contracts, Compass folder binding.
  - In-progress files written: planning, B1/PLAN.md, migrations 074+075, error registry,
    error envelope, connectivity error catalog, B1 Zod contracts, ETag middleware.
  - Still to write before close: outbox.ts, connections.repo.ts, connections.handler.ts,
    compass.client.ts, openapi.ts, route registration, server.ts wiring, OpenAPI YAML emission
    script, generated TS client, unit tests, integration tests (Testcontainers PG), Grafana
    dashboard, Prometheus alerts, user docs.
  - All §10 closure items: see `tasks/postgres-connection/B1/CHECKLIST.md`.

## Wave 2 — B2, B3, F1 (parallel; depend only on B1)

- [ ] **B2** Credential vault, KMS adapter, AES-GCM, audit, rotation, internal unwrap.
- [ ] **B3** PostgreSQL connector (pg driver), TLS, discovery, type mapping.
- [ ] **F1** Data Connection app shell + Compass routing + permissions chrome.

## Wave 3 — B4, F2, F3

- [ ] **B4** BullMQ + `child_process` worker runtime + egress allowlist + per-tenant FIFO.
- [ ] **F2** Sources list view (depends on B1, B3).
- [ ] **F3** Connection creation wizard (depends on B1, B2, B3).

## Wave 4 — B5, B6, B8, F4, F5, F6, F8, F9

- [ ] **B5** TableImport CRUD + snapshot/append strategies + Iceberg local FS catalog.
- [ ] **B6** Agent + WSS reverse tunnel + agent-proxy worker path.
- [ ] **B8** Virtual tables federation (kysely + Arrow IPC + REST catalog facade).
- [ ] **F4** Connection detail + rotation + danger zone.
- [ ] **F5** Snapshot/Append sync wizard.
- [ ] **F6** CDC wizard with preflight inspector.
- [ ] **F8** Agents management UI.
- [ ] **F9** Virtual tables UI.

## Wave 5 — B7, F7

- [ ] **B7** CDC via `pg-logical-replication` + slot/publication lifecycle + Redpanda emitter.
- [ ] **F7** Sync detail (run history, lineage, live SSE, error triage).

## Wave 6 — B9

- [ ] **B9** Funnel three-stage pipeline + Postgres object DB + blue-green reindex.

## Wave 7 — B10, F10

- [ ] **B10** Ontology binding API + FK Link Types + OSDK regen hook.
- [ ] **F10** Ontology Manager binding integration + live Object Explorer + Quiver preview.

## Closure deliverables (after Wave 7)

- [ ] `REPORT-W1.md` … `REPORT-W7.md` (one per wave).
- [ ] `FINAL-REPORT.md` with the 200+ acceptance-criterion → test mapping and the F10 ≤5-minute
      end-to-end recording (deferred where infra-bound; in-session test substituted).
- [ ] `DEFERRED.md` per task documenting every production-scale criterion not run in-session.

---

## Session-capacity note (honest, per prompt §3.5)

Spec scope = 20 L/XL tasks, each requiring real implementation + Testcontainers integration
tests + Playwright + Lighthouse + dashboards + alerts + threat models (B2/B4/B6/B8) +
per-task OpenAPI + TS client + perf runs. Per the prompt §5 loop, each task is a real
multi-step execution. The full corpus cannot be closed in a single agent turn; this working
set is the contract for execution across however many turns it takes, and only ticks `[x]` on
a task when §10's twelve bullets are all green for it. No tick = not done.
