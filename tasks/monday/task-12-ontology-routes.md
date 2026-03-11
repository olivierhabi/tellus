# TASK 12 OF 30: Ontology Routes (Express Router)

**Objective:** Create the Express router that handles HTTP requests for Ontology CRUD operations and delegates to the ontology service. Routes validate input, call the service, format the response, and handle errors.

**Step-by-step instructions:**

Create src/routes/ontology.js. Import Express Router, ontologyService (Task 11), and response formatter utilities (Task 9).

**Route 1: POST /api/v2/ontologies**

Create a new ontology. Input validation is handled by `validateBody` middleware (Task 19) using `CREATE_ONTOLOGY_SCHEMA`. The handler:
1. Extract `displayName` and `description` from `req.body`.
2. Call `ontologyService.create({displayName, description, createdBy: req.user?.id || 'system'})`.
3. Format using `formatOntology(row, 0)` (new ontology has 0 object types).
4. Return with `sendCreated(res, formatted)`.
5. Catch: if `err.code === 'ONTOLOGY_ALREADY_EXISTS'`, call `sendError(res, 'ONTOLOGY_ALREADY_EXISTS', err.message)`. Otherwise, `next(err)`.

**Route 2: GET /api/v2/ontologies**

List all ontologies with pagination.
1. Extract `pageSize` from `req.query` — parse as integer, default 100, clamp to 1–1000.
2. Extract `pageToken` from `req.query` — string or undefined.
3. Call `ontologyService.list({pageSize, pageToken})`.
4. Format each ontology: `formatOntology(row, row.object_type_count)`.
5. Return with `sendSuccess(res, {data: formatted, totalCount: result.totalCount, pageSize: result.pageSize, nextPageToken: result.nextPageToken})`.

**Route 3: GET /api/v2/ontologies/:ontologyId**

Get a single ontology.
1. Extract `ontologyId` from `req.params`.
2. Validate UUID format: regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. If invalid, call `sendError(res, 'INVALID_PARAMETER', "ontologyId must be a valid UUID.")` and return.
3. Call `ontologyService.getById(ontologyId)`.
4. Format using `formatOntology(result, result.objectTypeCount)`.
5. Return with `sendSuccess(res, formatted)`.
6. Catch: if `err.code === 'ONTOLOGY_NOT_FOUND'`, call `sendError(res, 'ONTOLOGY_NOT_FOUND', err.message)`. Otherwise, `next(err)`.

**Route 4: PUT /api/v2/ontologies/:ontologyId**

Update an ontology.
1. Extract `ontologyId` from `req.params`.
2. Extract `displayName` and `description` from `req.body`. At least one must be provided; if neither is present, call `sendError(res, 'VALIDATION_FAILED', "At least one field (displayName or description) must be provided.")` and return.
3. Call `ontologyService.update(ontologyId, {displayName, description})`.
4. Format using `formatOntology(result, null)` — objectTypeCount is not re-fetched on update; pass null and let the formatter omit it or re-query.
5. Return with `sendSuccess(res, formatted)`.
6. Catch: handle `ONTOLOGY_NOT_FOUND` and `ONTOLOGY_ALREADY_EXISTS` with `sendError`. Otherwise, `next(err)`.

**Route 5: DELETE /api/v2/ontologies/:ontologyId**

Delete an ontology (cascades all child resources).
1. Extract `ontologyId` from `req.params`.
2. Call `ontologyService.delete(ontologyId)`.
3. Return with `sendNoContent(res)`.
4. Catch: handle `ONTOLOGY_NOT_FOUND`. Otherwise, `next(err)`.

**Error handling pattern:**

All route handlers are wrapped in try/catch. The catch block checks `err.code` against known error codes and uses `sendError`. Unknown errors are passed to `next(err)` for the global error handler (Task 10).

**Registration in src/server.js:**
```javascript
const ontologyRouter = require('./routes/ontology');
app.use(ontologyRouter);
```

**Files to create:** src/routes/ontology.js
**Modify:** src/server.js to mount the router

**Verification:**
- `curl -X POST http://localhost:3000/api/v2/ontologies -H 'Content-Type: application/json' -d '{"displayName":"Test"}'` → 201 with ontologyId
- `curl http://localhost:3000/api/v2/ontologies` → 200 with data array
- `curl http://localhost:3000/api/v2/ontologies/{id}` → 200 with single ontology
- `curl -X PUT http://localhost:3000/api/v2/ontologies/{id} -H 'Content-Type: application/json' -d '{"displayName":"Updated"}'` → 200
- `curl -X PUT` with empty body → 400 with VALIDATION_FAILED
- `curl -X DELETE http://localhost:3000/api/v2/ontologies/{id}` → 204
- `curl http://localhost:3000/api/v2/ontologies/{id}` after delete → 404
