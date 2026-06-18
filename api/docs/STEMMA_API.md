# Stemma API (B1)

**Mount prefix:** *(not mounted on the live server — available as a module)*
**Status:** **Module-ready** — `createStemmaAdminApp({ pool })` from `src/services/stemma/admin/app.ts` and `createStemmaSmartHttpApp({ pool })` from `src/services/stemma/smartHttp/app.ts` produce standalone Express apps. Wire by adding `app.use("/api/v1/stemma", createStemmaAdminApp({ pool }))` and `app.use("/api/v1/stemma/git", createStemmaSmartHttpApp({ pool }))` to `src/server.ts`.
**Source:** `src/services/stemma/admin/`, `src/services/stemma/smartHttp/`, `src/services/stemma/wire/`
**Migrations applied:** `050_stemma_ddl`.

Stemma is the source of truth for repository identity (`ri.stemma.main.repository.<uuid>`),
ref CAS under SERIALIZABLE isolation, and the smart-HTTP wire surface for
`git clone` / `git push`. The wire codec is pure-TS (no `isomorphic-git`,
no shell-out to `git http-backend`) — see `decisions/code-repository/D-2026-05-01-006`.

## Admin surface

### `POST /repositories`

```http
POST /api/v1/stemma/repositories
Idempotency-Key: 22000000-2200-4000-8000-220000000099
Content-Type: application/json

{
  "displayName":       "data-pipelines",
  "defaultBranchName": "main"
}
```

**201 Created** — minted `rid`, atomic insert of the repo + symbolic HEAD ref.

### `DELETE /repositories/:rid`

Soft-tombstones the repo. Subsequent admin reads return 404
`Stemma:RepositoryNotFound`.

### `GET /repositories/:rid`

Returns `{ rid, displayName, defaultBranchName, state, createdAt }`. Tombstoned
repos return 404 to *every* principal (no IDOR leak).

### `GET /repositories/:rid/refs`

Lists every ref including the symbolic HEAD pseudo-ref. The smart-HTTP advertise
route filters `isSymbolic` so `git clone` sees only real refs.

### `POST /repositories/:rid/refs:apply`

Atomic multi-ref CAS. Body:

```json
{
  "updates": [
    { "kind": "create", "name": "refs/heads/main", "newSha": "0123…" },
    { "kind": "update", "name": "refs/heads/dev",  "oldSha": "abc…", "newSha": "def…" },
    { "kind": "delete", "name": "refs/heads/old",  "oldSha": "fed…" }
  ]
}
```

If any single ref CAS fails, the whole batch is rejected with
`409 Stemma:RefUpdateRejected` and `parameters.rejection = { refName, reason: "stale-old-sha", currentTip }`.
Concurrent multi-CAS to the same ref is verified by chaos tests at
`tests/integration/code-repos/stemma/admin-routes-integration.test.ts`.

## Smart-HTTP surface

### `GET /:rid/info/refs?service=git-upload-pack`

Spec-compliant pkt-line advertisement for `git fetch` / `git clone`.

```
0017# service=git-upload-pack\n
0000
<40hex> refs/heads/main\0multi_ack thin-pack side-band-64k …agent=tellus-stemma/1.0.0\n
<40hex> refs/heads/dev\n
0000
```

Capabilities are NUL-separated from the first ref payload. Empty repo emits
the canonical `0000000…0000000 capabilities^{}\0…` zero-id sentinel.

### `GET /:rid/info/refs?service=git-receive-pack`

Same shape; receive-pack capabilities advertised:
`report-status delete-refs atomic agent=tellus-stemma/1.0.0`.

### `POST /:rid/git-upload-pack`

**Currently 501** `Stemma:NotImplemented`. Packfile generation from KV-stored
objects is the next milestone for B1.

### `POST /:rid/git-receive-pack`

End-to-end push handler. Pipeline:

1. Parse pkt-line stream → ref-update commands + capabilities + packfile body.
2. `INSERT INTO stemma_quarantine (rid, principal_sub, expires_at, state='OPEN', …)` (sha256 of packfile body computed at route layer).
3. Run `applyRefUpdates(...)` under SERIALIZABLE.
4. `UPDATE stemma_quarantine SET state = 'PROMOTED'|'REJECTED'`.
5. Emit one audit row (`stemmaPushAccepted` or `stemmaPushRejected`) with `parameters.quarantineSha`.

**413 Stemma:PushBodyTooLarge** when body exceeds `STEMMA_MAX_PUSH_BYTES`
(default 100 MiB).
**400 Stemma:InvalidArgument** with `parameters.parseError` on malformed
pkt-line framing or unknown ref-update directive.

## Error names

| `errorName` | HTTP | When |
|---|---|---|
| `Stemma:RepositoryNotFound` | 404 | Unknown or tombstoned RID. |
| `Stemma:RefUpdateRejected` | 409 | Stale-old-sha on at least one ref in the batch. |
| `Stemma:RefAlreadyExists` | 409 | `create` directive on existing ref. |
| `Stemma:RefMissing` | 409 | `update`/`delete` on absent ref. |
| `Stemma:InvalidArgument` | 400 | Malformed pkt-line, bad ref name, etc. |
| `Stemma:PushBodyTooLarge` | 413 | Body > limit. |
| `Stemma:NotImplemented` | 501 | upload-pack stub. |
| `Stemma:Unauthenticated` | 401 | Missing principal. |
| `Stemma:MissingIdempotencyKey` | 400 | POST without `Idempotency-Key`. |
| `Stemma:InvalidIdempotencyKey` | 400 | Non-UUID-v4 key. |

## Schema highlights (migration 050)

- `stemma_repository (rid PK, display_name, default_branch_name, state CHECK ('ACTIVE','TOMBSTONED'), tombstoned_at, created_at)`
- `stemma_ref (repository_rid FK CASCADE, name, sha NULLABLE for symbolic, target_ref NULLABLE, is_symbolic, …, PRIMARY KEY (repository_rid, name))`
- `stemma_quarantine (quarantine_id PK, repository_rid FK, principal_sub, state CHECK ('OPEN','PROMOTED','REJECTED','EXPIRED'), expires_at CHECK (expires_at > created_at))`

## Test coverage

- `tests/unit/code-repos/stemma/wire/pkt-line-unit.test.ts` — 28 cases
- `tests/unit/code-repos/stemma/wire/ref-update-command-unit.test.ts` — 16 cases
- `tests/integration/code-repos/stemma/admin-routes-integration.test.ts` — 16 cases
- `tests/integration/code-repos/stemma/smart-http-integration.test.ts` — 19 cases
- `tests/integration/code-repos/migrations/050-stemma-ddl-roundtrip-integration.test.ts` — 24 cases

## Open work for full B1 DoD

- Real `git-upload-pack` (packfile generation from KV objects)
- 1 GB packfile end-to-end test, real `git` CLI client
- N=50 concurrent push chaos
- Mid-push node-kill chaos
- gc / repack lifecycle
- k6 load test (50 MB/s clone throughput)
