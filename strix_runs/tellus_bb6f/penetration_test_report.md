# Security Penetration Test Report

**Generated:** 2026-08-18 07:56:10 UTC

# Executive Summary

# Executive Summary

A combined white-box + live dynamic assessment of the **tellus** Ontology Engine (Express/TypeScript, Keycloak-backed) — source at `/workspace/tellus`, live API at `http://host.docker.internal:3000/` — identified a **compromised security posture requiring immediate remediation**.

**Overall risk posture: Critical.** The application can be fully compromised from three independent directions, including one that requires **no credentials at all**.

## Headline findings

- **3 Critical / 21 High / 18 Medium / 1 Low** findings; 16 live dynamic findings + 27 dependency-CVE advisories, all validated against the running application.
- **Unauthenticated remote code execution (host takeover)** via the Functions executor (vuln-0042). A network caller with *zero credentials* executes arbitrary TypeScript, escapes the in-process Node `vm` sandbox through the constructor chain, and runs OS commands as the hosting process user (demonstrated: macOS host, `uid=501(olivierhabimana)`, home directory readable, `POSTGRES_URL`/`PGPASSWORD` leaked from environment). The same primitive is reachable with any low-priv viewer JWT via the legacy functions route (vuln-0041).
- **Pre-auth superadmin** via dev test hooks active on the deployed stack (vuln-0034, 9.8): `X-Tellus-Test-Auth` header grants attacker-chosen `tellus-superadmin` with no source restriction whenever `NODE_ENV != production` and `TELLUS_TEST_HOOKS=1`.
- **Chained escalation**: a zero-role remote user can self-grant publish permission through a localhost dev-fallback leak behind the proxy (vuln-0024), then publish & invoke arbitrary code (demonstrated end-to-end).

## Business impact

Full takeover of the backend and exposure of the developer workstation hosting it: database credentials, all ontology data (including Rwanda RRA Customs, BK, RSwitch, Irembo business domains), user identity and audit history, plus the ability to persist payloads into the shared ontology. Because the stack currently runs with `NODE_ENV=development` + test hooks enabled, the *authentication layer does not meaningfully resist a remote unauthenticated caller.*

## Overarching remediation theme

Drive the code-execution surface to **zero un-gated entry points**: decommission the legacy functions router, require the publish gate on every code-execution endpoint, and hard-induct fail-closed behavior for `NODE_ENV=development` toggles on any listener that faces a network.

# Methodology

# Methodology

**Engagement type:** Combined white-box (full source) + live dynamic testing. **Frameworks:** OWASP WSTG / OWASP API Top 10 / NIST SP 800-115 categories, with source-aware SAST triage feeding targeted dynamic validation.

**Scope:** Source repo `/workspace/tellus`; live API `http://host.docker.internal:3000/` (and reachable backing Keycloak at `:8086` for token issuance).

## Phases

1. **Foundation mapping (white-box).** Full route inventory (~612 paths) with auth/authorization guards; auth model (Keycloak RS256/JWKS, PATs, CBAC, dev toggles); Functions/Automate executor trust boundary; raw-SQL surfaces; file-ops; SSRF surfaces; secrets sweep. Artifacts: `/workspace/.source-aware/route-map.md`, `/workspace/.source-aware/sast-triage.md`.
2. **Static baseline.** `semgrep` (p/default + p/secrets, 216 findings across 2212 files), `ast-grep` structural pass (63k call-sites), `gitleaks` (12), `trufflehog` (191), `trivy fs` (35 vulns + 165 misconfigs), `retire` (clean). No live credentials found; all secret hits = fixture/docs false positives.
3. **Live enablement.** Keycloak reachable at `host.docker.internal:8086` (realm `tellus`, public client); multi-role tokens minted (superadmin / admin / editor / viewer / nogroups) via a Host-header issuer trick; unauth surface mapped (`/health*`, `/api/docs`, `/api/metrics`); resource IDs harvested for IDOR chains.
4. **Targeted dynamic validation** per vulnerability class with working PoCs: auth bypass, IDOR/BOLA, SQL/DuckDB (`/api/v1/sql`), RCE (functions + transforms, 3 publish/invoke avenues), SSRF (connectivity/webhook egress guards), file uploads (multer/zip/attachments), info disclosure, code-assistant/LLM, prototype pollution, mass assignment.
5. **Supply-chain (SCA).** 27 dependency-CVE advisories filed with `create_dependency_report`, reachability assessed per package.
6. **Attack-chain reasoning.** Every confirmed finding treated as a pivot; the BFLA → publish → invoke → sandbox escape chain was demonstrated end-to-end; plausible combinations of unrelated findings written up; unproven hypotheses (e.g. workload-JWT secret misuse, DNS rebinding, prototype pollution) documented as ruled out with reasoning.

**Coverage caveats:** The code-assistant's actual LLM engine (`TELOS_AIE_AGENT_URL`) 403s on all customer tokens and is out of scope; the connectors' non-PostgreSQL drivers, Temporal internals, and Jemma publish scheduler were outside deep exploitation scope.

