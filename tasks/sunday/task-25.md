# TASK 25: API Reference Documentation — Auto-Generated from Code

This task has three sub-tasks.

**Depends on:** Task 17 (validation schemas in `/src/schemas/`)

## Objective
Create an auto-generated API reference document that stays synchronized with the actual codebase. Instead of manually maintaining API docs (which inevitably go stale), build a script that introspects the Express router and generates the documentation automatically.

## Exact Specification

Create a script at `/src/docs/generateApiDocs.js` that:

## Sub-task 25B: Create the Documentation Generator Script

1. Imports the Express app from `server.js` (without starting the HTTP listener)
2. Walks the Express router stack to discover all registered routes
3. For each route, reads the associated schema from the `/src/schemas/` directory (Task 17) — the schema is matched to a route by importing the schema file that corresponds to the route file name (e.g., `/src/schemas/objectTypes.js` for routes in `/src/routes/objectTypes.js`)
4. For each route, reads JSDoc-style comments from the route handler source code
5. Generates a Markdown file at `/docs/API_REFERENCE.md`

The generated documentation for each endpoint must include:

- HTTP method and path
- Description (from JSDoc `@description` comment on the handler)
- URL parameters with types (from the schema's `params` definition)
- Query parameters with types and defaults (from the schema's `query` definition)
- Request body schema with types, required/optional, and descriptions (from the schema's `body` definition)
- Example request (with curl command)
- Example response (from JSDoc `@example_response` comment or from a test fixture)
- Error codes (from a `@errors` JSDoc comment listing possible error codes)

The route handlers should be annotated with JSDoc comments like this:

```javascript
/**
 * @description Create a new Object Type in the Ontology
 * @errors NOT_FOUND (Ontology not found), ALREADY_EXISTS (apiName taken), VALIDATION_ERROR (invalid input)
 * @example_response { "data": { "apiName": "Employee", "displayName": "Employee", "properties": {...} } }
 */
router.post('/ontology/:ontologyId/objectTypes', validate(createObjectTypeSchema), asyncHandler(async (req, res) => {
  // ...
}));
```

---

## Sub-task 25A: Add JSDoc Annotations to All Route Handlers

**Must be completed before Sub-task 25B can generate complete docs.**

Add `@description`, `@errors`, and `@example_response` JSDoc comments to every route handler in the following files:
- `/src/routes/ontology.js`
- `/src/routes/objectTypes.js`
- `/src/routes/datasources.js`
- `/src/routes/queries.js`
- `/src/routes/links.js`
- `/src/routes/actions.js`
- `/src/routes/interfaces.js`
- `/src/routes/objectTypeInterfaces.js`

Each handler must have all three annotation tags. This is tedious but essential — the auto-generated docs are only as good as the annotations.

The generated Markdown should look like:

```markdown
## POST /api/v1/ontology/:ontologyId/objectTypes

**Description:** Create a new Object Type in the Ontology

**URL Parameters:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| ontologyId | UUID | Yes | The ID of the Ontology |

**Request Body:**
| Field | Type | Required | Description |
|---|---|---|---|
| apiName | string | Yes | PascalCase identifier (e.g., "Employee"). Pattern: /^[A-Z][a-zA-Z0-9]*$/ |
| displayName | string | Yes | Human-readable name. Max 500 characters. |
| description | string | No | Free-form description. Max 10,000 characters. |
| properties | array | Yes | Array of property definitions. Min 1, Max 2000. |
| properties[].apiName | string | Yes | camelCase property name. Pattern: /^[a-z][a-zA-Z0-9]*$/ |
| properties[].baseType | enum | Yes | One of: string, boolean, integer, long, double, ... |
| properties[].isRequired | boolean | No | Default: false |

**Example Request:**
\```bash
curl -X POST http://localhost:3000/api/v1/ontology/abc-123/objectTypes \
  -H "Content-Type: application/json" \
  -d '{"apiName":"Employee","displayName":"Employee","properties":[...]}'
\```

**Example Response (201 Created):**
\```json
{ "data": { "apiName": "Employee", ... } }
\```

**Possible Errors:**
| Code | Status | Description |
|---|---|---|
| NOT_FOUND | 404 | Ontology with this ID not found |
| ALREADY_EXISTS | 409 | An Object Type with this apiName already exists |
| VALIDATION_ERROR | 400 | Request body failed validation |
```

The script should be runnable with `node src/docs/generateApiDocs.js` and should overwrite `/docs/API_REFERENCE.md` each time.

Add an npm script: `"docs": "node src/docs/generateApiDocs.js"` in package.json.

---

## Sub-task 25C: Documentation Completeness Test

Also add a test that verifies the generated docs match the actual routes — run the generator and compare the route count with the actual Express router. If they differ, the test fails, alerting that new routes were added without JSDoc annotations.

## Verification
1. Run `npm run docs` → `/docs/API_REFERENCE.md` is generated
2. Open the generated file → verify every endpoint is listed with complete documentation
3. Add a new route without JSDoc → run the test → verify it flags the missing annotation
4. Verify every example curl command in the generated docs actually works when executed against the running server (requires Task 26 seed data to be loaded first)
5. Verify the generated file is at least 5,000 words (comprehensive coverage)
