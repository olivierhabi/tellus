# Automate Function effect — invocation contract: production runbook

Migration: `src/migrations/156_function_invocation_contract.sql` (+ `.down.sql`).
Admin endpoints: `GET /api/functions/registry/legacy/versions`, `GET /api/functions/registry/legacy/status`.
Metrics: `tellus_function_effect_executions_total{contract,status}`, `tellus_function_legacy_contract_executions_total{status}`.
Policy module: `src/services/functions/executionPolicy.ts`.

## 1. Invocation contract invariants (read first)

1. `function_registry_function_version.invocation_contract` (persisted per immutable
   published version) is the ONLY execution-mode selector. Execution never
   branches on arity, `fn.length`, `fn.toString()`, or object-key order.
2. `typescript-v2-positional-v2`: every published parameter resolves BY PUBLISHED
   NAME and invokes POSITIONALLY in immutable published order (`position`).
   `Client`-typed parameters are injected dependencies; nothing else is injected.
   The full bindings object is NEVER passed as an argument.
3. `legacy-object-envelope-v1`: the pre-contract behavior, byte-identical, for
   artifacts published before the column existed. Backfilled by migration 156.
4. Automatic upgrades resolve `>=pinned <(major+1).0.0`, never from a pinned
   version < 1.0.0, never to a prerelease, never to a signature-incompatible
   candidate, and **never across invocation contracts**. The resolved immutable
   artifact (`semver` + `artifact_sha256` + `invocation_contract` +
   `signature_hash`) is pinned ONCE per `automation_effect_execution` row;
   retries re-execute exactly that artifact. Retries never re-resolve "latest".
5. Artifact integrity: publish bundles are content-addressed
   (`artifact_sha256`) with a DB unique index enforcing immutability; blob
   reads verify the digest on fetch (`functionsRegistry/artifactStore.ts`);
   the effect pins `artifactSha256` at save time and the executor refuses
   identity mismatches (`FUNCTION_VERSION_INCOMPATIBLE`).

## 2. Supported parameter matrix (both layers agree)

| Published type kind                       | Constant binding | Dynamic binding | Editor                     |
|-------------------------------------------|------------------|-----------------|----------------------------|
| string / boolean                          | yes              | yes             | text / true-false select   |
| integer / long / float / double           | yes              | yes             | numeric input              |
| date ("YYYY-MM-DD")                       | yes              | yes             | date input                 |
| timestamp (RFC 3339 with zone, → UTC)     | yes              | yes             | datetime input             |
| optional(T) (incl. `T \| null`)           | yes (T editor)   | yes             | inner editor + omit        |
| list<E> / map<K,V> / struct{…}            | yes              | yes             | validated JSON editor      |
| Client (injected)                         | n/a (never user-bound) | n/a       | "injected" note            |
| **objectSet / ontologyObject / unsupported** | **NO**        | **NO**          | **DISABLED + explanation** |

Unsupported kinds are rejected server-side at activation (`FUNCTION_PARAMETER_UNSUPPORTED_TYPE`,
fatal issue) and at execution (same code, 422) — stale or hand-built configs fail closed.

Known unsupported UI surfaces in this release (honest gates, by design):
condition object-set binding editors, ontology-object reference pickers,
object-set parameter bindings. Implementing any of them requires the full
pipeline (UI + API + validation + execution + tests) — not this change.

## 3. Legacy contract deprecation controls

* **Metric** `tellus_function_legacy_contract_executions_total` — alert on
  `rate > 0` after the deprecation date.
* **Structured log** `automate.function.legacy_contract_execution` (functionRid,
  apiName, version, artifact prefix, automationId, effectId, deprecationDate).
  Never logs parameter values.
* **Inventory** `GET /api/functions/registry/legacy/versions` (superadmin).
* **Burndown** `GET /api/functions/registry/legacy/status` (superadmin):
  versions by contract, automation drafts pinning legacy versions, executions
  by contract over the last 30 days, current policy.
* **UI warning** — the Automate Function-effect editor shows a warning callout
  when a legacy-contract version is selected. Activation adds a non-fatal
  `FUNCTION_LEGACY_CONTRACT_DEPRECATED` validation warning.
