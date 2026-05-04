# Functions Registry API (B8)

**Mount prefix:** *(not mounted on the live server — available as a module)*
**Status:** **Module-ready** — `createFunctionsRegistryAdminApp({ pool })` from `src/services/functionsRegistry/admin/app.ts`. Wire by adding `app.use("/api/v1/functions", createFunctionsRegistryAdminApp({ pool }))` to `src/server.ts`.
**Source:** `src/services/functionsRegistry/`
**Migrations applied:** `055_b8_functions_registry`.

The Functions Registry stores published function versions per repository.
Each `(repository_rid, semver, branch?)` row carries an immutable
`artifact_sha256` and a lifecycle (`AVAILABLE | YANKED`). Idempotent publish
deduplicates same-sha retries; sha mismatch with same `(repo, branch, semver)`
is rejected as `409 Functions:VersionImmutable`. Branch-aware preview
resolution excludes `is_preview=true` versions from default-branch lookups.

## Endpoints

### `POST /functions/:rid/versions`

Publish a function version. Idempotency-required.

```http
POST /api/v1/functions/ri.stemma.main.repository.<uuid>/versions
Idempotency-Key: <uuid>
Content-Type: application/json

{
  "semver":         "1.2.3",
  "branch":         "main",
  "isPreview":      false,
  "artifactSha256": "0123abcd…64hex…",
  "manifest":       {
    "exports": [ { "name": "calculateDaysSalesOutstanding", "language": "typescript" } ]
  }
}
```

**201 Created** (first publish):

```json
{
  "repositoryRid":  "ri.stemma.main.repository.<uuid>",
  "semver":         "1.2.3",
  "branch":         "main",
  "isPreview":      false,
  "artifactSha256": "0123abcd…",
  "state":          "AVAILABLE",
  "publishedAt":    "2026-05-03T12:35:00.000Z"
}
```

**200 OK** (idempotent dedup): same `(repo, semver, branch)` + identical
`artifactSha256` returns the existing row with `X-Idempotent-Replay: true`.

**409 Functions:VersionImmutable**: same `(repo, semver, branch)` + different
`artifactSha256`. Versions are append-only.

### `GET /functions/:rid/versions?branch=main&includeYanked=false&pageSize=20&pageToken=…`

Cursor-paginated list of versions for a repo. Filters:

- `branch` — match a specific branch column (NULL for default-branch publishes).
- `includeYanked` — default `false`; set `true` to include yanked rows.

```json
{
  "items": [
    {
      "semver":         "1.2.3",
      "branch":         "main",
      "isPreview":      false,
      "artifactSha256": "0123…",
      "state":          "AVAILABLE",
      "publishedAt":    "2026-05-03T12:35:00.000Z",
      "yankedAt":       null,
      "yankReason":     null
    }
  ],
  "nextPageToken": "eyJzZW0iOiIxLjIuMyJ9"
}
```

### `GET /functions/:rid/versions/:semver?branch=main`

Returns a specific row. 404 `Functions:VersionNotFound` on unknown.

### `GET /functions/:rid/resolve?range=^1.2.0&branch=feature/x`

Branch-aware semver target resolution. Selects the highest `semver` in the
specified `range` that is:

1. `state = 'AVAILABLE'`,
2. either matches `branch === requestedBranch` or `branch IS NULL`,
3. **excludes preview versions when** `requestedBranch === defaultBranch` (the
   "preview-version exclusion from default branch resolution" rule).

```json
{
  "matched":        true,
  "semver":         "1.5.7",
  "branch":         "feature/x",
  "artifactSha256": "abcd…",
  "isPreview":      true
}
```

If no candidate matches, `{ "matched": false }` with status 200 (intentional —
no-match is not an error; preview resolution may have legitimately filtered
everything out).

**Range syntax** — npm-compatible: `^1.2.0`, `~1.2.0`, `1.2.x`, `1.2.*`,
`>=1.2.3 <2.0.0`, exact `1.2.3`, conjunction `>=1.0.0 <2.0.0 || >=3.0.0`,
star `*`. Invalid range → `400 Functions:InvalidRange`.

### `POST /functions/:rid/versions/:semver/yank`

Lifecycle flip `AVAILABLE → YANKED`. Idempotent.

```http
POST /api/v1/functions/ri.stemma.main.repository.<uuid>/versions/1.2.3/yank
Idempotency-Key: <uuid>
Content-Type: application/json

{ "reason": "security: CVE-2026-NNNN" }
```

**200 OK** with the YANKED row. Already-yanked → 200 with `replayed=true`.
Yanked rows are excluded from `resolveTarget` and from default `listVersions`.

## Error names

| `errorName` | HTTP | When |
|---|---|---|
| `Functions:VersionImmutable` | 409 | Same `(repo, semver, branch)` + different sha. |
| `Functions:VersionNotFound` | 404 | Unknown row. |
| `Functions:InvalidArgument` | 400 | Validation failure. |
| `Functions:InvalidRange` | 400 | Garbled semver range. |
| `Functions:Unauthenticated` | 401 | Missing principal. |
| `Functions:PermissionDenied` | 403 | Caller cannot yank a version they didn't publish. |
| `Functions:MissingIdempotencyKey` | 400 | Mutating POST without key. |
| `Functions:InvalidIdempotencyKey` | 400 | Non-UUID-v4 key. |
| `Functions:Internal` | 500 | Unexpected. |

## Schema highlights (migration 055)

- `function_version (repository_rid, branch NULLABLE, semver, artifact_sha256, is_preview, state CHECK ('AVAILABLE','YANKED'), yanked_at, yanked_by_principal, yank_reason, published_at, manifest JSONB)`
- `UNIQUE (repository_rid, branch, semver)` — enforces append-only versioning per `(repo, branch, semver)`.
- `function_version_yank_lifecycle_chk` — `state='YANKED'` requires `yanked_at IS NOT NULL` and `yank_reason IS NOT NULL`.

## Concurrency invariants

- Two CI pods racing to publish the same `(repository_rid, branch, semver)`
  with the same sha → 1 winner (201), 1 dedup (200 + replay flag).
- Same triple with different sha → 1 winner (201), 1 conflict
  (409 `VersionImmutable`).
- Verified by `tests/integration/code-repos/functions/admin-routes-integration.test.ts`.

## Test coverage

- `tests/unit/code-repos/functions/semver-unit.test.ts` — 38 cases (parser/comparator/range/preview-exclusion)
- `tests/unit/code-repos/functions/errors-unit.test.ts` — 12 cases
- `tests/integration/code-repos/functions/admin-routes-integration.test.ts` — 18 cases
- `tests/integration/code-repos/migrations/055-b8-functions-registry-roundtrip-integration.test.ts` — 11 cases
