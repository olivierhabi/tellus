# Object Set Service — Query API Reference

## 1. Overview

The Object Set Service is the query layer of the Ontology Engine. It provides read-only access to indexed objects stored in OpenSearch, supporting filtered search, full-text search, aggregations, and cursor-based pagination. Every application that displays, filters, or summarizes ontology objects uses these endpoints.

The service sits between the consumer (REST client, OSDK, Workshop widgets) and OpenSearch. It translates a high-level query DSL into OpenSearch Query DSL, executes the query, and formats the response into the Palantir-compatible API shape.

## 2. Authentication

**Week 1 implementation:** No authentication is required. All endpoints are publicly accessible.

**Planned format:** Future versions will require a Bearer token:
```
Authorization: Bearer <token>
```

## 3. Common Response Format

### Success (list/search)

```json
{
  "data": [ { "__primaryKey": "EMP-001", "__objectType": "Employee", ... } ],
  "nextPageToken": "eyJ..." | null,
  "totalCount": 1523
}
```

### Success (single object)

```json
{
  "__primaryKey": "EMP-001",
  "__objectType": "Employee",
  "fullName": "Melissa Chang",
  "salary": 145000
}
```

### Success (aggregation)

```json
{
  "data": {
    "totalEmployees": 1523,
    "avgSalary": 125340.50
  }
}
```

### Error

```json
{
  "error": {
    "code": "OBJECT_TYPE_NOT_FOUND",
    "message": "Object type 'Employe' not found. Available object types: Employee, Company.",
    "details": { "objectType": "Employe", "availableTypes": ["Employee", "Company"] },
    "timestamp": "2025-03-12T10:30:00.000Z"
  }
}
```

## 4. Endpoints Reference

---

### 4.1 List Objects

```
GET /api/v1/objects/:objectType
```

Returns all objects of a given type with optional pagination and sorting.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `$pageSize` | integer | 100 | Objects per page (1–10,000) |
| `$pageToken` | string | — | Cursor for pagination |
| `$orderBy` | string | `__pk:asc` | Sort: `"salary:desc,fullName:asc"` |
| `$select` | string | all | Comma-separated fields: `"fullName,salary"` |

**Example:**
```
GET /api/v1/objects/Employee?$pageSize=10&$orderBy=salary:desc&$select=fullName,salary
```

**Response:** `200 OK`
```json
{
  "data": [
    { "__primaryKey": "EMP-001", "__objectType": "Employee", "fullName": "Melissa Chang", "salary": 145000 }
  ],
  "nextPageToken": "eyJ...",
  "totalCount": 100
}
```

**Errors:**
- `404 OBJECT_TYPE_NOT_FOUND` — Object type does not exist
- `400 INVALID_QUERY` — Invalid `$pageSize` (0, negative, >10000)
- `400 PROPERTY_NOT_FOUND` — Unknown property in `$orderBy` or `$select`

---

### 4.2 Get Single Object

```
GET /api/v1/objects/:objectType/:primaryKey
```

Retrieves a single object by its primary key using a direct O(1) lookup.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `$select` | string | all | Comma-separated fields to include |

**Example:**
```
GET /api/v1/objects/Employee/EMP-001
```

**Response:** `200 OK`
```json
{
  "__primaryKey": "EMP-001",
  "__objectType": "Employee",
  "fullName": "Melissa Chang",
  "email": "melissa.chang@acme.com",
  "salary": 145000,
  "department": "Engineering",
  "startDate": "2021-03-15",
  "isActive": true
}
```

**Errors:**
- `404 OBJECT_TYPE_NOT_FOUND` — Object type does not exist
- `404 OBJECT_NOT_FOUND` — No object with that primary key

---

### 4.3 Search Objects

```
POST /api/v1/objects/:objectType/search
Content-Type: application/json
```

The primary search endpoint. Supports the full filter DSL with compound operators, pagination, sorting, and property selection.

**Request Body:**

```json
{
  "where": { "type": "eq", "field": "department", "value": "Engineering" },
  "$orderBy": [{ "field": "salary", "direction": "desc" }],
  "$pageSize": 50,
  "$pageToken": null,
  "$select": ["fullName", "salary", "department"]
}
```

