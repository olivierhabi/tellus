# Developer Console: Enterprise Parity and Gap Analysis

- **Status:** Architecture decision record and executable production-readiness plan
- **Last reviewed:** 2026-07-20
- **Scope:** Tellus `/developer-console`, third-party applications, Ontology SDK generation, application telemetry, and service-user sharing

## Executive decision

Tellus now implements a secured Developer Console control plane and an immutable artifact-registry MVP. It can register an application, provision and rotate a real Keycloak OAuth client, persist tenant-scoped configuration, enforce application ACLs, bind the application to authoritative resources from Ontology Manager, compile a deterministic npm-compatible package, publish it to content-addressed object storage, install its generated runtime, query the real Object API, accept bounded metrics, and maintain durable audit and reconciliation state.

The implementation does **not** yet satisfy every certification gate in this program. The remaining platform programs are:

1. complete OSDK conformance for every ontology type, link, interface, action, function, edit, auth, and compatibility behavior;
2. authoritative gateway telemetry and analytics-store rollups rather than application-submitted raw points;
3. downstream policy enforcement and drift repair for every recorded service share;
4. multi-region recovery, independently verified tenant isolation, capacity certification, and operational SLO evidence.

Consequently, the correct current claim is:

> Tellus has a production-capable single-tenant Developer Console control plane, an Ontology-Manager-integrated generator/runtime, and an immutable artifact-registry MVP. Phase 0 engineering gates and the implemented Phase 1 core are E2E verified. Unrestricted multi-tenant production and literal Palantir equivalence remain prohibited claims until the later certification gates pass.

This is not only a terminology distinction. The missing systems own important security, compatibility, durability, availability, and operational contracts that cannot be provided by a UI or a few synchronous HTTP handlers.

### Current release classification

| Environment | Decision | Conditions |
|---|---|---|
| Local development and automated tests | Approved | Test hooks and development signing/KMS fallbacks must remain impossible in production configuration |
| Controlled internal pilot | Approved | Named users, explicit operator ownership, backups, and documented rollback |
| Single-tenant production | Conditionally approved | Managed KMS/signing, artifact SSE, production test-hook exclusion, backup/restore, alerts, and deployment-specific smoke evidence are mandatory |
| Multi-tenant production | Blocked | Independent isolation testing and Phase 4 downstream policy enforcement/recovery gates must pass |
| Tellus SDK/registry MVP | Conditionally approved | Immutable package workflow is operational; npm CLI auth, managed signing, scanning, restore, and complete runtime conformance remain release gates |

No phase may be declared complete from UI behavior alone. Promotion requires the exit evidence defined in this document and a signed release-readiness record.

## What “100% clone” would require

A defensible 100% claim requires parity at four independent layers:

| Layer | Required evidence | Current state |
|---|---|---|
| User interface and information architecture | Every supported screen, state, action, validation, and error matches an explicit reference contract | Substantial coverage for the implemented Developer Console route tree |
| API and behavior | Compatible request/response schemas, authorization, concurrency, errors, pagination, versioning, and lifecycle behavior | Partial; core application and configuration workflows exist |
| SDK and runtime | Compatible generated APIs plus working query, link, action, function, auth, error, and pagination semantics | Partial source generation; no complete runtime |
| Platform operations | Registry, workers, queues, policy enforcement, telemetry, audit, disaster recovery, multi-tenant isolation, scaling, and SLOs | Not implemented as an integrated Developer Console platform |

Passing UI E2E tests proves the tested workflows. It does not prove undocumented behavior, proprietary internal equivalence, global scale, or every edge case. Palantir's complete private implementation and acceptance suite are not available in this repository. Therefore, Tellus can certify compatibility with a **Tellus-owned public contract**, but it cannot honestly certify literal equivalence to all Foundry internals.

## Parity objective and reference boundary

The engineering target is **behavioral parity for a declared reference surface**, not reconstruction of private Palantir internals. Before implementation continues, product and engineering must publish a frozen reference manifest containing:

- the observed Foundry edition, deployment type, UI/API version where visible, and capture date;
- every in-scope route, screen, state, control, validation, permission, error, and lifecycle transition;
- public request/response contracts and externally observable concurrency and pagination behavior;
- supported application types, OAuth flows, ontology resources, SDK languages, package clients, and runtime environments;
- explicit exclusions and intentional Tellus differences;
- provenance for each requirement: public documentation, authorized observation, Tellus product decision, or interoperability requirement;
- a stable requirement ID mapped to design, implementation, test evidence, and release status.

The reference manifest is versioned and immutable after approval. Changes require a new manifest version and compatibility assessment. “Current Foundry” is not an acceptable target because it moves independently of Tellus releases.

### Permitted claims

| Claim | When it is permitted |
|---|---|
| `Foundry-inspired` | Visual or conceptual similarity is documented; no compatibility implication |
| `Foundry-faithful for declared workflows` | The frozen behavior matrix passes for the named workflows and intentional differences are published |
| `100% Tellus Developer Platform Specification vN compliant` | Every mandatory requirement in the named specification passes its conformance suite |
| `100% Palantir Foundry clone` | Not permitted without an authoritative Palantir specification, lawful reference access, and an authoritative conformance suite |

## What is implemented today

### Application control plane

Migrations `111_developer_console_applications.sql` and `114_developer_console_production_control_plane.sql`, the route authorization middleware, and `DeveloperConsoleService` implement:

- third-party application records with Foundry-style application RIDs;
- application list, search, recent, “mine,” and favorite behavior;
- public and confidential OAuth client metadata;
- Keycloak client provisioning during application creation;
- one-time return of the confidential client secret from the create response;
- redirect URI, restriction, permission-mode, grant-type, scope, and project-grant persistence;
- soft deletion of applications and durable identity-deletion reconciliation;
- application owner/editor/viewer ACLs with opaque deny-by-default 404 behavior;
- tenant-scoped queries and uniqueness;
- encrypted durable idempotency responses and request-hash conflict detection;
- real Keycloak secret regeneration with old-secret invalidation;
- optimistic concurrency through ETag/If-Match and row versions;
- mutation, identity, SDK, sharing, and secret-operation audit events;
- validation and bounded list sizes;
- authenticated session and PAT access on the routes where PAT access is enabled.

Production requires a real tenant claim (or explicit single-tenant configuration), managed KMS configuration, and test-hook exclusion. Resource-level authorization is enforced on every application-scoped Developer Console route.

### Ontology Manager integration

The Developer Console reads the existing ontology tables rather than maintaining a separate demo catalog:

- `object_type` and `property` for object types and property schemas;
- `action_type` for action metadata and parameters;
- `interface` for interfaces;
- `ontology_function` for functions.

Selected SDK resources are stored in `tpa_ontology_resources`. Generation enriches an object type with its properties, required/array flags, mapped TypeScript types, and primary key. Action resources are enriched with their parameters. Unknown resource API names are rejected when the authoritative catalog is available.

This is meaningful integration: the Developer Console and Ontology Manager share the same source of truth. It is not, by itself, a complete OSDK implementation.

### SDK generation, runtime, and immutable registry MVP

Migrations `112_tpa_sdk_versions.sql`, `113_tpa_foundry_parity.sql`, and `115_developer_console_artifact_registry.sql` add:

- per-application semantic-looking versions;
- generation status and creator metadata;
- an immutable resource snapshot field;
- ontology binding metadata;
- a JSONB map of build inputs/source text;
- immutable artifact digest, object-storage key, byte size, manifest, publish, and revocation metadata;
- durable build jobs with leases, retries, failure state, and dead-letter state.

`DeveloperConsoleService.generateSdkVersion()` currently:

1. loads selected ontology resources;
2. enriches them from Ontology Manager;
3. derives the next version as `0.<number-of-existing-versions>.0`;
4. generates property-aware TypeScript, a transport runtime, `package.json`, and `README.md`;
5. compiles ESM JavaScript, source maps, and `.d.ts` declarations;
6. applies lifecycle-script, dependency-source, and generated-source secret policy checks;
7. emits CycloneDX SBOM and SLSA-shaped signed provenance metadata;
8. creates a deterministic npm `.tgz`, hashes it, and publishes to a content-addressed MinIO/S3 key;
9. exposes authenticated npm-style metadata and digest-verified immutable tarball endpoints;
10. stores a durable retry job so object-store failures can be reclaimed by a leased worker.

Generated object files include property interfaces and primary-key metadata. Generated action files include parameter interfaces. The embedded runtime provides authenticated/retrying Object list/get/search/aggregate/link traversal plus Action and Function invocation transports. The enterprise E2E installs the tarball and uses that runtime to query the live Object API.

### Basic application metrics

Migration `113_tpa_foundry_parity.sql` adds `tpa_metrics_points`, indexed by application/time and application/metric/time. The service supports:

- batches of at most 5,000 metric points;
- request, error, and latency values;
- arbitrary JSON dimensions;
- bounded reads of at most 10,000 points;
- request/error totals and an in-process median latency calculation;
- an empty-state response when no points exist.

Some Developer Console mutations record request points on a best-effort basis. A direct authenticated ingest endpoint can also insert points.

### Service-share metadata

Migration `113_tpa_foundry_parity.sql` adds `tpa_service_shares`, with resource kind, ID, display name, access level, creator, and timestamp. The service supports listing and transactional replacement of up to 2,000 share records per application.

This lets the Developer Console remember intended shares. It does not prove that every downstream resource system or policy engine grants and enforces those permissions.

### Existing verification

The frontend repository contains full-stack Cypress coverage for:

- application list, search, and favorites;
- application creation through the UI and API;
- the application route tree;
- OAuth and Platform SDK saves;
- display information updates;
- Ontology SDK empty state, catalog selection, save, version generation, and package inspection;
- rejection of a resource absent from Ontology Manager;
- generated object property schema.

The dedicated Ontology SDK Cypress spec has passed 4/4 tests in the current environment. The backend enterprise E2E additionally proves authorization denial, idempotent Keycloak provisioning, stale-write rejection, real secret cutover, Ontology Manager validation, compiled tarball publication/download, digest verification, installed-runtime Object API access, audit, and metrics. These tests still do not constitute load, disaster-recovery, independent security, or multi-region certification.

## Artifact registry MVP: implemented scope and remaining certification

### What exists

The current implementation retains source/build inputs in PostgreSQL, publishes compiled immutable bytes to MinIO/S3, records a content digest and manifest, serves npm-style metadata and tarball bytes behind application ACLs, verifies bytes on read, and maintains durable retry jobs. Published versions are never regenerated on read; pre-registry legacy versions return an explicit `410 LEGACY_ARTIFACT_UNAVAILABLE`.

