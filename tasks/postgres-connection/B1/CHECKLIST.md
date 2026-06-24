# B1 §10 closure checklist

Per agent prompt §10. A task is **done** iff every line is green. Status today: all OPEN
unless marked otherwise. Last updated: 2026-05-18.

| # | §10 item | Status | Evidence |
|---|---|---|---|
| 1 | Every file in Files-to-Create exists with real code | **partial** | written: migrations 074/075 (up+down), `src/lib/errors/{envelope,registry,connectivity.errors}.ts`, `src/services/connectivity/contracts.ts`, `src/middleware/connectivityEtag.ts`. Still to write: `src/services/connectivity/{index,openapi}.ts`, `store/{connections.repo,outbox}.ts`, `handlers/connections.handler.ts`, `clients/compass.client.ts`, `src/routes/connectivity.routes.ts`. |
| 2 | Every endpoint implemented + documented response shape | **open** | 0 of 7 handlers wired. |
| 3 | Every error code implemented + registered + reachable in test | **partial** | 13 codes registered in `src/lib/errors/connectivity.errors.ts`; reachability tests pending. |
| 4 | Every metric emits with exact name + labels | **open** | `tellus_idempotent_replay_total` already emitted by existing idempotency middleware (reused). `tellus_connectivity_request_duration_seconds{route,method,status}` histogram + per-status counters pending. |
| 5 | Unit tests cover ≥80% branches on new code | **open** | none written. |
| 6 | Integration tests against Testcontainers exercise each acceptance criterion literally | **open** | testcontainers harness not yet wired. |
| 7 | Frontend Playwright (1 happy + 2 error per route) | **n/a for B1** | B1 is backend-only. |
| 8 | Load-test SLOs met where named | **n/a for B1** | B1 has no SLO load test. |
| 9 | Grafana dashboard JSON + Prometheus alert rules committed | **open** | `dashboards/connectivity.json` + `alerts/connectivity.yml` pending. |
| 10 | User-facing docs updated | **open** | `docs/user/data-connection/connections.md` pending. |
| 11 | Lighthouse ≥90 on new frontend routes | **n/a for B1** | |
| 12 | Conjure IDL/OpenAPI generated, lint passes, TS+Python clients compile | **open** | `npm run generate:openapi:connectivity` script + emitter + generated YAML + `openapi-typescript` client all pending. Python client deferred to a tooling task. |
| — | PR description with criterion→test mapping | **open** | |

## Acceptance criteria mapping (spec §76)

| # | Criterion | Verifying test (planned) |
|---|---|---|
| 1 | Round-trip CRUD with valid `If-Match`; invalid → 409 | `tests/connectivity/b1.integration.test.ts:crud-happy-path` + `:if-match-mismatch` |
| 2 | Concurrent PUT with same `If-Match` → one 2xx + one 409 | `:concurrent-put-occ` |
| 3 | Soft-delete excludes from list; read returns 404 | `:soft-delete-semantics` |
| 4 | `Idempotency-Key` 24h replay returns original response | `:idempotency-replay` (uses existing middleware) |
| 5 | Compass folder deletion blocked while connection exists | `:compass-folder-locked-by-connection` |
| 6 | CI: openapi.yaml committed + TS client compiles | `tests/connectivity/b1.openapi-emission.test.ts` + `scripts/check-openapi-up-to-date.sh` |

## Deferred (none for B1)

Spec §84: "Deferred. None — B1 has no infra-blocked criteria."
