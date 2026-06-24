# Code Repository API (B2)

**Mount prefix:** `/api/v1/code-repositories`
**Status:** **Live** — wired in `src/server.ts:558` via `mountCodeRepositoryRouter({ pool })`.
**Source:** `src/services/codeRepository/admin/routes.ts`
**E2E coverage:** `tellus-fe/cypress/e2e/code-repositories.cy.ts` (7 cases, full Docker stack)
**Migrations applied:** `050_stemma_ddl`, `051_code_repos_audit`, `053_b2_code_repository`.

The Code Repository service is the front door for repositories in Tellus.
It runs the createRepository saga (Compass reservation → Stemma create → Template
push → ACTIVE) under SERIALIZABLE-isolation idempotency, durable-before-ack
audit, ETag-guarded mutations, and IDOR-as-404.

## Authentication

All endpoints require the standard Tellus `Authorization: Bearer <jwt>` OR
`TELLUS_TOKEN` cookie. In test environments (orchestrator sets
`CODE_REPOS_TEST_AUTH=1`), the headers `X-Tellus-Test-Principal: <user>` and
`X-Tellus-Test-Role: <role>` (or `X-Tellus-Test-Roles: r1,r2`) bypass JWT
verification and synthesise a principal. Test mode is gated on the env flag
and is impossible to enable in production builds.

## Cross-cutting headers

| Header | Direction | Purpose |
|---|---|---|
| `Idempotency-Key` (UUID v4) | request | Required on every POST. Same key + same body → replay; same key + different body → `409 CodeRepos:IdempotencyConflict`. 24h TTL. |
| `If-Match` (`W/"<n>"`) | request | Required on PATCH/DELETE. Mismatch → `400 CodeRepos:InvalidSettings` with `parameters.reason="etag-mismatch"`. |
| `ETag` (`W/"<n>"`) | response | Returned on every read + mutation; tracks `resource_version`. |
| `X-Idempotent-Replay: true` | response | Set when the response was served from the idempotency cache. |
| `X-Request-Id` | response | Per-request UUID for log correlation. |

## Error envelope (§1.3)

Every 4xx/5xx response has exactly four keys:

```json
{
  "errorCode":       "INVALID_ARGUMENT",
  "errorName":       "CodeRepos:NameConflict",
  "errorInstanceId": "01HX…",
  "parameters":      { "displayName": "demo" }
}
```

`errorName` regex: `^[A-Z][a-zA-Z0-9]{0,63}:[A-Z][a-zA-Z0-9]{0,63}$`.

| `errorName` | HTTP | Meaning |
|---|---|---|
| `CodeRepos:NameConflict` | 409 | `(parent_folder_rid, lower(display_name))` already taken by an ACTIVE repo. |
| `CodeRepos:RepositoryNotFound` | 404 | Unknown RID or tombstoned (IDOR collapses to 404). |
| `CodeRepos:InvalidSettings` | 400 | Validation failure or ETag mismatch. |
| `CodeRepos:TemplateNotFound` | 404 | Template adapter rejected `(templateId, templateVersion)`. |
| `CodeRepos:CompassUnavailable` | 503 | Compass reservation step failed. |
| `CodeRepos:StemmaUnavailable` | 503 | Stemma create step failed. |
| `CodeRepos:IdempotencyConflict` | 409 | Same `Idempotency-Key`, different body. |
| `CodeRepos:Unauthenticated` | 401 | Missing or invalid principal. |
| `CodeRepos:PermissionDenied` | 403 | Compass `canAct` returned false (rare; IDOR collapses to 404 first). |
| `CodeRepos:Internal` | 500 | Unexpected; retriable; `errorInstanceId` matches one log line. |

## Endpoints

### `POST /`

Create a repository. Drives the 4-step saga to completion or compensation.

```http
POST /api/v1/code-repositories
Idempotency-Key: 11000000-1100-4000-8000-110000000099
Content-Type: application/json

{
  "displayName":      "data-pipelines",
  "parentFolderRid":  "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345",
  "templateId":       "typescript-functions",
  "templateVersion":  "2.4.0",
  "defaultBranch":    "main"
}
```

**201 Created**

```http
HTTP/1.1 201 Created
ETag: W/"1"
X-Request-Id: 01HX…

{
  "rid":              "ri.stemma.main.repository.<uuid>",
  "displayName":      "data-pipelines",
  "parentFolderRid":  "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345",
  "templateId":       "typescript-functions",
  "templateVersion":  "2.4.0",
  "defaultBranch":    "main",
  "state":            "ACTIVE",
  "resourceVersion":  1,
  "createdAt":        "2026-05-03T12:34:56.789Z",
  "updatedAt":        "2026-05-03T12:34:56.789Z",
  "createdBy":        "alice"
}
```

