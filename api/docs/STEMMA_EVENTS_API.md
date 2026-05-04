# Stemma Events API (B10)

**Mount prefix:** *(not mounted on the live server — available as a module)*
**Status:** **Module-ready** — `createStemmaEventsAdminApp({ pool })` from `src/services/stemmaEvents/admin/app.ts`. Wire by adding `app.use("/api/v1/stemma-events", createStemmaEventsAdminApp({ pool }))` to `src/server.ts`.
**Source:** `src/services/stemmaEvents/`
**Migrations applied:** `052_b10_stemma_events`.

Stemma Events is the fan-out plane for Stemma push/merge/tag activity. It
implements the pre-receive policy decision (branch protection, regex
validation), the post-receive durable-before-ack write of `stemma_event` +
audit, HMAC-SHA256-signed callback delivery to subscribers, atomic 5-failure
auto-suspend, and cursor-paginated event log reads.

## Endpoints

### `POST /pre-receive`

Pure-logic policy decision. Idempotency-exempt (non-mutating).

```http
POST /api/v1/stemma-events/pre-receive
Content-Type: application/json

{
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "principal":     { "userId": "alice", "roles": ["editor"] },
  "repoSettings":  {
    "protectedBranches": [
      { "pattern": "main", "requirePullRequest": true, "allowedRoles": ["maintainer"] }
    ]
  },
  "commands": [
    { "kind": "update", "ref": "refs/heads/main",       "newSha": "0123…" },
    { "kind": "create", "ref": "refs/heads/feature/x",  "newSha": "abcd…" }
  ]
}
```

**200 OK**

```json
{
  "decisions": [
    { "kind": "deny", "errorName": "BranchProtection:DirectPushDenied",
      "parameters": { "ref": "refs/heads/main" } },
    { "kind": "allow" }
  ]
}
```

Error names emitted via `decisions[i].errorName`:

| `errorName` | HTTP-on-deny | Spec |
|---|---|---|
| `BranchProtection:InvalidBranchName` | 400 | Ref fails `^refs/heads/[a-zA-Z0-9._/-]{1,255}$` |
| `BranchProtection:DirectPushDenied` | 403 | `requirePullRequest=true` and direct push attempted |
| `BranchProtection:UnauthorizedPusher` | 403 | Principal not in `allowedRoles` |
| `BranchProtection:RefRollbackDenied` | 409 | New tip is not a fast-forward |
| `BranchProtection:TagImmutable` | 403 | Tag refs are append-only (D-2026-05-01-004) |
| `BranchProtection:LockedRef` | 423 | Ref locked by ongoing administrative operation |

### `POST /post-receive`

Atomic write of `stemma_event` + audit row in one SERIALIZABLE transaction.

```http
POST /api/v1/stemma-events/post-receive
Idempotency-Key: 33000000-3300-4000-8000-330000000099
Content-Type: application/json

{
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "eventType":     "PUSH",
  "ref":           "refs/heads/main",
  "oldSha":        "0123…",
  "newSha":        "4567…",
  "commitCount":   3,
  "synchronousDispatch": true
}
```

**201 Created**

```json
{
  "eventRid": "ri.stemma.main.event.<uuid>",
  "auditRowId": "<uuid>"
}
```

If `synchronousDispatch=true`, the response includes per-subscriber outcomes
(test-only; production fires-and-forgets).

`eventType ∈ {"PUSH","MERGE","TAG"}`. The route validates that `principal.userId`
is null OR a valid UUID v4 (production keycloakSub is UUID by construction).

### `GET /events?repositoryRid=…&pageSize=20&pageToken=…`

Cursor-paginated event log.

```json
{
  "items": [
    {
      "eventRid":     "ri.stemma.main.event.<uuid>",
      "repositoryRid": "ri.stemma.main.repository.<uuid>",
      "eventType":    "PUSH",
      "ref":          "refs/heads/main",
      "oldSha":       "0123…",
      "newSha":       "4567…",
      "occurredAt":   "2026-05-03T12:35:00.000Z"
    }
  ],
  "nextPageToken": "eyJzZXEiOjQ3fQ"
}
```

Cursor token is opaque base64url; ≥30-day stable. Garbled tokens →
`400 StemmaEvents:InvalidPageToken`.

### `POST /subscriptions`

Register a webhook subscriber.

