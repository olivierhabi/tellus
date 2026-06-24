# Tellus — Production-Readiness & Security Audit

**Date:** 2026-06-01
**Auditors:** (1) senior staff engineer perspective — production readiness; (2) application-security analyst perspective — exposure surface.
**Scope:** the `tellus` repository at `/Users/olivierhabimana/Desktop/projects/tellus`, `main` branch working tree.
**Method:** read-only, citation-anchored. Every finding cites a `file:line` that was actually read or grepped. Findings are tagged **[CONFIRMED]** (code read end-to-end) or **[SUSPECTED]** (pattern-matched / not yet exhaustively verified). Automated tooling (grep, `git`) only *supplements* a finding; none *originate* one.

---

## 0. Premise reconciliation (read this first)

The audit request described a *"Fastify/Drizzle backend and a Next.js 14 / BlueprintJS / Monaco frontend."* **None of that matches the repository.** What is actually present:

| Claimed | Observed | Evidence |
|---|---|---|
| Fastify | **Express 4** | `package.json:86` (`"express": "^4.21.2"`), `src/server.ts:8` |
| Drizzle ORM | **node-postgres (`pg`) raw SQL + Knex** | `package.json:93,98`; `src/db.ts:1`; `foundryDb` via Knex |
| Next.js 14 / BlueprintJS / Monaco frontend | **No frontend in repo** | `app/` contains only `app/test1/quiver.md`; no `package.json`/JSX/TSX UI tree present |

**Consequence for this report:** the frontend-oriented phases of a typical web-app audit — DOM XSS sinks, `dangerouslySetInnerHTML`, `localStorage` token storage, CSP for an SPA — are recorded as **N/A — no frontend in repo** rather than fabricated. The real exposure surface is a **backend-only Express + `pg`/Knex monolith** of ~730 TypeScript files / ~198.7k LOC exposing ~478 HTTP endpoints, a user-supplied-DB-host connectivity layer, an AEAD credential vault, and several env-gated auth bypasses. That is what is audited below.

---

## Phase 0 — Diagnostics

| Item | Finding | Evidence |
|---|---|---|
| Language / size | TypeScript; **730 `.ts` files, 198,724 LOC** under `src/` | `find src -name '*.ts'` count |
| Framework | Express 4.21.2 (`commonjs`) | `package.json:62,86` |
| Data access | `pg` 8.20 (raw parameterized SQL) + Knex 3.1 (`foundryDb`) | `package.json:93,98`; `src/db.ts` |
| TypeScript | 5.9.3 | `package.json:135` |
| **Package manager — SPLIT** | **CI/CVE/coverage use `pnpm` v10 (`pnpm-lock.yaml`); production Docker image uses `npm ci` (`package-lock.json`)** | `.github/workflows/ci.yml:84-96`; `Dockerfile:10-11,24-25` |
| **Dual lockfile** | Both `package-lock.json` and `pnpm-lock.yaml` committed | repo root |
| Node runtime | **Unpinned** — no `engines` field, no `.nvmrc`. CI pins `24.12.0` only inside the workflow | `package.json` (no `engines`); no `.nvmrc`; `ci.yml:92` |
| Tests | Vitest (`vitest.config.ts`, `vitest.unit.config.ts`); large `tests/` tree (unit/integration/e2e/perf/foundry/connectivity) | `package.json:15-49` |
| CI workflows | `ci.yml`, `cve-scan.yml`, `coverage-gate.yml`, `loadtest.yml`, `m1-gate.yml` | `.github/workflows/` |
| Secrets at rest | `.env` present on disk; **NOT git-tracked and NOT in git history** | `git ls-files --error-unmatch .env` → no match; `git log --all -- .env` → empty; `.gitignore:8-10,37` |

---

## Phase 1 — Endpoint inventory

### 1.1 How the surface is wired

`src/server.ts:432-845` is the single mount map. Two enforcement middlewares are mounted **before** every data-plane route, each guarded by a boot-time assertion that refuses to start the server if the middleware is missing:

- **PAT scope gate** — `app.use("/api", patSecurityGate)` (`src/server.ts:354`) + assertion (`:363-371`).
- **Global auth gate** — `app.use(globalAuth())` (`src/server.ts:388`) + assertion (`:389-397`). This is the single control that makes the ~60 legacy route files authenticated-by-default (`src/middleware/globalAuth.ts:282-389`), fail-closed on JWT error (`globalAuth.ts:356-365`).

