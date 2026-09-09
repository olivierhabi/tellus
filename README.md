# Ontology Engine

[![CI](https://github.com/olivierhabi/tellus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/olivierhabi/tellus/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/olivierhabi/tellus/branch/main/graph/badge.svg)](https://codecov.io/gh/olivierhabi/tellus)

## 1. Overview

The Ontology System Engine is an open-source implementation of the core concepts from Palantir Foundry's Ontology. It provides a semantic layer that maps datasets to real-world entities (objects), with typed properties, relationships (links), and parameterized edit operations (actions). On top of the ontology kernel it ships a dataset/datasource indexing pipeline (PostgreSQL → OpenSearch), an action engine with audit logging and idempotency, a branch/merge model, an Automate platform (conditions, effects, Functions with a canonical invocation contract), and a Temporal-backed object data funnel.

## 2. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.x | pinned by `engines` in `package.json` and `.nvmrc` |
| pnpm | 10.x | pinned by `packageManager` in `package.json` (`corepack enable` is enough) |
| Docker + Docker Compose | any recent | runs the local service stack (Postgres, OpenSearch, Keycloak, MinIO, …) |
| Git | — | |

## 3. Install

```bash
git clone https://github.com/olivierhabi/tellus.git
cd tellus
pnpm install
```

## 4. Environment Setup

```bash
cp .env.example .env
```

`.env.example` documents every variable the server reads (database, OpenSearch, Keycloak, S3/MinIO, Temporal, rate limits). The defaults target the docker-compose stack below, so a fresh copy works without edits.

For the test lanes there are **no baked-in credentials**: export the test-only variables documented in [`.env.test.example`](.env.test.example) before running suites or the datasource test scripts:

```bash
cp .env.test.example .env.test   # fill in values
set -a; source .env.test; set +a
```

## 5. Local Service Stack (Docker Compose)

The CI pipeline ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs against the same services the local `docker-compose.yml` provides. To start the core stack the API needs:

```bash
docker compose up -d postgres opensearch keycloak minio
```

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL 16 | `127.0.0.1:5432` | metadata store + object instances |
| OpenSearch 2 | `127.0.0.1:9200` | search / serving indices |
| Keycloak 25 | `127.0.0.1:8086` | SSO / OAuth 2.0 identity provider |
| MinIO | `127.0.0.1:9000` (S3 API), `127.0.0.1:9001` (console) | dataset/file object storage |

The full stack adds Redis (`6379`), Kafka (`9092`, with Zookeeper `2181`), ClickHouse (`8123`), Temporal (`7233`) and Lakekeeper (`8181`) for the funnel/analytics features:

```bash
docker compose up -d          # everything, including the containerised app on :3000
```

All ports are bound to `127.0.0.1` only. Teardown: `docker compose down` (add `-v` to wipe the volumes).

## 6. Database Setup

```bash
npm run migrate          # core migrations (src/migrations/)
npm run migrate:all      # core + foundry + auth passes
```

## 7. Run

```bash
npm run dev              # nodemon + tsx, API on http://localhost:3000
```

Production build/run:

```bash
npm run build            # tsc → dist/ + asset copy
npm start                # node dist/server.js
```

Health check: `curl http://localhost:3000/health`.

## 8. Test

Export the test-only variables first (see §4).

```bash
npm run test:unit        # pure unit lane, no Docker required (vitest.unit.config.ts)
npm run test:coverage    # default vitest config with v8 coverage → coverage/
```

Other lanes (need the docker stack up):

```bash
npm test                       # unit + integration + e2e vitest discovery
npm run test:integration
npm run test:e2e               # bash/curl end-to-end suites
npm run test:perf              # benchmarks
npm run test:all               # consolidated runner (tests/runAll.ts)
```

### One-command smoke test

With the docker stack running and test env vars exported:

```bash
npm run migrate && npm run seed && npm run test:unit
```

Expected passing output: migrations apply (or report already-applied), the seed prints its RRA ontology summary (`Seed complete` with object-type/datasource counts), and vitest ends with `Test Files  N passed (N)` / `Tests  M passed (M)` and exit code `0`.

> **Note:** `npm run seed` resets the enterprise ontology and is protected by the destructive-test guard (`src/services/testing/destructiveTestGuard.ts`). Against a dev-shaped database it refuses to run; the CI jobs run it inside a sealed, test-shaped lane (FUNN-ISO-1). To smoke-test only the safe path locally, `npm run migrate && npm run test:unit` is sufficient.

## 9. Architecture Overview

TypeScript/Express API server backed by PostgreSQL (system of record) and OpenSearch (serving/search), with MinIO for blobs and Temporal for durable funnel execution.

| Path | Responsibility |
|------|----------------|
| [`src/server.ts`](src/server.ts) / [`src/boot`](src/boot) | process entry, middleware wiring, graceful shutdown |
| [`src/routes`](src/routes) | HTTP route handlers (objects, actions, links, search, ontology, datasets, functions, automate, …) |
| [`src/services`](src/services) | business logic: query/indexing pipeline, branch merge, link resolution, storage, automate runtime, function executor |
| [`src/models`](src/models) | domain model types (link types, action audit log, funnel state, …) |
| [`src/actions`](src/actions) | action engine: validation, rule compilation, edit application, idempotency |
| [`src/middleware`](src/middleware) | auth (Keycloak/PAT), rate limiting, validation, error handling |
| [`src/migrations`](src/migrations) | numbered SQL migrations applied by `npm run migrate` |
| [`src/workers`](src/workers) / [`src/workflows`](src/workflows) | Temporal worker + workflow definitions for the object data funnel |
| [`tests`](tests) | vitest lanes: `unit/`, `integration/`, `e2e/`, `funnel/`, plus the pinned lane identity in `tests/laneEnv.ts` |

Deeper design docs live in [`docs/`](docs/) (operations runbooks, the function invocation contract, evidence policy). [`AGENTS.md`](AGENTS.md) documents the verification stack and test-lane invariants.

## 10. CI & Release Cadence

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) gates every PR: **lint** (`npm run lint`, fails the build), **typecheck** (`tsc --noEmit`), unit, integration, e2e, perf, and a secret scan.
- Dependency updates are automated via Dependabot ([`.github/dependabot.yml`](.github/dependabot.yml), weekly npm).
- Releases follow semver tags (`v0.3.0` …) with a corresponding [CHANGELOG.md](CHANGELOG.md) entry. Fixes and features land as small commits that include their tests together.
