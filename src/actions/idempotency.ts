// ---------------------------------------------------------------------------
// Action Idempotency Protection (Task 21)
//
// Prevents duplicate action execution when clients retry requests. The
// mechanism works as follows:
//
//   1. Client includes an `Idempotency-Key` header (typically UUID v4)
//   2. Server checks if a result is cached for this key
//   3. If cached: return the cached result (no re-execution)
//   4. If not cached: execute normally, then cache the result
//
// Both successful AND failed results are cached. A retry returns the same
// result regardless of success or failure. The client must use a new key
// if they want to fix parameters and retry.
//
// Keys expire after 24 hours. After expiry, the key can be reused.
//
// Race condition FIX (Phase A5, F-04): `withIdempotencyLock` serializes
// concurrent requests for the same idempotency key via a session-scoped
// PostgreSQL advisory lock (`pg_advisory_lock(hashtext(key))`). Two
// identical requests now queue: the first runs, caches its result, and
// the second — after waking on the lock — finds the cached result and
// returns it. The lock is session-scoped (not transaction-scoped) so it
// can guard the entire check → execute → store sequence without
// interleaving with the action's own internal transactions.
//
// Cross-action-type reuse: If a client reuses the same idempotency key
// for a different action type, the cache is bypassed (the old result is
// for the wrong action) and the new action executes. The store step
// overwrites the cached entry with the new action type's result via
// ON CONFLICT DO UPDATE, so subsequent retries are correctly served
// from cache.
//
// Principal/body scoping (migration 188): cached rows are keyed by
// (idempotency_key, principal) and additionally carry a sha256 hash of the
// canonical request. A cross-user key collision can no longer replay
// another user's result — the second caller simply misses the cache and
// executes normally, storing under their own (key, principal) row. The
// same caller reusing a key with a DIFFERENT body is rejected with a
// conflict signal the routes map to HTTP 409 (code "IdempotencyConflict"),
// matching the code-repos contract (G-C-23).
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a cached idempotency result (the JSONB payload). */
export interface CachedResult {
  [key: string]: unknown;
}

/**
 * Scope a cached idempotency row is bound to. `principal` identifies the
 * caller; `requestHash` is the sha256 of the canonical request
 * (method + path + body) so a reused key with a mutated body is a conflict
 * rather than a false replay.
 */
export interface IdempotencyScope {
  principal: string;
  requestHash: string;
}

/**
 * Outcome of a scoped cache lookup:
 *   - "hit"      — same key, same principal, same action type, same body
 *                  hash: replay the cached result.
 *   - "miss"     — no usable row for this (key, principal): execute normally.
 *   - "conflict" — same key + same principal + same action type but a
 *                  DIFFERENT body hash: the caller must receive a 409
 *                  (re-executing would risk a duplicate mutation under a
 *                  replayed key; replaying would return the wrong body).
 */
export type ScopedIdempotencyCheck =
  | { kind: "hit"; result: CachedResult }
  | { kind: "miss" }
  | { kind: "conflict" };

/**
 * Scope for server-internal callers that have no HTTP request context (the
 * automate effect runtime). Its keys are `automate:<effect_execution_id>` —
// unique per effect execution — so a fixed principal with an empty body
 * hash preserves the pre-188 semantics exactly: same key ⇒ replay.
 */
const SYSTEM_SCOPE = { principal: "system", requestHash: "" } as const;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Pure replay decision over rows already fetched for (key, principal):
 * the row for the SAME action type decides hit vs conflict; rows for other
 * action types are ignored (cross-action-type reuse bypasses the cache and
 * the store step overwrites). Exported for unit tests.
 */
export function decideScopedReplay(
  rows: Array<{
    action_type_api_name: string;
    request_hash: string | null;
    result: CachedResult;
  }>,
  actionTypeApiName: string,
  requestHash: string
): ScopedIdempotencyCheck {
  for (const row of rows) {
    if (row.action_type_api_name !== actionTypeApiName) continue;
    if ((row.request_hash ?? "") === requestHash) {
      return { kind: "hit", result: row.result };
    }
    return { kind: "conflict" };
  }
  return { kind: "miss" };
}