All fields are optional. An empty body `{}` returns all objects (match_all).

**Allowed top-level fields:** `where`, `$orderBy`, `$pageSize`, `$pageToken`, `$select`. Any unexpected field causes a `400` error.

**Example — compound filter:**
```json
{
  "where": {
    "type": "and",
    "value": [
      { "type": "eq", "field": "department", "value": "Engineering" },
      { "type": "gt", "field": "salary", "value": 100000 },
      { "type": "not", "value": [{ "type": "eq", "field": "isActive", "value": false }] }
    ]
  },
  "$pageSize": 20
}
```

**Errors:**
- `404 OBJECT_TYPE_NOT_FOUND`
- `400 INVALID_QUERY` — Unknown filter type, unexpected field, invalid `$pageSize`, empty `$select`, nesting too deep
- `400 PROPERTY_NOT_FOUND` — Unknown property in filter, `$orderBy`, or `$select`
- `400 INCOMPATIBLE_FILTER` — Filter type incompatible with property type

---

### 4.4 Aggregate Objects

```
POST /api/v1/objects/:objectType/aggregate
Content-Type: application/json
```

Computes statistical summaries over a set of objects. Returns computed values, not individual objects.

**Request Body:**

```json
{
  "where": { "type": "eq", "field": "department", "value": "Engineering" },
  "aggregations": [
    { "type": "count", "name": "totalEmployees" },
    { "type": "avg", "field": "salary", "name": "avgSalary" },
    { "type": "terms", "field": "department", "name": "byDept", "size": 10 }
  ]
}
```

The `aggregations` array is **required** and must be non-empty (max 25).

**Response:** `200 OK`
```json
{
  "data": {
    "totalEmployees": 450,
    "avgSalary": 142350.75,
    "byDept": [
      { "key": "Engineering", "count": 200 },
      { "key": "Sales", "count": 120 }
    ]
  }
}
```

**Errors:**
- `404 OBJECT_TYPE_NOT_FOUND`
- `400 INVALID_QUERY` — Missing or empty aggregations array
- `400 INVALID_AGGREGATION` — Type mismatch (e.g., `avg` on string), duplicate names

---

### 4.5 Full-Text Search

```
POST /api/v1/objects/:objectType/searchFullText
Content-Type: application/json
```

Searches across ALL text properties simultaneously with relevance ranking, fuzzy matching, and highlighting.

**Request Body:**

```json
{
  "query": "melissa chang engineering",
  "where": { "type": "eq", "field": "isActive", "value": true },
  "$pageSize": 20,
  "$select": ["fullName", "department", "email"]
}
```

The `query` field is **required** (non-empty string, max 1000 characters).

**Response:** `200 OK`
```json
{
  "data": [
    {
      "__primaryKey": "EMP-001",
      "__objectType": "Employee",
      "fullName": "Melissa Chang",
      "department": "Engineering",
      "email": "melissa.chang@acme.com",
      "__highlights": {
        "fullName": ["<mark>Melissa</mark> <mark>Chang</mark>"],
        "department": ["<mark>Engineering</mark>"]
      }
    }
  ],
  "nextPageToken": null,
  "totalCount": 1
}
```

**Key differences from `/search`:**
- Default sort is `_score` descending (relevance), not `__pk` ascending
- Response includes `__highlights` with `<mark>` tags around matched terms
- Uses `multi_match` with `cross_fields` type and `fuzziness: "AUTO"`

**Errors:**
- `400 INVALID_QUERY` — Empty query string or exceeds 1000 characters
- `404 OBJECT_TYPE_NOT_FOUND`

---

## 5. Filter DSL Reference

### Supported Filter Types (13 total)

#### Leaf Filters

| Type | Description | Required Fields | Value Type |
|---|---|---|---|
| `eq` | Equals | `field`, `value` | Primitive matching property type |
| `gt` | Greater than | `field`, `value` | Number, date string, or string |
| `gte` | Greater than or equal | `field`, `value` | Number, date string, or string |
| `lt` | Less than | `field`, `value` | Number, date string, or string |
| `lte` | Less than or equal | `field`, `value` | Number, date string, or string |
| `contains` | Full-text match | `field`, `value` | String only |
| `startsWith` | Prefix match | `field`, `value` | String only |
| `isNull` | Field is null/missing | `field` | No value |
| `isNotNull` | Field has value | `field` | No value |
| `in` | Matches any in array | `field`, `value` | Array (max 10,000 elements) |

