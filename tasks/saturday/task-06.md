## TASK 6: Update the Backing Datasource Registration to Use Datasets

### Context
In Days 1-2, the `backing_datasource` table stored a raw `file_path` pointing directly to a CSV file on disk. Now that we have a proper Dataset abstraction (Tasks 1-5), we need to update the backing datasource registration endpoint so that it references a `dataset_id` instead of (or in addition to) a raw file path. This bridges the gap between the Dataset layer and the Ontology layer.

In Palantir Foundry, "backing datasources" are always datasets (or restricted views of datasets, or streaming datasources). You never point an object type directly at a raw file. The Ontology Manager UI allows you to select a dataset and then map its columns to object type properties. Our implementation must follow this same pattern.

### Exact Specification

**Update endpoint: `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource`**

The request body must now accept EITHER a `datasetId` (new preferred method) or a `filePath` (legacy fallback for backward compatibility):

**New format (preferred):**
```json
{
  "datasetId": "a1b2c3d4-...",
  "columnMapping": {
    "employeeId": "emp_id",
    "fullName": "full_name",
    "salary": "annual_salary",
    "startDate": "start_date",
    "isActive": "is_active"
  },
  "primaryKeyColumn": "emp_id"
}
```

**Legacy format (still supported):**
```json
{
  "filePath": "/data/datasets/employees.csv",
  "columnMapping": { ... },
  "primaryKeyColumn": "emp_id"
}
```

**Validation rules when `datasetId` is provided:**

1. The dataset must exist. If not, return HTTP 404:
```json
{ "error": "DATASET_NOT_FOUND", "message": "Dataset '...' was not found." }
```

2. The dataset must have at least one committed transaction. If not, return HTTP 400:
```json
{ "error": "DATASET_EMPTY", "message": "Dataset '...' has no committed data. Upload data to the dataset before using it as a backing datasource." }
```

3. Every value in `columnMapping` must correspond to an actual column in the dataset's `schema_definition`. If a mapped column doesn't exist, return HTTP 400:
```json
{ "error": "COLUMN_NOT_FOUND", "message": "Column 'annual_salry' does not exist in dataset '...'. Available columns: ['emp_id', 'full_name', 'annual_salary', 'start_date', 'is_active']. Did you mean 'annual_salary'?" }
```
Note: include a "Did you mean" suggestion using Levenshtein edit distance if the misspelling has an edit distance of 2 or fewer compared to an existing column name. Levenshtein edit distance counts the minimum number of single-character insertions, deletions, or substitutions needed to transform one string into another.

4. The `primaryKeyColumn` must be one of the dataset's columns. If not, return the same COLUMN_NOT_FOUND error.

5. The `primaryKeyColumn` must map to a property that is designated as the object type's primary key. If the object type's `primary_key_property_id` is set, verify that the property it points to is included in the `columnMapping` and maps to `primaryKeyColumn`. If they do NOT match, return HTTP 400:
```json
{ "error": "PRIMARY_KEY_MISMATCH", "message": "The object type 'Employee' has primary key property 'employeeId' mapped to column 'emp_id', but primaryKeyColumn is set to 'other_col'. The primaryKeyColumn must match the column mapped to the primary key property." }
```
If they DO match, validation passes — do not return an error.

6. Palantir rule: one dataset can only back one object type. Check if any other object type already references this `dataset_id`:
```sql
SELECT ot.api_name FROM backing_datasource bs JOIN object_type ot ON bs.object_type_id = ot.object_type_id WHERE bs.dataset_id = $1 AND ot.api_name != $2;
```
If found, return HTTP 409:
```json
{ "error": "DATASET_ALREADY_BACKING", "message": "Dataset '...' is already used as a backing datasource for object type 'OtherType'. A single dataset can only back one object type." }
```

**Successful registration:**

When all validations pass:
1. Upsert into `backing_datasource`:
   ```sql
   INSERT INTO backing_datasource (mapping_id, object_type_id, dataset_id, file_path, column_mapping, primary_key_column)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (object_type_id) DO UPDATE SET
     dataset_id = EXCLUDED.dataset_id,
     file_path = EXCLUDED.file_path,
     column_mapping = EXCLUDED.column_mapping,
     primary_key_column = EXCLUDED.primary_key_column,
     registered_at = now();
   ```
   Note: if `datasetId` is provided, `file_path` should be set to the path of the latest committed transaction's file regardless of type (for backward compatibility with the indexer). If `filePath` is provided directly, `dataset_id` should be NULL.

**Mutual exclusivity rule:** If both `datasetId` and `filePath` are provided in the same request, return HTTP 400:
```json
{ "error": "AMBIGUOUS_DATASOURCE", "message": "Provide either datasetId or filePath, not both." }
```

2. Determine the `file_path` for the indexer:
   - If `datasetId` is provided: find the latest committed transaction and use its `file_path`
   - If `filePath` is provided: use it directly

3. Return HTTP 200:
```json
{
  "backingDatasource": {
    "objectType": "Employee",
    "datasetId": "a1b2c3d4-...",
    "datasetName": "Employee Directory Q1 2025",
    "columnMapping": { ... },
    "primaryKeyColumn": "emp_id",
    "registeredAt": "2025-03-15T12:00:00.000Z"
  },
  "message": "Backing datasource registered. Call POST /api/v1/ontology/:id/objectTypes/Employee/reindex to index the data into the Ontology."
}
```

### Validation Criteria
- Registration with a valid datasetId succeeds
- Registration with a non-existent datasetId returns 404
- Registration with an empty dataset returns 400
- Registration with a misspelled column name returns 400 with "Did you mean" suggestion
- Registration with a dataset already backing another object type returns 409
- Legacy filePath registration still works
- After registration, the backing_datasource table has both dataset_id and file_path populated
- Providing both datasetId and filePath returns 400 with AMBIGUOUS_DATASOURCE
- Primary key mismatch returns 400 with PRIMARY_KEY_MISMATCH and a message showing the actual vs expected column
