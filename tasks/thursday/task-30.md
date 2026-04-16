# TASK 30: Create Link System README and Architecture Documentation

**Objective:** Write comprehensive documentation for the link system in `docs/LINKS.md`. This serves as both developer documentation (for the human maintaining the system) and as the reference for future AI agent tasks that build on top of the link system (Workshop, OSDK, Agent Studio).

**Prerequisites:** Tasks 1-29 must be complete (all link system implementation and tests).

**Contents — write exactly these 7 sections:**

**Section 1: Architecture Overview**

Write a text-based diagram showing the flow from link type definition → FK/join table → resolver → API response. Include:
- The `link_type` PostgreSQL table as the metadata store.
- The four resolvers (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, MANY_TO_MANY) and the unified dispatcher (`resolveLink`).
- The OpenSearch indices as the data layer.
- The join table CSV files for M2M links.
- The API endpoints that expose link traversal.

**Section 2: Cardinality Reference**

Write a table with these exact columns: `Cardinality`, `Source`, `Target`, `FK Location`, `Resolution Strategy`, `Example`. Include one row for each of the 4 cardinalities with concrete examples (Company/Employee, Employee/Company, User/Profile, Student/Course).

**Section 3: API Reference**

Document every link endpoint with:
- HTTP method and full path
- Request parameters (path, query, body) with types
- Response schema
- One complete curl example with example response

Endpoints to document (one subsection per endpoint):
1. `POST /api/v1/ontology/:ontologyId/linkTypes` (Task 2)
2. `GET /api/v1/ontology/:ontologyId/linkTypes` (Task 3)
3. `GET /api/v1/ontology/:ontologyId/linkTypes/:apiName` (Task 4)
4. `PUT /api/v1/ontology/:ontologyId/linkTypes/:apiName` (Task 5)
5. `DELETE /api/v1/ontology/:ontologyId/linkTypes/:apiName` (Task 6)
6. `GET /api/v1/objects/:objectType/:primaryKey/links/:linkType` (Task 12)
7. `POST /api/v1/objects/:objectType/searchAround` (Task 13)
8. `GET /api/v1/objects/:objectType/:primaryKey/links/:linkType/count` (Task 15)
9. `GET /api/v1/objects/:objectType/:primaryKey/links` (Task 16)
10. `POST /api/v1/ontology/:ontologyId/linkTypes/:apiName/joinTable` (Task 17)
11. `GET /api/v1/ontology/:ontologyId/linkTypes/export` (Task 25)
12. `POST /api/v1/ontology/:ontologyId/linkTypes/import` (Task 26)

**Section 4: Performance Characteristics**

Include a table showing expected latencies at various scales, derived from Task 28's benchmark targets:

| Operation | Data Scale | Target p95 |
|-----------|-----------|------------|
| FK link resolution | 10K objects | < 20ms |
| Search Around | 1,000 source matches | < 200ms |
| M2M link resolution | 100K join table rows | < 500ms |
| Link count | Any scale | < 15ms |
| Bulk link count | 5 link types | < 50ms |

**Section 5: Palantir Parity Checklist**

For each Palantir link feature, indicate parity status using one of: `MATCHED`, `PARTIAL`, `NOT IMPLEMENTED`. Include:
- Link type CRUD
- FK-based link resolution (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE)
- M2M link resolution via join table
- Bidirectional traversal
- Self-referential links
- Search Around with source/target filters
- Link count and bulk link count
- Multi-hop traversal
- Link type export/import
- Link permissions (NOT IMPLEMENTED)
- Incremental join table indexing (NOT IMPLEMENTED)
- Link-level security filtering (NOT IMPLEMENTED)
- Streaming link updates (NOT IMPLEMENTED)

**Section 6: Known Limitations vs. Palantir**

Write a bulleted list of known gaps:
- No incremental join table indexing (we read CSV at query time; Palantir indexes join tables into Object Storage)
- No security filtering on links (no RLS/CLS yet)
- No link-level permissions (Palantir has separate permissions for link types)
- No streaming updates to links
- No materialization of link traversal results
- M2M join table CSV is read synchronously (must be replaced with indexed approach for production scale)

**Section 7: Future Work**

Write a bulleted list of what needs to be built in subsequent weeks:
- Workshop linked object table widget (Week 2)
- OSDK `.pivotTo()` code generation (Week 2)
- Link-level permissions and security (Week 3)
- Indexed join tables for M2M performance (Week 3)
- Agent Studio link traversal actions (Week 4)

**File to create:** `docs/LINKS.md`

**Testing:**
1. Verify the document renders correctly as Markdown (check heading hierarchy, code blocks, tables).
2. Verify every API endpoint listed in Section 3 matches the actual implemented routes (cross-reference with `src/routes/linkTypes.js` and `src/routes/linkTraversal.js`).
3. Verify every curl example in Section 3 is syntactically valid and uses correct paths/methods.
4. Verify the Palantir Parity Checklist covers all features built in Tasks 1-29.
