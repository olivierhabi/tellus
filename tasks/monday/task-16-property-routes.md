# TASK 16 OF 30: Property Routes

**Objective:** Create Express routes for Property CRUD, nested under object types at `/api/v2/ontologies/:ontologyId/objectTypes/:apiName/properties`.

**Step-by-step instructions:**

Create src/routes/properties.js with `{mergeParams: true}` to access `:ontologyId` and `:apiName` from parent routers.

**Helper: resolveObjectTypeId**

Before calling property service methods, resolve the object type ID from the route params. Query: `SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If not found, call `sendError(res, 'OBJECT_TYPE_NOT_FOUND', ...)` and return. Use this in every route handler.

**Route 1: POST .../properties**

Create a property. Input validation via `validateBody(CREATE_PROPERTY_SCHEMA)` from Task 19. Handler:
1. Resolve objectTypeId.
2. Call `propertyService.create(objectTypeId, req.body)`.
3. Format using `formatProperty`.
4. Return HTTP 201 with `sendCreated(res, formatted)`.

**Route 2: GET .../properties**

List all properties ordered by ordinal.
1. Resolve objectTypeId.
2. Call `propertyService.listByObjectType(objectTypeId)`.
3. Format each using `formatProperty`.
4. Return HTTP 200 with `sendSuccess(res, {data: formatted})`.

**Route 3: GET .../properties/:propApiName**

Get a single property.
1. Resolve objectTypeId.
2. Call `propertyService.getByApiName(objectTypeId, req.params.propApiName)`.
3. Format using `formatProperty`.
4. Return HTTP 200 with `sendSuccess(res, formatted)`.
5. If PROPERTY_NOT_FOUND, return HTTP 404.

**Route 4: PUT .../properties/:propApiName**

Update a property. Updatable fields: displayName, description, isRequired, ordinal. NOT updatable: apiName, baseType.
1. Resolve objectTypeId.
2. Call `propertyService.update(objectTypeId, req.params.propApiName, req.body)`.
3. Return HTTP 200 with formatted result.
4. If VALIDATION_FAILED (tried to change apiName/baseType), return HTTP 400.

**Route 5: DELETE .../properties/:propApiName**

Delete with service-layer checks (PK protection, title warning).
1. Resolve objectTypeId.
2. Call `propertyService.delete(objectTypeId, req.params.propApiName)`.
3. Return HTTP 204 with `sendNoContent(res)`.
4. If PROPERTY_NOT_FOUND, return HTTP 404. If VALIDATION_FAILED (PK property), return HTTP 400.

**Route 6: POST .../primaryKey**

Set the primary key property. Body: `{"propertyApiName": "employeeId"}`.
1. Resolve objectTypeId.
2. Validate `propertyApiName` is present in body. If missing, return HTTP 400 with `REQUIRED_FIELD_MISSING`.
3. Call `propertyService.setPrimaryKey(objectTypeId, req.body.propertyApiName)`.
4. Return HTTP 200 with `sendSuccess(res, {message: "Primary key set to '{propertyApiName}'."})`.

**Route 7: POST .../titleProperty**

Set the title property. Body: `{"propertyApiName": "fullName"}`.
1. Resolve objectTypeId.
2. Validate `propertyApiName` is present. If missing, return HTTP 400.
3. Call `propertyService.setTitleProperty(objectTypeId, req.body.propertyApiName)`.
4. Return HTTP 200 with `sendSuccess(res, {message: "Title property set to '{propertyApiName}'."})`.

**Error handling pattern:**

Same as Task 14: try/catch in every handler. Known error codes → `sendError`. Unknown → `next(err)`.

**Registration in src/server.js:**
```javascript
const propertyRouter = require('./routes/properties');
app.use('/api/v2/ontologies/:ontologyId/objectTypes/:apiName/properties', propertyRouter);
// Also mount setPrimaryKey and setTitleProperty routes:
app.use('/api/v2/ontologies/:ontologyId/objectTypes/:apiName', propertyRouter);
```

Note: Routes 6 and 7 (primaryKey/titleProperty) are at the object type level, not the property level. Mount them accordingly or define them in the objectTypes router (Task 14). The implementation choice is left to the developer — either approach works as long as the full paths are correct.

**Files to create:** src/routes/properties.js
**Modify:** src/server.js to mount the router

**Verification:**
- `POST .../properties` with valid body → 201
- `POST .../properties` with invalid baseType → 400 with INVALID_BASE_TYPE
- `GET .../properties` → 200 with array ordered by ordinal
- `GET .../properties/employeeId` → 200 with single property
- `PUT .../properties/fullName` with `{"displayName": "New Name"}` → 200
- `PUT .../properties/fullName` with `{"baseType": "integer"}` → 400 VALIDATION_FAILED
- `DELETE .../properties/email` → 204
- `DELETE .../properties/employeeId` (PK) → 400 VALIDATION_FAILED with "Cannot delete the primary key property"
- `POST .../primaryKey` with `{"propertyApiName": "employeeId"}` → 200
- `POST .../titleProperty` with `{"propertyApiName": "fullName"}` → 200
