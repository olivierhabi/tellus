## TASK 10: Build the Dataset-to-Ontology Column Mapping Suggestion Engine

### Context
When a user uploads a dataset and wants to connect it to an object type, they need to specify how dataset columns map to Ontology properties (the `columnMapping` in the backing datasource registration). In Palantir Foundry, the Ontology Manager UI handles this with a visual column-to-property mapping interface that auto-suggests mappings based on name similarity and type compatibility.

For our API-only week-1 implementation, we build a mapping suggestion engine that analyzes a dataset's columns and an object type's properties, and returns a suggested mapping. This saves the user from having to manually figure out which CSV column corresponds to which Ontology property.

### Exact Specification

**Endpoint: `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/suggestMapping`**

Request body:
```json
{
  "datasetId": "a1b2c3d4-..."
}
```

**Algorithm:**

Step 1: Load the dataset's schema (column names and detected types) and the object type's properties (api_names and base_types).

Step 2: For each object type property, find the best matching dataset column using a scoring system:

```javascript
function calculateMatchScore(propertyApiName, propertyBaseType, columnName, columnDetectedType) {
  let score = 0;
  
  // Name similarity (0-60 points)
  const normalizedProp = propertyApiName.toLowerCase().replace(/[_-]/g, '');
  const normalizedCol = columnName.toLowerCase().replace(/[_-]/g, '');
  
  if (normalizedProp === normalizedCol) {
    score += 60;  // Exact match after normalization
  } else if (normalizedCol.includes(normalizedProp) || normalizedProp.includes(normalizedCol)) {
    score += 40;  // Substring match
  } else {
    // Levenshtein edit distance — shorter distance = higher score
    // Use the `fastest-levenshtein` npm package (add to package.json) or implement:
    // Levenshtein distance = minimum single-character edits (insert, delete, substitute) to transform one string into another
    const distance = levenshtein(normalizedProp, normalizedCol);
    const maxLen = Math.max(normalizedProp.length, normalizedCol.length);
    const similarity = 1 - (distance / maxLen);
    score += Math.round(similarity * 30);
  }
  
  // Type compatibility (0-40 points)
  if (isTypeCompatible(propertyBaseType, columnDetectedType)) {
    score += 40;  // Types are compatible
  } else if (isTypeCoercible(propertyBaseType, columnDetectedType)) {
    score += 20;  // Types can be coerced (e.g., string column → integer property)
  }
  
  return score;
}
```

**Type compatibility rules** (`isTypeCompatible` — lossless, returns score 40):
- `string` property ← any column type (everything can be a string)
- `integer` / `long` property ← `"integer"` column
- `double` / `float` property ← `"number"` or `"integer"` column
- `boolean` property ← `"boolean"` column
- `date` property ← `"date"` column
- `timestamp` property ← `"timestamp"` or `"date"` column

**Type coercion rules** (`isTypeCoercible` — lossy but possible, returns score 20):
- `integer` / `long` property ← `"string"` column (can try parseInt at indexing time)
- `double` / `float` property ← `"string"` column (can try parseFloat at indexing time)
- `boolean` property ← `"string"` column (can try parsing "true"/"false" at indexing time)
- `date` / `timestamp` property ← `"string"` column (can try date parsing at indexing time)
- `integer` / `long` property ← `"number"` column (may truncate decimals)
- All other cross-type combinations: not coercible (score 0)

Step 3: For each property, select the column with the highest score. If the score is below 20 (very poor match), don't suggest it — mark it as "unmapped". Each column can only be mapped to one property. Use a greedy assignment algorithm:
1. Compute the best (highest score) column match for each property
2. Sort all (property, column, score) triples by score descending
3. When two properties have the same score, break ties alphabetically by property `apiName`
4. Process in order: assign the column to the property. Once a column is assigned, remove it from consideration for subsequent properties.

If the dataset's `schema_definition` is empty (no columns), return HTTP 400:
```json
{ "error": "DATASET_NO_SCHEMA", "message": "Dataset has no schema definition. Upload data to the dataset first." }
```

Step 4: Also identify the best primary key column: the dataset column that maps to the object type's primary key property.

**Response (HTTP 200):**
```json
{
  "suggestedMapping": {
    "employeeId": {
      "column": "emp_id",
      "score": 75,
      "confidence": "high",
      "typeMatch": "compatible",
      "nameMatch": "substring"
    },
    "fullName": {
      "column": "full_name",
      "score": 100,
      "confidence": "exact",
      "typeMatch": "compatible",
      "nameMatch": "exact"
    },
    "salary": {
      "column": "annual_salary",
      "score": 60,
      "confidence": "medium",
      "typeMatch": "compatible",
      "nameMatch": "substring"
    },
    "startDate": {
      "column": "start_date",
      "score": 100,
      "confidence": "exact",
      "typeMatch": "compatible",
      "nameMatch": "exact"
    }
  },
  "unmappedProperties": [
    { "apiName": "notes", "baseType": "string", "reason": "No matching column found with sufficient confidence" }
  ],
  "unmappedColumns": [
    { "columnName": "internal_code", "detectedType": "string", "reason": "No matching property found" }
  ],
  "suggestedPrimaryKeyColumn": "emp_id",
  "readyToRegister": true,
  "columnMapping": {
    "employeeId": "emp_id",
    "fullName": "full_name",
    "salary": "annual_salary",
    "startDate": "start_date"
  }
}
```

The `readyToRegister` flag is true if:
1. All required properties have a mapping
2. The primary key property has a mapping
3. No type incompatibilities exist in the suggested mapping

The `columnMapping` field can be directly passed to the datasource registration endpoint — this is the convenience that makes the workflow: upload → suggest → register → index seamless.

**Confidence levels:**
- `"exact"`: Score >= 90 — almost certainly correct
- `"high"`: Score 70-89 — very likely correct
- `"medium"`: Score 40-69 — plausible but should be reviewed
- `"low"`: Score 20-39 — uncertain, user should verify

### Validation Criteria
- Exact column names (fullName → full_name) get "exact" confidence
- Substring matches (salary → annual_salary) get "medium" or "high" confidence
- Type-incompatible matches (boolean property → number column) get lower scores
- Properties with no reasonable match appear in unmappedProperties
- Columns with no reasonable match appear in unmappedColumns
- The columnMapping output can be directly used in the datasource registration endpoint
- Primary key column suggestion is correct
- readyToRegister is false when required properties are unmapped
