# Developer Console production-baseline implementation evidence

- **Evidence date:** 2026-07-20
- **Environment:** local production-equivalent dependency stack (Tellus API, PostgreSQL, Keycloak, Ontology Manager tables, MinIO/S3)
- **Scope:** Phase 0 secured control plane, Phase 1 immutable-registry core, and installed OSDK Object-read runtime
- **Certification boundary:** engineering evidence, not an independent security, capacity, disaster-recovery, or Palantir-conformance certification

## Implemented controls

| Control | Evidence |
|---|---|
| Tenant/application authorization | Every application route composes owner/editor/viewer ACL middleware; a different authenticated principal receives opaque `404` |
| Durable create idempotency | Request hash plus KMS-wrapped encrypted response; replay returns the same RID and one-time secret; changed body returns `409` |
| Optimistic concurrency | ETag/If-Match row version; accepted mutation increments the version; stale mutation returns `412` |
| OAuth identity lifecycle | Confidential client created in Keycloak; rotate calls Keycloak regeneration; old secret returns `401`, new secret obtains a token |
| Cross-system recovery | Durable Keycloak reconciliation jobs with leased retries and dead-letter state |
| Ontology integration | Selection comes from authoritative Ontology Manager tables; unknown object type returns `400` |
| Immutable artifacts | Deterministic compile to ESM, source map, and declarations; npm tgz stored under a content-addressed object key; SHA-256 verified on download |
| Build recovery | Durable build job plus horizontally safe `FOR UPDATE SKIP LOCKED` worker, leases, retry budget, and dead letter |
| Supply-chain metadata | CycloneDX SBOM, SLSA-shaped provenance, HMAC attestation, lifecycle/dependency/secret policy checks; production signing/SSE fail closed |
| Registry protocol | Authenticated npm-style metadata and immutable tarball endpoints; pre-registry versions return explicit `410` rather than regenerating |
| Generated runtime | Installed tarball exports authenticated Object list/get/search/aggregate/traversal and Action/Function transports with timeout, cancellation, retry, idempotency, ETag, and structured errors |
| Audit/telemetry | Durable mutation and secret audit events; bounded metrics ingest and query; trusted publisher role required in production |

## Commands and results

### Schema migration

```bash
npm run migrate:foundry
```

Result: migration `115_developer_console_artifact_registry.sql` recorded in `schema_migrations_applied`; `tpa_sdk_build_jobs` and artifact columns exist. Migrations 111 through 115 are present in the environment.

### TypeScript build check

```bash
npx tsc --noEmit --pretty false
```

Result: pass, zero TypeScript diagnostics.

### Deterministic artifact unit suite

```bash
npx vitest run --config vitest.unit.config.ts \
  tests/unit/services/developerConsoleArtifactRegistry-unit.test.ts
```

Result: **3/3 pass**.

Verified:

- identical input produces identical tarball bytes and digest;
- source change changes the digest;
- ESM, source maps, `.d.ts`, package manifest, SBOM, and provenance are emitted;
- lifecycle scripts, non-registry dependency sources, and embedded secret patterns are rejected.

### Enterprise full-stack E2E

```bash
./scripts/test-developer-console-enterprise-e2e.sh
```

Result: **PASS**.

The test creates and removes a fresh application and verifies:

1. two independent login principals;
2. Keycloak and PostgreSQL application provisioning;
3. encrypted idempotent replay and payload conflict;
4. cross-principal deny-by-default authorization;
5. successful and stale ETag writes;
6. Keycloak client-credentials token before rotation;
7. new-secret success and old-secret rejection after rotation;
8. authoritative ontology selection and unknown-type rejection;
9. SDK compilation and MinIO/S3 publication;
10. npm metadata and immutable tarball download;
11. tar contents, SHA-256 header/byte verification, SBOM, and provenance;
12. importing the installed generated package and querying the live Object API;
13. durable membership, audit, and metric paths.

### Existing frontend/full-stack compatibility

```bash
cd ../tellus-fe
./scripts/test-developer-console-ontology-sdk.sh
npx cypress run --browser electron --spec \
  cypress/e2e/developer-console-ontology-sdk.cy.ts,\
cypress/e2e/developer-console-full-surface.cy.ts
```

Results:

- Ontology SDK shell/API/TypeScript package verification: **PASS**;
- Cypress Ontology SDK after production `If-Match` client wiring: **4/4 pass**;
- Cypress complete Developer Console route surface isolated rerun: **14/14 pass**;
- combined Cypress evidence: **18/18 pass**, zero screenshots/failures.

One combined run exposed a UI timing assumption where the Platform SDK test clicked before its GET completed. The harness now waits for the configuration response, asserts the checkbox actually changes, and verifies both OAuth and Platform mutations carry an `If-Match: "vN"` header. The hardened full-surface rerun passed 14/14.

## Remaining release gates

The following were not proven by this evidence and remain mandatory before corresponding claims:

- complete OSDK type/link/interface/action/function/edit/auth/browser conformance;
- npm CLI installation using short-lived registry credentials;
- managed asymmetric signing and external vulnerability/license/malware scanning;
- isolated build execution, per-tenant quota enforcement, and concurrent build/load certification;
- authoritative gateway telemetry stream, rollups, retention, replay, and percentile analytics;
- downstream share grant/revoke enforcement and drift repair;
- independent tenant-isolation/security review;
- backup restore, object-store corruption recovery, worker/queue/KMS failure drills, multi-AZ/region recovery, and SLO approval.

Accordingly, the evidence supports a **production-capable single-tenant Developer Console baseline** when production KMS/signing/SSE/test-hook requirements are satisfied. It does not support the unbounded statement “100% perfect Palantir Foundry clone.”
