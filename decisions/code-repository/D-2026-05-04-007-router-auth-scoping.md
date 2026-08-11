# D-2026-05-04-007 — Router auth scoping: per-route, never `router.use(auth)` at parent prefixes

## Ambiguity

Express's `app.use(prefix, router)` runs the router's middleware stack
for **every** request whose URL begins with `prefix`, falling through to
the next mounted handler only if no route inside the router matches. A
router that declares `router.use(requireCodeReposAuth())` therefore
authenticates every request under its mount prefix, **including** ones
its own routes don't claim.

The B3 Templates router shipped with this exact shape:

```ts
// src/services/templates/admin/routes.ts (BEFORE this decision)
const router = express.Router();
router.use(requireCodeReposAuth());          // ← router-level
router.get("/templates", ...);
router.get("/templates/:id/versions/:v", ...);
router.post("/scaffold", ...);
```

…and was mounted at the parent prefix:

```ts
// src/server.ts (BEFORE)
app.use("/api/v1", templatesRouter);
```

The result was a 401 leak across the entire `/api/v1/*` surface. Every
request that wasn't claimed by an earlier-mounted router — including
`POST /api/v1/auth/login`, the very route used to **obtain** the token
the templates router checks for — was 401-rejected by the templates
router's own auth middleware before the real auth router downstream
could see it.

A first-pass fix wrapped the mount in a path-filter middleware:

```ts
app.use("/api/v1", (req, res, next) => {
  if (req.url === "/templates" || req.url.startsWith("/templates/") || ...) {
    return templatesRouter(req, res, next);
  }
  return next();
});
```

This worked but reimplemented Express's path matcher in user space,
introduced a second source of truth for "which paths does this router
serve," and silently swallowed any sibling route added under the same
parent prefix in the future.

## Options considered

1. **Keep the path-filter band-aid.** Hand-rolled `req.url.startsWith`
   guard in `src/server.ts`. Rejected: two sources of truth for the
   router's path coverage; future routes silently break the filter
   without test signal; `startsWith` is unanchored (`/templates-x` would
   falsely match without explicit boundary checks).

2. **Mount at `/api/v1/templates` only, keep `router.use(auth)`,
   refactor `/scaffold` into a separate top-level mount with the same
   pattern.** Rejected only as a half-measure: still leaves the rule
   "router.use(auth) is dangerous at parent-prefix mounts" implicit and
   discoverable only via the next reviewer reading this file.

3. **Per-route auth attachment + split the templates router into two
   factories** (`createTemplatesRouter` for `/templates`,
   `createScaffoldRouter` for `/scaffold`), each mounted at its own
   resource prefix on the live server. Internal route paths become
   relative to the mount (`router.get("/", auth, ...)` instead of
   `router.get("/templates", auth, ...)`).

   Result: every middleware (json parser, auth, idempotency) is strictly
   scoped to its resource. Sibling routes are invisible to it. The
   router can never authenticate on a path that isn't its own.

## Chosen option

**Option 3.** Encoded as the B3 router refactor and adopted symmetrically
on the B2 codeRepository router.

## Rule (the contract this decision creates)

> A router that may ever be mounted at a parent prefix MUST NOT declare
> auth via `router.use(requireCodeReposAuth())` (or any other auth
> middleware). Auth is attached **per-route** as the first handler
> argument. Routers SHOULD be mounted at their resource-specific prefix
> (e.g. `/api/v1/templates`), with internal routes relative to the
> mount. If the router serves multiple resources, it MUST be split into
> one factory per resource.

This rule applies to `requireCodeReposAuth`, `requireTellusAuth`, and
any future auth middleware in the codebase.

## Rationale

Per the Decision Protocol's priority order:

- **Production safety** (priority 1): the leak shipped to a running dev
  server and silently 401-ed login. This is exactly the class of bug the
  rule prevents at the architectural layer rather than the review layer.
- **Idempotency of mount placement** (priority 2): a router that obeys
  this rule is safe to mount at any prefix. Reviewers no longer need to
  audit `app.use(...)` lines for "does this prefix overshadow a
  sibling?"
- **Express idiomatic** (priority 3): the framework's own primitive
  (`app.use(specificPrefix, router)`) does the work; we stop
  reimplementing path matching in user code.
- **Consistent with Conjure**: in Foundry's Conjure-generated handlers,
  every endpoint declares its own auth scope per the IDL. The split-
  router shape is the closest Express idiom to that contract.

## What evidence would change this

- An Express version that changes router prefix semantics such that
  `router.use(...)` only runs for matched routes (currently impossible
  without breaking the framework's middleware contract).
- Adoption of an Express alternative (Conjure-generated handlers, hono,
  fastify with type-safe routing) where per-endpoint auth is the
  framework default and the band-aid pattern cannot occur.

Either would supersede this decision; until then it stands.

## Contract IDs that depend on this decision

- G-C-07/G-C-08/G-C-11 (auth) — the implementation pattern that
  satisfies these contracts is the per-route attachment.
- G-C-21 (mount conventions) — implicitly extended: each Code Repos
  service mounts at its resource prefix, never at a parent.

## Tests pinned to this decision

- `tests/integration/code-repos/server-mount-isolation-integration.test.ts`:
  - "POST /api/v1/auth/login reaches the auth stub (regression)"
  - "GET /api/v1/foobar (no router matches) hits the catch-all 404, not a 401"
  - "GET /api/v1/templatesx (suffix collision) is NOT intercepted by /api/v1/templates"
  - "POST /api/v1/scaffolding (suffix collision) is NOT intercepted by /api/v1/scaffold"
  - "templates 401 short-circuits before any pool.query()"
  - "scaffold 401 short-circuits before any pool.query()"

These run in `vitest.codeRepos.config.ts` and gate every PR that touches
the affected files. Reverting D-2026-05-04-007 either by reintroducing
`router.use(requireCodeReposAuth())` or by reintroducing the path-filter
band-aid will cause the regression suite to fail loudly.

## Lint guard (recommended follow-up, not in this decision)

A custom ESLint rule or grep-based CI gate forbidding the literal string
`router.use(requireCodeReposAuth` outside of test files would prevent
re-introduction at review time. Tracked as a separate task.

## Files touched in the implementation

- `src/services/templates/admin/routes.ts` — split into
  `createTemplatesRouter` + `createScaffoldRouter`; per-route auth.
- `src/services/templates/admin/app.ts` — standalone test factory mounts
  both routers at their resource prefixes.
- `src/services/codeRepository/admin/routes.ts` — `router.use(auth)`
  removed; auth attached per-route on all 10 endpoints.
- `src/server.ts` — replaced the path-filter band-aid with two clean
  `app.use("/api/v1/templates", ...)` / `app.use("/api/v1/scaffold", ...)`
  mounts.
- `tests/integration/code-repos/server-mount-isolation-integration.test.ts`
  (new) — 12 tests covering sibling isolation, suffix-collision, auth
  enforcement, and DB-leak guard.
