# Link System Architecture & API Reference

## 1. Architecture Overview

The Link subsystem defines typed, directed relationships between Object Types
in the Ontology. It mirrors Palantir's "Link Types" and "Search Around" concepts.

```
                    +-----------------+
                    |   PostgreSQL    |
                    |  (link_type)    |
                    +--------+--------+
                             |
                    +--------v--------+
                    | Link Resolver   |
                    |   Service       |
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v--------+
     | FK-based   |  | Join Table  |  | Multi-hop   |
     | Resolution |  | CSV (M2M)  |  | Traversal   |
     +--------+---+  +------+------+  +----+--------+
              |              |              |
              +--------------+--------------+
                             |
                    +--------v--------+
                    |   OpenSearch    |
                    | (object indices)|
                    +-----------------+
```

**Data flow:**
1. Link type definitions stored in PostgreSQL `link_type` table
2. Link Resolver queries OpenSearch indices using FK property values
3. M2M links use CSV join table files on disk
4. Results paginated and returned via REST API

## 2. Cardinality Reference

| Cardinality   | FK Side  | Resolution Strategy | Example |
|---------------|----------|---------------------|---------|
| ONE_TO_ONE    | Source or Target | FK lookup + single result | Employee -> Badge |
| ONE_TO_MANY   | Target   | Query target index where FK = source PK | Company -> Employees |
| MANY_TO_ONE   | Source   | Read source FK, get target by PK | Employee -> Company |
| MANY_TO_MANY  | Join CSV | Parse CSV, terms query on target PKs | Employee <-> Departments |

## 3. API Reference

### Link Type CRUD

#### Create Link Type
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes \
  -H "Content-Type: application/json" \
  -d '{
    "apiName": "companyEmployees",
    "displayName": "Company Employees",
    "cardinality": "ONE_TO_MANY",
    "sourceObjectTypeApiName": "Company",
    "targetObjectTypeApiName": "Employee",
    "targetPropertyApiName": "companyId"
  }'
```

#### List Link Types
```bash
curl http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes?pageSize=100
```

#### Get Link Type
```bash
curl http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees
```

#### Update Link Type
```bash
curl -X PUT http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees \
  -H "Content-Type: application/json" \
  -d '{"displayName": "Company -> Employees", "isBidirectional": true}'
```

#### Delete Link Type
```bash
curl -X DELETE http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees
```

### Link Resolution

#### Resolve Linked Objects
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees/resolve \
  -H "Content-Type: application/json" \
  -d '{"objectPK": "c1", "direction": "forward", "pageSize": 50}'
```

#### Object-Level Link Resolution
```bash
curl http://localhost:3000/api/v2/objects/Company/c1/links/companyEmployees
```

#### Link Count
```bash
curl http://localhost:3000/api/v2/objects/Company/c1/links/companyEmployees/count
```

#### Bulk Count
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/bulkCount \
  -H "Content-Type: application/json" \
  -d '{"objectTypeApiName": "Company", "objectPK": "c1"}'
```

#### Search Around
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees/searchAround \
  -H "Content-Type: application/json" \
  -d '{"direction": "forward", "sourceFilter": {"industry": "tech"}}'
```

#### Multi-Hop Traversal
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/multiHop \
  -H "Content-Type: application/json" \
  -d '{
    "startingPKs": ["c1"],
    "steps": [
      {"linkTypeApiName": "companyEmployees", "direction": "forward"},
      {"linkTypeApiName": "employeeDepartments", "direction": "forward"}
    ]
  }'
```

### Join Table Management

#### Upload Join Table CSV
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/employeeDepartments/upload \
  -F "file=@employee_departments.csv"
```

#### Validate Join Table
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/employeeDepartments/validate
```

### Analysis & Migration

#### Link Type Analysis
```bash
curl http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees/analysis
```

#### Validate Cardinality Migration
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/companyEmployees/validateMigration \
  -H "Content-Type: application/json" \
  -d '{"targetCardinality": "MANY_TO_MANY"}'
```

### Export / Import

#### Export
```bash
curl http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/export -o link-types.json
```

#### Import
```bash
curl -X POST http://localhost:3000/api/v2/ontologies/{ontologyId}/linkTypes/import \
  -H "Content-Type: application/json" \
  -d @link-types.json
```

## 4. Performance Characteristics

| Operation | Target Latency | Notes |
|-----------|---------------|-------|
| FK-based resolve | < 50ms | Single OpenSearch query |
| M2M resolve (CSV) | < 200ms | CSV parse + terms query |
| Link count (FK) | < 20ms | OpenSearch _count API |
| Link count (M2M) | < 100ms | CSV line scan |
| Search Around | < 500ms | Two-phase: source filter + bulk resolve |
| Multi-hop (2 hops) | < 1s | Sequential hop queries |
| Multi-hop (5 hops) | < 5s | Max allowed hops |
| Bulk count (10 types) | < 200ms | Parallel Promise.allSettled |

## 5. Palantir Parity Checklist

| Feature | Status |
|---------|--------|
| Link type CRUD | MATCHED |
| ONE_TO_ONE resolution | MATCHED |
| ONE_TO_MANY resolution | MATCHED |
| MANY_TO_ONE resolution | MATCHED |
| MANY_TO_MANY via join table | MATCHED |
| Bidirectional links | MATCHED |
| Self-referential links | MATCHED |
| Search Around (2-phase) | MATCHED |
| Reverse Search Around | MATCHED |
| Link counts | MATCHED |
| Bulk link counts | MATCHED |
| Multi-hop traversal | PARTIAL (max 5 hops, no graph caching) |
| Join table CSV upload | MATCHED |
| Join table validation | MATCHED |
| FK validation for actions | MATCHED (always valid, warnings only) |
| Link type export/import | MATCHED |
| Link analysis statistics | PARTIAL (simplified distribution) |
| Cardinality migration validation | PARTIAL (basic checks) |
| Link type on object type detail | MATCHED |
| OpenAPI documentation | MATCHED |

## 6. Known Limitations

1. **M2M CSV join tables** are stored on local disk — not suitable for
   multi-node deployments without shared storage.
2. **Multi-hop traversal** caps intermediate results at 100,000 PKs and
   maximum 5 hops.
3. **Search Around** caps source objects at 100,000.
4. **Link analysis distribution** is simplified for FK-based links
   (estimated, not exact percentiles).
5. **Join table validation** samples up to 10,000 keys per side.
6. **No real-time link count caching** — every count hits OpenSearch.

## 7. Future Work

- **Distributed join table storage** (S3/GCS) for multi-node deployments
- **Link count caching** with Redis/Memcached
- **Graph database backend** (Neptune/Neo4j) for multi-hop queries
- **Incremental join table updates** (append-only CSV)
- **Link type versioning** for schema evolution tracking
- **Async link validation** jobs for large datasets
- **Link-based aggregations** (e.g., sum of linked object properties)
- **WebSocket notifications** for link type changes
