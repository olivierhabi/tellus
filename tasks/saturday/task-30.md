## TASK 30: Build the Architecture Documentation and Palantir Mapping Reference

### Context
The final task of Saturday is to document the architecture of what was built and create a detailed mapping between each component and the corresponding Palantir documentation. This serves two purposes: (1) it helps the human verify that the implementation matches Palantir's design, and (2) it serves as the reference for future weeks when additional components are built.

### Exact Specification

Create a single file `/docs/ARCHITECTURE.md` containing all 7 sections below. This is one Markdown document, not 7 separate files. Write the content by hand based on the code built during the week — this is a documentation task, not a code-generation task.

**Section 1: System Architecture Diagram (ASCII)**

```
┌────────────────────────────────────────────────────────────────┐
│                        REST API LAYER                           │
│  /api/v2/ontology  /api/v2/objects  /api/v2/actions  /api/v2/datasets  │
└──────┬──────────────────┬───────────────────┬──────────────┬───┘
       │                  │                   │              │
┌──────▼──────┐   ┌───────▼───────┐   ┌──────▼──────┐  ┌───▼────────┐
│  Metadata   │   │  Object Set   │   │   Action    │  │  Dataset   │
│  Service    │   │  Service      │   │   Engine    │  │  Service   │
│ (PostgreSQL)│   │ (OpenSearch)  │   │ (PG + OS)   │  │ (PG + FS)  │
└──────┬──────┘   └───────▲───────┘   └──────┬──────┘  └───┬────────┘
       │                  │                   │              │
       │          ┌───────┴───────┐           │              │
       │          │   Reindex     │◄──────────┘              │
       └─────────►│   Engine      │◄─────────────────────────┘
                  │   (Funnel)    │
                  └───────┬───────┘
                          │
                  ┌───────▼───────┐
                  │  OpenSearch   │
                  │  (Object DB)  │
                  └───────────────┘
```

**Section 2: Component-to-Palantir Mapping**

For each of the following components, write a subsection with: our implementation file path, the Palantir equivalent name, a URL to the corresponding Palantir documentation page (use the URLs from `/src/utils/palantirDocMapping.json` created in Task 26, and supplement with manual lookup for non-API components), what we implemented vs. what Palantir has (gap analysis), and what's planned for future weeks.

**Components to document (complete list):**
1. Ontology Service (`/src/routes/ontology.js`, `/src/services/ontologyService.js`)
2. Object Type Service (properties, schema management)
3. Dataset Service (`/src/routes/datasets.js`, `/src/services/datasetService.js`)
4. File Upload Handler (`/src/utils/fileHandler.js`)
5. Backing Datasource Registration
6. Reindex Engine / Object Data Funnel (`/src/services/reindexService.js`)
7. Object Query Service (search, filter, aggregate, full-text search)
8. Link Type Service
9. Action Engine (apply, validate, bulk, audit)
10. Interface Service
11. Column Mapping Suggestion Engine (`/src/services/mappingSuggestionService.js`)
12. Health Check and System Status (`/src/routes/health.js`)
13. Type Conversion Utility (`/src/utils/typeConverter.js`)
14. File Reader Utility (`/src/utils/fileReader.js`)

Example subsection:
```
### Reindex Engine (Object Data Funnel)

Our implementation: /src/services/reindexService.js
Palantir equivalent: Object Data Funnel service in Object Storage V2
Palantir docs: https://www.palantir.com/docs/foundry/object-indexing/overview/

Implemented (Week 1):
✅ Full reindex from backing datasource files
✅ Multi-transaction file merging (SNAPSHOT + APPEND)
✅ "Most recent transaction wins" for duplicate PKs
✅ Duplicate PK detection within single transaction
✅ Required property null validation
✅ User edit preservation (creates, updates, deletes)
✅ Funnel state tracking
✅ Reindex history

NOT implemented (Future weeks):
❌ Incremental indexing (changelog computation — Week 3)
❌ Spark-based parallel processing — Week 3
❌ Streaming indexing via Kafka — Week 10
❌ Multi-materialization support
❌ is_deleted column handling via CDC
❌ Configurable indexing throughput limits (2 MB/s per object type)
```