/**
 * Scoped cache lookup (migration 188). Only rows belonging to
 * `scope.principal` are considered, so a cross-user key collision is a
 * plain miss — the second caller executes normally and stores under their
 * own (key, principal) row.
 *
 * @param key               - The idempotency key from the client header
 * @param actionTypeApiName - The action type being executed
 * @param scope             - Caller identity + canonical request hash
 */
export async function checkIdempotencyKeyScoped(
  key: string,
  actionTypeApiName: string,
  scope: IdempotencyScope
): Promise<ScopedIdempotencyCheck> {
  const result = await query(
    `SELECT action_type_api_name, request_hash, result
     FROM idempotency_key
     WHERE idempotency_key = $1
       AND principal = $2
       AND expires_at > now()`,
    [key, scope.principal]
  );

  return decideScopedReplay(
    result.rows as Array<{
      action_type_api_name: string;
      request_hash: string | null;
      result: CachedResult;
    }>,
    actionTypeApiName,
    scope.requestHash
  );
}

/**
 * Backward-compatible unscoped check used by the internal automate runtime
 * (keys there are `automate:<effect_execution_id>`, unique per execution, so
 * principal/body scoping adds nothing). Returns just the cached result or
 * null — conflict is impossible in the fixed system scope because the
 * request hash is a constant.
 */
export async function checkIdempotencyKey(
  key: string,
  actionTypeApiName: string
): Promise<CachedResult | null> {
  const check = await checkIdempotencyKeyScoped(
    key,
    actionTypeApiName,
    SYSTEM_SCOPE
  );
  return check.kind === "hit" ? check.result : null;
}

/**
 * Store the result of an action execution keyed by the idempotency key.
 *
 * Uses ON CONFLICT ... DO UPDATE to handle two scenarios:
 *
 *   1. Race condition (same action type): Two concurrent requests both pass
 *      the check. The first insert wins; the second updates with the same
 *      action type's result — functionally identical, no harm done.
 *
 *   2. Cross-action-type reuse: The client reuses the same idempotency key
 *      for a different action type. `checkIdempotencyKey` bypasses the cache
 *      (returns null) and the action executes normally. Without the UPDATE,
 *      the new result would be silently dropped by DO NOTHING, meaning
 *      subsequent retries for the second action type would re-execute every
 *      time — defeating idempotency. The UPDATE overwrites the cached entry
 *      with the new action type's result, restoring idempotency protection.
 *
 * When `opts` is supplied (migration 188), the row is additionally bound to
 * the caller's principal and request-body hash; the upsert then conflicts
 * only within that caller's scope, never against another user's row.
 *
 * @param key               - The idempotency key from the client header
 * @param actionTypeApiName - Which action type was executed
 * @param executionId       - The unique execution ID
 * @param result            - The full action result to cache (JSONB)
 * @param opts              - Optional principal/body-hash scope (migration 188)
 */
export async function storeIdempotencyKey(
  key: string,
  actionTypeApiName: string,
  executionId: string,
  result: Record<string, unknown>,
  opts?: { principal: string; requestHash: string }
): Promise<void> {
  const principal = opts?.principal ?? SYSTEM_SCOPE.principal;
  const requestHash = opts?.requestHash ?? SYSTEM_SCOPE.requestHash;
  await query(
    `INSERT INTO idempotency_key
       (idempotency_key, principal, action_type_api_name, request_hash, execution_id, result, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '24 hours')
     ON CONFLICT (idempotency_key, principal) DO UPDATE
       SET action_type_api_name = EXCLUDED.action_type_api_name,
           request_hash         = EXCLUDED.request_hash,
           execution_id         = EXCLUDED.execution_id,
           result               = EXCLUDED.result,
           expires_at           = EXCLUDED.expires_at`,
    [
      key,
      principal,
      actionTypeApiName,
      requestHash,
      executionId,
      JSON.stringify(result),
    ]
  );
}
/**
 * Clean up expired idempotency keys. Run this periodically (e.g., daily
 * or every 6 hours) to prevent the table from growing unbounded.
 *
 * @returns The number of deleted rows
 */
