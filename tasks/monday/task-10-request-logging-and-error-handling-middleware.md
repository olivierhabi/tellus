# TASK 10 OF 30: Request Logging and Error Handling Middleware

**Objective:** Create two Express middleware functions in two separate files: a request logger that logs every request/response as structured JSON, and a global error handler that catches unhandled errors and returns formatted error responses. Both are registered in src/server.js.

**Step-by-step instructions:**

**File 1: src/middleware/requestLogger.js**

Export a single Express middleware function. On every incoming request:

1. Attach `req.requestId = crypto.randomUUID()` and `req._startTime = Date.now()`.
2. Log request start as single-line JSON: `{"level":"info","type":"request_start","requestId":"...","method":"POST","path":"/api/v2/...","timestamp":"..."}`. Include the request body truncated to 2000 characters. Exception: do NOT log bodies for paths containing `/auth/` or `/password/`.
3. On `res.on('finish')`, log completion: `{"level":"info","type":"request_complete","requestId":"...","statusCode":201,"durationMs":45,"timestamp":"..."}`. If `statusCode >= 400`, use `"level":"error"` instead of `"level":"info"`.
4. Attach `req.log = function(message, data)` helper that emits structured JSON with the same requestId, for use by service-layer code. Format: `{"level":"info","type":"app_log","requestId":"...","message":"...","data":{...},"timestamp":"..."}`.
5. Call `next()`.

**File 2: src/middleware/errorHandler.js**

Export a single 4-parameter Express error handler `(err, req, res, next)`. This must be added LAST in the middleware chain (after all routes).

Error translation logic in this exact order:

1. If `err` has a `code` property matching a key in ERROR_CODES (from responseFormatter.js, Task 9), call `sendError(res, err.code, err.message, err.details)` with the HTTP status from HTTP_STATUS_MAP.
2. If `err` is a PostgreSQL error (detected by `err.code` being a string of digits), translate these specific codes:
   - `23505` (unique violation) → call `sendError(res, 'ALREADY_EXISTS', 'A resource with that identifier already exists.')` with HTTP 409
   - `23503` (foreign key violation) → call `sendError(res, 'VALIDATION_FAILED', 'Referenced resource does not exist.')` with HTTP 400
   - `23502` (not-null violation) → call `sendError(res, 'REQUIRED_FIELD_MISSING', 'A required field was not provided.')` with HTTP 400
   - Any other PostgreSQL error code → call `sendError(res, 'INTERNAL_ERROR', 'An unexpected database error occurred.')` with HTTP 500
3. For all other errors (no recognized code), log the full error stack trace to console, then call `sendError(res, 'INTERNAL_ERROR', 'An internal server error occurred.')` with HTTP 500. Never expose internal error details (stack traces, SQL queries) to the client.

**Registration in src/server.js:**

Add requestLogger BEFORE all routes:
```javascript
app.use(requestLogger);
// ... routes ...
app.use(errorHandler); // MUST be last
```

Route handlers should propagate errors to the error handler by calling `next(err)` in catch blocks, or by throwing errors (which Express 5 catches automatically, but since we use Express 4.x, all route handlers must use explicit try/catch with next(err)).

**Files to create:** src/middleware/requestLogger.js, src/middleware/errorHandler.js
**Modify:** src/server.js to register both middleware

**Verification:**
- `POST /api/v2/ontologies` with valid body → two log lines appear in stdout (request_start and request_complete with `durationMs`)
- Insert a duplicate ontology name → response is `409` with `{"error":{"code":"ALREADY_EXISTS",...}}`
- Throw an unrecognized error in a route handler → response is `500` with `{"error":{"code":"INTERNAL_ERROR",...}}`, stack trace appears in server logs but NOT in the response body
- PostgreSQL not-null violation (e.g., missing display_name) → response is `400` with `{"error":{"code":"REQUIRED_FIELD_MISSING",...}}`
