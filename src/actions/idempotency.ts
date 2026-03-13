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
// Race condition (known limitation for week 1): If two identical requests
// arrive simultaneously, both will execute. The ON CONFLICT DO UPDATE
// ensures the result is cached regardless, but does not prevent double
// execution. In production, use SELECT ... FOR UPDATE or PG advisory locks.
//
// Cross-action-type reuse: If a client reuses the same idempotency key
// for a different action type, the cache is bypassed (the old result is
// for the wrong action) and the new action executes. The store step
// overwrites the cached entry with the new action type's result via
// ON CONFLICT DO UPDATE, so subsequent retries are correctly served
// from cache.
// ---------------------------------------------------------------------------

import { query } from "../db";

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

export default { checkIdempotencyKey, storeIdempotencyKey, cleanupExpiredKeys };