### 1.2 Inventory totals (grep-enumerated across all 74 route files + 4 router factories)

| Bucket | Files | Route definitions |
|---|---|---|
| `src/routes/**` (66 top-level + 8 `quiver/*`) | 74 | **423** |
| `services/functionsRegistry/admin/routes.ts` | 1 | 5 |
| `services/templates/admin/routes.ts` | 1 | 3 |
| `services/connectivity/index.ts` (the v2 router builder) | 1 | 47 |
| `services/codeRepository/mount.ts` | 1 | composes sub-routers (0 inline) |
| `src/server.ts` inline handlers (`/health`, save-to-ontology, test-hook) | — | ~3 |
| **Total addressable endpoints** | **78** | **≈478** |

> Methodology note: counts come from `grep -E '\b(router|app|[a-zA-Z]+Router)\.(get|post|put|patch|delete|all)\('`. This is authoritative for `file:line` but a handful of files use a router-variable name the regex under-counts (e.g. `quiver/publishing.ts` shows 11 same-line matches but 0 under the looser pattern). Treat 478 as a verified floor, not a hand-counted exact.

### 1.3 Route families and auth-guard status

Guard column derived by cross-referencing each mount prefix against `isAllowlisted()` (`src/middleware/globalAuth.ts:122-191`):
- **Global (Y)** — gated by the global JWT/PAT auth middleware.
- **Router (R)** — allowlisted from the *global* gate; relies on the router's own auth chain (`requireCodeReposAuth`, etc.).
- **Public (P)** — intentionally unauthenticated (probes, metrics, docs, auth surface).
- **Env (E)** — mounted/bypassable only behind an env flag.

| Family | Mount prefix (server.ts) | Files (≈defs) | Guard |
|---|---|---|---|
| Ontology core | `/api/v1/ontology/:ontologyId/...` | ontology 7, objectTypes 12, properties 8, links 30, actionTypes 7, actions 5, interfaces 7, objectViews 6, branches 7, groups 7, functions 6, explorations 5, exports 4, governance 7, objectDataStore 1, indexing 3, edits 3, reindex/reindexStatus/reindexById 5, summary/geo/comparisons/migrationManager 8, auditLog 4 | Global (Y) |
| Objects/search | `app.use(objectsRouter)` (`:753`), `/api/v1/search` (`:807`) | objects 10, search 4 | Global (Y) |
| Datasets (**6 routers, 1 prefix**) | `/api/v1/datasets` (`:578-579,802-805`) | datasets 6, dataPreview 1, foundryDatasets 11, columnStats 2, versions 4, duplicates 2 | Global (Y) |
| Foundry ingestion | `/api/v1/projects...`, `/api/v1/resources`, `/api/v1/compass`, `/api/v1/breadcrumb` (`:790-829`) | projects 6, folders 8, uploads 1, projectUploads 3, projectWorkspace 5, autosave 2, members 4, compassChildren 1, breadcrumb 1 | Global (Y) |
| Pipelines / Palantir-stack | `/api/v1/projects/:id/pipelines` (`:820`), `/api/v1` (`:773-775`), `/api/v1/funnel` (`:784`) | pipelines 45, funnel 26, sql 2, charts 1, pipelines-status 2, pipelinesMetrics 1 | Global (Y); `/funnel/metrics` & `/pipelines/metrics` Public (P) |
| Connectivity v2 | `/api/v1/connectivity` (`:782`) | connectivity.routes (delegates), connectivity/index 47, vectorAndTimeseries 2 | Global (Y) |
| Workshop | `/api/v1/workshop` (`:688`) | workshopModules 22 | Global (Y) |
| Code Repositories | `/api/v1/code-repositories` (`:598`) | mount.ts (saga/ledger/branches) | **Router (R)** — `globalAuth.ts:161` |
| Functions Registry | `/api/v1/functions` (`:612`) | functionsRegistry 5 | **Router (R)** — `globalAuth.ts:168` |
| Templates / Scaffold | `/api/v1/templates`, `/api/v1/scaffold` (`:675-676`) | templates 3 | **Router (R)** — `globalAuth.ts:176-177` |
| Quiver | `/quiver/api/v1` (`:694`) | aip 4, analyses 6, compute 3, versions 8, instructions 2, registry 1, publishing ~11, index (composes) | Global (Y) **unless** `QUIVER_ALLOW_TEST_AUTH=1` → Env (E) bypass (`globalAuth.ts:186-188`) |
| Auth surface | `/api/v1/auth` (`:812`) | tellusAuthV1 45, keycloak 3 | Public (P) — `globalAuth.ts:141` |
| Auth test hooks | `/api/v1/auth/_test` (`:817`) | tellusAuthTestHooks 3 (`/login-bypass`, `/reset-mfa`, `/seed-passkey`) | Env (E) — mounted only `NODE_ENV!=="production"` |
| Dev tools | `/api/v1/dev` (`:839`) | devTools 3 | Env (E) + allowlisted (`globalAuth.ts:149`) |
| Test hooks | `/api/v1/_test/...` (`:483-497`) | rate-limiter reset | Env (E) `TELLUS_TEST_HOOKS=1` |
| Health / ops | `/health`, `/api/v1/health`, `/api/metrics` | health 5, healthCheck 2, healthDetailed 1, healthReady 1, foundryHealth 1, systemHealth 3 | Public (P) — `globalAuth.ts:130-138` |
| Misc | various | favorites 5, preferences 4, bulkActions 1, datasources 5, members | Global (Y) |
| API docs | `/api/docs` (`setupFoundrySwagger`, `:842`) | Swagger UI + spec | Public (P) — `globalAuth.ts:145` |