# Technical Analysis

# Technical Analysis

## Confirmed dynamic findings (all validated live)

**Critical**
- **vuln-0034 (Critical 9.8, CWE-489)** — Pre-auth superadmin via `X-Tellus-Test-Auth` / `Bearer test-auth:` on the deployed stack; roles taken verbatim from the header.
- **vuln-0041 (Critical 9.9, CWE-94)** — Legacy `POST /api/v1/ontology/:ontology/functions` + `:apiName/invoke` (mounted `src/server.ts:1293`) registers and executes arbitrary TypeScript with **no publish gate**; `this.constructor.constructor("return process")()` escapes the in-process `vm` to full host command execution. Demonstrated: `id` returned `uid=501(olivierhabimana)`, `fs.writeFileSync` round-trip, `process.env` leaked `POSTGRES_URL`/`PGPASSWORD`. Works for ANY low-priv authenticated user; dev-toggle independent.
- **vuln-0042 (Critical 9.8, CWE-94)** — `POST /api/v1/code-repositories/:rid/functions/invoke` executes `inlineSource` with **no credentials at all** (zero-token and garbage-token both accepted on the live stack), then the same constructor-chain escape yields host RCE.

**High**
- **vuln-0024 (High 8.8, CWE-269)** — BFLA on `/api/v1/functions/admin/function-publish-grants` via `CODE_REPOS_TEST_AUTH=1` localhost dev-fallback fabricating a superadmin principal **behind the gateway/proxy**; remote zero-role user self-grants publish permission → demonstrated publish→invoke. 
- **vuln-0038 (High 7.5, CWE-306)** — Unauthenticated remote publish via registry `POST /api/v1/functions/:rid/versions`.
- **vuln-0043 (High 8.8, CWE-94)** — Transforms executor executes user Python locally (default when `TELLUS_TRANSFORM_EXECUTION_MODE` unset) gated only by Compass WRITE, not `authorizePublish`; demonstrated host Python exec (`uid=501`) — child env correctly scrubbed.
- **vuln-0009 (Medium→CVSS 6.5, CWE-862)** — Zero-role JWT reads the full global audit log (21,252 rows: principal UUIDs, source IPs, parameters incl. loan decisions).
- **vuln-0011 (Medium 6.5, CWE-639)** — Cross-user read IDOR: `DATASET_RBAC_ENABLED` defaults false + `dataPlaneGuard` GET passthrough + default-org auto-enroll → any user reads any other user's project/dataset contents.

**Medium / Low (10 more)**
- Unauth info disclosure x3 (vuln-0012, vuln-0016, vuln-0021: `/api/v1/system/health` + `/health/detailed`, `/api/docs/spec.json` 612-path catalog incl. superadmin routes, `/api/metrics` + pipelines/funnel metrics — precisely CWE-497, filed as CWE-200 due to platform field-lock).
- Cross-user read IDOR on Quiver AIP traces (vuln-0028, empty ownership guard).
- Latent design flaw: client-controlled `authorizeApplyAction` bypasses OMS manifest gate (vuln-0033).
- Internal-service fingerprint via rate-limit-exempt PostgreSQL connectivity probe (vuln-0040); IPv6-literal canonicalisation mismatch blocks allowlisted webhooks (vuln-0039); stored-XSS / active content via attachment upload (vuln-0027, CSS-exfil confirmed despite CSP).