export async function cleanupExpiredKeys(): Promise<number> {
  const result = await query(
    "DELETE FROM idempotency_key WHERE expires_at < now()"
  );
  return result.rowCount ?? 0;
}

/**
 * Execute `fn` while holding a PostgreSQL advisory lock keyed on
 * `idempotencyKey`. Two concurrent requests with the same key queue on
 * this lock: the first wins, runs the callback (check + execute + store),
 * and on release the second sees the cached result and returns it.
 *
 * Implementation note (F-04 + F-10 interaction):
 *   A naive session-scoped lock pins the pool client for the entire
 *   action duration. With 50 concurrent requests against a 20-connection
 *   pool the lock-holding client and the action-path client deadlock.
 *
 *   We use `pg_try_advisory_lock` (non-blocking) with exponential
 *   backoff instead. The lock client is held only for the ~ms it takes
 *   to issue the SELECT, released immediately, and reacquired for each
 *   subsequent attempt. The action's own getClient() never competes.
 *
 *   The lock is SESSION-scoped so it persists across client release —
 *   the pool client returns to PG still owning the lock, and any later
 *   client checked out from the pool that tries to acquire the same
 *   lock fails `pg_try_advisory_lock` until the unlock runs on the
 *   ORIGINAL session. To guarantee the unlock reaches the original
 *   session we retain `lockClient` across the callback and release it
 *   at the end.
 *
 * Fail-safe contract (F-04):
 *   - The lock is always released, even if `fn` throws. `pg_advisory_unlock`
 *     is idempotent — calling it without a held lock is a no-op warning.
 *   - The dedicated client is always returned to the pool.
 *   - Advisory locks use `hashtext(key)` (built-in 32-bit hash). Collisions
 *     merely serialize unrelated keys; they never corrupt data.
 *
 * @param idempotencyKey - Client-supplied idempotency key (any string)
 * @param fn             - Callback to run under the lock
 */
export async function withIdempotencyLock<T>(
  idempotencyKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const MAX_WAIT_MS = 30_000;
  const startedAt = Date.now();
  let attempt = 0;

  // Acquire phase: try-lock with exponential backoff. The advisory lock is
  // session-scoped, so the ORIGINAL client that succeeds at pg_try_advisory_lock
  // is the one that must later call pg_advisory_unlock. We therefore retain
  // `lockClient` from the successful attempt onward.
  let lockClient: Awaited<ReturnType<typeof getClient>> | null = null;
  while (true) {
    const client = await getClient();
    try {
      const res = await client.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [idempotencyKey],
      );
      if (res.rows[0]?.acquired === true) {
        lockClient = client;
        break;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    client.release();

    if (Date.now() - startedAt >= MAX_WAIT_MS) {
      throw new Error(
        `withIdempotencyLock: failed to acquire advisory lock for key within ${MAX_WAIT_MS}ms`,
      );
    }
    // Exponential backoff with jitter: 10ms → 20ms → 40ms ... cap at 250ms
    const base = Math.min(10 * 2 ** attempt, 250);
    const jitter = Math.random() * base * 0.25;
    await new Promise((r) => setTimeout(r, base + jitter));
    attempt += 1;
  }

  try {
    return await fn();
  } finally {
    try {
      await lockClient!.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [idempotencyKey],
      );
    } catch {
      // Non-fatal: if unlock fails the lock is released on session close.
    }
    lockClient!.release();
  }
}

export default {
  checkIdempotencyKey,
  storeIdempotencyKey,
  cleanupExpiredKeys,
  withIdempotencyLock,
};
