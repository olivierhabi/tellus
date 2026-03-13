## TASK 26: Build the Complete API Documentation Generator

### Context
Every endpoint built this week needs to be documented. This task creates an auto-generated API reference that lists every endpoint, its request/response format, example payloads, and error codes. The documentation is generated from the actual route definitions so it stays in sync with the code.

### Exact Specification

Create `/src/utils/generateApiDocs.js` that:

1. Scans all route files in `/src/routes/` using Express router introspection: `require()` each route module and walk `router.stack` to discover all registered routes (method, path pattern). For metadata (description, request/response schemas, error codes), read the JSDoc comment block immediately preceding each `router.METHOD()` call in the source file using static text analysis (regex or AST parsing).
2. For Palantir documentation URLs: create a companion file `/src/utils/palantirDocMapping.json` that maps each endpoint path pattern to a Palantir documentation URL. The generator reads this mapping and includes the URL in the output. Example entry: `"/api/v2/objects/:objectType/search": "https://www.palantir.com/docs/foundry/api/ontology-resources/objects/search-objects/"`
3. Generates a Markdown file at `/docs/API_REFERENCE.md`

The generated documentation must cover every endpoint built during the week:

**Endpoints to document (complete list):**

ONTOLOGY:
- POST /api/v2/ontology
- GET /api/v2/ontology/:id

OBJECT TYPES:
- POST /api/v2/ontology/:id/objectTypes
- GET /api/v2/ontology/:id/objectTypes
- GET /api/v2/ontology/:id/objectTypes/:apiName
- POST /api/v2/ontology/:id/objectTypes/:apiName/properties
- PUT /api/v2/ontology/:id/objectTypes/:apiName/properties/:propApiName
- DELETE /api/v2/ontology/:id/objectTypes/:apiName/properties/:propApiName
- POST /api/v2/ontology/:id/objectTypes/:apiName/datasource
- POST /api/v2/ontology/:id/objectTypes/:apiName/reindex
- GET /api/v2/ontology/:id/objectTypes/:apiName/reindex/status
- GET /api/v2/ontology/:id/objectTypes/:apiName/reindex/history
- GET /api/v2/ontology/:id/objectTypes/:apiName/edits
- GET /api/v2/ontology/:id/objectTypes/:apiName/edits/diff/:pk
- POST /api/v2/ontology/:id/objectTypes/:apiName/suggestMapping

OBJECTS (QUERY):
- GET /api/v2/objects/:objectType
- GET /api/v2/objects/:objectType/:pk
- GET /api/v2/objects/:objectType/:pk/view
- POST /api/v2/objects/:objectType/search
- POST /api/v2/objects/:objectType/aggregate
- POST /api/v2/objects/:objectType/searchFullText

LINKS:
- POST /api/v2/ontology/:id/linkTypes
- GET /api/v2/ontology/:id/linkTypes
- GET /api/v2/objects/:objectType/:pk/links/:linkType
- POST /api/v2/objects/:objectType/searchAround

ACTIONS:
- POST /api/v2/ontology/:id/actionTypes
- GET /api/v2/ontology/:id/actionTypes
- POST /api/v2/actions/:actionType/apply
- POST /api/v2/actions/:actionType/validate
- POST /api/v2/actions/:actionType/applyBulk
- GET /api/v2/actions/:actionType/audit

INTERFACES:
- POST /api/v2/ontology/:id/interfaces
- POST /api/v2/ontology/:id/objectTypes/:apiName/implements
- GET /api/v2/ontology/:id/interfaces/:apiName/objects

DATASETS:
- POST /api/v2/datasets/upload
- GET /api/v2/datasets
- GET /api/v2/datasets/:datasetId
- GET /api/v2/datasets/:datasetId/preview
- POST /api/v2/datasets/:datasetId/transactions
- DELETE /api/v2/datasets/:datasetId

SYSTEM:
- GET /api/v2/health
- GET /api/v2/status

For each endpoint, include:
- Description (one paragraph)
- Request format (method, path, headers, body schema)
- Example request with curl command
- Example response (successful)
- Error responses (all possible error codes with example response bodies)
- Palantir doc reference URL (where the original Palantir behavior is documented)

### Validation Criteria
- All 42 endpoints listed above are documented (exact count, not "40+")
- Every example curl command is syntactically correct
- Every error code has an example response
- The Palantir doc reference links in `palantirDocMapping.json` are real, working URLs (verify with HTTP HEAD requests)
- The generator can be re-run (`node src/utils/generateApiDocs.js`) to regenerate the documentation from current route files