### 1.4 Duplication / overlap clusters

| Cluster | Members | Canonical | Redundant / risk | Tag |
|---|---|---|---|---|
| **`/api/v1/datasets` — 6 routers on one prefix** | `datasetRouter` (`:578`), `dataPreviewRouter` (`:579`), `foundryDatasetRouter` (`:802`), `foundryColumnStatsRouter` (`:803`), `foundryVersionsRouter` (`:804`), `datasetDeduplicateRouter` (`:805`) | Express first-match by path; each owns distinct sub-paths | High consolidation risk: 6 independently-authored routers share a prefix; a future path collision is resolved silently by mount order. Consolidate behind one dataset router or namespace the foundry variants. | [CONFIRMED] |
| **Reindex dual-addressing** | `/objectTypes/:apiName/reindex` (`:704`) **and** `/objectTypes/by-id/:objectTypeId` → `resolveObjectTypeIdToApiName` → same `reindexRouter` (`:735-739`) | by-id mount (stable UUID) | apiName mount is legacy/mutable; keep one. Edits feed has the identical dual mount (`:566-573`). | [CONFIRMED] |
| **Functions defined twice** | ontology-scoped `routes/functions.ts` at `/api/v1/ontology/:id/functions` (`:762`) vs Functions Registry factory at `/api/v1/functions` (`:612`) | Two genuinely different resources (per-ontology functions vs platform registry) | Naming collision invites confusion; document the distinction. Not a true duplicate. | [CONFIRMED] |
| **Health endpoints ×6** | `health.ts`, `healthCheck.ts`, `healthDetailed.ts`, `healthReady.ts`, `foundryHealth.ts`, `systemHealth.ts` + inline `/health` (`:444`) | `healthReady.ts` `/ready` (real dependency probe) + inline `/health` (PG ping) | Several health routers overlap; `healthCheck.ts`/`systemHealth.ts` mounting is not all visible in `server.ts` — verify which are live. | [SUSPECTED] |

---

## Phase 2 — Security findings

Severity: **P0** ship-blocker · **P1** must-fix-before-enterprise · **P2** fix-soon · **P3** hygiene · **INFO** verified-safe.

