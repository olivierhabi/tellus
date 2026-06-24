# Reindex Debugging Guide

## Problem
The reindex endpoint returns "Failed to trigger indexing" with no specific error message.

## Quick Diagnosis

### 1. Run the debug script
```bash
# First, get a fresh auth token from your browser's DevTools:
# 1. Open DevTools (F12)
# 2. Go to Application > Cookies > localhost:3001
# 3. Copy the value of TELLUS_TOKEN cookie

# Run the debug script:
cd /Users/olivierhabimana/Desktop/projects/tellus
./test-reindex-debug.sh "YOUR_FRESH_TOKEN_HERE"
```

### 2. Common Issues

#### Authentication Error (401)
- Token has expired (default TTL is 30 minutes)
- Get a fresh token from browser cookies

#### No Backing Datasource (NO_BACKING_DATASOURCE)
- Object type has no registered backing datasource
- Register one via the Data Source Wizard

#### File Not Found
- The datasource file path is invalid
- For foundry-bridged datasources, check MinIO bucket

#### OpenSearch Connection Error
- OpenSearch not running at localhost:9200
- Check Docker containers: `docker ps`

### 3. Backend Logs
Check the server console output for detailed error messages.

### 4. Database State
Check the funnel_state table for the object type:
```sql
SELECT fs.*, ot.api_name
FROM funnel_state fs
JOIN object_type ot ON fs.object_type_id = ot.object_type_id
WHERE ot.api_name = 'OlivierOrder';
```

### 5. Test Reindex Manually
```bash
curl -X POST "http://localhost:3000/api/v1/ontology/00000000-0000-0000-0000-000000000001/objectTypes/OlivierOrder/reindex?force=true" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

## Frontend Error Handling

The frontend now extracts more specific error messages from the response:
- `error.error.message`
- `error.message`
- `error.error.details.message`
- Falls back to HTTP status code

## Backend Error Flow

1. `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex` POST
2. Validates ontology exists
3. Validates object type exists
4. Validates backing datasource exists
5. Checks if reindex needed (skip if not force)
6. Acquires atomic lock
7. Calls `reindexObjectType()` which:
   - Loads metadata
   - Reads datasource files
   - Merges transactions
   - Applies edits
   - Indexes to OpenSearch
   - Updates funnel_state