### What an enterprise artifact registry must provide

An enterprise registry needs at least:

- immutable, content-addressed artifact blobs outside the transactional application database;
- a package/version namespace with atomic publish and conflict semantics;
- npm-compatible metadata and tarball endpoints if npm clients are expected to install packages;
- checksums, signatures, provenance attestations, and software bill of materials;
- malware, secret, license, and dependency-policy scanning before promotion;
- lifecycle states such as queued, building, quarantined, published, deprecated, and revoked;
- retention, legal hold, garbage collection, and restore behavior;
- tenant and package-level authorization on publish and download;
- short-lived download credentials or signed URLs;
- replication, caching/CDN, backup, restore, and regional recovery;
- download audit records and operational metrics;
- compatibility with package-manager caching and conditional requests;
- protection against namespace takeover, replay, substitution, and confused-deputy attacks.

### Remaining registry certification gaps

- The first publish is an API fast path; the durable worker currently handles retries, not isolated sandboxed compilation for every build.
- Signing uses an HMAC attestation key and fails closed when absent in production; managed asymmetric KMS/Sigstore signing and independent verification are not implemented.
- The policy gate blocks lifecycle scripts, non-registry dependency sources, and common generated-source secrets, but does not run a third-party vulnerability/malware/license intelligence service.
- Production object publication fails closed unless artifact SSE is configured, but replication, object-lock/legal-hold, CDN/cache, backup restore, and regional recovery require deployment evidence.
- Metadata is npm-shaped and the tarball is npm-compatible, but a clean `npm install` using a short-lived registry credential still needs a retained CLI conformance test.
- There is no promotion channel, deprecation/revocation UI, retention/garbage collection policy, or certified per-tenant storage/download quota.
- Version allocation is protected by an advisory lock but remains an automatic `0.minor.0` policy; caller-supplied semver and schema-driven recommendations are Phase 2 work.

### Why it was not delivered as part of the page implementation

The prior JSONB-only claim was intentionally rejected. The implemented MVP closes the immutable-byte and installable-runtime gap, while the remaining items above are kept as explicit release gates rather than being hidden behind UI success.

## Why complete OSDK runtime and code generation are not implemented

### What exists

The generator creates resource descriptors and TypeScript types for selected object properties and action parameters, emits ontology/client metadata and a stable package layout, compiles JavaScript and declarations, and embeds a Tellus transport runtime. The runtime implements authenticated Object list/get/search/aggregate/link traversal, Action apply, and Function invoke operations with timeout, cancellation, bounded retry/backoff, idempotency, optimistic-concurrency headers, and a stable `TellusOsdkError` envelope. The E2E suite installs the generated tarball and executes an Object API query.

### What a complete OSDK requires

A complete OSDK is more than generated interfaces. It needs generated metadata and a tested runtime for:

- object fetch-by-primary-key;
- object search, filtering, ordering, pagination, selection, and aggregation;
- nullable, numeric, temporal, geospatial, media, attachment, decimal, struct, union, and array type semantics;
- link types, inverse links, link traversal, and linked-object pagination;
- interfaces, interface implementations, shared properties, and polymorphism;
- action submission, validation, batching, asynchronous execution, and structured action errors;
- functions, function parameters/results, streaming where supported, and error envelopes;
- edits, transactions, optimistic concurrency, branch/version semantics, and change visibility;
- ontology version compatibility, rename/deprecation behavior, and generated symbol stability;
- OAuth flows for browser, backend, and service-account clients;
- token refresh, audience/scope handling, retries, backoff, cancellation, and timeouts;
- transport codecs and a stable error taxonomy;
- ESM/CJS and supported TypeScript/Node/browser matrices;
- source maps, declarations, tree shaking, package exports, and reproducible builds;
- compatibility tests against the production Ontology, Object, Action, Function, and Query APIs.

### Concrete gaps in the current generator/runtime

- Generated resource definitions and the generic runtime implement core network operations, but do not yet expose fully resource-specific fluent clients.
- Link traversal transport exists; generated link-type metadata, inverse-link typing, and linked-object result typing are incomplete.
- Interfaces and functions currently receive shallow descriptors rather than complete type and invocation models.
- Action parameter parsing assumes a limited metadata shape.
- Type mapping is necessarily incomplete for the full ontology type system.
- Generated property names are normalized to TypeScript identifiers without a fully specified collision and reserved-word policy.
- There is no schema fingerprint or compatibility analysis that blocks breaking releases.
- Deterministic byte generation and an installed Node Object query are tested; supported browser/Node/TypeScript matrix conformance is not complete.
- Action and Function transports are generated but do not yet have safe non-destructive E2E fixtures covering success/error/idempotency behavior.
- Auth accepts a token or asynchronous token supplier, but public-client PKCE, refresh coordination, audience negotiation, and service-account helper adapters need conformance tests.

### Why full OSDK certification remains open

The runtime spans multiple Tellus data-plane APIs. The implemented transport is executable and tested for Object reads, but complete certification depends on a stable cross-service protocol and ontology intermediate representation. Full link/interface/action/function/edit/auth compatibility cannot be inferred from one successful query, so those behaviors remain explicit Phase 2 conformance work.

## Why platform-scale services are not implemented

### What exists