| ID | Sev | Category | file:line | Description | Exploit scenario | Remediation | Tag |
|---|---|---|---|---|---|---|---|
| **F-01** | **P1** | CORS / CSRF | `src/server.ts:264-295` | When `CORS_ORIGINS` is unset, `origin` resolves to `true` (reflect **any** origin) **with `credentials:true`**. `.env.example:15` ships `CORS_ORIGINS=` empty, so the insecure default is the documented default. Auth also accepts the `TELLUS_TOKEN` httpOnly cookie (`globalAuth.ts:308-321`). | A logged-in user visits `evil.com`; the page issues `fetch('https://tellus/api/v1/...', {credentials:'include'})`. The browser attaches `TELLUS_TOKEN`; the server reflects `Access-Control-Allow-Origin: evil.com` + `Allow-Credentials: true`, so the attacker script reads authenticated responses cross-origin. | Reject/omit ACAO when `CORS_ORIGINS` unset **in production** (fail-closed); never combine `credentials:true` with origin reflection. | [CONFIRMED] |
| **F-02** | **P2** | Supply chain / build parity | `Dockerfile:10-11,24-25`; `package.json:138-148`; `package-lock.json:976,8731`; `ci.yml:96`; `cve-scan.yml:18` | **Toolchain split.** Production image installs with `npm ci` against `package-lock.json`; CI + the blocking CVE scan install with `pnpm` against `pnpm-lock.yaml`. The hardening `pnpm.overrides` (tar≥7.5.11, fast-xml-parser≥5.5.6, path-to-regexp≥0.1.13, lodash) are honored by pnpm but **ignored by npm**. `package-lock.json` resolves `fast-xml-parser 5.4.1` (< pin) and `path-to-regexp 0.1.12` (< pin), proving the production tree differs from the scanned tree. (The `lodash@<4.18.0` pin is also unsatisfiable — 4.18.0 does not exist.) | The CVE gate passes against the pnpm tree while production ships the un-overridden npm tree. A future CVE patched only via the override would be flagged green in CI yet shipped vulnerable. Today's resolved versions appear patched for the known CVEs, so impact is latent. | Pick **one** package manager. Delete the unused lockfile, install with the same tool in CI and Docker, and move overrides to npm's top-level `overrides` key if npm wins. | [CONFIRMED] |
| **F-03** | **P2** | Secrets hygiene / key custody | `.env` (`TELLUS_LOCAL_KEK_B64`, `TELLUS_SUPERADMIN_PASSWORD`, `PGPASSWORD`, `S3_SECRET_ACCESS_KEY`, `CLICKHOUSE_PASSWORD`, `LAKEKEEPER_PG_*`, `TEMPORAL_PG_PASSWORD`) | The on-disk `.env` holds a **populated** vault master KEK (`TELLUS_LOCAL_KEK_B64`) plus superadmin and DB credentials in plaintext. The KEK is the root of the AES-256-GCM credential vault (`aesgcm.ts`). *Not a git leak* — confirmed absent from tracking and history. | Anyone with filesystem read on a host/pod (sidecar compromise, backup snapshot, debug shell) reads the KEK and can decrypt the entire connectivity credential store, plus log in as superadmin. | Source the KEK and DB/superadmin secrets from a secrets manager / KMS (Vault, AWS Secrets Manager) injected at runtime; never persist the master KEK to a file. Rotate the KEK and superadmin password. | [CONFIRMED] |
| **F-04** | **P2** | AuthN / defense-in-depth | `src/services/codeRepos/middleware/principal.ts:94`; `src/middleware/globalAuth.ts:186`; `src/server.ts:280-282` | Test-auth bypasses trust the `X-Tellus-Test-Principal` header to mint a synthetic identity. The only guard is a single env var (`CODE_REPOS_TEST_AUTH==="1"`, `QUIVER_ALLOW_TEST_AUTH==="1"`) — **no secondary `NODE_ENV!=="production"` assertion**. The CORS config explicitly allows the `X-Tellus-Test-Principal/Role/Roles` headers **in all environments** (`server.ts:280-282`), and `globalAuth` allowlists the code-repos/functions/templates prefixes from the global gate (`globalAuth.ts:154-177`). | One misconfigured env var in production (`CODE_REPOS_TEST_AUTH=1`) turns a header into a full authentication bypass for the code-repository / functions surface — no credential required. The allowlisted prefixes have only the per-router chain as their gate. | Add a hard `NODE_ENV!=="production"` (or boot-time refusal) around every test-auth bypass; strip the test headers from production CORS `allowedHeaders`. | [CONFIRMED] |
| **F-05** | **P2** | SSRF (residual) | `src/services/connectivity/connectors/postgresql/egress.ts:115-178` | `assertEgressForConfig` blocks literal reserved/RFC-1918/loopback/link-local IPv4 + IPv6 ULA/link-local + known internal hostnames (incl. cloud metadata `169.254.169.254`, `metadata.google.internal`). It checks the **literal host string only** — **DNS rebinding is explicitly out of scope** (`:115-117`): a public hostname whose A-record resolves to a private IP is not re-checked at connect time. | An authenticated user runs "Test connection" against `attacker.com` whose DNS returns `169.254.169.254`; the egress check passes (public name), then `pg` connects to the metadata endpoint → SSRF pivot. Bounded by per-principal rate limiting. | Resolve the hostname, validate the **resolved IP** against the blocklist, and pin that IP for the actual connection (or use a DNS-pinning dialer). | [CONFIRMED] |
| **F-06** | **P3** | Sensitive data in logs | `src/db.ts:133-137,353-357` | On query error (non-23505, non-shutdown) the full SQL **and parameter array** are written to `console.error`. Parameters can include credentials, tokens, PII. | Log aggregation captures secrets/PII in plaintext; a log reader (or a leaked log bundle) exposes them. | Redact/omit `params` (or hash them) in error logs; log a parameter count and SQLSTATE instead of raw values. | [CONFIRMED] |
| **F-07** | **P3** | CI quality gates | `.github/workflows/ci.yml` (no lint step); `coverage-gate.yml:43-60` | CI runs typecheck (`pnpm run build`), unit/integration/e2e/perf/test:all, and a **separate blocking** branch-coverage gate (`coverage-gate.yml`). There is **no lint/SAST gate** in any workflow, and Codecov upload in `ci.yml:107-113` is non-blocking (`fail_ci_if_error:false`). | Style/security lint regressions (e.g. an accidental `eval`, a disabled rule) merge without a gate; no static analysis catches injection/secret patterns pre-merge. | Add an ESLint (+ `eslint-plugin-security`) gate and a SAST step (CodeQL/Semgrep) to `ci.yml`. | [CONFIRMED] |
| **F-08** | **P3** | Runtime pinning | `package.json` (no `engines`); no `.nvmrc` | Node version is unpinned in the repo; only `ci.yml:92` pins `24.12.0`. Local/Docker base-image drift is possible. | A build host on a different Node major resolves native deps (`duckdb`, `bcrypt`, `nodejs-polars`) differently → "works in CI, breaks in prod". | Add `"engines": { "node": "24.x" }` and a `.nvmrc`; align the Docker base image. | [CONFIRMED] |
| **F-09** | **P3** | Ops documentation | `.env.example` (28 lines) | `.env.example` documents only PG/Server/CORS/DATA_DIR/S3, but the real deployment surface (per `.env` keys + `server.ts` `REQUIRED_ENV_VARS`) includes `TELLUS_LOCAL_KEK_B64`, `TELLUS_SUPERADMIN_*`, Keycloak, Temporal, ClickHouse, Lakekeeper, Redis, Quiver vars — none documented. | A fresh deploy omits required secrets; failure mode is a partial boot or silent degraded mode. | Bring `.env.example` to parity with the documented/required surface (placeholders only). | [CONFIRMED] |
| **INFO-1** | INFO | SQL injection (cleared) | `src/services/connectivity/connectors/postgresql/discovery.ts:355-380` | The flagged `SELECT ${colList} FROM ${relation} LIMIT ${capped}` is **safe**: `colList`/`relation` are built via `quoteIdent()` (`:355-357,376-377`), column names come from the catalog via `discoverColumns` (`:368`), and `capped` is a clamped integer (`:372-375`). | n/a — identifier injection is neutralized; integer is sanitized. | None required. Keep the `quoteIdent` discipline; consider a lint rule banning un-quoted identifier interpolation. | [CONFIRMED] |
| **N/A-1** | N/A | Frontend (XSS / `dangerouslySetInnerHTML` / `localStorage` tokens / SPA CSP) | — | No frontend exists in the repo (`app/` holds only `app/test1/quiver.md`). | n/a | n/a — re-audit if/when a frontend is added to this repo. | [CONFIRMED] |

