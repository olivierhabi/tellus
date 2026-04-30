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

## Summary of what's new

**23 new endpoints, one new route family** (`/funnel`):

- **Save-to-ontology commit path** — new UUID-keyed POST plus sibling
  GETs for status/history. Legacy apiName-keyed routes
  (`/objectTypes/:apiName/reindex`) remain for back-compat.
- **Object Data Store summary** — one new GET that collapses pipeline
  state + index-replacement state into three UI-ready fields.
- **Funnel control plane** — 22 endpoints covering durable signals,
  Lakekeeper bootstrap, Iceberg snapshots, ClickHouse link DDL, and
  the dual-index Quickwit replacement workflow.

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
