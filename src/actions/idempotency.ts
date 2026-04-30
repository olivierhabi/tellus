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
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a cached idempotency result (the JSONB payload). */
export interface CachedResult {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check if an action with this idempotency key has already been executed.
 *
 * Returns the cached result if found and not expired, null otherwise.
 * Includes a cross-action-type guard: if the cached result is for a
 * DIFFERENT action type, returns null (ignores the cache). This prevents
 * incorrect results when a client reuses the same key across different
 * action types.
 *
 * @param key              - The idempotency key from the client header
 * @param actionTypeApiName - The action type being executed
 * @returns The cached result if found, null if not
 */
export async function checkIdempotencyKey(
  key: string,
  actionTypeApiName: string
): Promise<CachedResult | null> {
  const result = await query(
    `SELECT action_type_api_name, result
     FROM idempotency_key
     WHERE idempotency_key = $1
       AND expires_at > now()`,
    [key]
  );

  if (result.rows.length === 0) return null;

  // Cross-action-type guard: if the cached result is for a DIFFERENT
  // action type, ignore the cache and execute normally.
  if (result.rows[0].action_type_api_name !== actionTypeApiName) {
    return null;
  }

  return result.rows[0].result as CachedResult;
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
 * @param key               - The idempotency key from the client header
 * @param actionTypeApiName - Which action type was executed
 * @param executionId       - The unique execution ID
 * @param result            - The full action result to cache (JSONB)
 */
export async function storeIdempotencyKey(
  key: string,
  actionTypeApiName: string,
  executionId: string,
  result: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO idempotency_key
       (idempotency_key, action_type_api_name, execution_id, result, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '24 hours')
     ON CONFLICT (idempotency_key) DO UPDATE
       SET action_type_api_name = EXCLUDED.action_type_api_name,
           execution_id         = EXCLUDED.execution_id,
           result               = EXCLUDED.result,
           expires_at           = EXCLUDED.expires_at`,
    [key, actionTypeApiName, executionId, JSON.stringify(result)]
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
