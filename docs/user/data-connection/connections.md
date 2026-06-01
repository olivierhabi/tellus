# Tellus Data Connection — Connections

> **Status.** B1 implementation. CRUD against `/api/v2/connectivity/connections` is live.
> Credential vault (B2), PostgreSQL connector (B3), syncs (B5), CDC (B7), virtual tables (B8)
> ship in subsequent waves and are documented as they land.

## What is a Connection?

A **Connection** is a customer-defined data source — currently PostgreSQL only — that
Tellus uses to import and/or federate data. Each Connection is owned by a Compass folder
and is governed by a Multipass scope: `connectivity:read` for visibility, `connectivity:write`
for mutation.

Connections are versioned (`version` field, exposed as the `ETag` header in weak form,
`W/"<n>"`) and use optimistic concurrency. Mutations require an `If-Match` header carrying
the current `ETag`; a stale `If-Match` returns **HTTP 409**
`Tellus:Connectivity:ResourceVersionMismatch`.

## Creating a connection

```http
POST /api/v2/connectivity/connections HTTP/1.1
Authorization: Bearer <multipass-jwt with connectivity:write>
Idempotency-Key: 8a9c5fdf-7d2c-4f88-b9c2-2c25f5d3a3a1
Content-Type: application/json

{
  "name": "my-pg-source",
  "description": "Read replica of fraud detection DB",
  "connectorType": "postgresql",
  "workerType": "foundryWorker",
  "config": {
    "connectorType": "postgresql",
    "postgres": {
      "host": "db.example.com",
      "port": 5432,
      "database": "fraud",
      "tlsMode": "verify-full"
    }
  },
  "egressPolicy": {
    "allowlist": [{ "kind": "host", "host": "db.example.com", "port": 5432 }]
  },
  "compassFolderRid": "ri.compass.main.folder.<uuid>"
}
```

**Response (201 Created):**

```http
HTTP/1.1 201 Created
ETag: W/"1"
Location: /api/v2/connectivity/connections/ri.magritte.main.source.<uuid>
Content-Type: application/json

{ "rid": "ri.magritte.main.source.<uuid>", "version": 1, ... }
```

`Idempotency-Key` is required for production clients and replays the original response
verbatim for 24 hours.

## Editing a connection

```http
PUT /api/v2/connectivity/connections/{rid} HTTP/1.1
Authorization: Bearer ...
If-Match: W/"3"
Content-Type: application/json

{ "description": "Updated description" }
```

- Missing `If-Match` → **HTTP 412** `Tellus:Connectivity:IfMatchRequired`.
- Stale `If-Match` → **HTTP 409** `Tellus:Connectivity:ResourceVersionMismatch`.
- Reload the resource, merge your changes against the new version, re-PUT.

## Deleting a connection

```http
DELETE /api/v2/connectivity/connections/{rid} HTTP/1.1
Authorization: Bearer <multipass-jwt with connectivity:write>
If-Match: W/"5"
```

Returns **HTTP 204**. The connection is soft-deleted (`deleted_at IS NOT NULL`); future
reads return 404. Deleting a connection that has active TableImports or VirtualTables
returns **HTTP 412** `Tellus:Connectivity:HasActiveDependencies` with the dependency list
in `parameters.dependencies`.

Deleting the **Compass folder** holding active connections is blocked at the database layer
by `connectivity_connections_folder_fk` (ON DELETE RESTRICT). PostgreSQL returns
`foreign_key_violation`; Compass surfaces a friendly error.

## Compass binding

Creating a connection registers a sibling `resources` row of type `source` under the named
folder via a transactional outbox. The outbox poller dispatches in the background; even if
Compass is temporarily slow, the connection insert commits and Compass eventually catches
up. Inspect outbox health via Grafana → "Tellus Connectivity" → "Outbox backlog".

## Status endpoint

```http
GET /api/v2/connectivity/connections/{rid}/status HTTP/1.1
```

Returns `{ rid, state, lastCheckedAt, details }` where `state` ∈
`UNKNOWN | HEALTHY | DEGRADED | UNREACHABLE | AUTH_FAILED | TLS_FAILED`.

B1 emits `UNKNOWN` until B3's `testConnection` ships and populates the status log.

## Error envelope

All 4xx/5xx responses use the Conjure-style envelope:

```json
{
  "errorCode": "CONFLICT",
  "errorName": "Tellus:Connectivity:ResourceVersionMismatch",
  "errorInstanceId": "9e1c2b22-...-...-...-............",
  "parameters": { "provided": 3, "current": 5 }
}
```

The `errorInstanceId` correlates to a log line; pass it to support when raising a ticket.
Sensitive parameter keys (`password`, `secret`, `token`, `ciphertext`, `kek`, …) are
redacted automatically before serialization.

## Required Multipass scopes

| Endpoint | Scope |
|---|---|
| `POST /connections` | `connectivity:write` |
| `GET /connections`, `GET /connections/{rid}` | `connectivity:read` |
| `PUT /connections/{rid}` | `connectivity:write` |
| `DELETE /connections/{rid}` | `connectivity:write` |
| `GET /connections/{rid}/configuration` | `connectivity:read` |
| `GET /connections/{rid}/status` | `connectivity:read` |

A token bearing the wildcard `connectivity:*` scope satisfies all routes.

## Generated OpenAPI

```bash
npm run generate:openapi:connectivity
# writes openapi/connectivity.yaml and openapi/connectivity.json
```

The frontend regenerates its typed client (`tellus-fe/lib/api/connectivity.gen.ts`) from
`openapi/connectivity.json` via `openapi-typescript`. CI fails the build if the committed
YAML drifts from the regenerated output.

## Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `tellus_connectivity_request_duration_seconds` | histogram | `route`, `method`, `status` | Per-request latency. |
| `tellus_connectivity_errors_total` | counter | `errorName`, `route` | Total typed errors. |
| `tellus_connectivity_outbox_enqueued_total` | counter | `operation` | Outbox rows enqueued. |
| `tellus_connectivity_outbox_deliveries_total` | counter | `operation`, `result` | Outbox dispatches. |
| `tellus_connectivity_outbox_dispatch_duration_seconds` | histogram | `operation` | Per-row dispatch latency. |
| `tellus_idempotent_replay_total` | counter | `endpoint` | Idempotency-Key replays returned from cache. |

Alerts in `alerts/connectivity.yml` cover SLO breach, error spikes, outbox backlog, and
outbox failure rate.