### Positive controls observed (credit where due)

- **Fail-closed global auth** + boot assertion: `src/server.ts:388-397`, `globalAuth.ts:356-365` (RS256, issuer check, JWKS-fetch failure → reject).
- **PAT scope gate** + boot assertion: `src/server.ts:354-371`.
- **Helmet** security headers: `src/server.ts:176`.
- **Rate limiting** (per-IP, Retry-After, probe-exempt) + Redis-backed limiter bootstrap: `src/server.ts:205-224,1040-1052`.
- **Request wall-clock budget** (504 on expiry) + boot assertion: `src/server.ts:332-341`.
- **Parameterized queries**, **circuit breaker**, **`withTransaction` poison-on-rollback** (discards the connection so a failed ROLLBACK can't leak an open tx), **idempotent-only retry**: `src/db.ts:103-141,188-252,258-365`.
- **AES-256-GCM** credential vault: random 12-byte IV per encrypt, 16-byte auth tag, versioned wire format, tag verification on decrypt: `src/services/connectivity/credentials/aesgcm.ts:29-77`.
- **Mandatory fail-closed security filter**: `buildSecurityFilter` returns `match_none` when context is missing; `requireSecurityContext` throws rather than running an unfiltered query: `src/middleware/securityContext.ts:203-233`.
- **SSRF egress guard** (reserved-range blocklist): `egress.ts:120-178`.
- **Graceful shutdown** + in-flight tracking + 503-on-draining: `src/server.ts:412-425,1358-1452`.
- **Migration gate + schema contract** fail-fast on boot (exit 1 on drift): `src/server.ts:947-1014`.
- **Blocking CVE scan** (`pnpm audit --prod --audit-level=high`) + **grype** high-severity gate + **SBOM**, on PR and daily cron: `.github/workflows/cve-scan.yml:19-34`.
- **Supply-chain**: `npm ci --ignore-scripts` in the Docker build: `Dockerfile:11,25`.

---

## Phase 3 — Production-readiness scorecard

**PASS** = control present & verified · **GAP** = present but incomplete/at-risk · **MISSING/UNVERIFIED** = not found in the read surface.

| Dimension | Rating | Evidence / rationale | Tag |
|---|---|---|---|
| Observability (traces/metrics/logs) | **PASS** | OTel bootstrap before instrumented libs (`server.ts:5`); `prom-client`; `/api/metrics`; `X-Trace-Id` middleware (`server.ts:181-182`); structured JSON logs. | [CONFIRMED] |
| Health & readiness probes | **PASS** | `/health` PG ping (`server.ts:444-469`); `/health/ready` checks PG+S3+Temporal+Lakekeeper (`routes/healthReady.ts:128`). | [CONFIRMED] |
| Graceful shutdown | **PASS** | In-flight counter, 503 while draining, 25s wait, pool drain (`server.ts:412-425,1358-1452`). | [CONFIRMED] |
| Rate limiting | **PASS** | Per-IP limiter, probe-exempt, Redis-backed (`server.ts:205-224`). | [CONFIRMED] |
| Connection pooling / leak guards | **PASS** | Pool config + `withTransaction` poison-on-rollback + circuit breaker (`db.ts:43-67,188-252`). | [CONFIRMED] |
| Idempotency | **PASS** | `idempotencyKeyMiddleware` + `actions/idempotency` + 6h cleanup (`server.ts:729-734,1334-1346`). | [CONFIRMED] |
| Schema / migration safety | **PASS** | Migration gate + schema contract, exit 1 on drift in prod (`server.ts:947-1014`). | [CONFIRMED] |
| AuthN | **PASS** | Global fail-closed JWT/PAT gate + boot assertion (`server.ts:388-397`). | [CONFIRMED] |
| AuthZ / multi-tenancy isolation | **GAP** | Strong mandatory fail-closed filter exists (`securityContext.ts:203-233`), but enforcement completeness depends on every search/data handler calling `requireSecurityContext`/`buildSecurityFilter` — a convention, not a structural guarantee. Non-search data paths (raw `pg` reads in routes) were not exhaustively verified to inject the filter. | [SUSPECTED] |
| Secrets management | **GAP** | Vault crypto is excellent (F-INFO), but the master KEK + DB/superadmin secrets live in a plaintext on-disk `.env` (F-03); no KMS/secret-manager integration observed in the prod path. | [CONFIRMED] |
| Dependency / supply-chain | **GAP** | Blocking CVE scan + SBOM + `--ignore-scripts` are strong, but the dual-lockfile / npm-vs-pnpm parity gap (F-02) means the scanned tree ≠ shipped tree. | [CONFIRMED] |
| CORS / CSRF posture | **GAP** | Insecure allow-any-origin-with-credentials default (F-01). | [CONFIRMED] |
| CI quality gates | **GAP** | Typecheck + multi-tier tests + blocking coverage gate present; no lint/SAST gate (F-07). | [CONFIRMED] |
| API versioning | **GAP** | `/api/v1` and `/api/v1/connectivity` coexist deliberately (`server.ts:782`), but no deprecation/sunset policy or version-negotiation scheme was found. | [SUSPECTED] |
| Backup / DR | **MISSING/UNVERIFIED** | Only signal is a `backups/` entry in `.gitignore:37` ("Local DB backups (never commit dumps)"). No backup/restore/PITR process was read; do **not** infer one exists. | [CONFIRMED-absent-in-read-surface] |
| Runtime version pinning | **GAP** | No `engines`/`.nvmrc` (F-08). | [CONFIRMED] |

---

## Phase 4 — Executive summary & remediation roadmap

### Executive summary (≤1 page)

Tellus is a substantial, **backend-only** Express + PostgreSQL platform (~199k LOC, ~478 endpoints) that is **architecturally more mature than typical pre-enterprise codebases**: it has a fail-closed global auth gate with boot assertions, parameterized SQL with a circuit breaker and transaction-poisoning guard, an AES-256-GCM credential vault, a mandatory fail-closed row/column security filter, graceful shutdown, a migration/schema gate, and a **blocking** CVE scan with SBOM. The previously suspected SQL-injection sink (`discovery.ts:380`) was read and **cleared** — it is properly identifier-quoted.

**There are no P0 ship-blockers (P0 count: 0).** The work that stands between this codebase and an enterprise sale is concentrated in **one P1 and five P2s**, all config- or hygiene-level rather than architectural:

1. **(P1) CORS allow-any-origin + credentials by default** (`server.ts:264-295`) — combined with cookie auth, this is a cross-origin credential-theft vector whenever `CORS_ORIGINS` is left unset, which is the shipped default.
2. **(P2) npm-vs-pnpm build-parity gap** (`Dockerfile` vs `ci.yml`) — the security gate validates a different dependency tree than production ships.
3. **(P2) Vault master KEK + superadmin/DB secrets in a plaintext on-disk `.env`** — filesystem read = full vault decryption.
4. **(P2) Env-gated test-auth bypasses with no `NODE_ENV` backstop** + test headers allowed in prod CORS — a single env typo becomes an auth bypass.
5. **(P2) Residual SSRF via DNS rebinding** in the connectivity probe — the egress guard checks the literal host, not the resolved IP.

Lower-priority hygiene (P3): query-error logs dump SQL params, no lint/SAST gate, unpinned Node, incomplete `.env.example`. Two readiness dimensions need attention beyond security: **multi-tenancy enforcement completeness** (the filter is mandatory by design but applied by convention) and **backup/DR** (no process found in the read surface — reviewers must confirm it exists operationally).

### Prioritized remediation roadmap

Effort: **S** ≤½ day · **M** 1–3 days · **L** >3 days.

1. **F-01 — Fail-closed CORS.** Files: `src/server.ts:264-295`. Effort **S**. *Acceptance: with `NODE_ENV=production` and `CORS_ORIGINS` unset, a request bearing an unlisted `Origin` receives **no** `Access-Control-Allow-Origin` header and no `Allow-Credentials:true`.*
2. **F-04 — Harden test-auth bypasses.** Files: `src/services/codeRepos/middleware/principal.ts:94`, `src/middleware/globalAuth.ts:186`, `src/server.ts:280-282`. Effort **S**. *Acceptance: with `NODE_ENV=production`, setting `CODE_REPOS_TEST_AUTH=1`/`QUIVER_ALLOW_TEST_AUTH=1` does **not** activate the header bypass (boot refuses or guard returns 401); `X-Tellus-Test-*` headers absent from prod CORS `allowedHeaders`.*
3. **F-03 — Externalize secrets / KEK custody.** Files: deployment manifests + `.env` consumers. Effort **M**. *Acceptance: `TELLUS_LOCAL_KEK_B64`, `TELLUS_SUPERADMIN_PASSWORD`, `PGPASSWORD` are injected from a secrets manager at runtime; no master KEK persisted to disk; both rotated.*
4. **F-02 — Single package manager.** Files: `Dockerfile`, `Dockerfile.verify`, `ci.yml`, `cve-scan.yml`, `coverage-gate.yml`, one of `package-lock.json`/`pnpm-lock.yaml` deleted, `package.json:138-148`. Effort **M**. *Acceptance: CI and Docker install with the same tool against the same single lockfile; the CVE scan runs against the exact tree shipped to production; overrides live under that tool's override key.*
5. **F-05 — DNS-pinned egress.** Files: `src/services/connectivity/connectors/postgresql/egress.ts`, the dialer in `.../postgresql/pool.ts`. Effort **M**. *Acceptance: the connectivity probe resolves the hostname, rejects when any resolved A/AAAA record is in the blocklist, and connects to the pinned resolved IP.*
6. **F-06 — Redact log params.** Files: `src/db.ts:133-137,353-357`. Effort **S**. *Acceptance: query-error logs contain SQLSTATE + parameter count, never raw parameter values.*
7. **F-07 — Add lint + SAST gate.** Files: `.github/workflows/ci.yml`. Effort **S–M**. *Acceptance: a blocking ESLint (+security plugin) job and a CodeQL/Semgrep job run on every PR.*
8. **F-08/F-09 — Pin runtime, complete env docs.** Files: `package.json`, `.nvmrc`, `.env.example`. Effort **S**. *Acceptance: `engines.node` + `.nvmrc` present and matching the Docker base; `.env.example` lists every required/ documented var as a placeholder.*
9. **(Readiness) Verify multi-tenancy enforcement completeness.** Effort **L**. *Acceptance: an audit/lint proves every data-read handler injects `buildSecurityFilter`/`requireSecurityContext`; no raw-SQL read path bypasses marking/CBAC.*
10. **(Readiness) Confirm/establish backup-DR.** Effort **M**. *Acceptance: documented, tested PG backup + restore (PITR) runbook exists; reviewers can point to the process, not just the `backups/` gitignore line.*

---

## Coverage report — what was read vs sampled

**Exhaustively read (end-to-end):** `src/server.ts` (full mount map + lifecycle), `src/middleware/globalAuth.ts`, `src/middleware/securityContext.ts`, `src/db.ts`, `src/services/connectivity/credentials/aesgcm.ts`, `src/services/connectivity/connectors/postgresql/egress.ts` (guard region), `src/services/connectivity/connectors/postgresql/discovery.ts` (preview region), `src/services/codeRepos/middleware/principal.ts` (auth region), `package.json`, `.env.example`, `.env` (variable **names** only — values deliberately not read), `.github/workflows/ci.yml`, `.github/workflows/cve-scan.yml`, `Dockerfile` (install steps), `.gitignore`, `coverage-gate.yml` (gate region).

**Enumerated by grep (file:line authoritative, handlers not each hand-read):** all 74 files under `src/routes/**` and the 4 router factories (`services/{codeRepository/mount,functionsRegistry/admin/routes,templates/admin/routes,connectivity/index}.ts`) for the endpoint inventory (~478 definitions). `package-lock.json` grepped for the overridden packages' resolved versions.

**Explicitly NOT read (sampled-out):** the wider `src/services/**` layer beyond connectivity core (~450+ files — funnel, pipelines, workshop, temporal, opensearch, keycloak admin, etc.), `tests/**`, `dist/**`, `node_modules/**`, `scripts/**`, `src/migrations/**`, `src/controllers/**` and `src/models/**` handler bodies, and `pnpm-lock.yaml` contents. CVE *findings* themselves were not enumerated (the pipeline that would do so, `pnpm audit`/grype, lives in CI and was not executed here).

**Declared completeness (stop-and-report rule):** this audit is **complete for the route surface and the auth / data-access / secrets / build boundaries**; it is **sampled for the wider service layer**. The two `[SUSPECTED]` readiness items (multi-tenancy enforcement completeness, API-version deprecation policy) and the backup/DR `MISSING/UNVERIFIED` rating require an operational confirmation this read-only audit cannot supply. No `[CONFIRMED]` finding in this report lacks a corresponding read.
