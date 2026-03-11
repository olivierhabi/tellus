# TASK 30 OF 30: README Documentation

**Objective:** Create a single README.md file at the project root that documents the Ontology Engine project. This is a documentation-only task — no application code is created or modified.

**Step-by-step instructions:**

Create README.md at the project root with these seven sections in this exact order:

**Section 1 — Overview:** Include this exact paragraph: "The Ontology System Engine is an open-source implementation of the core concepts from Palantir Foundry's Ontology. It provides a semantic layer that maps datasets to real-world entities (objects), with typed properties, relationships (links), and parameterized edit operations (actions)." Include a table mapping Palantir terms to our current implementation (Week 1 scope only):

| Palantir Concept | Our Implementation |
|---|---|
| Ontology | `ontology` table (PostgreSQL) |
| Object Type | `object_type` table + future OpenSearch index |
| Property | `property` table + future OpenSearch field |
| Backing Datasource | `backing_datasource` table + file scanner |
| Object Data Funnel | `funnel_state` table (state tracking only; actual indexer is Week 2) |

Do NOT include Link Type, Action Type, Object Storage V2, or Object Set Service in this table — those are not implemented in the current 30-task scope.

**Section 2 — Architecture Diagram:** Text-based diagram showing the Week 1 data flow:
```
CSV/JSON File → File Scanner Service → Backing Datasource (metadata in PostgreSQL)
                                            ↓
                                     Funnel State (tracks indexing status)
                                            ↓
PostgreSQL ← stores all metadata ← REST API (Express) ← Client (curl/UI)
```

**Section 3 — Quick Start:** Step-by-step setup instructions:
- Prerequisites: Docker, Node.js 20+
- Commands (in this exact order):
  1. `docker run --name ontology-pg -e POSTGRES_PASSWORD=ontology -e POSTGRES_DB=ontology -p 5432:5432 -d postgres:16`
  2. `npm install`
  3. `npm run migrate`
  4. `npm run seed`
  5. `npm run dev`
- Include exactly 5 curl examples demonstrating the core workflow:
  1. `GET /health` — verify server is running
  2. `POST /api/v2/ontologies` — create an ontology
  3. `POST /api/v2/ontologies/:id/objectTypes/batch` — create object type with properties
  4. `GET /api/v2/ontologies/:id/objectTypes` — list object types
  5. `GET /api/v2/ontologies/:id/objectTypes/:apiName` — get object type with properties

**Section 4 — API Reference:** Document every implemented endpoint grouped by resource. For each endpoint include: HTTP method, path, request body example (JSON), response body example (JSON), and possible error codes with HTTP status. Groups:
- Ontology: POST/GET(list)/GET(single)/PUT/DELETE
- Object Types: POST(batch)/GET(list)/GET(single)/PUT/DELETE
- Properties: POST/GET(list)/GET(single)/PUT/DELETE/POST(primaryKey)/POST(titleProperty)/POST(batch)
- Datasources: POST(register)/GET/DELETE/POST(scan)
- Lifecycle: POST(changeStatus)/POST(clone)/GET(export)/POST(import)
- Statistics: GET
- Export/Import: GET(export ontology)/POST(import ontology)

Include curl commands that can be copy-pasted directly (using `localhost:3000`).

**Section 5 — Palantir Documentation References:** Table with three columns: Palantir Doc URL, Concept It Defines, Implementing File(s). Include only URLs that are explicitly referenced in the 30 task files.

**Section 6 — Roadmap:** Table showing what subsequent weeks add:
| Week | Focus |
|---|---|
| Week 2 | OpenSearch indexing, Object Data Funnel execution |
| Week 3 | Query API, Object Set Service, authentication |
| Week 4 | Link Types, join tables |
| Week 5 | Action Types, execution engine |

**Section 7 — Technical Decisions:** Document these three decisions with the rationale provided:
1. Why PostgreSQL (not MongoDB): relational integrity for schema definitions — every property must reference a valid object type.
2. Why OpenSearch (not PostgreSQL full-text search): Palantir uses a dedicated search engine, and we need aggregation performance at scale.
3. Why raw SQL (not Prisma/Sequelize): ORMs hide exact queries, making it impossible to verify we match Palantir's behavior.

**Files to create:** README.md

**Verification:**
- README.md exists at project root
- All curl commands in the API reference execute successfully against the running server (after `npm run seed`)
- Every Palantir doc URL in Section 5 returns HTTP 200 (not 404)
- The Palantir mapping table in Section 1 contains only components implemented in the 30-task scope (no Link Type, Action Type, Object Storage V2, or Object Set Service)
