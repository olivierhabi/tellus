# TASK 14 OF 30: Object Type Routes

**Objective:** Create Express routes for Object Type CRUD operations. All routes are nested under an ontology: `/api/v1/ontology/:ontologyId/objectTypes`.

**Step-by-step instructions:**

Create src/routes/objectTypes.js. Use Express Router with `{mergeParams: true}` to access `:ontologyId` from the parent router.

**Route 1: POST /api/v1/ontology/:ontologyId/objectTypes**

Create a new object type. Input validation is handled by `validateBody` middleware (Task 19) using `CREATE_OBJECT_TYPE_SCHEMA`. Call `objectTypeService.create(req.params.ontologyId, req.body)`. Format the response using `formatObjectType` from Task 9 (pass the created row, empty properties array `[]`, `null` for datasource, and the created funnelState row). Return HTTP 201 with the formatted response using `sendCreated(res, formatted)`.

**Route 2: GET /api/v1/ontology/:ontologyId/objectTypes**

List object types with pagination. Extract `pageSize` (integer, default 100, clamp to range 1–1000) and `pageToken` (string or null) from `req.query`. Call `objectTypeService.listByOntology(ontologyId, {pageSize, pageToken})`. Format each row using `formatObjectTypeSummary(row, row.property_count, row.datasource_name, row.index_status)`. Return HTTP 200 with `sendSuccess(res, {data: formatted, totalCount, pageSize, nextPageToken})`.

**Route 3: GET /api/v1/ontology/:ontologyId/objectTypes/:apiName**

Get a single object type with full details. Validate `:apiName` is a non-empty string (no regex needed — PascalCase validation is the service layer's responsibility). Call `objectTypeService.getByApiName(ontologyId, apiName)`. Format using `formatObjectType(result.objectType, result.properties, result.datasource, result.funnelState)`. Return HTTP 200 with `sendSuccess(res, formatted)`.

**Route 4: PUT /api/v1/ontology/:ontologyId/objectTypes/:apiName**

Update an object type. Updatable fields: `displayName` (string, 1–256 chars), `description` (string or null), `icon` (string), `iconColor` (string), `status` (one of 'active', 'experimental', 'deprecated'). At least one field must be provided in the request body; if none are provided, return HTTP 400 with `VALIDATION_FAILED` and message "At least one field must be provided for update." Call `objectTypeService.update(ontologyId, apiName, req.body)`. Format using `formatObjectType`. Return HTTP 200 with `sendSuccess(res, formatted)`.

**Route 5: DELETE /api/v1/ontology/:ontologyId/objectTypes/:apiName**

Delete an object type with cascade. Call `objectTypeService.delete(ontologyId, apiName)`. Return HTTP 204 using `sendNoContent(res)`.

**Error handling pattern for all routes:**

Wrap every route handler in try/catch. In the catch block, if `err.code` matches a known error code (OBJECT_TYPE_NOT_FOUND, OBJECT_TYPE_ALREADY_EXISTS, INVALID_API_NAME, VALIDATION_FAILED, ONTOLOGY_NOT_FOUND), call `sendError(res, err.code, err.message)`. Otherwise, call `next(err)` to pass to the global error handler (Task 10).

**Registration in src/server.js:**
```javascript
const objectTypeRouter = require('./routes/objectTypes');
app.use('/api/v1/ontology/:ontologyId/objectTypes', objectTypeRouter);
```

**Files to create:** src/routes/objectTypes.js
**Modify:** src/server.js to mount the router

**Verification:**
- `POST /api/v1/ontology/:id/objectTypes` with valid body → 201 with formatted object type including empty properties and null datasource/funnelState
- `POST` with duplicate apiName → 409 with OBJECT_TYPE_ALREADY_EXISTS
- `GET /api/v1/ontology/:id/objectTypes` → 200 with paginated list, each item has property_count
- `GET /api/v1/ontology/:id/objectTypes?pageSize=2` → 200 with at most 2 items and nextPageToken if more exist
- `GET /api/v1/ontology/:id/objectTypes/Employee` → 200 with full object type including properties object, datasource, indexingState
- `GET` with non-existent apiName → 404 with OBJECT_TYPE_NOT_FOUND
- `PUT` with `{"displayName":"New Name"}` → 200 with updated displayName
- `PUT` with empty body → 400 with VALIDATION_FAILED
- `DELETE /api/v1/ontology/:id/objectTypes/Employee` → 204