#### Compound Filters

| Type | Description | Value |
|---|---|---|
| `and` | All must match | Array of sub-filters (1–100 elements) |
| `or` | At least one must match | Array of sub-filters (1–100 elements) |
| `not` | Must not match | Array with exactly 1 sub-filter |

#### Type Compatibility

| Property Type | eq | gt/gte/lt/lte | contains | startsWith | in | isNull |
|---|---|---|---|---|---|---|
| string | `.keyword` | `.keyword` | text field | `.keyword` | `.keyword` | base field |
| integer/long | direct | direct | N/A | N/A | direct | base field |
| double/float | direct | direct | N/A | N/A | direct | base field |
| boolean | direct | N/A | N/A | N/A | direct | base field |
| date | direct | direct | N/A | N/A | direct | base field |
| timestamp | direct | direct | N/A | N/A | direct | base field |
| geopoint | N/A | N/A | N/A | N/A | N/A | base field |

**Maximum nesting depth:** 10 levels.

#### Examples

**eq on string:**
```json
{ "type": "eq", "field": "department", "value": "Engineering" }
```

**Range filter:**
```json
{ "type": "gt", "field": "salary", "value": 100000 }
```

**Compound and:**
```json
{
  "type": "and",
  "value": [
    { "type": "eq", "field": "department", "value": "Engineering" },
    { "type": "gt", "field": "salary", "value": 100000 }
  ]
}
```

**Not filter:**
```json
{
  "type": "not",
  "value": [{ "type": "eq", "field": "isActive", "value": false }]
}
```

**In filter:**
```json
{ "type": "in", "field": "department", "value": ["Engineering", "Sales", "Marketing"] }
```

---

## 6. Aggregation Reference

### Supported Types (9 total)

| Type | Requires `field` | Extra Params | Compatible Types |
|---|---|---|---|
| `count` | No | — | All (counts total matching objects) |
| `avg` | Yes | — | Numeric only |
| `sum` | Yes | — | Numeric only |
| `min` | Yes | — | Numeric, date, timestamp |
| `max` | Yes | — | Numeric, date, timestamp |
| `terms` | Yes | `size` (1–1000, default 10) | All except geo, struct |
| `date_histogram` | Yes | `interval` (required) | date, timestamp only |
| `range` | Yes | `ranges` (required) | Numeric only |
| `cardinality` | Yes | — | All except struct |

### Interval Values for `date_histogram`

`year`, `quarter`, `month`, `week`, `day`, `hour`, `minute`

### Example — Multiple Aggregations

```json
{
  "aggregations": [
    { "type": "count", "name": "total" },
    { "type": "avg", "field": "salary", "name": "avgSalary" },
    { "type": "terms", "field": "department", "name": "byDept", "size": 20 },
    { "type": "date_histogram", "field": "startDate", "interval": "year", "name": "byYear" }
  ]
}
```

---

## 7. Pagination Reference

The API uses **cursor-based pagination** with opaque page tokens. This ensures stable pagination even as data changes.

### How It Works

1. First request: omit `$pageToken`. Server returns `nextPageToken` if more pages exist.
2. Subsequent requests: pass the `nextPageToken` from the previous response.
3. Continue until `nextPageToken` is `null` (last page).

### Page Token Behavior

- Tokens encode: sort values, object type, sort order, query hash, creation timestamp
- Tokens expire after 24 hours
- Tokens are validated against the current object type — using a token from one object type on another returns `400 INVALID_PAGE_TOKEN`
- Changing the `where` clause while reusing a token returns `400 INVALID_PAGE_TOKEN`

### Default Sort Order

| Endpoint | Default Sort |
|---|---|
| List (`GET`) | `__pk` ascending |
| Search (`POST /search`) | `__pk` ascending |
| Full-Text Search (`POST /searchFullText`) | `_score` descending (relevance) |

A `__pk` tiebreaker is always appended to ensure deterministic ordering.

---

## 8. Property Type Reference