```http
POST /api/v1/stemma-events/subscriptions
Idempotency-Key: <uuid>
Content-Type: application/json

{
  "repositoryRid":  "ri.stemma.main.repository.<uuid>",
  "callbackUrl":    "https://consumer.example/webhook",
  "eventTypes":     ["PUSH", "TAG"],
  "hmacSecret":     "shared-32-byte-secret-…"
}
```

**201 Created** with ETag `W/"0"` and `subscriptionRid`.

### `GET /subscriptions/:rid`

Returns subscription detail. Unknown → 404 `StemmaEvents:SubscriptionNotFound`
(IDOR-as-404).

### `GET /subscriptions?repositoryRid=…&state=ACTIVE&pageSize=20&pageToken=…`

Cursor-paginated list filtered by repo + state. State ∈ `{ACTIVE, SUSPENDED}`.

### `DELETE /subscriptions/:rid`

204 No Content. Unknown → 404. ETag-guarded via `If-Match`.

### `POST /subscriptions/:rid/reactivate`

Flips a SUSPENDED subscription → ACTIVE; resets `consecutive_failures = 0`.
Already-ACTIVE input is a no-op (no second audit row emitted).

## Callback dispatch

Each accepted post-receive triggers fan-out to every matching ACTIVE
subscription:

1. Build canonical event JSON.
2. Sign: `X-Tellus-Signature: sha256=<hexdigest>` where digest is
   `HMAC-SHA256(hmacSecret, body)`.
3. POST `callbackUrl` with `Content-Type: application/json` and the signature.
4. On non-2xx or transport failure, atomic UPDATE: `consecutive_failures += 1`;
   if the new value is `>= 5`, transition to SUSPENDED in the same UPDATE.
5. SUSPENDED rows are excluded from subsequent fan-out until reactivated.

Verifier helper available: `verifyCallbackSignature(signatureHeader, body, secret)`.

## Error names

| `errorName` | HTTP | When |
|---|---|---|
| `StemmaEvents:SubscriptionNotFound` | 404 | Unknown subscription RID. |
| `StemmaEvents:RepositoryNotFound` | 404 | Unknown or tombstoned repo. |
| `StemmaEvents:InvalidArgument` | 400 | Validation failure. |
| `StemmaEvents:InvalidPageToken` | 400 | Garbled cursor. |
| `StemmaEvents:Unauthenticated` | 401 | Missing principal. |
| `StemmaEvents:MissingIdempotencyKey` | 400 | POST mutating without key. |
| `StemmaEvents:InvalidIdempotencyKey` | 400 | Non-UUID-v4 key. |
| `BranchProtection:*` (six names) | 400/403/409/423 | Pre-receive denials. |

## Concurrency invariants

- Two parallel `recordDeliveryFailure` on a sub at 4 prior failures → both
  succeed; final state SUSPENDED; counter ∈ {5, 6}. Atomic UPDATE.
- Fan-out failure isolation — a thrown subscriber callback does NOT propagate;
  outcome is `failed`, audit + event still landed.
- Post-receive durable-before-ack — sabotage `code_repos_audit_hash_head`
  mid-call → `recordPostReceive` throws, the stemma_event INSERT rolls back.

## Schema highlights (migration 052)

- `stemma_event (event_rid PK, repository_rid FK CASCADE, event_type CHECK, ref, old_sha, new_sha, principal_sub UUID NULLABLE, payload JSONB, occurred_at, seq BIGSERIAL)`
- `stemma_subscription (subscription_rid PK, repository_rid FK, callback_url, event_types TEXT[], hmac_secret, state CHECK ('ACTIVE','SUSPENDED'), consecutive_failures, …)`
- Index `(repository_rid, occurred_at DESC, seq DESC)` for fan-out lookup.

## Test coverage

- `tests/unit/code-repos/stemma-events/pre-receive-policy-unit.test.ts`
- `tests/unit/code-repos/stemma-events/hmac-unit.test.ts`
- `tests/unit/code-repos/stemma-events/branch-protection-errors-unit.test.ts`
- `tests/integration/code-repos/stemma-events/event-store-integration.test.ts` — 14
- `tests/integration/code-repos/stemma-events/subscription-store-integration.test.ts` — 14
- `tests/integration/code-repos/stemma-events/callback-dispatcher-integration.test.ts` — 5
- `tests/integration/code-repos/stemma-events/post-receive-service-integration.test.ts` — 5
- `tests/integration/code-repos/stemma-events/admin-routes-integration.test.ts` — 24
- `tests/integration/code-repos/migrations/052-b10-stemma-events-roundtrip-integration.test.ts` — 12
