# TASK 21: Graceful Shutdown Handler

## Objective
Implement a graceful shutdown mechanism that properly closes all connections (PostgreSQL pool, OpenSearch client) when the server receives a termination signal. Without this, the server can leave open connections, corrupt in-progress indexing operations, and cause data inconsistency. In production Kubernetes environments, graceful shutdown is mandatory — the pod receives SIGTERM and has 30 seconds to finish in-progress requests before being forcefully killed with SIGKILL.

## Exact Specification

Add shutdown handling to `server.js`:

```javascript
const server = app.listen(PORT, () => {
  console.log(JSON.stringify({
    type: 'server_start',
    timestamp: new Date().toISOString(),
    port: PORT,
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
  }));
});

// Track in-progress requests
let activeRequests = 0;
let isShuttingDown = false;

app.use((req, res, next) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Server is shutting down' }
    });
  }
  activeRequests++;
  res.on('finish', () => { activeRequests--; });
  next();
});

async function gracefulShutdown(signal) {
  console.log(JSON.stringify({
    type: 'shutdown_initiated',
    timestamp: new Date().toISOString(),
    signal,
    activeRequests,
  }));
  
  isShuttingDown = true;
  
  // Stop accepting new connections
  server.close(() => {
    console.log(JSON.stringify({ type: 'server_closed', timestamp: new Date().toISOString() }));
  });
  
  // Wait for in-progress requests to complete (max 25 seconds)
  const maxWait = 25000;
  const startWait = Date.now();
  while (activeRequests > 0 && (Date.now() - startWait) < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(JSON.stringify({ type: 'shutdown_waiting', activeRequests, elapsed: Date.now() - startWait }));
  }
  
  if (activeRequests > 0) {
    console.warn(JSON.stringify({ type: 'shutdown_forced', activeRequests, message: 'Forcing shutdown with active requests' }));
  }
  
  // Close database connections
  try {
    await pool.end();
    console.log(JSON.stringify({ type: 'postgresql_disconnected' }));
  } catch (err) {
    console.error(JSON.stringify({ type: 'postgresql_disconnect_error', error: err.message }));
  }
  
  // Close OpenSearch client
  try {
    await opensearchClient.close();
    console.log(JSON.stringify({ type: 'opensearch_disconnected' }));
  } catch (err) {
    console.error(JSON.stringify({ type: 'opensearch_disconnect_error', error: err.message }));
  }
  
  console.log(JSON.stringify({ type: 'shutdown_complete', timestamp: new Date().toISOString() }));
  process.exit(0);
}

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));  // Docker/K8s sends this
process.on('SIGINT', () => gracefulShutdown('SIGINT'));    // Ctrl+C in terminal

// Handle uncaught errors (last resort — should never happen if error handling is correct)
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    type: 'uncaught_exception',
    timestamp: new Date().toISOString(),
    error: err.message,
    stack: err.stack,
  }));
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({
    type: 'unhandled_rejection',
    timestamp: new Date().toISOString(),
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  }));
  // Don't shutdown for unhandled rejections — log and continue
  // In Node.js 15+, unhandled rejections crash the process by default.
  // We handle them here to log context before the crash.
});
```

The request-tracking middleware (the one that increments/decrements `activeRequests`) must be registered BEFORE all route handlers so it captures every request. The `isShuttingDown` check must also be early so new requests during shutdown get rejected immediately.

The 25-second timeout aligns with Kubernetes' default 30-second termination grace period — 25 seconds for cleanup, 5 seconds buffer before SIGKILL.

## Verification

**Important behavioral distinction:** `uncaughtException` triggers a graceful shutdown (the process is in an undefined state and must exit). `unhandledRejection` does NOT trigger shutdown — it only logs the error and continues. Verify this difference in tests 1 and 7.
1. Start the server, make a request, then send SIGTERM → verify clean shutdown log messages appear
2. Start a long-running request (e.g., a large indexing operation), send SIGTERM → verify the request completes before shutdown
3. Start the server, send SIGINT (Ctrl+C) → verify same clean shutdown
4. During shutdown, make a new request → verify 503 SERVICE_UNAVAILABLE
5. Verify PostgreSQL pool is closed (check pg pool stats)
6. Verify no "connection refused" errors appear in logs during shutdown
7. Trigger an unhandled promise rejection → verify it is logged but the server does NOT shut down (continues accepting requests)