**Section 3: Database Schema Reference**

List every PostgreSQL table created by the migration files (Task 1) with all columns, types, constraints, and indexes. Group by component. Write this by reading the actual migration SQL files and transcribing the schema — do NOT generate it programmatically. Tables to include (complete list): `dataset`, `dataset_transaction`, `ontology`, `object_type`, `object_type_property`, `backing_datasource`, `funnel_state`, `reindex_history`, `link_type`, `action_type`, `action_type_parameter`, `interface`, `ontology_edit`.

**Section 4: OpenSearch Index Reference**

Show the complete OpenSearch type mapping used when creating indices during reindex (from Task 7). For each of the 15 Palantir base types (string, integer, long, double, float, boolean, date, timestamp, geopoint, geoshape, struct, array variants, decimal, byte, short), list the corresponding OpenSearch field type and any analyzer/format settings.

**Section 5: API Reference Summary**

Markdown table of all 42 endpoints (the same list documented in Task 26) with columns: HTTP method, path, one-line description, and source route file. This section is a quick-reference index; the full details are in `/docs/API_REFERENCE.md` (Task 26).

**Section 6: Test Coverage Matrix**

Manually written Markdown table mapping each Palantir behavior to the integration test that verifies it. Use the template below as a starting point, but verify and update it against the actual test files (Tasks 17-24) to ensure accuracy. Every test in every suite must appear at least once in this table.

```
| Palantir Behavior | Test Suite | Test # | Status |
|---|---|---|---|
| Object type creation with typed properties | Suite 1 | 1.2 | ✅ |
| Dataset upload with metadata extraction | Suite 1 | 1.3 | ✅ |
| Backing datasource registration | Suite 1 | 1.4 | ✅ |
| Full reindex from datasource | Suite 1 | 1.5 | ✅ |
| Object query with filters | Suite 1 | 1.8-1.9 | ✅ |
| Aggregation queries | Suite 1 | 1.10 | ✅ |
| Full-text search | Suite 1 | 1.11 | ✅ |
| User edit preservation (update) | Suite 2 | 2.7 | ✅ |
| User edit preservation (create) | Suite 2 | 2.12 | ✅ |
| User edit preservation (delete) | Suite 2 | 2.16 | ✅ |
| Most recent transaction wins | Suite 3 | 3.8 | ✅ |
| SNAPSHOT replaces all data | Suite 3 | 3.13 | ✅ |
| Link traversal (forward) | Suite 4 | 4.2 | ✅ |
| Link traversal (reverse) | Suite 4 | 4.3 | ✅ |
| Search Around with filter | Suite 4 | 4.4 | ✅ |
| Bulk actions with partial failure | Suite 5 | 5.2 | ✅ |
| Complete audit trail | Suite 5 | 5.4-5.5 | ✅ |
| Dataset transaction history | Suite 6 | 6.2-6.5 | ✅ |
| Dataset preview with merge | Suite 6 | 6.8-6.10 | ✅ |
| Column mapping suggestions | Suite 7 | 7.1-7.6 | ✅ |
| Graceful error handling | Suite 8 | 8.1-8.15 | ✅ |
```

**Section 7: Known Limitations and Future Work**

Bulleted list of features NOT implemented in Week 1, organized by component. For each limitation, note which future week it is planned for (if known) or mark as "TBD". Include at minimum:
- Incremental indexing / changelog computation
- Spark-based parallel processing
- Streaming indexing via Kafka
- Multi-materialization support
- is_deleted column handling via CDC
- Authentication and authorization
- Rate limiting
- Pagination cursors for large result sets
- WebSocket real-time updates
- Multi-tenant isolation

### Validation Criteria
- All 14 components listed in Section 2 are documented with gap analysis
- Every Palantir doc reference URL is valid and correct (manually verified)
- The gap analysis honestly lists what's missing per component
- The test coverage matrix includes every individual test from all 8 suites (dynamically counted, not hardcoded)
- The architecture diagram accurately represents the system's data flow
- The database schema in Section 3 matches the actual migration SQL (all 13 tables)
- The API summary in Section 5 lists exactly 42 endpoints
- The document is a single coherent Markdown file, not auto-generated
