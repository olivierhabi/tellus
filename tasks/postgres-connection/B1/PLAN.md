# B1 PLAN

≤200 words per agent prompt §5.2.

**File order.**
1. Migrations 074 (connections) + 075 (outbox), up + down.
2. `src/lib/errors/{envelope,registry,connectivity.errors}.ts`.
3. `src/services/connectivity/contracts.ts` — Zod for `Connection`, `TableImport`, `VirtualTable`, `Driver`.
4. `src/middleware/etag.ts` — `setEtag(res, version)` + `requireIfMatch(req, version)`.
5. `src/services/connectivity/store/{connections.repo.ts,outbox.ts}` — Knex repo + outbox writer.
6. `src/services/connectivity/clients/compass.client.ts` — typed wrapper over `../../compassService`.
7. `src/services/connectivity/handlers/connections.handler.ts` — Express handlers for the 7 routes in spec §62–70.
8. `src/services/connectivity/openapi.ts` — Zod → OpenAPI 3.1 emitter; writes `openapi/connectivity.yaml`.
9. `src/services/connectivity/index.ts` + `src/routes/connectivity.routes.ts` — module entry + Express router; mounted from `src/server.ts`.
10. `scripts/generate-openapi-connectivity.ts` + `package.json` script.

**Test fixtures.** `tests/fixtures/containers.ts` — `startPostgres16()` via `@testcontainers/postgresql`; `tests/connectivity/b1.integration.test.ts` runs the six in-session acceptance criteria literally.

**Perf approach.** B1 has no SLO load test; cross-cutting p99 ≤150ms read / ≤400ms write asserted in integration tests via single-request latency budgets.

**Library choices.** Express 4, Knex 3, `zod` 4 (in deps), `@asteasolutions/zod-to-openapi` 7, `openapi-typescript` 6. To install: the last two only.