The broader Tellus server provides request limits, authentication, OpenTelemetry, Kafka, Temporal, PostgreSQL, MinIO/S3, Redis, and other platform foundations. The Developer Console now adds tenant-aware ACLs, input caps, ETags, encrypted idempotency, durable audit, identity reconciliation, artifact build leases/retries/dead-letter state, content-addressed storage, trusted-publisher enforcement in production, and fail-closed production KMS/signing/SSE configuration.

Those are production control-plane foundations. They are not evidence of certified multi-region, multi-tenant operation at an unspecified Foundry scale.

### Required enterprise platform capabilities

The combined Developer Console, registry, SDK, metrics, and sharing platform requires:

- durable job orchestration for code generation, scanning, publishing, and cleanup;
- horizontally scalable workers with leases, retry budgets, dead-letter handling, and idempotency;
- event-driven gateway telemetry rather than client-submitted telemetry as the primary source;
- a time-series/analytics store with rollups, retention tiers, cardinality controls, and late-event handling;
- centralized resource authorization and policy evaluation for every application operation;
- tenant isolation in data, cache keys, queues, storage prefixes, encryption keys, and audit trails;
- quota, rate, concurrency, and storage enforcement per tenant/application/principal;
- audit events for application, secret, scope, SDK, share, publish, download, and policy changes;
- KMS-backed secrets and signing keys with rotation and access audit;
- multi-AZ operation, backup/restore, disaster recovery, and tested recovery objectives;
- service SLOs, alerting, traces, capacity models, on-call runbooks, and failure injection;
- safe rollout, compatibility gates, migrations, and rollback across API, runtime, and generated packages.

### Concrete Developer Console risks today

The following remain production blockers for a broad multi-tenant rollout:

1. **Independent tenant-isolation certification:** tenant-aware application queries and ACLs are implemented, but caches, every downstream data plane, queues, storage, and operational access need independent adversarial review.
2. **Metrics authority and scale:** production ingest requires a trusted publisher role, but gateway emission, schema-versioned streaming, rollups, retention, cardinality controls, and percentile analytics are not yet the primary path.
3. **Share enforcement:** `tpa_service_shares` and reconciliation intent record desired state, but every authoritative target resource API does not yet prove grant and revoke enforcement within an SLO.
4. **Build isolation:** durable retry/dead-letter behavior exists, but initial compilation runs in the API process rather than an isolated, quota-limited build worker.
5. **Supply-chain certification:** deterministic bytes, SBOM, policy checks, attestation, and production fail-closed signing/SSE configuration exist; managed asymmetric signing, vulnerability intelligence, restore, object lock, and npm CLI conformance remain.
6. **Complete OSDK compatibility:** core runtime transports exist, but the full declared type/link/interface/action/function/edit/auth compatibility matrix has not passed.
7. **Operational scale evidence:** no approved demand forecast, load/soak profile, multi-AZ recovery exercise, regional failover, or signed SLO/error-budget record exists yet.

## What is realistically achievable as enterprise software

Tellus can achieve an enterprise-grade, Foundry-faithful Developer Console without claiming knowledge of Palantir's private implementation. The target should be defined as:

> A documented Tellus Developer Platform contract with equivalent user outcomes, stable APIs, generated SDK behavior, enterprise security, and measurable SLOs.

That target is testable and supportable. “Looks like Foundry” is not an adequate acceptance criterion; neither is “all Cypress tests pass.”

## Target enterprise architecture

```text
Developer Console UI
        |
        v
Developer Platform API ----> Policy/Authorization service ----> Audit log
        |
        +----> Application/OAuth control plane ----> Keycloak + reconciler
        |
        +----> Generation job DB ----> Durable queue/orchestrator
                                      |
                                      v
                              Isolated codegen workers
                                      |
                       compile/test/scan/sign/attest
                                      |
                                      v
                   Content-addressed object storage + metadata DB
                                      |
                                      v
                    npm-compatible registry gateway + cache/CDN

SDK runtime ----> Tellus API gateway ----> Ontology/Object/Action/Function APIs
                         |
                         +----> authoritative telemetry event stream
                                      |
                                      v
                         rollup/analytics store ----> DC Metrics API
```

### System boundaries

- **PostgreSQL:** control-plane metadata, jobs, version manifests, policy references, audit pointers—not large artifact bodies or unbounded raw telemetry.
- **Object storage:** immutable package tarballs, declarations, source maps, SBOMs, signatures, and provenance.
- **Queue/orchestrator:** build/publish/revoke/reconcile workflows with retries and idempotency.
- **Registry gateway:** npm protocol, authorization, caching, audit, and signed artifact delivery.
- **OSDK runtime:** separately versioned client library with a published compatibility matrix.
- **API gateway telemetry:** authoritative event producer; application SDK telemetry is supplemental.
- **Policy service:** single enforcement contract across Developer Console and resource APIs.

## Version 1 compatibility boundary

The first enterprise release must deliberately bound compatibility. Capabilities outside this matrix are not release blockers unless the approved reference manifest makes them mandatory.

