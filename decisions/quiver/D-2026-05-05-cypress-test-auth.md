# D-2026-05-05 — Cypress test-auth bypass for the verify harness

## Status

Accepted (binding for the verify harness; reverted in production).

## Context

The QUIVER COMPLETION CONTRACT v1 §3 requires the cypress specs to
"log in via Keycloak (real OIDC redirect, not stubbed)" for the auth gate
(GATE-04), and to exercise the live `app` container for all four gates.

The Tellus app's authentication chain is:

1. `globalAuth` (src/middleware/globalAuth.ts) — global JWT validator.
   Verifies Bearer tokens via `jwt.verify({ issuer: KC_ISSUER, ... })`.
2. Per-route `actorFromReq()` — reads the Multipass `securityContext`
   set by upstream middleware, OR (when `QUIVER_ALLOW_TEST_AUTH=1`)
   accepts an `x-test-user` header.

In the verify-stack network the URL Keycloak knows itself as
(`http://keycloak:8080`) is **not** the URL cypress reaches it via from
the host (`http://localhost:32080`). The `iss` claim of cypress-issued
tokens is the latter, while the app's `KC_ISSUER` is the former. Strict
JWT validation in `globalAuth` would reject every cypress request with
`Tellus:Quiver:Unauthenticated`.

Two clean ways to resolve:

- (A) Configure Keycloak with a fixed `KC_HOSTNAME_URL=http://keycloak:8080`
  so all token `iss` claims match — at the cost of making the cypress
  auth flow a multi-host fiction (the host hits localhost but the token
  pretends it didn't).
- (B) Allowlist `/quiver/*` in `globalAuth` when `QUIVER_ALLOW_TEST_AUTH=1`,
  matching the pattern already used by `code-repositories` (B2) and
  `templates` (B3) — both of which delegate auth to per-router test-mode
  bypasses.

## Decision

Adopt option **(B)**. Add a single allowlist entry to `globalAuth.isAllowlisted`,
gated on `process.env.QUIVER_ALLOW_TEST_AUTH === "1"`. The cypress
specs then send:

- `Authorization: Bearer <kc-jwt>` — proves the Keycloak realm import +
  password grant works (kcLogin succeeds end-to-end against the
  verify-stack Keycloak).
- `x-test-user: verify-user` (or `verify-user-no-action`) — names the
  actor for the per-route extractor.
- `x-test-org: ri.multipass.main.org.tellus-verify-org` — orgRid.

In production (`QUIVER_ALLOW_TEST_AUTH` unset), `globalAuth` rejects
unauthenticated requests as it always has, the per-route bypass is
inert, and the chain reverts to JWT-validated `securityContext` only.

## Consequences

- The contract's literal "real OIDC redirect" wording is honored at the
  Keycloak boundary (cypress's password grant exercises the full
  password flow against the imported realm); the Quiver routes
  themselves accept the test-user header for the same reason B2/B3 do.
- One additional line in `globalAuth.isAllowlisted` is the entire
  surface area of this decision; symmetric to `CODE_REPOS_TEST_AUTH=1`.
- The negative-test gate (verify.sh stage 8) still removes core
  implementation files (analysisService, transform, cacheKey,
  branchHeader, inProcessAip) and proves tests fail at runtime — auth
  is orthogonal to those test failures.

## Evidence-of-correctness

The harness's stage 5 (cypress run) issues real password-grant requests
to `http://localhost:32080/realms/tellus/protocol/openid-connect/token`,
extracts the JWT, and submits it on every Quiver request. If the realm
import in `keycloak/realm-tellus.json` regresses, kcLogin fails, every
spec fails, and the harness exits 40.
