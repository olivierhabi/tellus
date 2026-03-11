# TASK 19: Enhance the Request Logging Middleware

**File to modify:** `/src/middleware/requestLogger.js` (created in Monday Task 10)

**Dependencies:** Monday Task 10 (created the initial request logger with structured JSON logging, `req.requestId`, `req.log` helper).

**Purpose:** Extend the existing request logging middleware with three additional capabilities that are needed for the Object Set Service's operational monitoring: nanosecond-precision timing, client-facing request ID headers, and slow-query detection.

**This task does NOT rewrite the middleware from scratch.** It enhances Monday Task 10's implementation. All existing functionality (structured JSON log format, `req.requestId`, `req.log` helper, error-level logging for status >= 400) must continue to work.

**Enhancements to add:**

1. **Upgrade timing precision.** Replace `Date.now()` with `process.hrtime.bigint()` for nanosecond-accurate elapsed time measurement. The `durationMs` field in the log output should now be calculated as:
   ```javascript
   const startTime = process.hrtime.bigint();
   // ... on finish:
   const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
   ```
   This gives sub-millisecond precision (e.g., `4.23ms` instead of `4ms`), which is important for the Object Set Service where many queries complete in under 10ms.

2. **Add `X-Request-Id` response header.** Set `res.setHeader('X-Request-Id', req.requestId)` so clients can reference the request ID in support tickets or correlate requests across distributed systems. The `req.requestId` value is already set by Monday Task 10 using `crypto.randomUUID()` — do not change the generation method.

3. **Add slow-request detection.** After calculating `durationMs` in the `finish` handler, if the duration exceeds 1000ms, log a WARNING-level entry with the full request body (truncated to 2000 characters) to help identify problematic queries:
   ```json
   {
     "level": "warn",
     "type": "slow_request",
     "requestId": "...",
     "method": "POST",
     "path": "/api/v2/objects/Employee/search",
     "durationMs": 3245.67,
     "body": "{\"where\":{\"type\":\"and\",\"value\":[...truncated...]}",
     "timestamp": "..."
   }
   ```
   The body should be stored at request time (before the stream is consumed) via `JSON.stringify(req.body).substring(0, 2000)`. Only store the body for POST/PUT/PATCH requests.

**What NOT to change:**
- Do not change the UUID generation method (keep `crypto.randomUUID()`)
- Do not change the structured JSON log format
- Do not change or remove the `req.log` helper function
- Do not change the error-level logging for status >= 400
- Do not change the middleware registration in `server.js` (it is already registered before all routes)

**Export:** Same as before — a single Express middleware function (default export).

**Acceptance criteria:**
1. `durationMs` in log output shows sub-millisecond precision (e.g., `4.23` not `4`).
2. Response headers include `X-Request-Id` matching `req.requestId`.
3. A request taking >1000ms produces an additional `slow_request` log entry at `warn` level with the truncated request body.
4. A request taking <1000ms does NOT produce a `slow_request` log entry.
5. Existing `req.log("message", data)` still works and emits structured JSON with the request ID.
6. Existing `request_start` and `request_complete` log entries still appear for every request.