## Dependency-SCA findings (27 advisories filed)
Highest leverage: CVE-2026-69192 ip-address 8.6 (SSRF-class), 3× fast-uri host-confusion (7.5 each), CVE-2026-41907 uuid OOB write (7.5), CVE-2026-39244 adm-zip memory DoS (dead dep — recommend removal), 6× tar/brace-expansion/protobufjs DoS chain via duckdb/@kubernetes, CVE-2026-59892 @opentelemetry/propagator-jaeger unauth DoS (**ruled out as configured-off in this app's OTel bootstrap**).

## Validated SAFE surfaces (among the heaviest claims disproved)

- `/api/v1/sql` DuckDB executor — denylist + disabled filesystems + keyword parser hold against comment/CTE/ATTACH/httpfs/read_csv/copy/pragma abuse; snapshot empty in this env anyway.
- SQLi across the ORM surface — objectType filters, sort orders, folder/dataset/project queries all parameterised (`knex ??/$n` binding, zod enums).
- SSRF guard on connectivity/webhook egress — literal-host allowlist, DNS pinning, redirect blocking, domain-escape guard hold; only a weaker port-open oracle (vuln-0040) survived.
- Prototype pollution / mass assignment — no vulnerable deep-merge; service-layer allowlists drop `ownerId`/`roles`/`isSuperadmin`.
- Workload-JWT secret path, passkey enroll, PAT scope map, Jemma LLM surface — as-designed.

## Systemic root causes

1. **Code-execution trust boundary has multiple un-gated entry points** (legacy router, working-tree invoke, transforms preview/test) around a correctly-implemented `authorizePublish()` core. Fix targets: `src/server.ts:1293`, `src/routes/functions.ts`, `src/services/codeRepository/transforms/executor.ts`, `src/services/functionRuntime.ts`.
2. **Dev toggles remain active on a network-facing deployment** without environment indistinction (NODE_ENV=development + test hooks + localhost fallback + pre-seeded grant).
3. **Default-open data-plane authorization**: GET routes pass `dataPlaneGuard` without per-route authorize() and `DATASET_RBAC_ENABLED` defaults false.
4. **Public-by-default surface for ops endpoints**: metrics/spec/health mounts ahead of `globalAuth`.

# Recommendations

# Recommendations

## Immediate (24–72h)

1. **Decommission the legacy functions router.** Remove the mount and underlying handlers for `POST /api/v1/ontology/:ontology/functions` and `:apiName/invoke` (`src/server.ts:1293`, `src/routes/functions.ts`); they bypass every publish control. (vuln-0041)
2. **Gate every code-execution entry point behind `authorizePublish()`** — working-tree `inlineSource` invoke (`/api/v1/code-repositories/:rid/functions/invoke`, vuln-0042) and transforms preview/test/builds (vuln-0043). Add a boot assertion: no route may execute user source without the gate.
3. **Kill the dev fallbacks wherever the listener faces a network.** Remove `DEV_FALLBACK_PRINCIPAL` (`src/services/codeRepos/middleware/principal.ts:80-81,187-191`), require loopback+known-seed for `X-Tellus-Test-Auth` (`src/middleware/globalAuth.ts:434,499`), refuse boot when test flags are set **and** bind host is non-loopback regardless of NODE_ENV. (vuln-0034, vuln-0024, vuln-0038)
4. **Fix the vm escape.** Add a constructor-chain guard (freeze `Function.prototype.constructor` / run code in `vm.runInNewContext` with an isolated `globalThis` whose Function constructor is neutralised, and scrub `mainModule`/`require`) in `runSandboxed` + the worker pool. Never treat `vm` as a boundary — move execution into the worker pool with process-level isolation (seccomp/systemd or container).
5. **Revoke the poisoned publish grant** row (`55c5ebe7-...` / fabricated principal `53cf9bcf-...`) and audit the function registry for any functions published since the stack went live.
6. **Flip `DATASET_RBAC_ENABLED` to true + fail-closed `dataPlaneGuard`** and convert project reads from org-overlap to `project_members` membership. (vuln-0011, vuln-0009)

## Short-term (1–2 weeks)

- Default `TELLUS_TRANSFORM_EXECUTION_MODE=container` with explicit `TELLUS_TRANSFORM_ALLOW_LOCAL=1` opt-in.
- Require auth on `/api/metrics` family, `/api/docs/spec.json`, `/api/v1/system/health`, `/health/detailed` (implement `requireAuthenticated`/`requireScrapeToken` in `src/middleware` first, then apply the filed inline fixes).
- Tighten the connectivity probe oracle: uniform error envelope across closed/open-non-PG/open-PG; include authenticated caller in rate limiting (`/api/v1/connectivity/connections/test-config`, vuln-0040); apply same treatment to the sibling `/connections/:rid/test`.
- Fix Quiver AIP ownership guard (vuln-0028) and remove client-controlled `authorizeApplyAction` (vuln-0033).
- Pull fixes through `pnpm.overrides` for the dependency advisories (project already uses the pattern): fast-xml-parser, fast-uri, brace-expansion, tar, uuid, qs, body-parser, ip-address, protobufjs, @opentelemetry/*; **remove the dead `adm-zip@0.5.16` dependency**.

## Medium-term (1–2 months)

- **Remove or fix the `vm`-based function executor** as designed: worker pool with hardened sandbox per AGENTS.md threat model (container/microVM) — the current pool is explicitly documented NOT to be a security boundary.
- Make route authorization **default-closed**: add per-route `authorize()` across routers currently relying on globalAuth-only (the same pattern as `/api/v1/audit`).
- Restore rotation: wipe git history risk on `.env` (contains TELLUS_WORKLOAD_JWT_SECRET dev default, KC admin default password) and rotate Keycloak admin credentials.
- Delete dead code (`zipUploadService.ts`) or apply `fs.realpath` containment + symlink-aware extraction before any future route wires it (latent Zip Slip).
- CI regression: a boot-time test asserting zero anonymous code-exec routes, zero-role reads of projects/datasets/grants → 403/404, and no test-hook acceptance on non-loopback binds.

## Retest & validation guidance

- After patching vuln-0041/0042/0038, re-run the exact PoCs in each report (function register/invoke, working-tree invoke, transforms preview) with viewer / unauth / nogroups tokens and assert 403.
- After fixing vuln-0034/0024, re-run the header-based probes from a non-localhost source and assert 401/403.
- Re-run the IDOR matrix (`/workspace/.source-aware/idor-results.txt`) after vuln-0011 remediation; expect 403 for viewer/nogroups on other users' resources.
- Full regression sweep of the L1+L2 checklist (route map at `/workspace/.source-aware/route-map.md`) after the default-closed authorization refactor.

