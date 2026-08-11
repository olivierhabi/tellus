# B2 — Credential Vault — THREAT MODEL

Per agent prompt §6. Security-sensitive task. STRIDE references inline.

## Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Plaintext customer credentials (PG password, client TLS key, OAuth tokens) | HIGH | In-memory inside worker process during unwrap; never persisted. |
| Per-row Data Encryption Key (DEK, 32 bytes) | HIGH | Generated per credential row in `vault.createOrRotate`; lives in memory only during the wrap call; wrapped at rest. |
| Tenant Key-Encryption Key (KEK) | CRITICAL | Held by configured KMS (`TELLUS_KMS_ADAPTER`); for `local-aesgcm` it lives in `TELLUS_LOCAL_KEK_B64` env var. |
| Workload JWT signing secret | HIGH | `TELLUS_WORKLOAD_JWT_SECRET` env var. |
| Audit table contents | MEDIUM | `connectivity_credentials_audit`. Operator-visible metadata only — never plaintext. |
| Credential ciphertext at rest | LOW (with KEK assumed safe) | `connectivity_credentials.ciphertext` + `.wrapped_dek`. |

## Trust boundaries

1. **Public API → Connectivity service.** A Multipass-authenticated user hits `POST /connections/:rid/credentials`. The service validates `connectivity:write` scope and the body shape, never echoes credentials in responses, sanitizes credential-shaped keys before any error envelope serialization (`src/lib/errors/envelope.ts:sanitizeParameters`).
2. **Connectivity service → KMS.** The wrap/unwrap calls cross into Vault/AWS/GCP/local KMS via `KmsAdapter`. The KMS sees only the DEK (32 bytes), never the credential plaintext. Network path is mTLS in cloud-KMS configurations; for `local-aesgcm` no network path exists.
3. **Connectivity service → Worker.** A worker (B4) fetches credentials via `POST /api/v2/connectivity/internal/unwrap` bearing a short-lived workload JWT issued by `src/services/multipass/tokens.ts`. The JWT is scoped to a SINGLE `connection_rid` and the `connectivity:credential-unwrap` permission; the unwrap endpoint rejects mismatches.
4. **Operator → DB.** A DB-superuser-equivalent (DBA, infra engineer) can read raw `ciphertext` + `wrapped_dek` directly. They cannot decrypt without the KMS — they hold AEAD ciphertext only. This is the design (defense-in-depth: DB breach ≠ credential breach).

## Adversaries and mitigations

### A1 — External attacker with stolen Multipass token

- **Capability:** can hit any endpoint the token's scopes allow.
- **STRIDE:** Spoofing.
- **Mitigations:** Scope check (`connectivity:write` required for credential mutations); ETag/`If-Match` prevents accidental overwrite without context; audit row records `actor`/`outcome`/`scopes` on every operation.

### A2 — Compromised worker process

- **Capability:** can call the internal unwrap endpoint freely while the workload JWT is valid.
- **STRIDE:** Spoofing, Elevation of Privilege.
- **Mitigations:** Workload JWT TTL ≤300s; scoped to a single `connection_rid`; missing scope rejects (`Tellus:Connectivity:ScopeRequired`). Audit row carries the JWT subject so post-incident triage attributes the unwrap. The egress allowlist (B4) further restricts which hosts the compromised worker can dial with the unwrapped credential.

### A3 — DBA reading raw ciphertext

- **Capability:** SELECT * FROM connectivity_credentials.
- **STRIDE:** Information Disclosure.
- **Mitigations:** AEAD ciphertext is meaningless without the KEK; KEK lives in KMS (cloud-managed) or env (`local-aesgcm` — operator-discipline only). DBA cannot read audit-table rows containing plaintext because audit only carries structured metadata (regression test `scanForPlaintext` proves this each commit).

### A4 — Memory disclosure of a worker process (core dump, swap, hot-add observability)

- **Capability:** read process memory after a credential has been unwrapped.
- **STRIDE:** Information Disclosure.
- **Mitigations:** Best-effort scrub in `vault.ts` (Buffer.fill(0) after use); plaintext buffers are not pooled; Node lacks `mlock` but workers run with swap disabled in K8s by default (`securityContext.swap` / kernel `vm.swappiness`); core dumps disabled via systemd `LimitCORE=0` on worker units.

### A5 — Tampered ciphertext

- **Capability:** modify `connectivity_credentials.ciphertext` directly in DB.
- **STRIDE:** Tampering.
- **Mitigations:** AES-GCM auth tag verification fails closed → `Tellus:Connectivity:CredentialDecryptionFailed`. Spec §117.4 explicitly exercises this in an integration test.

### A6 — Replay of a captured workload JWT

- **Capability:** intercepted a valid workload JWT during transit.
- **STRIDE:** Spoofing.
- **Mitigations:** TTL ≤300s makes the window small; `connection_rid` claim restricts blast radius to one connection; replay is logged in the audit table.

### A7 — KMS outage

- **Capability:** N/A; an availability concern.
- **STRIDE:** Denial of Service.
- **Mitigations:** Cache: process-local LRU (`vault.ts`) holds unwrapped plaintexts for 60s, so transient KMS outages do not immediately break workers. Beyond 60s, unwraps fail with `KmsUnavailable` (operator-facing).

### A8 — Plaintext leak into logs

- **Capability:** any callsite that accidentally logs req.body or err.message with credential text.
- **STRIDE:** Information Disclosure.
- **Mitigations:**
  - `envelope.ts:sanitizeParameters` redacts credential-shaped keys.
  - `audit.repo.ts.write` only accepts structured operator-safe fields; no plaintext path exists.
  - In-session regression `connectivity_credentials_audit.scanForPlaintext(needle)` returns false in the B2 integration test that creates a credential and asserts no audit row references the plaintext.
  - Spec §116.1 acceptance criterion 1 is gated on this scan.

## Acceptance criteria → mitigation mapping

| Spec §116 criterion | Mitigation |
|---|---|
| 1 — plaintext never written to logs or audit | A8 (sanitizer + audit-only-metadata + scan regression) |
| 2 — rotation bumps version + If-Match required + cache invalidated | `store.repo.ts:insertNewVersion`, `vault.ts:createOrRotate` cache invalidation, `connections.handler.ts:putConnection` If-Match check |
| 3 — audit row on every unwrap | `vault.ts:unwrap` writes audit in both success and failure branches |
| 4 — tampered ciphertext fails GCM | A5 (AEAD auth tag) |
| 5 — KMS adapter swap compile-only | `kms/index.ts` adapter factory + per-adapter files |

## Deferred (production-scale)

Recorded in `tasks/postgres-connection/B2/DEFERRED.md` (to be created when running real Vault/AWS/GCP tests):
- Real Vault Transit functional tests against a `hashicorp/vault` Testcontainer (the in-session adapter is `local-aesgcm`).
- Real AWS KMS functional tests against a `localstack` Testcontainer.
- Real GCP KMS functional tests (no canonical fake; deferred entirely).
- Hardware security module attestation (HSM-backed KEK).
