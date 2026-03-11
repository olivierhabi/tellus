# TASK 28 OF 30: Ontology Export/Import (Full Ontology Definition)

**Objective:** Create two endpoints: one to export an entire ontology definition (all object types and their properties) as a JSON response, and one to import an ontology from a previously exported JSON body. This is for backup/restore and migration between environments.

**Step-by-step instructions:**

**Endpoint 1: GET /api/v2/ontologies/:ontologyId/export**

Add this route to src/routes/ontology.js. Add corresponding `exportOntology` method to src/services/ontologyService.js.

Implementation:
1. Fetch the ontology by ID. If not found, throw `ONTOLOGY_NOT_FOUND`.
2. Fetch all object types in this ontology: `SELECT * FROM object_type WHERE ontology_id = $1 ORDER BY created_at`.
3. For each object type, call `objectTypeService.exportDefinition(ontologyId, objectType.api_name)` (Task 21) to get the formatted export. Extract the `objectType` property from each result (strip the per-type `exportVersion` and `exportedAt` — those are only for single-type exports).
4. Build the full ontology export:

```json
{
  "exportVersion": "1.0",
  "exportedAt": "2025-03-11T12:00:00Z",
  "exportedFrom": "ontology-engine-v0.1.0",
  "ontology": {
    "displayName": "RRA Tax Ontology",
    "description": "Rwanda Revenue Authority tax collection digital twin.",
    "objectTypes": [
      {
        "apiName": "Taxpayer",
        "displayName": "Taxpayer",
        "description": "...",
        "icon": "person",
        "iconColor": "#1565C0",
        "status": "active",
        "primaryKeyProperty": "tin",
        "titleProperty": "fullName",
        "properties": [
          {"apiName": "tin", "displayName": "TIN", "baseType": "string", "isRequired": true, "isArray": false, "ordinal": 0}
        ]
      }
    ],
    "linkTypes": [],
    "actionTypes": [],
    "interfaces": []
  }
}
```

The `linkTypes`, `actionTypes`, and `interfaces` arrays are always empty in the current scope (these are planned for future sprints). Include them as empty arrays for forward compatibility.

5. Set response header: `Content-Disposition: attachment; filename="{ontology-display-name-kebab-case}-export-{YYYY-MM-DD}.json"` (e.g., `rra-tax-ontology-export-2025-03-11.json`). Convert display name to kebab-case (lowercase, spaces to hyphens, remove special characters).
6. Return HTTP 200 with the JSON body.

**Endpoint 2: POST /api/v2/ontologies/import**

Add this route to src/routes/ontology.js. Add corresponding `importOntology` method to src/services/ontologyService.js.

The request body is the JSON object (same format as the export response). This is a JSON body (Content-Type: application/json), NOT a file upload.

Implementation:
1. Validate `req.body.exportVersion === "1.0"`. If not, return 400 with `VALIDATION_FAILED` and message "Unsupported export version. Expected: 1.0."
2. Validate `req.body.ontology` exists and has `displayName` and `objectTypes` (array).
3. Use a single database transaction for the entire import:
   a. Create the ontology. If `displayName` already exists, append `" (imported)"` to make it unique. If that also exists, append `" (imported 2)"`, etc.
   b. For each object type in `objectTypes`, call `objectTypeService.importDefinition(newOntologyId, {exportVersion: "1.0", objectType: ot})` (Task 21).
4. If any creation fails, `ROLLBACK` the entire transaction — no partial imports.
5. Return HTTP 201 with the created ontology formatted via `formatOntology`, including the count of imported object types.

**Files to modify:** src/routes/ontology.js, src/services/ontologyService.js

**Verification:**
- `GET /api/v2/ontologies/:id/export` → 200 with JSON containing all 5 object types and 41 total properties (after seeding)
- Response has `Content-Disposition` header with `.json` filename
- `POST /api/v2/ontologies/import` with the exported JSON → 201, new ontology created with display name "RRA Tax Ontology (imported)", all 5 object types and 41 properties restored
- Import with duplicate display name → auto-appends " (imported)" suffix
- Import with invalid exportVersion → 400 VALIDATION_FAILED
- Import with one invalid object type → 400, nothing created (transaction rolled back)
- Delete the original ontology, then import → restores everything with a new ontologyId
