# Tellus — DEEP Production-Readiness & Security Audit (second pass)

**Date:** 2026-06-01
**Scope:** `tellus` repo, working tree on branch `finishing-object-explorer` (note: the original audit said `main`; the tree is mid-development with modified connectivity files).
**Method:** read-only, citation-anchored. Findings I personally read end-to-end are tagged **[VERIFIED]**. Findings sourced from a sub-investigation with a concrete `file:line` that I did not re-read myself are tagged **[REPORTED]** — treat as high-confidence-but-confirm. Corrections to the first audit are called out explicitly.
**Relationship to the first audit:** `2026-06-production-readiness-security-audit.md`. This pass exists because that audit *explicitly sampled out* "the wider `src/services/**` layer (~450+ files)" and rated the single most important enterprise control — **authorization** — as `[SUSPECTED]` without verifying it. That sampled-out layer is where the ship-blockers live.

---

## 0. Verdict on the first audit: competent but surface-level, and partly stale

The first audit is **well-structured, honest about its own method, and correct on the architecture reconciliation** (Express 4 + `pg`/Knex, no Drizzle/Fastify, no frontend — all [VERIFIED]). Its positive-controls section is real: fail-closed global *authentication*, AEAD vault, parameterized SQL, graceful HTTP drain, migration gate. Credit where due.

But for the stated goal — *landing an enterprise client* — it is surface-level in three decisive ways, and wrong in two places:

