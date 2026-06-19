# B2 PLAN — Credential vault with pluggable KMS adapter

≤200 words per agent prompt §5.2.

**File order.**
1. `src/migrations/076_b2_connectivity_credentials.sql` + `.down.sql` — `connectivity_credentials` (envelope-encrypted blob + version) + `connectivity_credentials_audit` (write/read/unwrap audit).
2. `src/lib/kms/index.ts` — `KmsAdapter` interface (`wrap`/`unwrap`/`describeKey`).
3. `src/lib/kms/adapters/local-aesgcm.ts` — default; AES-256-GCM via `node:crypto`, KEK from `TELLUS_LOCAL_KEK_B64`.
4. `src/lib/kms/adapters/{vault-transit,aws-kms,gcp-kms}.ts` — stubs that throw `KmsUnavailable` until configured; documented in `DEFERRED.md`.
5. `src/services/connectivity/credentials/aesgcm.ts` — primitive: encrypt/decrypt with DEK.
6. `src/services/connectivity/credentials/vault.ts` — orchestrates `KmsAdapter.wrap(DEK)` + `aesgcm.encrypt(plaintext, DEK)`.
7. `src/services/connectivity/credentials/{store.repo,audit.repo}.ts` — Knex repos.
8. `src/services/multipass/tokens.ts` — workload JWT issuer + verifier for the `connectivity:credential-unwrap` scope + `connection_rid` claim.
9. `src/services/connectivity/handlers/secrets.handler.ts` — CRUD + rotation + internal unwrap endpoints (mounted by `index.ts`).
10. Wire into `index.ts`; add endpoints to `openapi.ts`.

**Tests.** Unit: aesgcm round-trip, KEK rotation, tamper-detection. Integration (Testcontainers PG): persist → rotate → unwrap; audit row written; plaintext scan over log + audit table per spec §116.1.

**THREAT_MODEL.md** per §6.

**Library choices.** `node:crypto` only; no extra deps. JWT via existing `jsonwebtoken` already in deps.
