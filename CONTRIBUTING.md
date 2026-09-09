# Contributing to Tellus (Ontology Engine)

Thank you for contributing. This guide gets a change from clone to green CI.

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.x | pinned by `engines` in `package.json` and `.nvmrc` |
| pnpm | 10.x | pinned by `packageManager` (`corepack enable` is enough) |
| Docker + Docker Compose | any recent | Postgres, OpenSearch, Keycloak, MinIO, … |
| Git | — | conventional-commit style (see §6) |

## 2. Setup

```bash
git clone https://github.com/olivierhabi/tellus.git
cd tellus
pnpm install

cp .env.example .env            # server config (placeholders only, never commit a populated .env)
cp .env.test.example .env.test  # test-lane secrets, then:
set -a; source .env.test; set +a
```

`.env.example` documents **every** `process.env.*` the server reads (see the
audited gap-fill section at the bottom of the file). Test credentials are
**never baked into code**: `vitest.config.ts` and lane bootstrap fail fast
when `PGPASSWORD` is unset — export it from `.env.test` or CI secrets.

Start the backing services, then migrate:

```bash
docker compose up -d postgres opensearch keycloak minio
npm run migrate:all   # core + foundry + auth passes (src/migrations/)
npm run dev           # API on http://localhost:3000, health at /health
```

## 3. Test lanes

| Command | Needs Docker? | What it runs |
|---------|---------------|--------------|
| `npm run test:unit` | **No** — runs right after `pnpm install` | pure-unit lane (`vitest.unit.config.ts`) |
| `npm run test:unit:coverage` | No | unit lane with v8 coverage → `coverage/unit/` |
| `npm test` / `test:coverage` | Yes | full vitest discovery (unit + integration + e2e) |
| `npm run test:integration` | Yes | service-backed suites |
| `npm run test:e2e` / `test:perf` / `test:all` | Yes | bash/curl suites, benchmarks, consolidated runner |

Destructive suites (seed, funnel, multi-replica) run under the FUNN-ISO-1
isolated lane (`tests/laneEnv.ts`, `tests/testStackBootstrap.ts`) and refuse
dev-shaped databases via `src/services/testing/destructiveTestGuard.ts`.
Never point them at shared dev data.

## 4. Coverage policy (raise-only ratchet)

- The unit lane enforces a floor in `vitest.unit.config.ts`
  (`coverage.thresholds`, currently lines 37 / branches 30) — CI fails below it.
- `codecov.yml` enforces an 80% **patch** gate on PRs.
- `.github/workflows/coverage-gate.yml` adds per-module branch floors for
  critical-path files (`canonicalJson`, `hashChain`, `cbacPolicy`, … at 80%;
  orchestration modules ratcheting upward).
- Rule: any PR that lifts coverage **raises the floors in the same commit**.
  Never lower them. The 70 lines / 60 branches aspiration is tracked, not yet
  enforced.

## 5. What CI gates on every PR (`.github/workflows/ci.yml`)

1. **Lint + SAST** — `pnpm run lint` (ESLint + `eslint-plugin-security`; errors fail).
2. **Typecheck** — `npx tsc --noEmit` (required before any test job).
3. **Unit → integration → e2e → perf → test:all** against real containerized services.
4. **Secret scan** — gitleaks (`GITLEAKS_VERSION 8.30.1`, rules in `.gitleaks.toml`).
5. **CVE scan** — `pnpm audit --prod --audit-level=high` + Grype SBOM scan (nightly + PR).

Tag pushes (`v*`) additionally run `.github/workflows/deploy.yml`
(Docker image build, Helm lint, manifest validation).

## 6. Commit & release conventions

- Small commits, tests in the same commit as the fix/feature.
- Commit messages follow conventional style (`feat:`, `fix:`, `chore:`, …) —
  roughly half the history does; new commits should all do so.
- God-file breakups land as **behavior-preserving extractions**, one module
  per commit with its spec (see `CHANGELOG.md` 0.3.1 for the pattern).
- Releases are semver tags (`v0.4.0` …) with a `CHANGELOG.md` entry
  (Keep a Changelog format). Add an `[Unreleased]` entry with your change.

## 7. Security rules for contributors

- No credentials in code, tests, or workflow files. CI-only fallbacks must be
  non-functional sentinels or `${{ secrets.* }}` with a documented allowlist
  entry in `.gitleaks.toml` — never a real password.
- Production secrets come from a secrets manager (see `SECURITY.md`);
  `.env.example` values are placeholders.
- Logging goes through `src/utils/logger.ts` (Pino, PII-redacting) — never
  interpolate passwords, tokens, emails, or IDs into log strings.
- Publishing executable Functions is gated by `authorizePublish()`
  (see `docs/operations/automate-function-invocation-contract.md`); the
  `open-development` trust mode is dev/test only and refused in production.

## 8. Getting help

- Architecture and lane invariants: `AGENTS.md`.
- Operations runbooks: `docs/operations/`.
- Security policy and credential-rotation history: `SECURITY.md`, `docs/security/`.