| Area | Version 1 commitment | Evidence required |
|---|---|---|
| Generated language | TypeScript only | Generator fixtures and compilation matrix |
| Package format | Compiled ESM JavaScript, `.d.ts`, source maps, exports map, npm tarball, SBOM, signature, and provenance | Deterministic build and registry install tests |
| Runtime environments | Named Node.js LTS releases and named evergreen browser baselines, versioned in the compatibility manifest | Compile/run CI for every supported target |
| Authentication | Browser authorization code with PKCE, confidential backend client, and service-account/client-credentials flows | Token acquisition, refresh, expiry, revocation, audience, and scope tests |
| Objects | Primary-key fetch, search, filtering, ordering, selection, aggregation, cursor pagination, and documented consistency behavior | Object and Query API conformance tests |
| Ontology types | Every base and composite type explicitly listed in the ontology intermediate-representation specification | Round-trip property tests and generated fixtures |
| Links and interfaces | Forward/inverse traversal, pagination, interface implementation, shared properties, and polymorphic results | Generated compile/run and data-plane E2E tests |
| Actions | Parameter typing, validation, submission, batch behavior where supported, asynchronous status, and structured failures | Action API conformance tests |
| Functions | Parameter/result typing, invocation, error envelopes, and streaming only if declared by the manifest | Function API conformance tests |
| Compatibility | Stable symbol mapping, collision rules, rename/deprecation behavior, schema fingerprint, and semantic-release recommendation | Golden fixtures and upgrade tests |
| Package clients | Exact supported npm client versions and authentication mechanism listed in the release manifest | Clean-environment install tests |

Support matrices must contain exact versions before release. Terms such as “modern browser,” “TypeScript 5,” or “current Node” are insufficient in a signed compatibility manifest.

## Initial production service objectives and capacity envelope

These are minimum acceptance floors for the first production release. Product, security, and operations must ratify them in an architecture decision record before Phase 0 exits. A stricter target may replace a value; weakening a value requires an explicit risk acceptance.

| Capability | Initial production floor |
|---|---|
| Developer Platform API availability | 99.9% monthly, excluding announced maintenance |
| Registry metadata and download availability | 99.9% monthly |
| Read-only control-plane latency | p95 <= 500 ms and p99 <= 1,500 ms at the certified load, excluding client network time |
| Synchronous mutation latency | p95 <= 1,500 ms when no external identity-provider operation is performed |
| Asynchronous application provisioning | Accepted in <= 1 second; 95% reach a terminal state in <= 30 seconds |
| SDK generation and publication | Accepted in <= 1 second; p95 completion <= 5 minutes within the certified package envelope |
| Secret revocation | Old credential rejected within 60 seconds of a successful rotation response |
| Share revocation | Target resource APIs reject revoked access within 60 seconds |
| Metadata durability | RPO <= 5 minutes and RTO <= 60 minutes |
| Published artifact durability | No acknowledged artifact loss; immutable blobs replicated according to the approved storage policy |
| Telemetry ingestion | No cross-application spoofing; measured loss <= 0.01% inside the certified envelope; query freshness p95 <= 60 seconds |
| Audit delivery | Mutation and secret-operation audit events durable within 10 seconds |
| Tenant isolation | Zero permitted cross-tenant data or policy access; independently security-tested |

### Capacity certification profile

Each release must publish the exact load profile it passed. At minimum, it must state and test:

- tenant count, applications per tenant, users per tenant, and concurrent sessions;
- read and mutation requests per second, burst multiplier, and burst duration;
- concurrent Keycloak provisioning and reconciliation operations;
- ontology resource count, property/link/action/function counts, and generated package size;
- concurrent builds, queue depth, worker count, and artifact download throughput;
- telemetry events per second, active dimension cardinality, retention, replay volume, and query concurrency;
- database size, object-store size, backup size, restore duration, and regional failover assumptions.

The certified envelope must be derived from the approved demand forecast with safety margin and recorded with test results. The product must reject, queue, or rate-limit work outside that envelope rather than failing unpredictably.

## Implementation status against the delivery plan

| Phase | Engineering status | Certification status |
|---|---|---|
| Phase -1 — reference contract | Documented boundary and claim policy in this record | Product/legal/security approvals and frozen requirement manifest are external governance work |
| Phase 0 — secure control plane | Implemented: ACLs, tenant scope, encrypted idempotency, real rotation, reconciliation, audit, ETags, production seed cleanup | E2E engineering gate passed; independent security and deployment review remain |
| Phase 1 — artifact registry MVP | Core implemented: deterministic compile, `.d.ts`, tgz, MinIO/S3, digest, npm metadata, SBOM, policy scan, signed provenance, durable retry worker | npm CLI auth, managed asymmetric signing/scanning, restore, quotas, isolation, and scale gates remain |
| Phase 2 — Tellus OSDK | Core transport implemented and installed Object read tested | Full ontology/type/link/action/function/auth/browser compatibility suite remains |
| Phase 3 — metrics | Bounded persistence/query and trusted publisher production gate implemented | Authoritative gateway stream, rollups, retention, percentile, replay, and scale gates remain |
| Phase 4 — policy/multi-tenant | Application ACL and desired-share state implemented | Downstream enforcement/revocation, drift repair, independent isolation, DR, and SLO gates remain |
| Phase 5 — certification | Reproducible unit and enterprise E2E evidence added | Performance, soak, chaos, accessibility, upgrade, security, and named approvals remain |

Implementation is not the same as certification. A phase is not marked complete merely because its primary code path exists; the acceptance evidence below controls production claims.

## Delivery plan and acceptance gates

### Phase -1 — reference contract and program authorization

Deliverables:

- frozen reference manifest and requirement-to-evidence matrix;
- Tellus Developer Platform Specification v1 draft;
- approved Version 1 compatibility boundary;
- quantified demand forecast, production objectives, capacity profile, and cost envelope;
- architecture decisions for build versus buy, storage, queue/orchestration, registry protocol, signing/KMS, analytics store, and policy service;
- threat model, privacy/data-classification assessment, legal/product naming review, and third-party license review;
- named accountable owners, funded delivery capacity, dependency map, release milestones, and escalation path;
- migration, coexistence, rollback, and end-of-life strategy for the current source-bundle APIs.

Exit criteria:

- product, architecture, security, ontology, identity, operations, SDK, and legal owners approve the reference manifest;
- every mandatory behavior has a stable requirement ID and an objective verification method;
- every external dependency has an owner, availability contract, test environment, and failure-mode decision;
- no schedule or “100%” commitment depends on an unspecified capability or an unapproved production target.

### Phase 0 — secure the current control plane

Deliverables:

- enforce application-level read/write/admin authorization on every route;
- add organization/tenant ID to all relevant queries and unique constraints;
- implement durable create idempotency with stored request hash and response;
- implement real Keycloak secret regeneration and old-secret revocation;
- add an application/Keycloak reconciliation worker;
- move captured demo seed data behind an explicit development/test seed;
- add audit events for all mutations and secret operations;
- add optimistic concurrency (`version` or ETag/If-Match) for updates.

Exit criteria:

- cross-user and cross-tenant access tests prove deny-by-default behavior;
- retrying create with the same key returns the same result; a changed body is rejected;
- induced Keycloak/database failures converge to a consistent state;
- no production path returns a secret that is not active in the identity provider;
- no demo applications/resources are created by production migrations.

### Phase 1 — artifact registry MVP

Deliverables:

- generation job and artifact manifest schema;
- durable worker queue with leases, retry budgets, and dead-letter state;
- deterministic compilation to JavaScript and `.d.ts` output;
- npm tarball creation and content digest;
- object-storage publication with server-side encryption and immutable keys;
- npm metadata and tarball download endpoints;
- package/version ACLs, audit, quotas, and signed download authorization;
- SBOM, secret scan, dependency/license policy, and provenance attestation.

Exit criteria:

- `npm install` works against the Tellus registry using a short-lived credential;
- concurrent publish of the same version is atomic and deterministic;
- identical input produces the same digest;
- a changed or corrupt blob fails verification;
- restore from backup/object storage is exercised;
- published bytes never change; revocation changes availability/metadata, not history.

### Phase 2 — complete Tellus OSDK runtime and generator

Deliverables:

- versioned ontology intermediate representation shared by generator and server;
- comprehensive ontology type mapping;
- objects, links, interfaces, actions, functions, queries, aggregation, pagination, and errors;
- browser, Node, public-client, confidential-client, and service-account auth adapters;
- retry/backoff/cancellation and request tracing;
- symbol collision, rename, deprecation, and compatibility rules;
- generated fixtures plus compile/run conformance tests;
- semantic version recommendation based on schema compatibility.

Exit criteria:

- generated packages compile with every supported TypeScript version;
- runtime conformance passes against production-equivalent Object, Query, Action, and Function APIs;
- link traversal, pagination, auth refresh, retries, and structured failures are tested E2E;
- breaking ontology changes either fail generation or produce an explicit major-version recommendation;
- a compatibility matrix is published and enforced in CI.

### Phase 3 — authoritative metrics and analytics

Deliverables:

- gateway-side telemetry emission with trusted application identity;
- event stream with schema versioning and partition strategy;
- ingestion deduplication, late-event handling, and backpressure;
- rollups and retention tiers in an analytics/time-series store;
- cardinality budgets and dimension allowlists;
- metrics query API with bucket, group, percentile, and pagination semantics.

Exit criteria:

- clients cannot forge another application's metrics;
- sustained and burst load targets pass with defined lag and loss budgets;
- p50/p95/p99 are computed by the analytics system, not by loading raw points into an API process;
- retention, deletion, replay, and regional failure behavior are tested.

### Phase 4 — policy-backed sharing and multi-tenant operations

Deliverables:

- authoritative service principal lifecycle;
- ACL/policy transactions or durable sagas for every shared resource kind;
- marking/purpose/organization policy enforcement in downstream APIs;
- share reconciliation and drift detection;
- tenant-aware encryption, queues, caches, storage prefixes, quotas, and audit;
- SLO dashboards, alerts, runbooks, capacity models, backup, and disaster recovery.

Exit criteria:

- a stored share is demonstrably enforced by the target resource API;
- removing a share revokes access within a defined SLO;
- policy drift is detected and repaired;
- multi-tenant isolation and authorization receive independent security testing;
- failover, restore, queue backlog, worker crash, KMS failure, and object-store failure drills pass.

### Phase 5 — parity certification

Deliverables:

- the ratified final version of the Tellus Developer Platform Specification created in Phase -1;
- the completed feature/behavior matrix mapping every supported UI action to API, policy, storage, audit, and test evidence;
- golden compatibility fixtures and consumer-driven contract tests;
- performance, soak, chaos, security, accessibility, and upgrade suites;
- an explicit list of intentional differences from Foundry.

Exit criteria:

- every claim is tied to a published contract and automated or independently reviewed evidence;
- no “100%” claim depends solely on visual similarity or undocumented assumptions;
- release sign-off includes security, operations, SDK, ontology, and product owners.

## Program execution model

The phases describe acceptance gates, not a requirement that all engineering be sequential. After Phase -1, the following workstreams may proceed in parallel behind stable contracts:

