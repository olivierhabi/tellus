# Tellus architecture

This document describes the active backend architecture. The implementation,
route mounts, migrations, and deployment configuration remain the source of
truth.

## System context

Tellus is a TypeScript/Express ontology platform. The separate Next.js frontend
uses its HTTP APIs. Authentication is provided by Keycloak-compatible JWTs.

The backend coordinates:

- PostgreSQL for authoritative metadata, object state, action state, repository
  contents, notification inboxes, and operational records.
- OpenSearch for indexed object search, filtering, aggregation, and retrieval.
- Kafka for asynchronous platform events.
- Temporal for durable workflows.
- S3-compatible object storage and Lakekeeper/Iceberg for dataset and analytical
  storage paths.
- Redis-backed overlays and temporary state where configured.
- OpenTelemetry for traces and metrics.

Local runtime files under `var/` are not authoritative storage. In particular,
code repositories persist in the `coderepo_stemma_*` PostgreSQL tables.

## Request path

```text
Next.js / API clients
        |
        v
Express middleware
  security headers, tracing, limits, authentication, security context
        |
        +--------------------+
        |                    |
        v                    v
Version 1 APIs          Version 2 APIs
ontology and platform   OSS/OMS-compatible ontology APIs
        |                    |
        +---------+----------+
                  v
          domain services
                  |
        +---------+----------+------------------+
        |                    |                  |
        v                    v                  v
    PostgreSQL           OpenSearch       async/storage systems
```

Middleware ordering and worker startup are defined in `src/server.ts` and are
operationally significant.

## API surfaces

The active server exposes several additive surfaces:

- `/api/v1/ontology/...` — ontology, object type, link type, action type,
  interface, branch, function, exploration, governance, and related APIs.
- `/api/v1/objects/...` — object query and object-view APIs.
- `/api/v1/actions/...` and ontology-scoped action routes — validation, single
  execution, and batch execution.
- `/api/v1/connectivity/...` — connections and production webhooks.
- `/api/v1/code-repositories/...` — PostgreSQL-backed repositories, branches,
  commits, files, transforms, and related developer workflows.
- `/api/v1/functions/...` and `/api/v1/jemma/...` — function registry,
  publication, and execution workflows.
- `/api/v1/projects/...`, `/api/v1/resources/...`, and `/api/v1/datasets/...`
  — project, resource, dataset, version, and upload APIs.
- `/api/v1/workshop/...` and `/quiver/api/v1/...` — Workshop and Quiver
  services.
- `/api/v2/ontologies/:ontology/...` — ObjectSet v2, objects, links, actions,
  and OMS metadata.

The generated endpoint reference is `docs/API_REFERENCE_GENERATED.md`.
`src/server.ts` is authoritative for mounts; route modules are authoritative
for individual operations.

## Core domains

### Ontology and object data

Ontology metadata is stored in PostgreSQL. Object reads use the query and
ObjectSet services, with OpenSearch as the indexed search layer. Security
filters are injected before search execution. Object identity uses stable RIDs
persisted with object instances.

### ObjectSet and OMS v2

`src/services/oss/` implements the canonical ObjectSet engine:

- schema validation and compilation;
- set algebra and cross-object-type execution;
- signed pagination tokens;
- saved and temporary object sets;
- aggregation accuracy controls;
- subscriptions and derived properties.

The v2 route adapters live under `src/routes/v2/`.

### Actions and side effects

The action executor validates authorization, parameters, submission criteria,
rules, writebacks, and optimistic version constraints before applying edits.
Durable external side effects are dispatched through the side-effect outbox.
Notification delivery includes recipient visibility filtering and an in-app
notification inbox.

Connectivity webhooks are resolved by RID and executed through the connectivity
engine, which owns secret resolution, egress protection, retries, idempotency,
and execution records.

### Code repositories and functions

Repository contents and history are authoritative in PostgreSQL under the
`coderepo_stemma_*` schema. The retired disk-workspace adapter is not part of
the active read or write path.

Repository transforms, function publication, developer-console services, and
code-assistant routes build on this store. Generated or temporary local
workspaces must never be committed.

### Data ingestion and indexing

Funnel and indexing services validate sources, transform rows, maintain object
identity, write authoritative records, and synchronize searchable documents to
OpenSearch. Reindexing and edit-overlay paths preserve ontology and branch
scope.

### Connectivity

Connectivity services manage connection metadata, encrypted configuration,
webhooks, executions, and source-specific operations. Production webhook
execution applies SSRF protections and pinned destination validation.

## Background processing

Tellus uses background workers for durable side effects, indexing and
integration work. Kafka carries platform events and Temporal coordinates
durable workflows where configured. Worker startup order and feature flags are
owned by `src/server.ts`; deployments must not reorder them casually.

## Security boundaries

- Authentication is enforced globally except for explicitly documented public
  health, documentation, development, and test-hook routes.
- Request security context carries markings and CBAC information into domain
  execution.
- Object reads apply security filtering at the shared search boundary.
- Mutating actions apply authorization and optimistic concurrency checks.
- Webhook egress passes through the safe transport layer.
- Secrets belong in the configured secret store or environment, never source
  control.

See `SECURITY.md`, `docs/SECRETS.md`, and `docs/AUDIT_CONTRACT.md` for active
security contracts.

## Documentation policy

Keep documents that define an active contract, architecture decision, API,
runbook, or security/operations requirement. Completed agent plans, progress
ledgers, verification transcripts, generated test output, and point-in-time
review reports should live in issue/PR systems or CI artifacts rather than the
repository.

When architecture changes:

1. update this document;
2. update or regenerate the API reference;
3. add an ADR when the change introduces a durable design decision;
4. keep executable tests as verification instead of committing transcripts.
