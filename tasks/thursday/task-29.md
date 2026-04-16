# TASK 29: Create OpenAPI/Swagger Documentation for All Link Endpoints

**Objective:** Generate OpenAPI 3.0 specification for all link-related endpoints built in Tasks 2-17 and 25-26. This documentation will be used by the OSDK code generator and the Developer Console.

**Prerequisites:** Tasks 2-17, 25, and 26 must be complete.

**Implementation:** Create `docs/openapi-links.yaml`. Write valid OpenAPI 3.0 YAML that documents every endpoint listed below.

**Endpoints to document (12 total):**

| # | Method | Path | Task |
|---|--------|------|------|
| 1 | POST | `/api/v1/ontology/{ontologyId}/linkTypes` | Task 2 |
| 2 | GET | `/api/v1/ontology/{ontologyId}/linkTypes` | Task 3 |
| 3 | GET | `/api/v1/ontology/{ontologyId}/linkTypes/{apiName}` | Task 4 |
| 4 | PUT | `/api/v1/ontology/{ontologyId}/linkTypes/{apiName}` | Task 5 |
| 5 | DELETE | `/api/v1/ontology/{ontologyId}/linkTypes/{apiName}` | Task 6 |
| 6 | GET | `/api/v1/objects/{objectType}/{primaryKey}/links/{linkType}` | Task 12 |
| 7 | POST | `/api/v1/objects/{objectType}/searchAround` | Task 13 |
| 8 | GET | `/api/v1/objects/{objectType}/{primaryKey}/links/{linkType}/count` | Task 15 |
| 9 | GET | `/api/v1/objects/{objectType}/{primaryKey}/links` | Task 16 |
| 10 | POST | `/api/v1/ontology/{ontologyId}/linkTypes/{apiName}/joinTable` | Task 17 |
| 11 | GET | `/api/v1/ontology/{ontologyId}/linkTypes/export` | Task 25 |
| 12 | POST | `/api/v1/ontology/{ontologyId}/linkTypes/import` | Task 26 |

**For each endpoint, include:**

1. **Summary and description:** One-line summary and 1-2 sentence description.

2. **Parameters:** All path parameters (with `in: path`) and query parameters (with `in: query`), each with:
   - `name`, `in`, `required`, `schema` (with `type`, `format`, `default`, `maximum` as applicable)
   - `description`

3. **Request body (for POST/PUT):** Full JSON Schema definition with:
   - `required` array listing mandatory fields
   - `properties` with types, descriptions, and `example` values
   - Nested objects (e.g., `foreignKey`, `joinTable`, `sourceFilter`, `targetFilter`)

4. **Responses:** Document every possible HTTP status code:
   - `200` / `201`: Success response with full schema and example
   - `400`: Validation errors (list all possible error messages in description)
   - `404`: Not found (ontology, link type, or object)
   - `409`: Conflict (duplicate apiName)
   - `500`: Internal server error

5. **Example:** One complete request/response example per endpoint.

**Error response schema (shared across all endpoints):**

```yaml
components:
  schemas:
    Error:
      type: object
      required:
        - error
      properties:
        error:
          type: string
          description: Human-readable error message
          example: "Link type 'badLink' not found in this ontology."
```

**File to create:** `docs/openapi-links.yaml`

**Testing:**
1. Validate the YAML file by pasting into https://editor.swagger.io/ — verify no parsing errors.
2. Verify every endpoint path in the spec matches the actual Express route registration.
3. Verify every request body schema matches the validation rules defined in the corresponding task (Tasks 2, 5, 13, 17, 26).
4. Verify every response schema matches the actual response format defined in the corresponding task.
5. Verify every error status code is documented for each endpoint.