```text
Reference contract and program authorization
                    |
                    +--> Control-plane security and identity reconciliation
                    +--> Registry, build workers, and software supply chain ----+
                    +--> Ontology IR, generator, and OSDK runtime ---------------+--> Integrated conformance
                    +--> Policy-backed principals and resource sharing ----------+
                    +--> Gateway telemetry and analytics ------------------------+
                    +--> UI workflow parity and accessibility ------------------+
                                                                               |
                                                               Production certification
```

Registry and OSDK teams must agree on the artifact manifest, package layout, compatibility metadata, and publication protocol before either contract is frozen. Policy and telemetry requirements must be embedded in control-plane and runtime APIs rather than added after release.

### Required ownership

Names belong in the release-readiness record rather than this repository document. The program cannot begin a phase without a named accountable owner and funded delivery capacity for every applicable function.

| Function | Accountable outcome |
|---|---|
| Product owner | Reference scope, user outcomes, intentional differences, and release acceptance |
| Developer Platform/API owner | Control-plane contract, tenancy, lifecycle, concurrency, and migrations |
| Identity owner | Keycloak lifecycle, credentials, reconciliation, and service principals |
| Ontology owner | Ontology intermediate representation, compatibility, and source-of-truth behavior |
| SDK/runtime owner | Generator, runtime, language matrix, conformance, and upgrade policy |
| Registry/supply-chain owner | Workers, immutable artifacts, npm protocol, signing, scanning, and recovery |
| Policy/security owner | Authorization model, threat model, tenant isolation, security testing, and risk acceptance |
| Telemetry owner | Trusted emission, ingestion, analytics semantics, retention, privacy, and capacity |
| SRE/operations owner | SLOs, observability, capacity, incident response, backup, restore, and disaster recovery |
| Quality owner | Traceability, test strategy, evidence retention, accessibility, performance, and release gates |
| Legal/compliance owner | Reference provenance, naming, licensing, privacy, retention, and distribution constraints |

No engineer may self-approve a production exception in an area where they authored the implementation. Security, recovery, and tenant-isolation evidence require independent review.

### Mandatory architecture decisions

The following decisions must be recorded before dependent implementation is accepted:

- managed versus self-hosted queue/orchestrator and its delivery semantics;
- object storage, replication, immutability controls, retention, and recovery model;
- registry protocol implementation versus an existing registry product;
- signing, KMS, attestation, secret scanning, dependency scanning, and SBOM standards;
- ontology intermediate-representation schema and versioning authority;
- runtime transport, authentication, retry, error, and tracing contracts;
- policy engine and authoritative ACL ownership;
- telemetry transport, analytics store, tenant partitioning, retention, and deletion;
- regional topology, data residency, encryption boundaries, and disaster-recovery design;
- migration path for existing applications, generated versions, metrics, and shares.

Each decision must include alternatives, security and operational consequences, recurring cost, migration risk, exit strategy, and owner. This document deliberately does not invent vendor selections or delivery dates without approved constraints.

## Production rollout and change management

Production promotion is staged and reversible:

1. **Development:** synthetic tenants and test identity provider; destructive testing permitted.
2. **Integration:** production-equivalent dependencies; contract, migration, reconciliation, and failure tests.
3. **Internal pilot:** named tenants, non-sensitive workloads, explicit support hours, and daily drift review.
4. **Limited availability:** allowlisted production tenants inside a conservative quota envelope; 24/7 alerts and rollback readiness.
5. **General availability:** certified envelope, published SLOs, support policy, compatibility matrix, runbooks, and completed operational-readiness review.

Every stage requires:

- forward and backward-compatible database and API migrations;
- feature flags or versioned endpoints for material behavior changes;
- canary deployment, health/error/latency comparison, and defined observation window;
- tested rollback or roll-forward procedure, including cross-system reconciliation;
- customer-data migration validation and restoration rehearsal;
- release notes, deprecation periods, and consumer communication;
- a stored evidence bundle containing build provenance, tests, scans, approvals, and capacity results.

### Automatic stop and rollback conditions

Promotion stops, and rollback or feature isolation begins, when any of the following occurs:

- confirmed cross-tenant access or authorization bypass;
- a returned credential is inactive, an old credential remains valid beyond its SLO, or a secret appears in logs/artifacts;
- published artifact bytes or digest change for an existing version;
- unreconciled identity, share, or artifact state exceeds its error budget;
- data loss, audit loss, or telemetry spoofing exceeds the approved threshold;
- latency, availability, queue age, build failure, or capacity saturation breaches the release gate;
- backup restore, disaster recovery, or dependency-failure exercises do not meet approved objectives.

## Cost and schedule governance

No reliable completion date or cost can be derived from this gap analysis alone. Phase -1 must produce estimates from decomposed work, dependency readiness, staffing, and the certified demand forecast. The approved plan must distinguish:

- one-time engineering and migration effort;
- recurring compute, database, object storage, queue, KMS, CDN, scanning, telemetry, and support cost;
- licensing and vendor commitments;
- security, compliance, penetration-testing, and disaster-recovery costs;
- capacity headroom and regional replication cost;
- contingency for ontology/runtime contract changes and dependency delays.

Forecasts must be updated at every phase exit using measured build, storage, traffic, support, and failure data. Scope, time, quality, and cost trade-offs require product and engineering approval; production security and tenant isolation are not negotiable scope reductions.

