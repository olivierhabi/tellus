# TASK 29: Build the Swagger/OpenAPI Specification for All Action Endpoints

**Objective:** Generate a complete OpenAPI 3.0 specification document for all Action-related API endpoints built today. This specification serves as: (1) machine-readable API documentation, (2) the input for the OSDK code generator (which will be built in a later week to auto-generate typed clients), and (3) a contract for testing (the spec can be used to validate that all responses match the declared schemas).

**Create the file** at `src/api-spec/actions.openapi.json` (use JSON format, not YAML — this avoids needing a YAML parser at runtime since the middleware code imports JSON directly via `require()`).

**The spec must include ALL of these endpoints with complete request/response schemas:**

1. `POST /api/v1/ontology/{ontologyId}/actionTypes` — Create action type
2. `GET /api/v1/ontology/{ontologyId}/actionTypes` — List action types
3. `GET /api/v1/ontology/{ontologyId}/actionTypes/{apiName}` — Get action type
4. `PUT /api/v1/ontology/{ontologyId}/actionTypes/{apiName}` — Update action type
5. `DELETE /api/v1/ontology/{ontologyId}/actionTypes/{apiName}` — Delete action type
6. `POST /api/v1/ontology/{ontologyId}/actionTypes/{apiName}/clone` — Clone action type
7. `GET /api/v1/ontology/{ontologyId}/actionTypes/{apiName}/impact` — Impact analysis
8. `POST /api/v1/actions/{actionTypeApiName}/apply` — Execute action
9. `POST /api/v1/actions/{actionTypeApiName}/validate` — Validate action (dry run)
10. `POST /api/v1/actions/{actionTypeApiName}/applyBatch` — Batch execute
11. `GET /api/v1/actions/{actionTypeApiName}/audit` — Action audit log
12. `GET /api/v1/audit/log` — Global audit log
13. `GET /api/v1/audit/log/{executionId}` — Single audit entry
14. `GET /api/v1/audit/stats` — Audit statistics
15. `GET /api/v1/objects/{objectType}/{primaryKey}/editHistory` — Object edit history

**For each endpoint, include:**
- Path and method
- Summary and description
- Path parameters with types
- Query parameters with types, defaults, and constraints
- Request body schema (for POST/PUT)
- All **applicable** response codes for that specific endpoint (not every endpoint returns every code — e.g., a GET list endpoint never returns 409 or 429). Common mappings:
  - POST create: 201, 400, 409
  - GET list/single: 200, 404
  - PUT update: 200, 400, 404
  - DELETE: 204, 404
  - POST apply: 200, 400, 404, 409, 429, 500
  - POST validate: 200, 400, 404
  - POST applyBatch: 200, 400, 429
- Response body schemas for each applicable code
- Example requests and responses

**Define reusable schema components** for:
- `ActionTypeDefinition` (the full action type object)
- `ActionParameter` (a single parameter definition)
- `ActionRule` (a single rule definition, with discriminated union for rule types)
- `ActionExecutionResult` (the result of an action execution)
- `AuditLogEntry` (a single audit log record)
- `OntologyError` (the standard error response)
- `PaginatedResponse` (the common pattern with data, nextPageToken, totalCount)
- `BatchExecutionResult` (the batch endpoint response from Task 25)
- `ValidationResult` (the validate endpoint response from Task 19)
- `AuditStats` (the audit statistics response from Task 9, Endpoint 4)
- `EditHistoryEntry` (a single edit history entry from Task 17)
- `ImpactAnalysis` (the impact analysis response from Task 24)

**Also create a middleware** that serves the spec and a Swagger UI at these paths:
- `GET /api/v1/spec` — Returns the raw OpenAPI JSON
- `GET /api/v1/docs` — Renders Swagger UI (use swagger-ui-express npm package)

```javascript
const swaggerUi = require('swagger-ui-express');
const spec = require('./api-spec/actions.openapi.json');
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(spec));
app.get('/api/v1/spec', (req, res) => res.json(spec));
```

Install swagger-ui-express: `npm install swagger-ui-express`

**Automated validation:** The spec must pass validation:
```bash
npx swagger-cli validate src/api-spec/actions.openapi.json
```
This ensures the spec is valid OpenAPI 3.0 and all `$ref` references resolve correctly.

**Manual test:** Open `http://localhost:3000/api/v1/docs` in a browser and verify all 15 endpoints are listed with their full schemas, examples, and "Try it out" functionality works.
