# TASK 27: Build the Action Execution Rate Limiter

**Objective:** Implement rate limiting for action execution to prevent abuse and protect the system from runaway automation. Without rate limiting, a misconfigured Automate rule (future feature) could execute thousands of actions per second, overwhelming the database and OpenSearch. Rate limiting is also a security measure — it prevents denial-of-service attacks through the Action API.

**Create the module** at `src/middleware/rateLimiter.js`.

**Implementation using an in-memory sliding window counter** (upgrade to Redis in production):

```javascript
class RateLimiter {
    constructor() {
        // Store: { key: [timestamp1, timestamp2, ...] }
        this.windows = new Map();

        // Periodic cleanup: remove stale keys (keys with no timestamps within any active window)
        // to prevent unbounded memory growth. Runs every 60 seconds.
        this._cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
    }

    /**
     * Removes keys where all timestamps are older than the longest window (60 seconds).
     * Call this automatically via setInterval or manually for testing.
     */
    cleanup() {
        const now = Date.now();
        const maxWindowMs = 60 * 1000; // all current windows are 60 seconds
        for (const [key, timestamps] of this.windows) {
            const active = timestamps.filter(t => t > now - maxWindowMs);
            if (active.length === 0) {
                this.windows.delete(key);
            } else {
                this.windows.set(key, active);
            }
        }
    }

    /** Call this when shutting down to prevent dangling intervals */
    destroy() {
        clearInterval(this._cleanupInterval);
    }

    /**
     * Check if a request is allowed under the rate limit.
     * @param {string} key - The rate limit key (e.g., "action:updateSalary" or "user:system")
     * @param {number} maxRequests - Maximum requests allowed in the window
     * @param {number} windowMs - Window size in milliseconds
     * @returns {Object} { allowed: boolean, remaining: number, resetAt: Date }
     */
    check(key, maxRequests, windowMs) {
        const now = Date.now();
        if (!this.windows.has(key)) this.windows.set(key, []);
        
        // Remove expired timestamps
        const timestamps = this.windows.get(key).filter(t => t > now - windowMs);
        this.windows.set(key, timestamps);
        
        if (timestamps.length >= maxRequests) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: new Date(timestamps[0] + windowMs),
                retryAfterMs: timestamps[0] + windowMs - now
            };
        }
        
        timestamps.push(now);
        return {
            allowed: true,
            remaining: maxRequests - timestamps.length,
            resetAt: new Date(now + windowMs)
        };
    }
}
```

**Configure rate limits** for action execution:

```javascript
const RATE_LIMITS = {
    // Per action type: max 100 executions per minute
    perActionType: { maxRequests: 100, windowMs: 60 * 1000 },
    // Per user: max 500 executions per minute across all action types
    perUser: { maxRequests: 500, windowMs: 60 * 1000 },
    // Global: max 2000 executions per minute across entire system
    global: { maxRequests: 2000, windowMs: 60 * 1000 },
    // Batch endpoint: max 10 batch requests per minute per user
    batchPerUser: { maxRequests: 10, windowMs: 60 * 1000 },
};
```

**Create Express middleware** that applies rate limiting to action endpoints:

```javascript
function actionRateLimiter(req, res, next) {
    const actionType = req.params.actionTypeApiName;
    const user = req.context?.executedBy || 'anonymous';
    
    // Check all three limits
    const checks = [
        { ...limiter.check(`action:${actionType}`, RATE_LIMITS.perActionType.maxRequests, RATE_LIMITS.perActionType.windowMs), scope: 'action_type' },
        { ...limiter.check(`user:${user}`, RATE_LIMITS.perUser.maxRequests, RATE_LIMITS.perUser.windowMs), scope: 'user' },
        { ...limiter.check('global', RATE_LIMITS.global.maxRequests, RATE_LIMITS.global.windowMs), scope: 'global' },
    ];
    
    const blocked = checks.find(c => !c.allowed);
    if (blocked) {
        res.set('Retry-After', Math.ceil(blocked.retryAfterMs / 1000));
        res.set('X-RateLimit-Scope', blocked.scope);
        res.set('X-RateLimit-Remaining', '0');
        return res.status(429).json({
            errorCode: 'RATE_LIMIT_EXCEEDED',
            errorName: 'RateLimitExceededError',
            errorInstanceId: generateUUID(),
            message: `Rate limit exceeded for scope '${blocked.scope}'. Retry after ${Math.ceil(blocked.retryAfterMs / 1000)} seconds.`,
            parameters: { scope: blocked.scope, retryAfterMs: blocked.retryAfterMs }
        });
    }
    
    // Set rate limit headers on successful requests
    const minRemaining = Math.min(...checks.map(c => c.remaining));
    res.set('X-RateLimit-Remaining', String(minRemaining));
    
    next();
}
```

**Apply the middleware** to action routes:
```javascript
router.post('/:actionTypeApiName/apply', actionRateLimiter, async (req, res, next) => { ... });
router.post('/:actionTypeApiName/applyBatch', batchRateLimiter, async (req, res, next) => { ... });
```

**Create a separate `batchRateLimiter` middleware** for the batch endpoint that checks the `batchPerUser` limit in addition to the global limit:
```javascript
function batchRateLimiter(req, res, next) {
    const user = req.context?.executedBy || 'anonymous';

    const checks = [
        { ...limiter.check(`batch:${user}`, RATE_LIMITS.batchPerUser.maxRequests, RATE_LIMITS.batchPerUser.windowMs), scope: 'batch_per_user' },
        { ...limiter.check('global', RATE_LIMITS.global.maxRequests, RATE_LIMITS.global.windowMs), scope: 'global' },
    ];

    const blocked = checks.find(c => !c.allowed);
    if (blocked) {
        res.set('Retry-After', Math.ceil(blocked.retryAfterMs / 1000));
        return res.status(429).json({
            errorCode: 'RATE_LIMIT_EXCEEDED',
            message: `Rate limit exceeded for scope '${blocked.scope}'.`
        });
    }
    next();
}
```

**Test cases:**
```javascript
// Rapid-fire 101 requests to exceed per-action-type limit (100/min)
const promises = [];
for (let i = 0; i < 101; i++) {
    promises.push(fetch('/api/v1/actions/updateSalary/apply', {
        method: 'POST', body: JSON.stringify({ parameters: { employeeRef: 'EMP-001', newSalary: 100000 + i } })
    }));
}
const results = await Promise.all(promises);
const rateLimited = results.filter(r => r.status === 429);
// At least 1 request should be rate limited (the 101st request exceeds the 100/min limit).
// The exact count may vary due to Node.js event loop timing with Promise.all, but
// we expect at minimum the 101st request to be rejected.
assert(rateLimited.length >= 1, `Expected at least 1 rate-limited response, got ${rateLimited.length}`);
assert(rateLimited[0].headers.get('Retry-After') !== null);
```