**Idempotent replay** — repeating the exact same request returns the same body
with `X-Idempotent-Replay: true` and no second saga run.

**Validation rules**

| Field | Constraint |
|---|---|
| `displayName` | `^[\w][\w \-.()]{0,127}$` |
| `parentFolderRid` | structurally valid RID |
| `templateId` | `^[a-z][a-z0-9-]{0,63}$` |
| `templateVersion` | `^\d+\.\d+\.\d+(?:-[\w.]+)?$` (semver) |
| `defaultBranch` | `^[a-zA-Z0-9._/-]{1,255}$` |

### `GET /?state=ACTIVE&limit=50&pageToken=…`

Cursor-paginated list. Cursor tokens are opaque base64url; ≥30-day stable.

```json
{
  "items": [ { /* row */ } ],
  "nextPageToken": "eyJjcmVhdGVkQXQi…"
}
```

### `GET /:rid`

Returns the row with `ETag: W/"<resourceVersion>"`. Unknown or tombstoned →
`404 CodeRepos:RepositoryNotFound`.

### `PATCH /:rid`

```http
PATCH /api/v1/code-repositories/ri.stemma.main.repository.<uuid>
If-Match: W/"1"
Content-Type: application/json

{ "displayName": "data-pipelines-renamed" }
```

200 with bumped ETag `W/"2"`. ETag mismatch → 400 `InvalidSettings`.

### `DELETE /:rid`

```http
DELETE /api/v1/code-repositories/ri.stemma.main.repository.<uuid>
If-Match: W/"2"
```

204 No Content. Subsequent GET returns 404 (state=TRASHED is filtered).

### `GET /:rid/branches?protected=true|false`

Returns the cached branch list (populated by B10 stemma_event listeners on
`stemma.refs.updated`). Empty array for fresh repos.

```json
{
  "items": [
    {
      "branchName":     "main",
      "tipCommitSha":   "0123…",
      "isProtected":    true,
      "lastUpdatedAt":  "2026-05-03T12:35:00.000Z"
    }
  ]
}
```

### `PATCH /:rid/settings`

Update branch protection / requirePullRequest / allowedRoles. ETag-guarded.

## Audit (§1.10)

Every mutation produces exactly one row in `code_repos_audit_events` with:

- `category = "code_repository"`
- `action ∈ {"createRepository", "patchRepository", "deleteRepository", "patchSettings"}`
- `principal_user_id`, `principal_source` (either `"jwt"` or `"test-mode"`)
- `before_hash` / `after_hash` (sha256 of canonicalised resource state)
- `parameters_canon` (filtered request body)
- Hash chain via `code_repos_audit_hash_head` advisory-lock-protected singleton

The data UPDATE and the audit INSERT are one SERIALIZABLE transaction; if
audit fails, the data rolls back. Verified by
`tests/integration/code-repos/audit/audit-durable-before-ack-integration.test.ts`.

## Saga state machine

States: `INIT → COMPASS_RESERVED → STEMMA_CREATED → TEMPLATE_PUSHED → ACTIVE`,
plus `COMPENSATING → ROLLED_BACK | INIT_FAILED`.

Compensations are reverse-ordered:

| Failed step | Compensations issued |
|---|---|
| step1 (Compass) | none — INIT → ROLLED_BACK |
| step2 (Stemma) | release-compass |
| step3 (Template push) | tombstone-stemma → release-compass |
| step4 (activate) | delete-template → tombstone-stemma → release-compass |

Compensation success → ROLLED_BACK; compensation failure → INIT_FAILED
(retriable via re-init).

## Concurrency invariants

- Two parallel `POST /` for the same `(parentFolderRid, lower(displayName))`
  → exactly one 201, the other 409 `CodeRepos:NameConflict`. Enforced by the
  partial unique index `(parent_folder_rid, lower(display_name)) WHERE state='ACTIVE'`.
- Same `Idempotency-Key` from two principals → both succeed; key scope is per-principal.
- ETag race on PATCH → exactly one wins; loser sees 400 `InvalidSettings`.

## Test coverage

- `tests/integration/code-repos/code-repository/admin-routes-integration.test.ts` — 22 cases
- `tests/integration/code-repos/code-repository/saga-executor-integration.test.ts` — 9 cases
- `tests/unit/code-repos/code-repository/saga-state-machine-unit.test.ts` — 25 cases
- `tests/unit/code-repos/code-repository/errors-unit.test.ts` — 11 cases
- `tellus-fe/cypress/e2e/code-repositories.cy.ts` — 5 backend e2e cases (POST, replay, list, get, IDOR)
