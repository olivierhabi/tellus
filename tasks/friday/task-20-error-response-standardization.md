# TASK 20: Build Error Response Standardization Module

**Objective:** Create a centralized error handling module that ensures all error responses across all endpoints follow the same consistent format. This is important because the OSDK (which will be built in a later week) relies on predictable error response shapes to display errors to users. Palantir's API returns consistent error objects with specific fields.

**Create the module** at `src/middleware/errorHandler.js`.

**Define the standard error response format:**

```json
{
    "errorCode": "INVALID_PARAMETER",
    "errorName": "InvalidParameterError",
    "errorInstanceId": "uuid-unique-to-this-error-instance",
    "parameters": {
        "parameterName": "salary",
        "reason": "Value -500 is below minimum 0"
    },
    "message": "Parameter 'salary' is invalid: Value -500 is below minimum 0"
}
```

**Define all error codes** used by the Action system (and the broader API):

```javascript
const ERROR_CODES = {
    // Action-specific errors (from Palantir's documented failure types)
    INVALID_PARAMETER: { status: 400, name: 'InvalidParameterError' },
    SCALE_LIMIT_EXCEEDED: { status: 400, name: 'ScaleLimitExceededError' },
    AUTHENTICATION_FAILURE: { status: 403, name: 'AuthenticationError' },
    OBJECT_NOT_FOUND: { status: 404, name: 'ObjectNotFoundError' },
    DUPLICATE_PRIMARY_KEY: { status: 409, name: 'DuplicatePrimaryKeyError' },
    REQUIRED_PROPERTY_MISSING: { status: 400, name: 'RequiredPropertyMissingError' },
    TYPE_MISMATCH: { status: 400, name: 'TypeMismatchError' },
    SIDE_EFFECT_FAILURE: { status: 502, name: 'SideEffectFailureError' },
    FUNCTION_FAILURE: { status: 500, name: 'FunctionFailureError' },
    
    // General API errors
    NOT_FOUND: { status: 404, name: 'NotFoundError' },
    CONFLICT: { status: 409, name: 'ConflictError' },
    VALIDATION_ERROR: { status: 400, name: 'ValidationError' },
    INTERNAL_ERROR: { status: 500, name: 'InternalError' },
    ACTION_DISABLED: { status: 400, name: 'ActionDisabledError' },
    ACTION_TYPE_NOT_FOUND: { status: 404, name: 'ActionTypeNotFoundError' },
    OBJECT_TYPE_NOT_FOUND: { status: 404, name: 'ObjectTypeNotFoundError' },
    LINK_TYPE_NOT_FOUND: { status: 404, name: 'LinkTypeNotFoundError' },
    PROPERTY_NOT_FOUND: { status: 404, name: 'PropertyNotFoundError' },
    INDEX_ERROR: { status: 500, name: 'IndexError' },
};
```

**Create an `OntologyError` class:**

```javascript
class OntologyError extends Error {
    constructor(errorCode, message, parameters = {}) {
        super(message);
        this.errorCode = errorCode;
        this.errorName = ERROR_CODES[errorCode]?.name || 'UnknownError';
        this.statusCode = ERROR_CODES[errorCode]?.status || 500;
        this.errorInstanceId = generateUUID();
        this.parameters = parameters;
    }

    toResponse() {
        return {
            errorCode: this.errorCode,
            errorName: this.errorName,
            errorInstanceId: this.errorInstanceId,
            parameters: this.parameters,
            message: this.message
        };
    }
}
```

**Create Express error handler middleware:**

```javascript
function errorHandler(err, req, res, next) {
    if (err instanceof OntologyError) {
        console.error(`[${err.errorCode}] ${err.message} (${err.errorInstanceId})`);
        return res.status(err.statusCode).json(err.toResponse());
    }

    // Unhandled errors
    const instanceId = generateUUID();
    console.error(`[INTERNAL_ERROR] Unhandled: ${err.message} (${instanceId})`, err.stack);
    return res.status(500).json({
        errorCode: 'INTERNAL_ERROR',
        errorName: 'InternalError',
        errorInstanceId: instanceId,
        parameters: {},
        message: 'An internal error occurred. Reference ID: ' + instanceId
    });
}
```

Register the middleware LAST in `src/server.js` (after all route definitions):
```javascript
app.use(errorHandler);
```

**Update the following specific route handlers** to use `OntologyError` instead of ad-hoc error responses:
1. `src/routes/actionTypes.js` (Task 4 CRUD endpoints) — replace ad-hoc 400/404/409 responses
2. `src/routes/actions.js` (Task 8 apply endpoint, Task 19 validate endpoint) — replace error responses
3. `src/actions/actionExecutor.js` (Task 8 orchestrator) — throw OntologyError for each failure type

For example, in the action type CRUD routes (Task 4):

```javascript
// BEFORE (ad-hoc):
if (!actionType) return res.status(404).json({ error: 'Not found' });

// AFTER (standardized):
if (!actionType) throw new OntologyError('ACTION_TYPE_NOT_FOUND', 
    `Action type '${apiName}' not found in ontology '${ontologyId}'`,
    { actionTypeApiName: apiName, ontologyId });
```

**Also update the action executor** (Task 8) to throw `OntologyError` instances:

```javascript
// In the executor, when parameter validation fails:
if (!validation.valid) {
    throw new OntologyError('INVALID_PARAMETER', validation.errors.join('; '),
        { errors: validation.errors });
}

// When object not found:
throw new OntologyError('OBJECT_NOT_FOUND',
    `Object '${pk}' of type '${objectType}' not found`,
    { objectType, primaryKey: pk });
```

**Request logging middleware** (add before routes in `src/server.js`):

This is a simple middleware that assigns a unique `requestId` to each request and logs the method, URL, status code, and duration when the response finishes. It is included in this task because the `requestId` is used by the error handler to correlate error responses with request logs.

```javascript
function requestLogger(req, res, next) {
    const start = Date.now();
    const requestId = generateUUID();
    req.requestId = requestId;

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
        console.log(`[${logLevel}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms) [${requestId}]`);
    });

    next();
}
app.use(requestLogger);
```

**Test the standardized errors:**
```javascript
// Test 404 action type
const res = await fetch('/api/v1/actions/nonExistent/apply', { method: 'POST', body: '{"parameters":{}}' });
assert(res.status === 404);
const err = await res.json();
assert(err.errorCode === 'ACTION_TYPE_NOT_FOUND');
assert(err.errorInstanceId !== undefined);

// Test 400 invalid parameter
const res2 = await fetch('/api/v1/actions/updateSalary/apply', { method: 'POST', body: '{"parameters":{"salary":"not-a-number"}}' });
assert(res2.status === 400);
const err2 = await res2.json();
assert(err2.errorCode === 'INVALID_PARAMETER');

// Test 409 duplicate PK
const res3 = await fetch('/api/v1/actions/createEmployee/apply', { method: 'POST',
    body: JSON.stringify({ parameters: { employeeId: 'EMP-001', fullName: 'Duplicate' } }) });
assert(res3.status === 409);
const err3 = await res3.json();
assert(err3.errorCode === 'DUPLICATE_PRIMARY_KEY');
```
