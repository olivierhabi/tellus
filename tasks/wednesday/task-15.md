# TASK 15: Create the Error Handling System

**Dependencies:** None (foundational task consumed by all other tasks).

This task creates two files:
- `/src/utils/errors.js` — Error class hierarchy
- `/src/middleware/errorHandler.js` — Express error middleware and async handler wrapper

---

## Part A: Error Class Hierarchy

**File to create:** `/src/utils/errors.js`

Create a base class `OntologyError` that extends `Error` with additional fields: `code` (string), `statusCode` (number), and `details` (object). Then create specific subclasses for each error type. Each subclass sets its own `code` and `statusCode`.

**Error classes (10 total — 1 base class + 9 subclasses):**

1. `OntologyError` — Base class. Constructor: `(message, code, statusCode, details = {})`. Sets `this.name`, `this.code`, `this.statusCode`, `this.details`.

2. `ObjectTypeNotFoundError` — statusCode: 404, code: `"OBJECT_TYPE_NOT_FOUND"`. Constructor: `(objectType, availableTypes)`. Message: `"Object type '${objectType}' not found. Available types: ${availableTypes.join(', ')}."`. Details: `{ objectType, availableTypes }`.

3. `ObjectNotFoundError` — statusCode: 404, code: `"OBJECT_NOT_FOUND"`. Constructor: `(objectType, primaryKey)`. Message: `"Object '${primaryKey}' not found in object type '${objectType}'."`. Details: `{ objectType, primaryKey }`.

4. `PropertyNotFoundError` — statusCode: 400, code: `"PROPERTY_NOT_FOUND"`. Constructor: `(property, objectType, validProperties)`. Message must include a "did you mean?" suggestion if a valid property name is within Levenshtein edit distance 2 of the requested name. Sort suggestions by distance (closest first), include at most 3 suggestions. Example: `"Property 'deparment' not found on object type 'Employee'. Did you mean: department?"`. If no suggestion within distance 2: `"Property 'xyz' not found on object type 'Employee'. Valid properties: employeeId, fullName, email, ..."`. Details: `{ property, objectType, validProperties, suggestions }`.

5. `QueryValidationError` — statusCode: 400, code: `"INVALID_QUERY"`. Constructor: `(message, field = null)`. Details: `{ field }`.

6. `IncompatibleFilterError` — statusCode: 400, code: `"INCOMPATIBLE_FILTER"`. Constructor: `(filterType, property, propertyType)`. Message: `"Filter '${filterType}' is not compatible with property '${property}' of type '${propertyType}'."`. Details: `{ filterType, property, propertyType }`.

7. `PageTokenError` — statusCode: 400, code: `"INVALID_PAGE_TOKEN"`. Constructor: `(reason)`. Message: `"Invalid page token: ${reason}."`. Details: `{ reason }`.

8. `ObjectDatabaseUnavailableError` — statusCode: 503, code: `"OBJECT_DATABASE_UNAVAILABLE"`. Constructor: `(message = "OpenSearch is currently unavailable. Please try again.")`. Details: `{}`.

9. `MetadataStoreUnavailableError` — statusCode: 503, code: `"METADATA_STORE_UNAVAILABLE"`. Constructor: `(message = "PostgreSQL is currently unavailable. Please try again.")`. Details: `{}`.

10. `AggregationError` — statusCode: 400, code: `"INVALID_AGGREGATION"`. Constructor: `(message)`. Details: `{}`.

**Levenshtein distance function:** Include as a private (non-exported) function in this file:

```javascript
function levenshteinDistance(a, b) {
  // Standard dynamic programming implementation
  // Returns the edit distance (integer) between strings a and b
}
```

Used only by `PropertyNotFoundError`'s constructor.

**Export:** `{ OntologyError, ObjectTypeNotFoundError, ObjectNotFoundError, PropertyNotFoundError, QueryValidationError, IncompatibleFilterError, PageTokenError, ObjectDatabaseUnavailableError, MetadataStoreUnavailableError, AggregationError }`

---

## Part B: Error Handling Middleware and Async Handler

**File to create:** `/src/middleware/errorHandler.js`

**Function 1: `errorHandler(err, req, res, next)`**

Express 4-parameter error middleware. Handles three categories of errors:

1. **Custom `OntologyError` subclasses** — Use `err.statusCode` and `err.code`:
   ```javascript
   if (err instanceof OntologyError) {
     return res.status(err.statusCode).json({
       error: {
         code: err.code,
         message: err.message,
         details: err.details || {}
       }
     });
   }
   ```

2. **OpenSearch client errors** — Detected by `err.meta && err.meta.statusCode`:
   - OpenSearch 404 where the index does not exist (detected by `err.meta.body && err.meta.body.error && err.meta.body.error.type === "index_not_found_exception"`): wrap as `ObjectTypeNotFoundError`
   - OpenSearch 404 for a missing document (not an index error): wrap as `ObjectNotFoundError`
   - OpenSearch 400 (bad query): wrap as `QueryValidationError` with message from `err.meta.body.error.reason`
   - OpenSearch connection refused / timeout (`err.name === "ConnectionError"` or `err.name === "TimeoutError"`): wrap as `ObjectDatabaseUnavailableError`
   - All other OpenSearch errors: wrap as `ObjectDatabaseUnavailableError` with the OpenSearch status code in details

3. **Unknown errors** — Return 500 with no internal details:
   ```javascript
   console.error('[UNHANDLED ERROR]', err);
   return res.status(500).json({
     error: {
       code: "INTERNAL_ERROR",
       message: "An unexpected error occurred. Please try again or contact support.",
       details: {}
     }
   });
   ```
   Never expose stack traces or internal error messages to the client.

**Function 2: `asyncHandler(fn)`**

Wraps an async Express route handler so rejected promises are forwarded to `next()`:

```javascript
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
```

Every route handler must be wrapped with this: `router.get('/objects/:objectType', asyncHandler(async (req, res) => { ... }))`.

**Export:** `{ errorHandler, asyncHandler }`

**Registration in `server.js`:** Add `app.use(errorHandler)` AFTER all routes. This is the last middleware registered.

---

## Acceptance criteria:

1. `new PropertyNotFoundError("deparment", "Employee", ["department", "employeeId"])` produces message containing `"Did you mean: department?"`.
2. `new PropertyNotFoundError("xyz", "Employee", ["department", "employeeId"])` produces message with no suggestion (edit distance > 2), lists valid properties instead.
3. `new ObjectTypeNotFoundError("Employe", ["Employee", "Company"])` produces message `"Object type 'Employe' not found. Available types: Employee, Company."`.
4. Throwing `ObjectTypeNotFoundError` in a route handler wrapped with `asyncHandler` produces HTTP 404 with `{ error: { code: "OBJECT_TYPE_NOT_FOUND", ... } }`.
5. An OpenSearch connection error produces HTTP 503 with `OBJECT_DATABASE_UNAVAILABLE`.
6. An unexpected `TypeError` produces HTTP 500 with `INTERNAL_ERROR` and no stack trace in the response body (stack trace logged to console only).
7. All error classes are importable from `/src/utils/errors.js`.
8. Both `errorHandler` and `asyncHandler` are importable from `/src/middleware/errorHandler.js`.
