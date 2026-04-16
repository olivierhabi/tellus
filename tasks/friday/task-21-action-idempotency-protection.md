# TASK 21: Build Action Idempotency Protection

**Objective:** Implement idempotency protection to prevent the same action from being executed twice if the client retries a request. In distributed systems, network failures can cause a client to retry a request that actually succeeded — without idempotency protection, the action would execute twice (e.g., creating a duplicate employee or applying a salary change twice). Palantir handles this through execution IDs that track completed actions.

The idempotency mechanism works as follows: the client includes an `Idempotency-Key` header with a unique value (typically a UUID v4). The server checks if an action with this key has already been executed. If yes, it returns the cached result instead of re-executing. If no, it executes normally and stores the result keyed by the idempotency key.

**Create the module** at `src/actions/idempotency.js`.

**Implementation details:**

Create a new PostgreSQL table to track idempotency keys:
```sql
CREATE TABLE IF NOT EXISTS idempotency_key (
    idempotency_key TEXT PRIMARY KEY,
    action_type_api_name TEXT NOT NULL,
    execution_id UUID NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_key(expires_at);
```

The module exports three functions:

```javascript
/**
 * Checks if an action with this idempotency key has already been executed.
 * @param {string} key - The idempotency key from the client
 * @returns {Promise<Object|null>} The cached result if found, null if not
 */
async function checkIdempotencyKey(key, actionTypeApiName) {
    const result = await pool.query(
        'SELECT action_type_api_name, result FROM idempotency_key WHERE idempotency_key = $1 AND expires_at > now()',
        [key]
    );
    if (result.rows.length === 0) return null;
    // Cross-action-type guard: if the cached result is for a DIFFERENT action type,
    // ignore the cache and execute normally. This prevents incorrect results when
    // a client reuses the same key across different action types (a client error,
    // but we should not return incorrect data).
    if (result.rows[0].action_type_api_name !== actionTypeApiName) return null;
    return result.rows[0].result;
}

/**
 * Stores the result of an action execution keyed by the idempotency key.
 * @param {string} key - The idempotency key
 * @param {string} actionTypeApiName - Which action type was executed
 * @param {string} executionId - The unique execution ID
 * @param {Object} result - The full action result to cache
 */
async function storeIdempotencyKey(key, actionTypeApiName, executionId, result) {
    await pool.query(
        `INSERT INTO idempotency_key (idempotency_key, action_type_api_name, execution_id, result)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, actionTypeApiName, executionId, JSON.stringify(result)]
    );
}

/**
 * Cleans up expired idempotency keys. Run this periodically (e.g., daily).
 * Keys expire after 24 hours — after that, the same key can be reused.
 */
async function cleanupExpiredKeys() {
    const result = await pool.query('DELETE FROM idempotency_key WHERE expires_at < now()');
    return result.rowCount;
}
```

**Integrate with the action execution flow** in the action routes (Task 8):

```javascript
// In POST /api/v1/actions/:actionTypeApiName/apply
router.post('/:actionTypeApiName/apply', async (req, res, next) => {
    try {
        // Use ONLY the Idempotency-Key header for idempotency. Do NOT use req.body.executionId
        // because executionId is a server-generated value (created by executeAction in Task 8),
        // not a client-provided field. Using both would create confusion about field ownership.
        const idempotencyKey = req.headers['idempotency-key'] || null;
        
        // If idempotency key is provided, check for cached result
        if (idempotencyKey) {
            const cached = await checkIdempotencyKey(idempotencyKey, actionTypeApiName);
            if (cached) {
                // Action was already executed — return the cached result
                // Set a header to indicate this is a cached response
                res.set('X-Idempotency-Cached', 'true');
                return res.status(cached.success ? 200 : 400).json(cached);
            }
        }
        
        // Execute the action normally
        const result = await executeAction(ontologyId, actionTypeApiName, req.body.parameters, context);
        
        // Store the result for idempotency
        if (idempotencyKey) {
            await storeIdempotencyKey(idempotencyKey, actionTypeApiName, result.executionId, result);
        }
        
        return res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
        next(err);
    }
});
```

**Important behaviors to implement correctly:**

1. **Failed actions are also cached.** If an action fails (e.g., validation error), the failure result is cached under the idempotency key. A retry with the same key returns the same failure. The client must use a NEW idempotency key if they want to fix the parameters and try again.

2. **Keys expire after 24 hours.** This prevents the idempotency table from growing unbounded. After 24 hours, the same key can be reused (the assumption is that the client has already received the result by then).

3. **The Idempotency-Key header is optional.** If not provided, no idempotency protection is applied — the action executes every time. This is the default behavior for clients that don't need idempotency (e.g., interactive UI sessions where the user explicitly clicks "Submit").

4. **Race condition (known limitation for week 1).** If two identical requests arrive simultaneously (before either completes), both will pass the `checkIdempotencyKey` check (finding no cached result) and both will execute. The `ON CONFLICT DO NOTHING` in `storeIdempotencyKey` prevents a duplicate insert but does not prevent double execution. This is an acceptable limitation for week 1. In production, use `SELECT ... FOR UPDATE` or a PostgreSQL advisory lock to prevent concurrent execution with the same key.

5. **Cleanup scheduling.** Register a periodic cleanup in `src/server.js` using `setInterval`:
```javascript
const { cleanupExpiredKeys } = require('./actions/idempotency');
setInterval(async () => {
    const deleted = await cleanupExpiredKeys();
    if (deleted > 0) console.log(`[CLEANUP] Removed ${deleted} expired idempotency keys`);
}, 6 * 60 * 60 * 1000); // every 6 hours
```

6. **The key must be globally unique.** Two different actions using the same key would cause one of them to return the other's cached result, which would be incorrect. The client is responsible for generating unique keys (UUID v4 is recommended). If the same key is used with a DIFFERENT action type, the cached result might not match — add a check: if the cached result's `actionTypeApiName` doesn't match the current request's action type, ignore the cache and execute normally (the key was reused across different actions, which is a client error but shouldn't cause data corruption).

**Test cases:**
```javascript
const key = 'test-idempotency-key-' + Date.now();

// First execution: should run normally
const res1 = await fetch('/api/v1/actions/createEmployee/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ parameters: { employeeId: 'EMP-IDEM', fullName: 'Idempotent' } })
});
assert(res1.status === 200);
assert(res1.headers.get('X-Idempotency-Cached') === null);
const body1 = await res1.json();
assert(body1.success === true);

// Second execution with same key: should return cached result
const res2 = await fetch('/api/v1/actions/createEmployee/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ parameters: { employeeId: 'EMP-IDEM', fullName: 'Idempotent' } })
});
assert(res2.status === 200);
assert(res2.headers.get('X-Idempotency-Cached') === 'true');
const body2 = await res2.json();
assert(body2.executionId === body1.executionId); // same execution

// Verify the object was created only ONCE
const count = await opensearchClient.count({ index: 'ontology-employee', body: { query: { term: { '__pk': 'EMP-IDEM' } } } });
assert(count.body.count === 1); // not 2
```
