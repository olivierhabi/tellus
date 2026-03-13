# TASK 11: Object View API — Single Object Complete View

## Objective
Build the Object View endpoint that returns a comprehensive, fully-resolved view of a single object. In Palantir's Foundry, Object Views are described as "a central hub for all information and workflows related to a particular object." This includes the object's properties, all linked objects (summarized), available actions, and which Interfaces the object's type implements. This single endpoint powers the Object Detail page in Object Explorer and the Object Views feature in Workshop.

## Exact Specification

**Endpoint:** `GET /api/v2/objects/:objectType/:primaryKey/view`

**OntologyId resolution:** This endpoint does not include `ontologyId` in its path. Resolve the `ontologyId` by looking up the Object Type in PostgreSQL: `SELECT ontology_id FROM object_type WHERE api_name = $1`. If no Object Type is found, return 404. If multiple ontologies contain an Object Type with this api_name (unlikely but possible), use the first result (Object Type apiNames are expected to be unique within a deployment).

This endpoint does NOT simply return the raw object from OpenSearch. It enriches the object with metadata from PostgreSQL (links, actions, interfaces) and provides a complete operational picture of what you can DO with this object and what it's CONNECTED to.

**Implementation Steps:**

Step 1: Fetch the object from OpenSearch.
Query the index `ontology-{objecttype}` (lowercase) for the document with `__pk` = the primaryKey URL parameter. If not found, return HTTP 404 with error code "OBJECT_NOT_FOUND" and message "No {objectType} object found with primary key '{primaryKey}'".

Step 2: Fetch the Object Type metadata from PostgreSQL.
Query the `object_type` table joined with the `property` table to get the complete schema. This provides the property display names, descriptions, base types, and whether each property is required. You need this to enrich the raw property values with metadata in the response.

Step 3: Fetch all Link Types where this Object Type is either the source or target.
Query the `link_type` table for rows where `source_object_type = objectType OR target_object_type = objectType`. For each link type found, determine the "direction" (outgoing if this type is the source, incoming if this type is the target, or both if it's a self-link).

Step 4: For each Link Type, count the linked objects.
For ONE_TO_MANY/MANY_TO_ONE links (foreign key based): Query the linked Object Type's OpenSearch index to count objects where the FK property equals this object's PK (or vice versa). Use the OpenSearch `_count` API for efficiency — do NOT fetch all linked objects just to count them.
For MANY_TO_MANY links (join table based): Count rows in the join table (in PostgreSQL) where the source or target column matches this object's PK.
Return the count for each link type, along with a small preview of up to 3 linked objects (fetch these with a `size: 3` query to OpenSearch). The preview objects should include only their primary key and title property (the property marked as `title_property_id` on the `object_type` table, which was created in Day 2). If an Object Type does not have a `title_property_id` set, use the primary key property's value as the preview title.

Step 5: Fetch available Action Types.
Query the `action_type` table for all Action Types in this Ontology whose `rules` JSONB contains any rule targeting this Object Type. Use a JSONB containment query:
```sql
SELECT api_name, display_name, description FROM action_type
WHERE ontology_id = $1
AND rules::text LIKE '%"objectType":"' || $2 || '"%'
```
This is a rough filter — in production, you'd index the rules JSONB properly. For week 1, this text-based search is acceptable. Return the list of Action Type api_names and display names that can operate on this Object Type.

Step 6: Fetch Interface implementations.
Query the `object_type_interface` table joined with `interface` to get all Interfaces this Object Type implements, with their property mappings.

Step 7: Assemble the response.

**Response (HTTP 200):**
```json
{
  "data": {
    "object": {
      "__primaryKey": "EMP-001",
      "__objectType": "Employee",
      "__lastModified": "2025-03-16T14:30:00.000Z",
      "properties": {
        "employeeId": {
          "value": "EMP-001",
          "displayName": "Employee ID",
          "baseType": "string",
          "isRequired": true
        },
        "fullName": {
          "value": "Melissa Chang",
          "displayName": "Full Name",
          "baseType": "string",
          "isRequired": false
        },
        "salary": {
          "value": 145000,
          "displayName": "Annual Salary",
          "baseType": "double",
          "isRequired": false
        },
        "startDate": {
          "value": "2019-03-15",
          "displayName": "Start Date",
          "baseType": "date",
          "isRequired": false
        },
        "department": {
          "value": "Engineering",
          "displayName": "Department",
          "baseType": "string",
          "isRequired": false
        }
      }
    },
    "links": [
      {
        "linkTypeApiName": "employeeCompany",
        "linkTypeDisplayName": "Employer",
        "direction": "outgoing",
        "targetObjectType": "Company",
        "count": 1,
        "preview": [
          { "__primaryKey": "COMP-001", "title": "Acme Corporation" }
        ]
      },
      {
        "linkTypeApiName": "assignedTickets",
        "linkTypeDisplayName": "Assigned Tickets",
        "direction": "outgoing",
        "targetObjectType": "Ticket",
        "count": 12,
        "preview": [
          { "__primaryKey": "TKT-101", "title": "Fix login bug" },
          { "__primaryKey": "TKT-102", "title": "Update dashboard" },
          { "__primaryKey": "TKT-103", "title": "Deploy v2.1" }
        ]
      }
    ],
    "availableActions": [
      {
        "apiName": "updateSalary",
        "displayName": "Update Salary",
        "description": "Change an employee's annual salary"
      },
      {
        "apiName": "transferDepartment",
        "displayName": "Transfer to Department",
        "description": "Move an employee to a different department"
      },
      {
        "apiName": "terminateEmployee",
        "displayName": "Terminate Employment",
        "description": "End employment and deactivate access"
      }
    ],
    "interfaces": [
      {
        "apiName": "Auditable",
        "displayName": "Is Auditable",
        "propertyMapping": {
          "createdDate": "startDate",
          "createdBy": "hiringManager"
        }
      }
    ]
  }
}
```

**Performance considerations:**
The Object View endpoint makes multiple database and OpenSearch queries. For week 1, sequential execution is acceptable. But structure the code so that independent queries (OpenSearch object fetch, PostgreSQL metadata fetch, link counts) can be parallelized with `Promise.all()` in a future optimization. The code should look like:

```javascript
const [object, objectTypeMeta, linkTypes, actionTypes, interfaces] = await Promise.all([
  fetchObjectFromOpenSearch(objectType, primaryKey),
  fetchObjectTypeMeta(ontologyId, objectType),
  fetchLinkTypes(ontologyId, objectType),
  fetchActionTypes(ontologyId, objectType),
  fetchInterfaces(ontologyId, objectType),
]);
```

Do NOT execute these sequentially with `await` on each line — that would be 5 sequential round-trips instead of 5 parallel ones. Use `Promise.all()` from day one.

For the link counts, these must still be sequential per link type (or use OpenSearch `_msearch` to batch them). Create an exported helper function `countLinkedObjects(linkType, objectType, primaryKey)` in `/src/services/objectViewService.js` that returns `{ count, preview }`. This service file is also used by Task 13 (batch Object Views).

## Verification
1. Create Employee, Company, Ticket object types with sample data
2. Create link types: Employee → Company, Employee → Ticket
3. Create action types: updateSalary, transferDepartment, terminateEmployee
4. Have Employee implement Auditable Interface
5. GET /objects/Employee/EMP-001/view → verify all sections populated
6. Verify link counts match actual data
7. Verify preview objects have only PK and title
8. Verify available actions are relevant to Employee type
9. Verify interface mapping is correct
10. GET /objects/Employee/NONEXISTENT → verify 404