| Base Type | OpenSearch Mapping | Supports Exact Match | Supports Range | Supports Full-Text | Supports Geo |
|---|---|---|---|---|---|
| `string` | text + keyword | Yes (`.keyword`) | Yes (`.keyword`) | Yes | No |
| `boolean` | boolean | Yes | No | No | No |
| `integer` | integer | Yes | Yes | No | No |
| `long` | long | Yes | Yes | No | No |
| `double` | double | Yes | Yes | No | No |
| `float` | float | Yes | Yes | No | No |
| `decimal` | double | Yes | Yes | No | No |
| `byte` | byte | Yes | Yes | No | No |
| `short` | short | Yes | Yes | No | No |
| `date` | date (`yyyy-MM-dd`) | Yes | Yes | No | No |
| `timestamp` | date (ISO 8601) | Yes | Yes | No | No |
| `geopoint` | geo_point | No | No | No | Yes |
| `geoshape` | geo_shape | No | No | No | Yes |
| `struct` | object | No | No | No | No |

**Array types** (`string_array`, `integer_array`, etc.) follow the same rules as their base type. OpenSearch natively handles arrays — a term query on an array field matches if ANY element matches.

### System Fields

These exist on every object and do not need to be defined in the property table:

| Field | Type | Description |
|---|---|---|
| `__pk` | keyword | Primary key value |
| `__objectType` | keyword | Object type API name |
| `__lastModified` | date | Last modification timestamp |
| `__version` | long | Document version |

In API responses, `__pk` becomes `__primaryKey` and `__objectType` is preserved.

---

## 9. Error Code Reference

| Code | HTTP Status | Description | Resolution |
|---|---|---|---|
| `OBJECT_TYPE_NOT_FOUND` | 404 | Object type does not exist | Check spelling; response lists available types |
| `OBJECT_NOT_FOUND` | 404 | No object with that primary key | Verify the primary key value |
| `PROPERTY_NOT_FOUND` | 400 | Property does not exist on the object type | Check spelling; response includes "Did you mean?" suggestions |
| `INVALID_QUERY` | 400 | Malformed query (bad filter, invalid pageSize, etc.) | Read the error message for specifics |
| `INCOMPATIBLE_FILTER` | 400 | Filter type not compatible with property type | Use a compatible filter (e.g., `eq` instead of `contains` on numbers) |
| `INVALID_PAGE_TOKEN` | 400 | Page token is invalid, expired, or for wrong type | Start pagination from the beginning |
| `INVALID_AGGREGATION` | 400 | Aggregation type incompatible with field type | Check type compatibility table |
| `OBJECT_DATABASE_UNAVAILABLE` | 503 | OpenSearch is down or unreachable | Retry after a brief pause |
| `METADATA_STORE_UNAVAILABLE` | 503 | PostgreSQL is down or unreachable | Retry after a brief pause |
| `INTERNAL_ERROR` | 500 | Unexpected server error | Contact support with the `X-Request-Id` header value |

---

## 10. Limits and Constraints

| Limit | Value | Reference |
|---|---|---|
| Default page size | 100 | Palantir default |
| Minimum page size | 1 | — |
| Maximum page size | 10,000 | Palantir limit |
| Maximum `in` clause values | 10,000 | Palantir limit |
| Maximum filter nesting depth | 10 | Prevents query explosion |
| Maximum compound filter children | 100 | Prevents overly complex queries |
| Maximum `$orderBy` fields | 5 | Practical sort limit |
| Maximum aggregations per request | 25 | Prevents expensive queries |
| Maximum `terms` bucket size | 1,000 | OpenSearch practical limit |
| Default `terms` bucket size | 10 | — |
| Maximum search query length | 1,000 chars | Prevents abuse |
| Page token expiry | 24 hours | Prevents stale cursors |
| Property cache TTL | 60 seconds | Balance freshness vs. performance |
| OpenSearch query timeout | 30 seconds | Prevents indefinite hangs |
| Slow query warning threshold | 5,000 ms | Logged for monitoring |
| Maximum properties per object type | 2,000 | Palantir limit |
| OpenSearch retry attempts | 3 | Transient error recovery |
| Retry backoff | 100ms, 400ms, 1600ms | Exponential backoff |
