# TASK 16: Request Logging Middleware

## Objective
Create a request logging middleware that logs every incoming HTTP request and its response, including timing information. This provides an audit trail of all API activity and helps diagnose performance issues. In Palantir, every API call is logged with full attribution — this is your equivalent.

## Exact Specification

Create a file at `/src/middleware/requestLogger.js` that exports the logging middleware.

The middleware must log TWO entries per request: one when the request arrives (with method, path, and headers) and one when the response is sent (with status code and duration). This dual-logging pattern is important because if the server crashes during request processing, you still have the incoming request log.

**Request log entry (logged immediately when request arrives):**
```json
{
  "type": "request",
  "timestamp": "2025-03-16T15:30:00.123Z",
  "requestId": "req-a1b2c3d4",
  "method": "POST",
  "path": "/api/v1/objects/Employee/search",
  "query": {},
  "headers": {
    "content-type": "application/json",
    "user-agent": "curl/7.88.1",
    "x-request-id": "client-provided-id"
  },
  "ip": "192.168.1.100",
  "bodySize": 256
}
```

**Response log entry (logged when response is sent):**
```json
{
  "type": "response",
  "timestamp": "2025-03-16T15:30:00.189Z",
  "requestId": "req-a1b2c3d4",
  "method": "POST",
  "path": "/api/v1/objects/Employee/search",
  "statusCode": 200,
  "durationMs": 66,
  "responseSize": 4523
}
```

**Implementation:**

```javascript
const { v4: uuidv4 } = require('uuid');

function requestLogger(req, res, next) {
  // Generate or use provided request ID
  const requestId = req.headers['x-request-id'] || `req-${uuidv4().substring(0, 8)}`;
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  
  const startTime = process.hrtime.bigint();
  
  // Log incoming request
  const requestLog = {
    type: 'request',
    timestamp: new Date().toISOString(),
    requestId,
    method: req.method,
    path: req.originalUrl,
    query: req.query,
    headers: sanitizeHeaders(req.headers),
    ip: req.ip || req.socket.remoteAddress,  // Note: req.connection is deprecated in Node.js; use req.socket
    bodySize: req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0,
  };
  
  console.log(JSON.stringify(requestLog));
  
  // Capture response completion
  const originalEnd = res.end;
  let responseSize = 0;
  
  res.end = function(chunk, encoding) {
    if (chunk) {
      responseSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    }
    
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;
    
    const responseLog = {
      type: 'response',
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      responseSize,
    };
    
    console.log(JSON.stringify(responseLog));
    
    // Log slow requests as warnings
    if (durationMs > 1000) {
      console.warn(JSON.stringify({
        type: 'slow_request',
        requestId,
        path: req.originalUrl,
        durationMs: Math.round(durationMs),
        message: `Request took ${Math.round(durationMs)}ms (threshold: 1000ms)`
      }));
    }
    
    originalEnd.call(this, chunk, encoding);
  };
  
  next();
}

function sanitizeHeaders(headers) {
  // Remove sensitive headers from logs
  const sanitized = { ...headers };
  delete sanitized.authorization;  // NEVER log auth tokens
  delete sanitized.cookie;         // NEVER log cookies
  delete sanitized['x-api-key'];   // NEVER log API keys
  return sanitized;
}
```

**Critical rules:**
1. NEVER log the request body. Request bodies can contain sensitive data (PII, passwords, financial data). Log only the body SIZE.
2. NEVER log authorization headers, cookies, or API keys. The `sanitizeHeaders` function must strip these.
3. Use structured JSON logging (not plain text). This enables log aggregation tools (ELK, Loki, CloudWatch) to parse and index the fields.
4. Log slow requests (>1000ms) as warnings for easy filtering.
5. The `X-Request-Id` response header allows clients to correlate their request with server-side logs.
6. Use `process.hrtime.bigint()` for timing, NOT `Date.now()`. `hrtime` provides nanosecond precision and is monotonic (not affected by system clock adjustments). `Date.now()` can jump forward or backward if NTP adjusts the clock.

**Health check endpoint exclusion:** If health check endpoints (`/api/v1/health`) generate excessive log volume, you may add a condition to skip logging for those paths. For week 1, log all requests including health checks.

Register this middleware in `server.js` BEFORE all route handlers (it must see every request):
```javascript
app.use(requestLogger);  // FIRST
app.use(express.json({ limit: '10mb' }));  // Parse JSON bodies
app.use('/api/v1', routes);  // Routes
app.use(errorHandler);  // Error handler LAST
```

## Verification
1. Make a GET request → verify both request and response log entries appear in stdout
2. Make a POST request → verify bodySize is logged but body content is NOT logged
3. Send a request with Authorization header → verify it does NOT appear in logs
4. Make a slow request (add artificial delay) → verify slow_request warning appears
5. Send a request with X-Request-Id header → verify the same ID appears in both log entries and in the X-Request-Id response header
6. Verify log entries are valid JSON (parseable by JSON.parse)
7. Verify durationMs is a positive number with reasonable precision