* **Kill switch** `FUNCTION_LEGACY_CONTRACT_DISABLED=true` — legacy executions
  rejected with `FUNCTION_LEGACY_CONTRACT_DISABLED` (422). Positional
  executions are never affected. **Do not flip until the burndown report shows
  no automations pinning legacy versions.**
* **Sunset date** `FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE=YYYY-MM-DD` —
  surfaced in logs/UI/status; informational only.

### Migrating a legacy function to positional v2
1. Edit the source: declare the real parameters; remove the single-envelope
   parameter (`input`) and the placeholder-client convention if present.
2. Republish via `POST /api/code-repos/:rid/tags` (new immutable version rows
   stamp `typescript-v2-positional-v2` + canonical signature + `sha256:` hash).
3. Re-pin the automation to the new version (or rely on auto-upgrade — it can
   only cross to the new contract after a MAJOR republish under that contract
   AND an operator re-pin; auto-upgrade NEVER switches contracts on its own).
4. Never edit published artifacts in place.

## 4. Execution trust boundary (honest assessment)

**The current executor is NOT a secure boundary for untrusted code.** It is
`node:vm` code evaluation inside pooled `worker_threads` workers. It provides:
off-main-thread execution, per-worker V8 old-space cap
(`FUNCTION_WORKER_MAX_OLD_SPACE_MB`, default 256MB), per-phase CPU timeout
(`FUNCTION_TIMEOUT_MS`), wall-clock worker budget with terminate+respawn,
environment-variable allowlist (NODE_ENV/TZ/PATH/HOME only), a `require`
shim restricted to the ontology SDK, output (1 MiB) and log (1000 lines)
limits, and single-attempt failure isolation (no sync fallback). It does
**not** provide: kernel-level isolation, network or filesystem denial,
child-process denial, or secret isolation beyond the env allowlist.

Consequences are enforced in code (`authorizePublish()` in
`functions/executionPolicy.ts`, migration 164):

* **Keycloak publish role**: callers whose token carries
  `FUNCTION_PUBLISH_ROLE` (default `function:publish`) may publish globally.
* **DB grants** (`function_publish_grants`): active, non-revoked,
  non-expired grants scoped `global` or to one repository RID, matched on
  the local `users.id` or the Keycloak `sub`. Superadmins manage them via
  `POST|DELETE|GET /api/v1/functions/admin/function-publish-grants`
  (revocation is effective on the next request — no restart). Prefer
  time-bound grants (`expiresAt`).
* **Legacy env allowlist** (`FUNCTION_TRUSTED_AUTHOR_IDS`): still honored
  as a deprecated migration fallback — a once-per-process warning is logged
  and admissions are audited with `decision_source: env_allowlist`. Import
  entries with `scripts/import-function-trusted-authors.ts`, then unset it.
* `FUNCTION_EXECUTION_TRUST_MODE=open-development`: explicit development
  override. **Refused when `NODE_ENV=production`** (falls back to
  trusted-authors-only, logs `functions.execution_policy.open_mode_refused`).
* Anything else is denied (403 `CodeRepos:PermissionDenied` /
  `Functions:PermissionDenied`). Every decision — allow AND deny — is
  persisted to `function_publish_audit_log` (query it via
  `GET /api/v1/functions/admin/function-publish-audit-log`); an allow whose
  audit write fails is refused (500 `publish-audit-unavailable`) because
  publication is security-sensitive. Grants/authorization state are never
  cached across requests.
* Test lanes set `open-development` explicitly; the gate itself has dedicated
  tests (`tests/unit/functions/executionPolicy-unit.test.ts`,
  `tests/integration/code-repos/functions/publish-grants-integration.test.ts`).

### Threat model (documented, not mitigated by vm/worker_threads)
A malicious function artifact can: consume CPU/memory within the worker's
caps, read the allowlisted env vars (which contain no secrets), potentially
escape `vm` (CVE class: vm module is not a security boundary), and then act
with the API process's OS identity — network included. The trust gate makes
this a *trusted-author* problem rather than an *untrusted-code* problem until
Phase-B isolation lands.

### Follow-up specification: durable isolated execution (not this change)
1. Execution requests become immutable queue messages (artifact digest +
   signature hash + canonical bindings + execution id + idempotency key).
2. A separate worker fleet (no DB/API identity) claims messages; each claim
   spawns an ephemeral container/microVM: read-only rootfs, tmpfs workdir,
   network deny-all except the governed ontology adapter socket, CPU/memory
   cgroup limits, seccomp denying `clone`/`exec` for child processes.
