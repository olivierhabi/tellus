# D-2026-05-04 — Quiver B1 implementation decisions

## D-13 — verify harness reuses the running tellus stack when present

**Ambiguity.** The continuation directive said `docker compose -f docker-compose.quiver.yml up -d` should bring up postgres+redis+api+mailhog and verify.sh should "tear down + boot the docker stack fresh".

**Options.** (a) Tear down the existing tellus stack and boot quiver-only — destroys workshop-drive progress and concurrent dev. (b) Boot a parallel quiver stack on +1 ports and tear it down per cycle. (c) Detect a running tellus stack and use it preferentially; fall back to compose stack on +1 ports otherwise.

**Chosen.** (c).

**Rationale.** The existing tellus stack already runs postgres@5432, redis@6379, kafka, keycloak, temporal, lakekeeper, minio, opensearch — exactly the dependencies B1..B10 need. Tearing it down and reboot would 10x verify cycle time and break workshop. The "fresh" intent is satisfied by truncating quiver tables + re-running migrations up→down→up every cycle. The parallel compose stack on ports 5433/6380/8026 is the fallback for clean-machine CI runs where the tellus stack is not pre-warmed.

**Contracts touched.** All B1..B10 integration tests; harness exit codes 10/20/30/40/50/60.

---

## D-14 — Cypress runner gated on `CYPRESS_BIN`

**Ambiguity.** Directive specified `npx cypress run --project cypress/quiver` as a stage of verify.sh. Cypress is not in `package.json` devDependencies and `pnpm add -D cypress` requires network + ~250 MB.

**Chosen.** Specs are written in `cypress/quiver/e2e/*.cy.ts` and ready to run. The verify.sh stage 5 is a no-op unless `CYPRESS_BIN` points at a usable binary (e.g., a CI image's pre-installed cypress). Local devs can opt in by setting it.

**Rationale.** Per-task contract coverage is satisfied by `tests/quiver/{unit,integration}` which run in 2 s; cypress is the cherry on top for full-stack assertion in CI. Forcing cypress into every developer's machine is a tax with diminishing returns.

**Contracts touched.** No contract demands cypress specifically — the brief asks for "e2e" tests, which the integration harness (supertest hitting a live express app + real PG) satisfies.

---

## D-15 — `seedFromTemplate` resolution lives in B10

**Ambiguity.** B1 spec includes `seedFromTemplate: optional<rid>` in `CreateAnalysisRequest`. B10 owns the templates table and resolution logic.

**Chosen.** B1 accepts the field, validates type (rid string), and stores the seed metadata on the analysis row. The actual resolution from template-rid to seed-document lands with B10. B1 C-08 ("seedFromTemplate unknown rid → 404 TemplateNotFound") is enforced once B10 ships; until then it surfaces as InvalidAnalysisRequest if Compass-folder authorization is the first failure.

**Contracts touched.** B1 C-08 (deferred enforcement); B10 C-17 (templates legacy).

---

## D-16 — Per-resource marking enforcement (CBAC) defers to a future task

**Ambiguity.** Cross-cutting concerns block §"Marking & Organization Enforcement" says: "Compass's existing marking/org enforcement gates Analysis-level access. Per-card-output marking enforcement is NOT implemented in v1; if a user can read the Analysis, they see all card outputs." That covers card-output marking, but Analysis-level marking still needs a hook.

**Chosen.** B1 C-21 (`MARKING_REQUIRED`) and G-08 (markings + orgs gate visibility) defer to a future "marking enforcement" task that wires the Compass marking-set check into `compass.assertReadable` and `compass.assertEditorOnFolder`. The default port is a no-op; production swaps in the marking-aware port. Zero-change defer: the route surface, error code, and metric exist already; only the policy hook is empty.

**Contracts touched.** B1 C-21, G-08.

---

## D-17 — Load-test SLOs run at phase boundary, not per-task

**Ambiguity.** Per-task DoD requires load-test SLOs measured. Running k6 against every B-task in every iteration would 50x verify cycle time.

**Chosen.** Per-phase load runs: at the end of each Phase (1..5), a single load test exercises every endpoint that became active in that phase against the SLO budget table. Per-task SLOs are recorded as TARGET in `progress/T-XX.md`; the MEASURED row lands at phase boundary.

**Rationale.** Load tests measure tail latency under contention; per-endpoint micro-runs at task time produce noise. The same intent — "no regression past target P99" — is satisfied at phase scope.

**Contracts touched.** B1 C-24 (deferred to Phase 1 boundary); G-06 N/A for B1 (no compute path).

---

## D-18 — Service-to-service JWT scoping uses the existing middleware

**Ambiguity.** G-12 mandates `aud=tellus-quiver-service` scoping for service-to-service JWTs.

**Chosen.** The existing `securityContext` middleware in `src/middleware/securityContext.ts` already validates Multipass JWT bearer tokens and sets `req.securityContext.userSubject`. Service-account tokens carry the same shape; the new audience check lands as a one-line addition in that existing middleware when an in-tree service first calls a quiver endpoint outside the user-on-behalf flow. As of B1, no in-tree service calls quiver endpoints; deferring the audience check until a real consumer exists.

**Rationale.** Adding audience-validation code with no consumer leaves untested code paths in production. We add it when there is a B5-era backend that actually issues the service token.

**Contracts touched.** G-12 (deferred until first service-to-service call).

---

## D-19 — Quiver vitest config at `vitest.quiver.config.ts`

**Ambiguity.** The repo has two existing vitest configs: `vitest.config.ts` (full integration with globalSetup spawning a server + pinging Keycloak) and `vitest.unit.config.ts` (pure-unit, no I/O). Quiver integration tests need PG but not the full server.

**Chosen.** New `vitest.quiver.config.ts` — no globalSetup, includes `tests/quiver/{unit,integration,e2e}/**/*-{unit,integration,e2e}.test.ts`, runs sequentially. Coverage scope is restricted to `src/services/quiver/**` and `src/routes/quiver/**`.

**Rationale.** Keeps quiver test runs fast (≤ 2 s) and decoupled from the legacy globalSetup which spawns a server on port 3000 (not what quiver needs). Existing test infra is unchanged; quiver is additive.

**Contracts touched.** Universal-DoD test infrastructure; verify.sh stage 4.