| First audit's position | Reality (this pass) | Impact |
|---|---|---|
| AuthZ / multi-tenancy = **GAP [SUSPECTED]**, "enforced by convention" | **Broken Object- and Function-Level Authorization is structural and confirmed.** Any authenticated user can read/modify/**delete** any dataset, ontology object type, group, member role, quiver analysis, and connection **by ID**, and can **execute schema migrations** — none of these mutating routes carry a role/permission gate. | **Ship-blocker.** This is the #1 thing an enterprise security review tests, and it fails. |
| "**No P0 ship-blockers** (P0 count: 0)" | **At least one P0 class: missing object/function-level authorization** (OWASP API1 + API5). | The headline "0 P0" is false. |
| **F-01 (P1):** CORS reflects any origin + credentials by default | **Stale.** Current `server.ts:267-294` is **fail-closed in production** (`corsOrigin = corsOrigins?.length ? corsOrigins : !isProduction`) and strips test headers in prod. | First audit's top finding no longer applies to this code. |
| **F-06 (P3):** error logs dump "full SQL **and parameter array**" | **Overstated.** `db.ts:133-138` and `:353-358` log `sql`, `sqlState`, and `paramCount` — **not** parameter values. | Lowers F-06 to "SQL text in logs" only. |
| **F-05 (P2):** residual SSRF via DNS rebinding | **Fixed in the working tree.** `pool.ts:189` now calls `assertEgressResolved`, which resolves the host and rejects if any resolved IP is reserved, pinning the validated IP (`egress.ts:207-251`). | First audit's F-05 is closed; the egress layer is now a *strength*. |

**Net:** the first audit audited the *perimeter* (authN, CORS, secrets-at-rest, supply chain) thoroughly and the *interior* (who-can-do-what to which row) barely at all. The perimeter is in good shape. The interior is not.

---

## 1. P0 — Broken Object- & Function-Level Authorization (the enterprise ship-blocker)

The global gate (`globalAuth`) proves **who** you are and is genuinely fail-closed. **Almost nothing proves what you may do.** Authentication ≠ authorization, and the data plane conflates them.

### 1.1 Object-level (IDOR / OWASP API1) — read/modify/delete any object by ID

- **Datasets — [VERIFIED].** `src/routes/foundryDatasets.ts:16-24`: every route is `authenticate` only. The service queries by primary key with **no owner/project/org predicate**: `datasetService.ts:250` `.where({ id: datasetId }).first()`, `:267` `.update(...)`, `:464` `.delete()`. The caller's `user.id` is used only for the `updated_by` audit column, never as a filter.
  *Exploit:* any authenticated user calls `GET /api/v1/datasets/{uuid}` (metadata/schema), `GET .../{uuid}/download` (exfiltrate the file), or `DELETE /api/v1/datasets/{uuid}` (destroy it) for **any** dataset in the system.
- **Ontology object types — [VERIFIED].** `objectTypeService.ts:120,411,485`: `WHERE ontology_id = $1 AND api_name = $2`, where `ontology_id` comes straight from the URL path and is only checked for **existence**, never against the caller. No ontology→owner/membership table is consulted.
  *Exploit:* `PUT/DELETE /api/v1/ontology/{anyOntologyId}/objectTypes/{apiName}` rewrites or drops another tenant's schema.
- **Quiver analyses — [REPORTED, otService.ts:167,368].** OT mutations key on `WHERE rid = $1` only; the route bridge defaults `orgRid` to `"ri.multipass.main.org.default"` when the JWT has no `orgs` claim and never uses it in the WHERE clause.
- **Connectivity connections — [VERIFIED at the no-op].** The repo SQL is correctly written (`connections.repo.ts:131` `WHERE rid = $1 AND tenant = $2`), **but `$2` is always the literal `"default"`**: `normalizeClaims` (`globalAuth.ts:265-279`) emits no tenant field, and `extractUser` (`connections.handler.ts:202-207`) falls back to `"default"` with **no fail-closed**. So the tenant predicate partitions nobody.
  *Exploit (precise):* any authenticated user reads `GET /api/v1/connectivity/connections/{anyRid}/configuration` → another tenant's DSN **metadata** (host, port, user, database, egress policy) and can **update/delete** that connection. The **password itself is NOT returned** — it stays in the AEAD vault and `internalUnwrap` requires a workload JWT scoped to the specific RID (`secrets.handler` / `vault.ts`). So this is cross-tenant *config disclosure + tamper/delete*, not raw credential theft. Still P1.

**Correctly scoped (credit) — [REPORTED]:** favorites (`favorites.ts:35-119` `WHERE user_id = $1`), preferences, and projects (`projectService.ts:99,117` `WHERE owner_id = ?`) *do* filter by the authenticated principal. The team knows the pattern; it is applied to user-self-scoped resources and omitted on the shared data plane.

### 1.2 Function-level (OWASP API5) — privileged mutations with no role gate

The authorization primitives **exist** but are wired to a small fraction of the surface:

- `requireSuperAdmin` — only on `/api/v1/auth/admin/*`.
- `authorizeRoles(...)` (project_members) — only on uploads/autosave.
- `requireScope` (PAT scopes) — connectivity handlers only, and **only fires for PAT principals** (`source === "pat"`); an interactive JWT/cookie session bypasses scope checks entirely.
- `requirePermission` (gatekeeper) — **defined but not wired into any route** [REPORTED].

Sampled mutating/privileged endpoints with **only `authenticate`** (no role/permission gate):

| Endpoint | file:line | Tag |
|---|---|---|
| `PATCH /members/:userId` (change a member's role) | `members.ts:14` | **[VERIFIED]** |
| `DELETE /members/:userId` | `members.ts:13` | **[VERIFIED]** |
| `POST /api/v1/.../migrationManager/execute` (run schema migration) | `migrationManager.ts:53` | **[VERIFIED]** |
| `DELETE` objectType / `POST` create / `PUT` update | `objectTypes.ts:50,477,575` | **[VERIFIED]** |
| `DELETE` ontology | `routes/ontology.ts:243` | [REPORTED] |
| `DELETE` group | `routes/groups.ts:248` | [REPORTED] |
| `DELETE` link type / `PUT` link resolver config | `links.ts:553,1033` | [REPORTED] |
| `DELETE` property / interface / actionType | `properties.ts:259`, `interfaces.ts:830`, `actionTypes.ts:1044` | [REPORTED] |
| `DELETE` dataset / datasource | `datasets.ts:612`, `datasources.ts:195` | [REPORTED] |

*Exploit:* a freshly-provisioned user with an empty `roles[]` claim can self-promote (`PATCH /members/:me {role:"owner"}`), delete other users' data, drop ontology types, and trigger schema migrations. This is privilege escalation with no role check, independent of whether the deployment is single- or multi-tenant.

**Remediation (1.1 + 1.2):**
1. Introduce a resource→owner/org/project ownership model and a middleware that enforces it on `/api/v1/ontology/:ontologyId`, `/datasets/:id`, connectivity RIDs, and quiver RIDs — predicate every read/write on the verified principal, fail-closed.
2. Gate every mutating/privileged route with an explicit role/permission check (extend `authorizeRoles`/`requirePermission`); make "no role → deny" the default, not "authenticated → allow".
3. Derive `tenant`/`org` from a **verified** token claim (Keycloak protocol mapper) and **reject** when absent — never silently fall back to `"default"`. Back it with Postgres RLS keyed on `current_setting('app.tenant')` so a forgotten predicate cannot leak.

---

## 2. P1/P2 — confirmed secondary findings

| ID | Sev | file:line | Finding | Tag |
|---|---|---|---|---|
| D-01 | **P1** | `compute.ts:59`, `versions.ts:27`, `analyses.ts:47`, `wsGateway.ts:160` | **Quiver test-auth bypass has no `NODE_ENV` backstop.** Handlers accept `x-test-user` as the actor whenever `QUIVER_ALLOW_TEST_AUTH==="1"`. The `NODE_ENV!=="production"` guard exists only on the *globalAuth allowlist entry*, not on these route handlers. One env var flipped in prod = header-injected identity on every quiver mutation. (The first audit's F-04 is **correct for quiver, refuted for code-repos** — code-repos has a hard `NODE_ENV` check at `principal.ts:94`.) | **[VERIFIED]** |
| D-02 | **P1** | `coverage-gate.yml:87-92` | **The green coverage gate is misleading.** The core mutation engine is ratcheted to near-zero enforced branch coverage: `actionExecutor.ts: 0`, `editApplicator.ts: 0`, `queryExecutor.ts: 0`, `branchMergeService.ts: 2` (each `// TODO: raise to 80`). `vitest.config.ts` declares an `include` list but **no `thresholds`**. A regression in the action/edit/merge path ships with the gate still green. | **[VERIFIED]** |
| D-03 | **P1** | repo-wide; `src/migrations/` | **No backup/DR anywhere in-repo** (confirms first audit). ~**43% of migrations have no `.down.sql`** (44 downs / 77 ups), several ups contain `DROP`/`DELETE`. A bad deploy on a down-less migration requires a manual restore that does not exist. | [REPORTED] |
| D-04 | **P1** | `server.ts:206`, `boot/cacheAndRateLimit.ts:15,40`, `redisRateLimiter.ts:170` | **Rate limiting silently degrades to per-replica in-memory.** The global Express limiter uses the default MemoryStore; the action limiter only uses Redis when `RATE_LIMIT_BACKEND=redis` and falls back to memory silently otherwise. With N pods a client gets N× the limit; with Redis down the limiter fails open. "Redis-backed rate limiting" (first audit PASS) is opt-in and degrades without erroring. **Downgrade PASS→GAP.** | [REPORTED] |
| D-05 | **P2** | `tellusAuthService.ts:308-315` | **Token revocation (`isJtiRevoked`) fails OPEN on DB error** — a DB blip causes a revoked/logged-out token to be accepted. | [REPORTED] |
| D-06 | **P2** | `db.ts:43-82` | **No `statement_timeout` on the primary PG pool** (`max:20`). One pathological query holds a connection indefinitely; a handful exhausts the pool and wedges the service. | **[VERIFIED]** |
| D-07 | **P2** | `server.ts:1119,1133,1369-1463` | **Graceful shutdown does not stop background dispatchers/sweepers** (funnel, pipeline, overlay, temporal, iceberg, replacement, idempotency cleanup, auth sweeper). They keep issuing queries against a closing pool during drain. **Downgrade PASS→partial.** | [REPORTED] |
| D-08 | **P2** | `quiver/ot/eventBus.ts:51`, `websocket/eventBus.ts` | **In-process `EventEmitter` fan-out** — WS/presence/OT notifications are not delivered across replicas. Live notification correctness caps at 1 replica (or requires sticky-by-rid + Redis/Kafka fan-out). The OT *data* path is durable and replica-safe (Postgres `FOR UPDATE` + instruction log) — credit. | [REPORTED] |
| D-09 | **P2** | `wsGateway.ts:54,159-172` | **Quiver collab WS gateway is not wired** (`attachQuiverWs` has no caller; server mounts only the foundry WS). If/when wired, `defaultResolveUser` is a **placeholder that does not verify the JWT** (derives a pseudo-user from the first 16 chars of the token) and performs no doc-level authz. Dead today; latent P0 if enabled. | [REPORTED] |
| D-10 | **P2** | `searchAround/clickhouseTraversal.ts:142` | **ClickHouse string-literal escape doubles `'` only** — ClickHouse also honors backslash escapes, so the escaping is technically wrong for the engine. Reachable only on the >100k-PK escalation path and markings are re-enforced at the API boundary, so hard to drive, but fix to HTTP query params. (Wider injection sweep otherwise **clean** — the codebase is consistently parameterized; identifiers use allowlist/quote-doubling.) | [REPORTED] |
| D-11 | **P2/P3** | `scripts/fix-conn-20e01559.sh:19-45` | **Hygiene smell (untracked).** Hardcodes a PG admin password (`tellus123`), decrypts a live vault credential and echoes the plaintext through `psql` argv, and hardcodes a specific RID + the developer's email. Do not commit; rewrite to pull admin creds from env and never decrypt-and-echo vault plaintext. | [REPORTED] |
| D-12 | **P3** | `server.ts:284-292` cookie + `tellusAuthV1.ts:125` | **No CSRF token** anywhere; mitigated by `SameSite=strict` cookies in prod. Acceptable, but document it and ensure no prod cookie path is `SameSite=None/Lax`. | [REPORTED] |

---

## 3. Corrections to the first audit (brutal honesty cuts both ways)

- **F-01 (CORS) — partially WRONG / stale.** Production is fail-closed (`server.ts:273-274`). Downgrade to **P3, dev-only** (non-prod still reflects origin + credentials).
- **F-06 (log params) — overstated.** Only `sql`+`sqlState`+`paramCount` are logged, not values (`db.ts:133-138,350-358`). The residual issue is **SQL text** in logs (can still embed literals in some hand-built statements); keep as **P3**.
- **F-05 (DNS-rebinding SSRF) — now FIXED** by `assertEgressResolved` (`pool.ts:189`, `egress.ts:207-251`). Move to positive controls.
- **INFO-1 (discovery SQL) — confirmed safe** by an independent full injection sweep; the whole connectivity/identifier-quoting discipline holds.

---

## 4. Revised scorecard (deltas from first audit)

| Dimension | First audit | This pass | Why |
|---|---|---|---|
| AuthN | PASS | **PASS** | Global fail-closed gate is real. |
| **AuthZ (object + function level)** | GAP [SUSPECTED] | **FAIL — P0** | Confirmed BOLA/BFLA across the data plane (§1). |
| Multi-tenant isolation | GAP | **FAIL — P0/P1** | `tenant` always `"default"`; no org store; no fail-closed (§1.1). |
| CORS/CSRF | GAP (P1) | **PASS (prod) / minor** | Prod is fail-closed; F-01 stale. |
| SSRF / egress | GAP (P2 residual) | **PASS** | DNS-pin + blocklist floor now in place. |
| Secrets at rest | GAP | **GAP** | KEK/secrets still in on-disk `.env`; but per-tenant HKDF + prod-fail-closed KMS adapter are strong (credit). |
| Supply chain (npm vs pnpm) | GAP | **GAP** | Unchanged; valid finding. |
| Rate limiting | PASS | **GAP** | Silent per-replica in-memory fallback (D-04). |
| Graceful shutdown | PASS | **GAP** | Workers not quiesced (D-07). |
| HA / horizontal scale | (not rated) | **GAP** | In-process buses/limiters/queues cap notification & fairness at 1 replica (D-04, D-08). Data plane *does* scale (PG-locked OT, `SKIP LOCKED` dispatchers) — credit. |
| Backup / DR | MISSING | **MISSING — P1** | Confirmed; + ~43% irreversible migrations (D-03). |
| CI quality / coverage honesty | GAP | **GAP — P1** | Real integration infra (credit) but the coverage gate enforces 0–2% on the core engine (D-02). |

---

## 5. Re-prioritized roadmap for the enterprise sale

**Must fix before any enterprise security review (P0/P1):**
1. **Authorization.** Add object-level ownership enforcement + function-level role gates across the mutating data plane (§1). This is the deal-breaker; everything else is secondary. Effort **L**.
2. **Real tenant derivation + fail-closed** (`globalAuth`/`extractUser`); back with Postgres RLS. Effort **M**.
3. **Quiver `NODE_ENV` backstop** on the `x-test-user` handlers (D-01). Effort **S**.
4. **Coverage gate honesty** — raise the ratcheted core-engine files toward a real threshold and add `vitest` thresholds; stop reporting green on 0% (D-02). Effort **M**.
5. **Backup/DR runbook + reverse-migration policy** (D-03). Effort **M**.
6. **Rate-limiter + shutdown HA** — make Redis mandatory in prod (fail-closed, not silent memory), quiesce workers on shutdown (D-04, D-07). Effort **M**.

**Carry-over from first audit (still valid):** single package manager (F-02), externalize KEK/secrets to KMS (F-03), `statement_timeout` (D-06), lint/SAST gate (F-07), pin Node + complete `.env.example` (F-08/09).

**Close (no longer apply):** F-01 (prod fail-closed), F-05 (DNS-pin shipped).

---

## 6. Coverage of this pass

**Personally read end-to-end [VERIFIED]:** `securityContext.ts`, `globalAuth.ts` (claims/normalize/cookie/allowlist), `db.ts` (error-log + pool config), `server.ts:260-300` (CORS), `connections.handler.ts` (extractUser), `connections.repo.ts` (tenant predicate), `datasetService.ts` + `foundryDatasets.ts`, `objectTypeService.ts`, `egress.ts` (full), `pool.ts:150-199` (egress call path), `members.ts`, `migrationManager.ts`, `coverage-gate.yml`, quiver `actorFromReq` guards.

**Sub-investigated with `file:line` [REPORTED] — confirm before remediation sign-off:** the full BOLA/BFLA route table (§1.2), favorites/projects positive controls, quiver otService IDOR, rate-limiter/shutdown/event-bus HA, isJtiRevoked fail-open, migration reversibility ratio, ClickHouse escape, the `fix-conn` script, WS gateway dead-code/placeholder-auth.

**Not covered (next pass):** exhaustive per-handler BOLA verification across all ~478 endpoints (only a representative sample traced to SQL); the funnel/pipeline/temporal/opensearch service internals beyond security boundaries; runtime/dynamic testing (this was static, read-only).
