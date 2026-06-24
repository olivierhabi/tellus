# API Documentation — uncommitted additions

This directory documents every new or modified HTTP endpoint introduced
by the current branch (`adding-ontology`) over `main`. Existing docs
for the baseline API surface live in `/docs/API_REFERENCE.md`.

## Contents

| File | What it covers | Mount prefix |
|---|---|---|
| [`COMMIT_AND_INDEXING_API.md`](./COMMIT_AND_INDEXING_API.md) | UUID-keyed "Save to ontology" commit + reindex status/history | `/api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId` |
| [`OBJECT_DATA_STORE_API.md`](./OBJECT_DATA_STORE_API.md) | Single summary card used by the Datasources tab's "Object Storage V2" card | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/dataStore` |
| [`FUNNEL_API.md`](./FUNNEL_API.md) | Object Data Funnel — signals, runs, snapshots, overlay, Lakekeeper, ClickHouse links, Quickwit index replacement | `/api/v1/funnel` |
| [`OBJECT_EXPLORER_API.md`](./OBJECT_EXPLORER_API.md) | Object Explorer production-readiness — every endpoint touched by T-01..T-10 (charts, sql, exports, summary, explorations, search/searchFullText/searchAround, observability) | `/api/v1/objects/*`, `/api/v1/sql`, `/api/v1/charts`, `/api/v1/ontology/:ontologyId/{summary,explorations,exports}` |
| [`CODE_REPOSITORY_API.md`](./CODE_REPOSITORY_API.md) | **(Live)** B2 Code Repository service — createRepository saga, list/get/patch/delete, branches, settings | `/api/v1/code-repositories` |
| [`STEMMA_API.md`](./STEMMA_API.md) | B1 Stemma — admin (repos + refs CAS) + smart-HTTP (`info/refs`, `git-receive-pack`, `git-upload-pack`) | *module-only* |
| [`STEMMA_EVENTS_API.md`](./STEMMA_EVENTS_API.md) | B10 Stemma Events — pre-receive policy, post-receive durable-before-ack, HMAC-signed callback fan-out, cursor-paginated event log, subscriptions | *module-only* |
| [`JEMMA_API.md`](./JEMMA_API.md) | B6 Jemma — CI/CD run lifecycle, scheduler, per-repo capacity cap + per-(repo,ref) singleton, log chunks/SSE | *module-only* |
| [`TEMPLATES_API.md`](./TEMPLATES_API.md) | B3 Templates — deterministic scaffold engine for new repos (typescript-functions, python-functions, transforms-{python,java,sql}) | *module-only* |
| [`JOBSPEC_API.md`](./JOBSPEC_API.md) | B7 JobSpec Publisher — per-(repo,branch) JobSpec graph, per-output uniqueness, cycle detection, orphan replacement | *module-only* |
| [`FUNCTIONS_REGISTRY_API.md`](./FUNCTIONS_REGISTRY_API.md) | B8 Functions Registry — append-only function versions, branch-aware semver resolution, yank lifecycle | *module-only* |

## Summary of what's new

**23 ontology/funnel endpoints + 7 Code Repositories services** (`/code-repositories` is live; the rest are module-ready):

- **Save-to-ontology commit path** — new UUID-keyed POST plus sibling
  GETs for status/history. Legacy apiName-keyed routes
  (`/objectTypes/:apiName/reindex`) remain for back-compat.
- **Object Data Store summary** — one new GET that collapses pipeline
  state + index-replacement state into three UI-ready fields.
- **Funnel control plane** — 22 endpoints covering durable signals,
  Lakekeeper bootstrap, Iceberg snapshots, ClickHouse link DDL, and
  the dual-index Quickwit replacement workflow.
- **Code Repositories suite (B1, B2, B3, B6, B7, B8, B10)** — see
  [`CODE_REPOS_OVERVIEW.md`](./CODE_REPOS_OVERVIEW.md) for cross-cutting
  conventions (RID, error envelope, ETag, idempotency, audit chain,
  IDOR-as-404). B2 (`/api/v1/code-repositories`) is wired into the live
  server at `src/server.ts:558` and validated by a 7-case Cypress e2e
  suite running against the full Docker stack
  (`tellus-fe/cypress/e2e/code-repositories.cy.ts`). The other six
  services ship as Express app factories that import-and-mount cleanly
  but are not wired into `src/server.ts` yet.

## Conventions

- Every endpoint below the `/api/v1` prefix returns JSON.
- Success responses use `sendSuccess` (`200` with body) or
  `sendCreated` (`201`) unless noted. `sendSuccess(res, data, 202)` is
  used for **"accepted, async work started"** semantics.
- Error responses follow the structured envelope:
  ```json
  {
    "error": "<CODE>",
    "message": "<human-readable>",
    "statusCode": <http_status>,
    "requestId": "<uuid>"
  }
  ```
  Routes outside the response-formatter helpers return a flat
  `{error, message}` object.
- Auth: bearer via `Authorization` header OR `TELLUS_TOKEN` cookie.
  The backend JWT middleware accepts both Tellus-issued and Keycloak
  access tokens.
- Request IDs: every response carries `X-Request-Id` for log correlation.
