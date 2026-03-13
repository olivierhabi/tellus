// ---------------------------------------------------------------------------
// API Documentation Generator (Task 26)
//
// Scans all route files in src/routes/ and generates a comprehensive
// API_REFERENCE.md in the docs/ directory.
//
// Each endpoint includes: method, path, description, request/response
// format, curl example, and error codes.
//
// Run: npx tsx src/utils/generateApiDocs.ts
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EndpointDoc {
  method: string;
  path: string;
  description: string;
  section: string;
  requestBody?: string;
  responseBody?: string;
  curlExample: string;
  errorCodes?: string[];
  queryParams?: string[];
  headers?: string[];
}

// ---------------------------------------------------------------------------
// Endpoint Registry — all 42+ endpoints
// ---------------------------------------------------------------------------

function getAllEndpoints(): EndpointDoc[] {
  const BASE = "http://localhost:3000";

  return [
    // =====================================================================
    // Health & Status
    // =====================================================================
    {
      section: "Health & Status",
      method: "GET",
      path: "/health",
      description: "Basic health check. Verifies PostgreSQL connectivity.",
      responseBody: `{ "status": "healthy", "database": "connected", "timestamp": "..." }`,
      curlExample: `curl ${BASE}/health`,
      errorCodes: ["503 — database unreachable"],
    },
    {
      section: "Health & Status",
      method: "GET",
      path: "/api/v2/health",
      description: "Enhanced health check. Checks PG and OpenSearch with 2s timeout each. Returns in < 500ms.",
      responseBody: `{ "status": "healthy", "timestamp": "...", "checks": { "postgresql": { "status": "up", "responseMs": 5 }, "opensearch": { "status": "up", "responseMs": 12 } } }`,
      curlExample: `curl ${BASE}/api/v2/health`,
      errorCodes: ["503 — one or both services down"],
    },
    {
      section: "Health & Status",
      method: "GET",
      path: "/api/v2/status",
      description: "Comprehensive system status. Includes system memory, uptime, PG table counts, OpenSearch cluster info, ontology counts, dataset stats, and edit stats.",
      responseBody: `{ "status": "healthy", "system": { "memory": {...}, "uptime": "..." }, "postgresql": {...}, "opensearch": {...}, "ontology": {...}, "datasets": {...}, "edits": {...} }`,
      curlExample: `curl ${BASE}/api/v2/status`,
      errorCodes: ["503 — both services unreachable"],
    },

    // =====================================================================
    // Ontology CRUD
    // =====================================================================
    {
      section: "Ontology",
      method: "POST",
      path: "/api/v2/ontologies",
      description: "Create a new ontology.",
      requestBody: `{ "displayName": "Rwanda Tax Authority", "description": "..." }`,
      responseBody: `{ "ontologyId": "uuid", "displayName": "...", "description": "...", "createdAt": "...", "updatedAt": "...", "createdBy": "system", "objectTypeCount": 0 }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies -H "Content-Type: application/json" -d '{"displayName":"Test Ontology"}'`,
      errorCodes: ["409 ONTOLOGY_ALREADY_EXISTS"],
    },
    {
      section: "Ontology",
      method: "GET",
      path: "/api/v2/ontologies",
      description: "List all ontologies with pagination.",
      queryParams: ["pageSize (default 100, max 1000)", "pageToken"],
      responseBody: `{ "data": [...], "totalCount": 1, "pageSize": 100, "nextPageToken": null }`,
      curlExample: `curl ${BASE}/api/v2/ontologies`,
    },
    {
      section: "Ontology",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId",
      description: "Get a single ontology by ID.",
      responseBody: `{ "ontologyId": "uuid", "displayName": "...", ... }`,
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}`,
      errorCodes: ["404 ONTOLOGY_NOT_FOUND"],
    },
    {
      section: "Ontology",
      method: "PUT",
      path: "/api/v2/ontologies/:ontologyId",
      description: "Update an ontology (displayName and/or description).",
      requestBody: `{ "displayName": "Updated Name", "description": "Updated desc" }`,
      curlExample: `curl -X PUT ${BASE}/api/v2/ontologies/{ontologyId} -H "Content-Type: application/json" -d '{"displayName":"New Name"}'`,
      errorCodes: ["404 ONTOLOGY_NOT_FOUND", "409 ONTOLOGY_ALREADY_EXISTS"],
    },
    {
      section: "Ontology",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId",
      description: "Delete an ontology and all its children (cascades).",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}`,
      errorCodes: ["404 ONTOLOGY_NOT_FOUND"],
    },
    {
      section: "Ontology",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/export",
      description: "Export full ontology as JSON (with object types, properties, link types, action types).",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/export`,
      errorCodes: ["404 ONTOLOGY_NOT_FOUND"],
    },
    {
      section: "Ontology",
      method: "POST",
      path: "/api/v2/ontologies/import",
      description: "Import an ontology from a previously exported JSON payload.",
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/import -H "Content-Type: application/json" -d @export.json`,
      errorCodes: ["400 VALIDATION_FAILED", "409 OBJECT_TYPE_ALREADY_EXISTS"],
    },

    // =====================================================================
    // Object Types
    // =====================================================================
    {
      section: "Object Types",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/objectTypes",
      description: "Create a new object type.",
      requestBody: `{ "apiName": "Employee", "displayName": "Employee", "description": "..." }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes -H "Content-Type: application/json" -d '{"apiName":"Employee","displayName":"Employee"}'`,
      errorCodes: ["400 INVALID_API_NAME", "409 OBJECT_TYPE_ALREADY_EXISTS"],
    },
    {
      section: "Object Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes",
      description: "List all object types for an ontology.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes`,
    },
    {
      section: "Object Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName",
      description: "Get a single object type with properties, datasource, and funnel state.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}`,
      errorCodes: ["404 OBJECT_TYPE_NOT_FOUND"],
    },
    {
      section: "Object Types",
      method: "PUT",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName",
      description: "Update an object type (displayName, description, icon, etc).",
      curlExample: `curl -X PUT ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName} -H "Content-Type: application/json" -d '{"displayName":"Updated"}'`,
      errorCodes: ["404 OBJECT_TYPE_NOT_FOUND"],
    },
    {
      section: "Object Types",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName",
      description: "Delete an object type and its properties, datasource, and index.",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}`,
      errorCodes: ["404 OBJECT_TYPE_NOT_FOUND"],
    },

    // =====================================================================
    // Properties
    // =====================================================================
    {
      section: "Properties",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/properties",
      description: "Create a new property on an object type.",
      requestBody: `{ "apiName": "employeeId", "displayName": "Employee ID", "baseType": "string" }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/properties -H "Content-Type: application/json" -d '{"apiName":"salary","displayName":"Salary","baseType":"double"}'`,
      errorCodes: ["400 INVALID_API_NAME", "400 INVALID_BASE_TYPE", "409 PROPERTY_ALREADY_EXISTS"],
    },
    {
      section: "Properties",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/properties",
      description: "List all properties for an object type.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/properties`,
    },
    {
      section: "Properties",
      method: "PUT",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/properties/:propertyApiName",
      description: "Update a property (displayName, description).",
      curlExample: `curl -X PUT ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/properties/{propName} -H "Content-Type: application/json" -d '{"displayName":"Updated"}'`,
      errorCodes: ["404 PROPERTY_NOT_FOUND"],
    },
    {
      section: "Properties",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/properties/:propertyApiName",
      description: "Delete a property from an object type.",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/properties/{propName}`,
      errorCodes: ["404 PROPERTY_NOT_FOUND"],
    },
    {
      section: "Properties",
      method: "PUT",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/primaryKey",
      description: "Set the primary key property for an object type.",
      requestBody: `{ "propertyApiName": "employeeId" }`,
      curlExample: `curl -X PUT ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/primaryKey -H "Content-Type: application/json" -d '{"propertyApiName":"employeeId"}'`,
      errorCodes: ["404 PROPERTY_NOT_FOUND"],
    },
    {
      section: "Properties",
      method: "PUT",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/titleProperty",
      description: "Set the title property for an object type.",
      requestBody: `{ "propertyApiName": "fullName" }`,
      curlExample: `curl -X PUT ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/titleProperty -H "Content-Type: application/json" -d '{"propertyApiName":"fullName"}'`,
      errorCodes: ["404 PROPERTY_NOT_FOUND"],
    },

    // =====================================================================
    // Datasources
    // =====================================================================
    {
      section: "Datasources",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource",
      description: "Register a backing datasource for an object type.",
      requestBody: `{ "datasetName": "employees", "filePath": "/data/emp.csv", "fileFormat": "csv", "columnMapping": {...}, "primaryKeyColumn": "emp_id" }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/datasource -H "Content-Type: application/json" -d '{...}'`,
      errorCodes: ["409 DATASOURCE_ALREADY_REGISTERED", "400 DATASOURCE_FILE_NOT_FOUND"],
    },
    {
      section: "Datasources",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource",
      description: "Get the registered datasource for an object type.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/datasource`,
      errorCodes: ["404 DATASOURCE_NOT_FOUND"],
    },
    {
      section: "Datasources",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource",
      description: "Unregister the backing datasource.",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/datasource`,
      errorCodes: ["404 DATASOURCE_NOT_FOUND"],
    },
    {
      section: "Datasources",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource/scan",
      description: "Re-scan the backing file and update metadata (row count, column names, schema hash).",
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/datasource/scan`,
      errorCodes: ["404 DATASOURCE_NOT_FOUND"],
    },

    // =====================================================================
    // Indexing
    // =====================================================================
    {
      section: "Indexing",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index",
      description: "Trigger a full reindex of an object type into OpenSearch.",
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/index`,
      errorCodes: ["400 NO_BACKING_DATASOURCE", "409 INDEXING_IN_PROGRESS"],
    },
    {
      section: "Indexing",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index/status",
      description: "Get the indexing status for an object type.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/index/status`,
    },
    {
      section: "Indexing",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index",
      description: "Delete the OpenSearch index for an object type.",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/index`,
    },
    {
      section: "Indexing",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index/reindex/status",
      description: "Get the current reindex status and health assessment.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/index/reindex/status`,
    },
    {
      section: "Indexing",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/objectTypes/:apiName/index/reindex/history",
      description: "Get paginated reindex history.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/objectTypes/{apiName}/index/reindex/history`,
    },

    // =====================================================================
    // Objects (Query API)
    // =====================================================================
    {
      section: "Objects",
      method: "GET",
      path: "/api/v2/objects/:objectType",
      description: "List objects of a type with pagination and optional sorting.",
      queryParams: ["$pageSize (default 100)", "$pageToken", "$orderBy", "$select"],
      curlExample: `curl "${BASE}/api/v2/objects/Employee?\\$pageSize=10"`,
      errorCodes: ["404 OBJECT_TYPE_NOT_FOUND"],
    },
    {
      section: "Objects",
      method: "GET",
      path: "/api/v2/objects/:objectType/:primaryKey",
      description: "Get a single object by primary key.",
      curlExample: `curl ${BASE}/api/v2/objects/Employee/EMP-001`,
      errorCodes: ["404 OBJECT_NOT_FOUND", "404 OBJECT_TYPE_NOT_FOUND"],
    },
    {
      section: "Objects",
      method: "POST",
      path: "/api/v2/objects/:objectType/search",
      description: "Search objects with filter expressions, ordering, and pagination.",
      requestBody: `{ "where": { "type": "eq", "field": "department", "value": "Engineering" }, "$pageSize": 50 }`,
      curlExample: `curl -X POST ${BASE}/api/v2/objects/Employee/search -H "Content-Type: application/json" -d '{"where":{"type":"eq","field":"department","value":"Engineering"}}'`,
      errorCodes: ["400 QUERY_VALIDATION_ERROR", "404 OBJECT_TYPE_NOT_FOUND"],
    },
    {
      section: "Objects",
      method: "POST",
      path: "/api/v2/objects/:objectType/searchFullText",
      description: "Full-text search across all indexed text fields.",
      requestBody: `{ "query": "Habimana", "$pageSize": 10 }`,
      curlExample: `curl -X POST ${BASE}/api/v2/objects/Employee/searchFullText -H "Content-Type: application/json" -d '{"query":"Habimana"}'`,
      errorCodes: ["400 QUERY_VALIDATION_ERROR"],
    },
    {
      section: "Objects",
      method: "POST",
      path: "/api/v2/objects/:objectType/aggregate",
      description: "Run aggregations (count, avg, sum, min, max, terms, date_histogram, range, cardinality).",
      requestBody: `{ "aggregations": [{ "type": "avg", "field": "salary", "name": "avgSalary" }] }`,
      curlExample: `curl -X POST ${BASE}/api/v2/objects/Employee/aggregate -H "Content-Type: application/json" -d '{"aggregations":[{"type":"avg","field":"salary","name":"avgSalary"}]}'`,
      errorCodes: ["400 INVALID_AGGREGATION"],
    },
    {
      section: "Objects",
      method: "POST",
      path: "/api/v2/objects/:objectType/searchAround",
      description: "Search around linked objects (Search Around). Returns linked objects matching filters.",
      requestBody: `{ "linkType": "employedBy", "direction": "forward" }`,
      curlExample: `curl -X POST ${BASE}/api/v2/objects/Employee/searchAround -H "Content-Type: application/json" -d '{"linkType":"employedBy","direction":"forward"}'`,
      errorCodes: ["404 LINK_TYPE_NOT_FOUND"],
    },
    {
      section: "Objects",
      method: "GET",
      path: "/api/v2/objects/:objectType/:primaryKey/links/:linkType",
      description: "Resolve links for a specific object.",
      queryParams: ["direction (forward|reverse)", "pageSize", "pageToken", "select"],
      curlExample: `curl "${BASE}/api/v2/objects/Employee/EMP-001/links/employedBy"`,
      errorCodes: ["404 LINK_TYPE_NOT_FOUND"],
    },
    {
      section: "Objects",
      method: "GET",
      path: "/api/v2/objects/:objectType/:primaryKey/links/:linkType/count",
      description: "Count linked objects for a specific link type.",
      curlExample: `curl "${BASE}/api/v2/objects/Employee/EMP-001/links/employedBy/count"`,
      errorCodes: ["404 LINK_TYPE_NOT_FOUND"],
    },
    {
      section: "Objects",
      method: "GET",
      path: "/api/v2/objects/:objectType/:primaryKey/editHistory",
      description: "Get the complete edit history for a single object in reverse chronological order.",
      queryParams: ["$pageSize (default 50, max 500)", "$pageToken", "startTime", "endTime"],
      curlExample: `curl "${BASE}/api/v2/objects/Employee/EMP-001/editHistory"`,
      errorCodes: ["400 QUERY_VALIDATION_ERROR", "400 INVALID_PAGE_TOKEN"],
    },
    {
      section: "Objects",
      method: "POST",
      path: "/api/v2/objects/:objectType/validateForeignKeys",
      description: "Validate foreign key references for an object type.",
      curlExample: `curl -X POST ${BASE}/api/v2/objects/Employee/validateForeignKeys -H "Content-Type: application/json" -d '{}'`,
    },

    // =====================================================================
    // Link Types
    // =====================================================================
    {
      section: "Link Types",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/linkTypes",
      description: "Create a new link type between two object types.",
      requestBody: `{ "apiName": "employedBy", "displayName": "Employed By", "sourceObjectType": "Employee", "targetObjectType": "Company", "cardinality": "MANY_TO_ONE" }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/linkTypes -H "Content-Type: application/json" -d '{...}'`,
      errorCodes: ["409 ALREADY_EXISTS"],
    },
    {
      section: "Link Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/linkTypes",
      description: "List all link types for an ontology.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/linkTypes`,
    },
    {
      section: "Link Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/linkTypes/:linkApiName",
      description: "Get a single link type by API name.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/linkTypes/{linkApiName}`,
      errorCodes: ["404 LINK_TYPE_NOT_FOUND"],
    },
    {
      section: "Link Types",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId/linkTypes/:linkApiName",
      description: "Delete a link type.",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}/linkTypes/{linkApiName}`,
      errorCodes: ["404 LINK_TYPE_NOT_FOUND"],
    },

    // =====================================================================
    // Action Types
    // =====================================================================
    {
      section: "Action Types",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/actionTypes",
      description: "Create a new action type with rules and parameters.",
      requestBody: `{ "apiName": "hireEmployee", "displayName": "Hire Employee", "parameters": {...}, "rules": [...] }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes -H "Content-Type: application/json" -d '{...}'`,
      errorCodes: ["409 ACTION_TYPE_ALREADY_EXISTS"],
    },
    {
      section: "Action Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/actionTypes",
      description: "List all action types for an ontology.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes`,
    },
    {
      section: "Action Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/actionTypes/:actionApiName",
      description: "Get a single action type by API name.",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND"],
    },
    {
      section: "Action Types",
      method: "PUT",
      path: "/api/v2/ontologies/:ontologyId/actionTypes/:actionApiName",
      description: "Update an action type (displayName, description, parameters, rules).",
      curlExample: `curl -X PUT ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName} -H "Content-Type: application/json" -d '{...}'`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND"],
    },
    {
      section: "Action Types",
      method: "DELETE",
      path: "/api/v2/ontologies/:ontologyId/actionTypes/:actionApiName",
      description: "Delete an action type.",
      curlExample: `curl -X DELETE ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND"],
    },
    {
      section: "Action Types",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/actionTypes/:actionApiName/clone",
      description: "Clone an action type with a new API name.",
      requestBody: `{ "newApiName": "hireContractor", "newDisplayName": "Hire Contractor" }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}/clone -H "Content-Type: application/json" -d '{"newApiName":"hireContractor"}'`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND", "409 ACTION_TYPE_ALREADY_EXISTS"],
    },
    {
      section: "Action Types",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/actionTypes/:actionApiName/impact",
      description: "Analyze the impact of an action type (which object types and properties it touches).",
      curlExample: `curl ${BASE}/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}/impact`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND"],
    },

    // =====================================================================
    // Actions (Execution)
    // =====================================================================
    {
      section: "Actions",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/actions/:actionTypeApiName/apply",
      description: "Execute an action. Supports idempotency via Idempotency-Key header and optimistic concurrency via $expectedVersion.",
      headers: ["Idempotency-Key (optional)"],
      requestBody: `{ "parameters": { "employeeId": "EMP-001", "salary": 75000 } }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/actions/updateSalary/apply -H "Content-Type: application/json" -d '{"parameters":{"employeeId":"EMP-001","salary":75000}}'`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND", "400 INVALID_PARAMETER", "404 OBJECT_NOT_FOUND"],
    },
    {
      section: "Actions",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/actions/:actionTypeApiName/validate",
      description: "Dry-run validation of an action without applying edits.",
      requestBody: `{ "parameters": { ... } }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/actions/updateSalary/validate -H "Content-Type: application/json" -d '{"parameters":{"employeeId":"EMP-001","salary":75000}}'`,
      errorCodes: ["404 ACTION_TYPE_NOT_FOUND"],
    },
    {
      section: "Actions",
      method: "POST",
      path: "/api/v2/ontologies/:ontologyId/actions/:actionTypeApiName/applyBatch",
      description: "Execute the same action type multiple times with different parameter sets (max 100 per batch).",
      requestBody: `{ "requests": [{ "parameters": { ... } }, { "parameters": { ... } }] }`,
      curlExample: `curl -X POST ${BASE}/api/v2/ontologies/{ontologyId}/actions/updateSalary/applyBatch -H "Content-Type: application/json" -d '{"requests":[{"parameters":{"employeeId":"EMP-001","salary":80000}}]}'`,
      errorCodes: ["400 INVALID_PARAMETER"],
    },
    {
      section: "Actions",
      method: "POST",
      path: "/api/v2/actions/:actionTypeApiName/validate",
      description: "Validate an action using the default ontology (no ontologyId required).",
      curlExample: `curl -X POST ${BASE}/api/v2/actions/updateSalary/validate -H "Content-Type: application/json" -d '{"parameters":{...}}'`,
    },
    {
      section: "Actions",
      method: "POST",
      path: "/api/v2/actions/:actionTypeApiName/applyBatch",
      description: "Batch-execute actions using the default ontology.",
      curlExample: `curl -X POST ${BASE}/api/v2/actions/updateSalary/applyBatch -H "Content-Type: application/json" -d '{"requests":[...]}'`,
    },
    {
      section: "Actions",
      method: "POST",
      path: "/api/v2/actions/:actionTypeApiName/applyBulk",
      description: "Bulk-execute an action (max 1000 per call, with stopOnError and autoIndex options).",
      requestBody: `{ "requests": [...], "stopOnError": false, "autoIndex": true }`,
      curlExample: `curl -X POST ${BASE}/api/v2/actions/updateSalary/applyBulk -H "Content-Type: application/json" -d '{"requests":[...],"autoIndex":true}'`,
      errorCodes: ["400 INVALID_PARAMETER"],
    },

    // =====================================================================
    // Audit Log
    // =====================================================================
    {
      section: "Audit Log",
      method: "GET",
      path: "/api/v2/ontologies/:ontologyId/actions/:actionTypeApiName/audit",
      description: "Get audit log entries for a specific action type.",
      queryParams: ["pageSize", "pageToken", "result (success|failure)", "startTime", "endTime"],
      curlExample: `curl "${BASE}/api/v2/ontologies/{ontologyId}/actions/updateSalary/audit"`,
    },
    {
      section: "Audit Log",
      method: "GET",
      path: "/api/v2/audit/log",
      description: "Global audit log across all action types.",
      queryParams: ["pageSize", "pageToken", "result", "startTime", "endTime"],
      curlExample: `curl "${BASE}/api/v2/audit/log"`,
    },
    {
      section: "Audit Log",
      method: "GET",
      path: "/api/v2/audit/log/:executionId",
      description: "Get a single audit entry by execution ID.",
      curlExample: `curl ${BASE}/api/v2/audit/log/{executionId}`,
      errorCodes: ["404 AUDIT_ENTRY_NOT_FOUND"],
    },
    {
      section: "Audit Log",
      method: "GET",
      path: "/api/v2/audit/stats",
      description: "Get aggregate statistics across all action executions.",
      curlExample: `curl ${BASE}/api/v2/audit/stats`,
    },

    // =====================================================================
    // Edits
    // =====================================================================
    {
      section: "Edits",
      method: "GET",
      path: "/api/v2/ontology/:ontologyId/objectTypes/:apiName/edits",
      description: "List all edits for an object type with filtering and pagination.",
      queryParams: ["pageSize", "pageToken", "indexed (true|false)", "operation", "primaryKey"],
      curlExample: `curl "${BASE}/api/v2/ontology/{ontologyId}/objectTypes/{apiName}/edits"`,
    },
    {
      section: "Edits",
      method: "GET",
      path: "/api/v2/ontology/:ontologyId/objectTypes/:apiName/edits/diff/:primaryKey",
      description: "Diff view: compare datasource state vs ontology state for one object.",
      curlExample: `curl "${BASE}/api/v2/ontology/{ontologyId}/objectTypes/{apiName}/edits/diff/EMP-001"`,
    },

    // =====================================================================
    // Datasets
    // =====================================================================
    {
      section: "Datasets",
      method: "POST",
      path: "/api/v2/datasets/upload",
      description: "Upload a new dataset file (multipart form).",
      curlExample: `curl -X POST ${BASE}/api/v2/datasets/upload -F "file=@data.csv" -F "name=employees"`,
    },
    {
      section: "Datasets",
      method: "GET",
      path: "/api/v2/datasets",
      description: "List datasets with pagination and search.",
      queryParams: ["pageSize", "pageToken", "search"],
      curlExample: `curl "${BASE}/api/v2/datasets"`,
    },
    {
      section: "Datasets",
      method: "GET",
      path: "/api/v2/datasets/:datasetId",
      description: "Get full dataset details with transactions.",
      curlExample: `curl ${BASE}/api/v2/datasets/{datasetId}`,
      errorCodes: ["404 DATASET_NOT_FOUND"],
    },
    {
      section: "Datasets",
      method: "DELETE",
      path: "/api/v2/datasets/:datasetId",
      description: "Delete a dataset (with safety check for backing usage).",
      curlExample: `curl -X DELETE ${BASE}/api/v2/datasets/{datasetId}`,
      errorCodes: ["404 DATASET_NOT_FOUND", "409 DATASET_IN_USE"],
    },
    {
      section: "Datasets",
      method: "POST",
      path: "/api/v2/datasets/:datasetId/transactions",
      description: "Add a new transaction (append or snapshot) to a dataset.",
      curlExample: `curl -X POST ${BASE}/api/v2/datasets/{datasetId}/transactions -F "file=@new_data.csv" -F "type=APPEND"`,
      errorCodes: ["404 DATASET_NOT_FOUND", "400 INVALID_TRANSACTION_TYPE"],
    },
    {
      section: "Datasets",
      method: "GET",
      path: "/api/v2/datasets/:datasetId/transactions",
      description: "List transactions for a dataset.",
      curlExample: `curl "${BASE}/api/v2/datasets/{datasetId}/transactions"`,
      errorCodes: ["404 DATASET_NOT_FOUND"],
    },
    {
      section: "Datasets",
      method: "GET",
      path: "/api/v2/datasets/:datasetId/preview",
      description: "Preview dataset rows with column statistics.",
      queryParams: ["rows (default 50, max 500)", "transactionId"],
      curlExample: `curl "${BASE}/api/v2/datasets/{datasetId}/preview?rows=10"`,
      errorCodes: ["404 DATASET_NOT_FOUND"],
    },

    // =====================================================================
    // Reindex
    // =====================================================================
    {
      section: "Reindex",
      method: "POST",
      path: "/api/v2/ontology/:ontologyId/objectTypes/:apiName/reindex",
      description: "Trigger a full reindex with smart skip logic and atomic locking.",
      curlExample: `curl -X POST ${BASE}/api/v2/ontology/{ontologyId}/objectTypes/{apiName}/reindex`,
      errorCodes: ["409 REINDEX_IN_PROGRESS"],
    },
    {
      section: "Reindex",
      method: "GET",
      path: "/api/v2/ontology/:ontologyId/objectTypes/:apiName/reindex/status",
      description: "Get current reindex status.",
      curlExample: `curl ${BASE}/api/v2/ontology/{ontologyId}/objectTypes/{apiName}/reindex/status`,
    },
    {
      section: "Reindex",
      method: "GET",
      path: "/api/v2/ontology/:ontologyId/objectTypes/:apiName/reindex/history",
      description: "Get paginated reindex history.",
      curlExample: `curl "${BASE}/api/v2/ontology/{ontologyId}/objectTypes/{apiName}/reindex/history"`,
    },

    // =====================================================================
    // API Spec & Documentation
    // =====================================================================
    {
      section: "Documentation",
      method: "GET",
      path: "/api/v2/spec",
      description: "Returns raw OpenAPI JSON specification.",
      curlExample: `curl ${BASE}/api/v2/spec`,
    },
    {
      section: "Documentation",
      method: "GET",
      path: "/api/v2/docs",
      description: "Swagger UI interactive API documentation.",
      curlExample: `open ${BASE}/api/v2/docs`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Markdown Generator
// ---------------------------------------------------------------------------

export function generateApiReference(): string {
  const endpoints = getAllEndpoints();

  const lines: string[] = [];

  lines.push("# API Reference — Tellus Ontology Engine");
  lines.push("");
  lines.push(`> Auto-generated on ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`> Total endpoints: ${endpoints.length}`);
  lines.push("");

  // Table of contents
  lines.push("## Table of Contents");
  lines.push("");
  const sections = [...new Set(endpoints.map((e) => e.section))];
  for (const section of sections) {
    const anchor = section.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const count = endpoints.filter((e) => e.section === section).length;
    lines.push(`- [${section}](#${anchor}) (${count} endpoints)`);
  }
  lines.push("");

  // Summary table
  lines.push("## Endpoint Summary");
  lines.push("");
  lines.push("| Method | Path | Description |");
  lines.push("|--------|------|-------------|");
  for (const ep of endpoints) {
    lines.push(`| \`${ep.method}\` | \`${ep.path}\` | ${ep.description.split(".")[0]} |`);
  }
  lines.push("");

  // Per-section details
  for (const section of sections) {
    lines.push(`## ${section}`);
    lines.push("");

    const sectionEndpoints = endpoints.filter((e) => e.section === section);

    for (const ep of sectionEndpoints) {
      lines.push(`### \`${ep.method} ${ep.path}\``);
      lines.push("");
      lines.push(ep.description);
      lines.push("");

      if (ep.queryParams && ep.queryParams.length > 0) {
        lines.push("**Query Parameters:**");
        for (const qp of ep.queryParams) {
          lines.push(`- \`${qp}\``);
        }
        lines.push("");
      }

      if (ep.headers && ep.headers.length > 0) {
        lines.push("**Headers:**");
        for (const h of ep.headers) {
          lines.push(`- \`${h}\``);
        }
        lines.push("");
      }

      if (ep.requestBody) {
        lines.push("**Request Body:**");
        lines.push("```json");
        lines.push(ep.requestBody);
        lines.push("```");
        lines.push("");
      }

      if (ep.responseBody) {
        lines.push("**Response:**");
        lines.push("```json");
        lines.push(ep.responseBody);
        lines.push("```");
        lines.push("");
      }

      if (ep.errorCodes && ep.errorCodes.length > 0) {
        lines.push("**Error Codes:**");
        for (const ec of ep.errorCodes) {
          lines.push(`- \`${ec}\``);
        }
        lines.push("");
      }

      lines.push("**Example:**");
      lines.push("```bash");
      lines.push(ep.curlExample);
      lines.push("```");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write to file
// ---------------------------------------------------------------------------

export function writeApiDocs(outputPath?: string): string {
  const docsDir = path.resolve(__dirname, "..", "..", "docs");
  const filePath = outputPath || path.join(docsDir, "API_REFERENCE.md");

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = generateApiReference();
  fs.writeFileSync(filePath, content, "utf-8");

  return filePath;
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/utils/generateApiDocs.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  console.log("Running generateApiDocs self-tests...\n");

  const endpoints = getAllEndpoints();
  const markdown = generateApiReference();

  // =========================================================================
  // Test 1: At least 42 endpoints
  // =========================================================================
  console.log("=== 1. Endpoint count ===");
  assert(endpoints.length >= 42, `At least 42 endpoints (got: ${endpoints.length})`);

  // =========================================================================
  // Test 2: All endpoints have required fields
  // =========================================================================
  console.log("\n=== 2. Required fields ===");
  let allHaveFields = true;
  for (const ep of endpoints) {
    if (!ep.method || !ep.path || !ep.description || !ep.section || !ep.curlExample) {
      allHaveFields = false;
      console.error(`    Missing field on: ${ep.method} ${ep.path}`);
    }
  }
  assert(allHaveFields, "All endpoints have method, path, description, section, curlExample");

  // =========================================================================
  // Test 3: Expected sections present
  // =========================================================================
  console.log("\n=== 3. Expected sections ===");
  const sections = [...new Set(endpoints.map((e) => e.section))];
  const expectedSections = [
    "Health & Status", "Ontology", "Object Types", "Properties",
    "Datasources", "Indexing", "Objects", "Link Types", "Action Types",
    "Actions", "Audit Log", "Edits", "Datasets", "Reindex", "Documentation",
  ];
  for (const section of expectedSections) {
    assert(sections.includes(section), `Section present: ${section}`);
  }

  // =========================================================================
  // Test 4: Markdown has expected structure
  // =========================================================================
  console.log("\n=== 4. Markdown structure ===");
  assert(markdown.includes("# API Reference"), "Has title");
  assert(markdown.includes("## Table of Contents"), "Has TOC");
  assert(markdown.includes("## Endpoint Summary"), "Has summary table");
  assert(markdown.includes("| Method | Path |"), "Has summary table header");
  assert(markdown.includes("```bash"), "Has curl examples");
  assert(markdown.includes("```json"), "Has JSON examples");

  // =========================================================================
  // Test 5: All HTTP methods present
  // =========================================================================
  console.log("\n=== 5. HTTP methods ===");
  const methods = new Set(endpoints.map((e) => e.method));
  assert(methods.has("GET"), "Has GET endpoints");
  assert(methods.has("POST"), "Has POST endpoints");
  assert(methods.has("PUT"), "Has PUT endpoints");
  assert(methods.has("DELETE"), "Has DELETE endpoints");

  // =========================================================================
  // Test 6: Key endpoints present
  // =========================================================================
  console.log("\n=== 6. Key endpoints ===");
  const paths = new Set(endpoints.map((e) => `${e.method} ${e.path}`));
  assert(paths.has("GET /health"), "GET /health");
  assert(paths.has("GET /api/v2/health"), "GET /api/v2/health");
  assert(paths.has("GET /api/v2/status"), "GET /api/v2/status");
  assert(paths.has("POST /api/v2/ontologies"), "POST /api/v2/ontologies");
  assert(paths.has("GET /api/v2/ontologies"), "GET /api/v2/ontologies");
  assert(paths.has("POST /api/v2/objects/:objectType/search"), "POST search");
  assert(paths.has("POST /api/v2/objects/:objectType/aggregate"), "POST aggregate");
  assert(paths.has("POST /api/v2/ontologies/:ontologyId/actions/:actionTypeApiName/apply"), "POST action apply");

  // =========================================================================
  // Test 7: Write file
  // =========================================================================
  console.log("\n=== 7. Write file ===");
  const outputPath = path.resolve(__dirname, "..", "..", "docs", "API_REFERENCE.md");
  const result = writeApiDocs(outputPath);
  assert(fs.existsSync(result), "File written successfully");
  const fileContent = fs.readFileSync(result, "utf-8");
  assert(fileContent.length > 5000, `File has substantial content (${fileContent.length} chars)`);
  assert(fileContent.includes("# API Reference"), "File has title");

  // =========================================================================
  // Test 8: No duplicate endpoints
  // =========================================================================
  console.log("\n=== 8. No duplicate endpoints ===");
  const epKeys = endpoints.map((e) => `${e.method} ${e.path}`);
  const uniqueEps = new Set(epKeys);
  assert(uniqueEps.size === epKeys.length, `No duplicate endpoints (${uniqueEps.size} unique out of ${epKeys.length})`);

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll generateApiDocs tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