3. The artifact fetch is digest-verified before unsealing into the sandbox.
4. Results/logs stream back into `automation_effect_attempt` rows;
   termination reasons (oom/cpu/wall/exit-code) are persisted.
5. `automation_effect_execution` already provides: leases + heartbeats,
   cancellation (queued), idempotent attempt keys, retry backoff, exact
   artifact reuse across retries, duplicate-claim protection
   (SKIP LOCKED + lease-owner CAS). The queue step keeps these semantics.

## 5. Migration 156 under production conditions

**Pre-deployment checks**
* `TELLUS_MIGRATION_GATE=strict` (production default) — apply via
  `npm run migrate` as a discrete step (`psql -f` for a single file also
  works; the file is idempotent).
* Confirm disk headroom for the backfill index build and that
  `function_registry_function_version` is small enough for the
  (non-concurrent) index build — locks are row-level `SHARE UPDATE EXCLUSIVE`
  for `VALIDATE CONSTRAINT` and a short `ACCESS EXCLUSIVE` for `ADD COLUMN`;
  both are milliseconds-scale on registry-sized tables, but verify with
  `pg_stat_activity` on staging first.

**Properties (verified by `scripts/verify-migration-156.sh` on a scratch DB)**
* Additive only (new columns, NOT VALID check constraint + `VALIDATE`,
  deterministic `legacy-md5:` backfill keyed by contract + signature jsonb).
* Restart-safe: every statement is `IF NOT EXISTS`/`IS NULL` guarded;
  re-running after partial failure completes remaining work only.
* Rolling-deployment safe: old application code ignores new columns (all
  nullable or defaulted); new code treats a NULL contract as legacy
  (`invocationContractOf`) and a NULL resolved-pin as "first attempt".
* Indexes are plain `CREATE INDEX` (registry + execution-session tables),
  not CONCURRENTLY: the migration gate applies DDL inside a transaction.
  If your `automation_effect_execution` table is large (> ~1e7 rows), apply
  the two indexes manually with `CREATE INDEX CONCURRENTLY` before running
  the migration (they are `IF NOT EXISTS`-guarded) — documented choice, see
  the migration header.

**Deployment order**: migrate (strict gate) → deploy new code (any order
within a window is safe by the compat properties above).

**Health checks after deploy**
* `GET /api/functions/registry/legacy/status` — versions counts sane,
  no unexpected growth.
* `rate(tellus_function_effect_executions_total[5m])` per contract sane;
  `automate.function.validation_failed` / `unsupported_parameter_type` /
  `legacy_contract_rejected` only when expected.

**Rollback decision points**
* Code rollback: safe at any time (new columns are inert to old code).
* Data rollback (run `156_function_invocation_contract.down.sql`): only if
  no positional-v2 executions matter yet — the down migration drops
  `resolved_*` columns, so already-pinned execution rows lose their pin
  metadata (rows remain executable; a retry simply re-resolves). Prefer
  **forward recovery**: fix forward, never drop.
* Down-then-up round trip is idempotent and data-preserving for registry
  rows (hashes are recomputable) — proven by the verification script.

## 6. Common error codes (stable)

| Code | Meaning |
|---|---|
| FUNCTION_PARAMETER_INVALID | typed validation failed; `issues[]` carry paths |
| FUNCTION_PARAMETER_UNSUPPORTED_TYPE | configured binding for an unsupported type kind |
| FUNCTION_LEGACY_CONTRACT_DISABLED | legacy contract execution while kill switch on |
| FUNCTION_SIGNATURE_UNAVAILABLE | positional contract row missing signature metadata |
| FUNCTION_VERSION_INCOMPATIBLE | configured ≠ registry identity (artifact/apiName/repo) |
| FUNCTION_VERSION_UNAVAILABLE | referenced artifact gone (yanked/unavailable) |
| FUNCTION_OUTPUT_TOO_LARGE | output > 1 MiB |
| FUNCTION_EXECUTION_TIMEOUT / FUNCTION_EXECUTION_FAILED | sandbox wall/CPU budget or artifact error |
| CodeRepos/Functions:PermissionDenied (reason `function-author-not-trusted`) | publish trust gate |