## Test strategy required for enterprise certification

### Unit and property tests

- ontology-to-intermediate-representation conversion;
- every ontology base type and nested/array/nullability combination;
- identifier escaping, collisions, and reserved words;
- semantic compatibility classification;
- package manifest and digest determinism;
- policy decisions and idempotency state machines.

### Contract and integration tests

- Keycloak create/rotate/delete and reconciliation;
- PostgreSQL constraints and concurrent version publication;
- object-storage immutability and checksum verification;
- npm client metadata/tarball behavior;
- generated runtime against Object, Query, Action, Link, Interface, and Function APIs;
- audit and policy enforcement for every mutation.

### Full-stack E2E tests

- create application through UI, install generated SDK, authenticate, fetch/query an object, traverse a link, invoke an action/function, and observe authoritative metrics;
- change ontology, generate a compatible release, install it, and verify backward compatibility;
- attempt an incompatible change and verify the release gate;
- share and revoke a resource, proving downstream allow and deny behavior;
- rotate secret, prove new credential works, and prove old credential fails.

### Scale and resilience tests

- concurrent application creation and Keycloak throttling;
- large ontologies and package generation fan-out;
- registry download throughput and cache behavior;
- sustained telemetry volume, high cardinality, late events, and replay;
- worker death, queue outage, object-store outage, KMS outage, database failover, and regional recovery;
- soak testing for leaks, backlog growth, and storage lifecycle correctness.

### Security tests

- cross-user and cross-tenant authorization;
- PAT scope plus resource-policy composition;
- malicious ontology names and generated-code injection;
- package substitution, namespace takeover, replay, and dependency confusion;
- secret exposure in logs, metrics, audit, package contents, and error responses;
- SBOM/license/malware/policy rejection paths.

## Definition of done for an enterprise claim

Tellus may call this an **enterprise Developer Platform** when:

- the Phase -1 reference manifest, compatibility boundary, production objectives, owners, and architecture decisions are approved;
- the Phase 0 security blockers are closed;
- packages are immutable, installable, signed, scanned, and recoverable;
- the generated SDK executes the documented object/action/function/link contract;
- authorization is enforced at both control-plane and data-plane boundaries;
- metrics are authoritative and designed for sustained volume;
- share records are enforced by resource policy, not merely stored;
- SLO, capacity, backup, restore, and incident procedures are exercised;
- compatibility and intentional differences are published;
- the certified capacity envelope and service objectives pass in a production-equivalent environment;
- the release-readiness record contains named approvals and links to retained evidence for every mandatory requirement.

Tellus may call this **100% compliant** only relative to a named, versioned Tellus specification and its conformance suite. It should not claim 100% equivalence to all Palantir Foundry internals without an authoritative Palantir specification and test suite.

## Recommended product wording

Use for the current implementation:

> Tellus Developer Console provides a functional application-registration and OAuth control plane, live Ontology Manager resource selection, and versioned SDK source generation for controlled development and pilot use. Multi-tenant production approval, artifact-registry publication, the complete Tellus OSDK runtime, authoritative telemetry, and policy-backed service sharing require the enterprise readiness gates in this plan.

Use only after all enterprise gates pass:

> Tellus Developer Platform Specification v1 compliant. The certified release provides the published Developer Console workflows, SDK/runtime contract, package registry, policy enforcement, telemetry, service objectives, and capacity envelope, with documented intentional differences from its declared Foundry reference surface.

Do not use:

> 100% perfect Palantir Foundry clone.

The approved statements are bounded, supportable, and tied to named evidence. The prohibited statement is unbounded and cannot be verified from this codebase.

## Repository evidence

- Application schema: `src/migrations/111_developer_console_applications.sql`
- SDK version metadata: `src/migrations/112_tpa_sdk_versions.sql`
- Package-file, metrics, and share schema: `src/migrations/113_tpa_foundry_parity.sql`
- Tenant, ACL, encrypted idempotency, reconciliation, audit, and row-version schema: `src/migrations/114_developer_console_production_control_plane.sql`
- Immutable artifact and durable build-job schema: `src/migrations/115_developer_console_artifact_registry.sql`
- Application, ontology catalog, generator, metrics, and share behavior: `src/services/developerConsole/developerConsoleService.ts`
- Artifact compiler, policy, attestation, object publication, and digest verification: `src/services/developerConsole/artifactRegistryService.ts`
- Leased artifact retry worker: `src/services/developerConsole/artifactBuildWorker.ts`
- Keycloak cleanup reconciler: `src/services/developerConsole/reconciliationWorker.ts`
- ACL/idempotency/ETag security primitives: `src/services/developerConsole/developerConsoleSecurity.ts`
- Authenticated HTTP surface: `src/routes/developerConsole.ts`
- PAT route scopes: `src/services/patScopeMap.ts`
- Deterministic artifact unit tests: `tests/unit/services/developerConsoleArtifactRegistry-unit.test.ts`
- Backend enterprise E2E: `scripts/test-developer-console-enterprise-e2e.sh`
- Frontend production concurrency propagation: `../tellus-fe/lib/developerConsoleApi.ts`
- Frontend full-stack specifications: `../tellus-fe/cypress/e2e/developer-console-*.cy.ts`
- Full-stack shell checks: `../tellus-fe/scripts/test-developer-console-create.sh` and `../tellus-fe/scripts/test-developer-console-ontology-sdk.sh`
