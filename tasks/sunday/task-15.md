# TASK 15: Global Error Handler Middleware

This task has two sub-tasks.

## Objective
Create a centralized Express.js error handling middleware that catches all unhandled errors from route handlers and returns consistent, well-structured error responses. This replaces ad-hoc try/catch blocks in individual route handlers with a clean, uniform error handling pattern.

## Exact Specification

Create a file at `/src/middleware/errorHandler.js` that exports two things:

## Sub-task 15A: Create Error Classes, Error Handler Middleware, and asyncHandler Utility

**1. Custom Error Classes**

Create a hierarchy of custom error classes that route handlers can throw. Each class maps to a specific HTTP status code and error response shape:

```javascript
class AppError extends Error {
  constructor(code, message, statusCode, details = null) {
    super(message);
    this.code = code;           // e.g., "NOT_FOUND", "ALREADY_EXISTS"
    this.statusCode = statusCode; // e.g., 404, 409
    this.details = details;      // optional object with additional context
    this.name = this.constructor.name;
  }
}

class NotFoundError extends AppError {
  constructor(message, details = null) {
    super('NOT_FOUND', message, 404, details);
  }
}

class AlreadyExistsError extends AppError {
  constructor(message, details = null) {
    super('ALREADY_EXISTS', message, 409, details);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

class InvalidParameterError extends AppError {
  constructor(message, details = null) {
    super('INVALID_PARAMETER', message, 400, details);
  }
}

class ConflictError extends AppError {
  constructor(message, details = null) {
    super('CONFLICT', message, 409, details);
  }
}

class LimitExceededError extends AppError {
  constructor(message, details = null) {
    super('LIMIT_EXCEEDED', message, 400, details);
  }
}

class InternalError extends AppError {
  constructor(message, details = null) {
    super('INTERNAL_ERROR', message, 500, details);
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message, details = null) {
    super('SERVICE_UNAVAILABLE', message, 503, details);
  }
}
```

**2. Error Handler Middleware**

```javascript
function errorHandler(err, req, res, next) {
  // Log the error with full context
  const logEntry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    errorName: err.name,
    errorCode: err.code || 'UNKNOWN',
    errorMessage: err.message,
    statusCode: err.statusCode || 500,
    requestId: req.headers['x-request-id'] || null,
    // Include stack trace ONLY in development, NEVER in production
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  };
  
  console.error(JSON.stringify(logEntry));
  
  // Handle known application errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      }
    });
  }
  
  // Handle PostgreSQL-specific errors
  if (err.code && typeof err.code === 'string' && err.code.length === 5) {
    // PostgreSQL error codes are 5-character strings
    return handlePostgresError(err, req, res);
  }
  
  // Handle OpenSearch-specific errors
  if (err.meta && err.meta.statusCode) {
    return handleOpenSearchError(err, req, res);
  }
  
  // Handle JSON parse errors (malformed request body)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body contains invalid JSON',
        details: { parseError: err.message }
      }
    });
  }
  
  // Handle payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds the maximum size of ${err.limit} bytes`,
      }
    });
  }
  
  // Unknown errors — return 500 with generic message
  // NEVER expose internal error details to the client in production
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'An internal error occurred. Please try again later.'
        : err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    }
  });
}
```

**PostgreSQL error handler:**
```javascript
function handlePostgresError(err, req, res) {
  switch (err.code) {
    case '23505': // unique_violation
      return res.status(409).json({
        error: {
          code: 'ALREADY_EXISTS',
          message: 'A resource with this identifier already exists',
          details: { constraint: err.constraint, detail: err.detail }
        }
      });
    case '23503': // foreign_key_violation
      return res.status(400).json({
        error: {
          code: 'REFERENCE_NOT_FOUND',
          message: 'A referenced resource does not exist',
          details: { constraint: err.constraint, detail: err.detail }
        }
      });
    case '23502': // not_null_violation
      return res.status(400).json({
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: `Required field '${err.column}' is missing`,
          details: { column: err.column, table: err.table }
        }
      });
    case '23514': // check_violation
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'A value failed a validation constraint',
          details: { constraint: err.constraint }
        }
      });
    case '42P01': // undefined_table
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Database schema error. Please contact support.'
        }
      });
    default:
      return res.status(500).json({
        error: {
          code: 'DATABASE_ERROR',
          message: process.env.NODE_ENV === 'production'
            ? 'A database error occurred'
            : `PostgreSQL error ${err.code}: ${err.message}`
        }
      });
  }
}
```

**OpenSearch error handler:**
```javascript
function handleOpenSearchError(err, req, res) {
  const osStatus = err.meta.statusCode;
  
  switch (osStatus) {
    case 404:
      // Index not found — means the Object Type hasn't been indexed yet
      return res.status(404).json({
        error: {
          code: 'INDEX_NOT_FOUND',
          message: 'This Object Type has not been indexed yet. Trigger indexing first.',
          details: { index: err.meta.meta?.request?.params?.index }
        }
      });
    case 400:
      // Bad query — usually means the query DSL is malformed
      return res.status(400).json({
        error: {
          code: 'INVALID_QUERY',
          message: 'The search query is invalid',
          details: {
            reason: err.meta.body?.error?.reason,
            type: err.meta.body?.error?.type
          }
        }
      });
    case 503:
      return res.status(503).json({
        error: {
          code: 'SEARCH_UNAVAILABLE',
          message: 'The search service is temporarily unavailable. Please try again.'
        }
      });
    default:
      return res.status(502).json({
        error: {
          code: 'SEARCH_ERROR',
          message: process.env.NODE_ENV === 'production'
            ? 'An error occurred while searching'
            : `OpenSearch error ${osStatus}: ${JSON.stringify(err.meta.body?.error)}`
        }
      });
  }
}
```

**3. Register the middleware in server.js**

The error handler MUST be registered AFTER all route handlers:
```javascript
// Routes
app.use('/api/v2', ontologyRoutes);
app.use('/api/v2', objectTypeRoutes);
// ... all other routes

// Error handler (MUST be last)
app.use(errorHandler);
```

---

## Sub-task 15B: Refactor All Existing Route Handlers to Use Error Handler

**Depends on:** Sub-task 15A

This is a codebase-wide refactoring step. The following route files must be updated:
- `/src/routes/ontology.js`
- `/src/routes/objectTypes.js`
- `/src/routes/datasources.js`
- `/src/routes/queries.js`
- `/src/routes/links.js`
- `/src/routes/actions.js`
- `/src/routes/interfaces.js` (if created by Tasks 2-4)

**Acceptance criteria:** Zero instances of `res.status(4xx).json({ error:` or `res.status(5xx).json({ error:` remain in any route file. All async handlers use `asyncHandler()`.

**4. Update all existing route handlers**

Go through EVERY existing route handler in the codebase and:
- Remove try/catch blocks that manually construct error responses
- Replace `res.status(404).json({...})` with `throw new NotFoundError("...")`
- Replace `res.status(400).json({...})` with `throw new ValidationError("...")`
- Replace `res.status(409).json({...})` with `throw new AlreadyExistsError("...")`
- Wrap async route handlers with an async error wrapper to ensure thrown errors reach the middleware:

```javascript
// Helper to wrap async route handlers
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Usage:
router.get('/objects/:objectType/:pk', asyncHandler(async (req, res) => {
  const object = await fetchObject(req.params.objectType, req.params.pk);
  if (!object) throw new NotFoundError(`Object '${req.params.pk}' not found`);
  res.json({ data: object });
}));
```

Without the `asyncHandler` wrapper, thrown errors in async functions will result in unhandled promise rejections instead of reaching the error middleware. This is a critical pattern — EVERY async route handler MUST use it.

The `asyncHandler` utility function must be exported from `/src/middleware/errorHandler.js` alongside the error classes and the `errorHandler` middleware.

## Verification
1. Throw a NotFoundError from a route handler → verify 404 with correct JSON shape
2. Throw a ValidationError → verify 400 with correct JSON shape
3. Send malformed JSON in request body → verify 400 INVALID_JSON
4. Trigger a PostgreSQL unique violation → verify 409 ALREADY_EXISTS
5. Query a non-existent OpenSearch index → verify 404 INDEX_NOT_FOUND
6. Throw an unknown Error → verify 500 with generic message in production mode
7. Verify stack trace appears in development mode but NOT in production mode
8. Verify ALL existing route handlers have been updated to use throw instead of manual res.status()
9. Verify ALL async route handlers use the asyncHandler wrapper
10. Verify error log entries contain timestamp, method, path, and error details
