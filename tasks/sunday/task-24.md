# TASK 24: README.md — Architecture and Setup Documentation

**Depends on:** This task should be completed after all other Day 7 tasks, since Section 5 (API Reference) requires documenting every endpoint in the system.

## Objective
Write a comprehensive README.md file for the project that explains the architecture, how to set up and run the system, and how the system maps to Palantir's Ontology documentation. This README is the primary documentation artifact and must be sufficient for a new developer to understand, set up, and start working with the system without any verbal explanation.

## Exact Specification

Create `/README.md` with the following sections. Each section must be thorough — this is not a minimal README with placeholder text. Every section must contain real, accurate, tested information.

**Section 1: Project Title and Overview (200+ words)**

Title: "Ontology System Engine — Open Implementation of Palantir Foundry's Ontology Backend"

Explain what this system is in plain language: a backend engine that implements the core concepts from Palantir's Foundry Ontology — Object Types, Properties, Links, Actions, and Interfaces — backed by PostgreSQL for metadata and OpenSearch for object storage and queries. Explain the core value proposition: it transforms raw data (CSV files) into a queryable graph of typed objects with relationships, actions, and audit logging.

State explicitly what this IS and IS NOT:
- IS: The Ontology Engine backend (API-only) replicating Palantir's Ontology Language + Engine layers
- IS NOT: A complete Foundry replacement. Does not include: Workshop, Pipeline Builder, AIP, OSDK code generation, Functions runtime, streaming, branching, security/RBAC, or any UI applications

State the Palantir documentation references that guided the design, with URLs:
- Platform summary: https://www.palantir.com/docs/foundry/getting-started/foundry-platform-summary-llm/
- Ontology overview: https://www.palantir.com/docs/foundry/ontology/overview/
- Object backend architecture: https://www.palantir.com/docs/foundry/object-backend/overview/

**Section 2: Architecture Diagram (ASCII art)**

```
┌─────────────────────────────────────────────────────────┐
│                     REST API (:3000)                     │
│  /objects  /actions  /interfaces  /links  /health       │
├─────────┬───────────┬───────────────┬───────────────────┤
│ Query   │ Action    │ Interface     │ Object View       │
│ Service │ Engine    │ Validator     │ Service            │
├─────────┴─────┬─────┴───────────────┴───────────────────┤
│               │                                          │
│   PostgreSQL  │           OpenSearch                     │
│   (metadata)  │         (object store)                   │
│               │                                          │
│  - ontology   │  - ontology-employee (index)             │
│  - object_type│  - ontology-company (index)              │
│  - property   │  - ontology-ticket (index)               │
│  - link_type  │  - ... one index per object type         │
│  - action_type│                                          │
│  - interface  │                  ▲                       │
│  - audit_log  │                  │                       │
│  - edits      │           ┌──────┴──────┐                │
│               │           │   Indexer    │                │
│               │           │  (CSV→OS)   │                │
│               │           └──────┬──────┘                │
│               │                  │                       │
│               │           ┌──────┴──────┐                │
│               │           │  Dataset    │                │
│               │           │  (CSV/JSON) │                │
│               │           └─────────────┘                │
└───────────────┴──────────────────────────────────────────┘
```

Explain each component in the diagram with 2-3 sentences each.

**Section 3: Prerequisites**

List exact versions:
- Node.js 20+ (specify: `node --version` must show v20.x or higher)
- Docker (for PostgreSQL and OpenSearch)
- npm 10+
- curl or Postman (for API testing)
- ~2GB free RAM (OpenSearch needs at least 1GB)

**Section 4: Quick Start (step by step)**

Provide exact, copy-pasteable commands:
```bash
# 1. Clone the repository
git clone <repo-url>
cd ontology-engine

# 2. Start infrastructure
docker run -d --name postgres -e POSTGRES_PASSWORD=ontology -e POSTGRES_DB=ontology -p 5432:5432 postgres:16
docker run -d --name opensearch -e "discovery.type=single-node" -e "DISABLE_SECURITY_PLUGIN=true" -e "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m" -p 9200:9200 opensearchproject/opensearch:2.17.0

# 3. Wait for services to be ready
until docker exec postgres pg_isready; do sleep 1; done
until curl -s http://localhost:9200 > /dev/null; do sleep 1; done

# 4. Install dependencies
npm install

# 5. Run database migrations
node src/migrations/runner.js

# 6. Start the server
npm start

# 7. Verify it works
curl http://localhost:3000/api/v2/health
```

**Section 5: API Reference**

For EVERY endpoint in the system (expect 25-30 endpoints), provide:
- HTTP method and path
- Brief description (one sentence)
- Request body example (if POST/PUT)
- Response example
- Error codes that can be returned

Group endpoints by domain: Ontology, Object Types, Properties, Datasets, Queries, Links, Actions, Interfaces, Object Views, System.

This section should be 3000+ words by itself.

**Section 6: Palantir Documentation Mapping**

A table mapping each component of this system to its Palantir documentation URL:

| This System | Palantir Equivalent | Documentation URL |
|---|---|---|
| `object_type` PostgreSQL table | Object Types | https://www.palantir.com/docs/foundry/object-link-types/object-types-overview/ |
| `property` PostgreSQL table | Properties | https://www.palantir.com/docs/foundry/object-link-types/properties-overview/ |
| OpenSearch indexes | Object Storage V2 | https://www.palantir.com/docs/foundry/object-backend/overview/ |
| Indexer service | Object Data Funnel | https://www.palantir.com/docs/foundry/object-indexing/overview/ |
| Query service | Object Set Service | https://www.palantir.com/docs/foundry/object-backend/overview/ |
| Action engine | Action Types | https://www.palantir.com/docs/foundry/action-types/overview/ |
| Interfaces | Interfaces | https://www.palantir.com/docs/foundry/interfaces/interface-overview/ |
| Audit log | Action Metrics | https://www.palantir.com/docs/foundry/action-types/action-metrics/ |

Include 15+ rows.

**Section 7: Design Decisions and Palantir Behavior Replication**

Document every behavioral decision that was copied from Palantir's documentation:
1. "One datasource can only back one object type" — from the Object Types docs
2. "Most recent transaction wins for duplicate PKs" — from Funnel batch pipeline docs
3. "User edits take precedence over datasource data on reindex" — from Object Storage V2 docs
4. "Actions enforce max 10,000 affected objects" — from Action Types docs
5. "Required properties cause indexing to fail if null" — from Required Properties docs
6. "Search Around default limit is 100,000 objects" — from Object Backend docs
7. "New object types only allow edits via actions" — from Action Permissions docs
8. "Action rules are compiled into a single edit per object" — from Action Rules docs
9. "Interfaces provide object type polymorphism" — from Interfaces docs
10. "Many-to-many links require a join table" — from Link Types docs

For each decision, include the exact Palantir documentation quote (paraphrased to 1-2 sentences) and the URL.

**Section 8: Environment Variables**

List all configurable environment variables with their defaults and descriptions:
```
PORT=3000                    # Server port
PG_HOST=localhost            # PostgreSQL host
PG_PORT=5432                 # PostgreSQL port
PG_DATABASE=ontology         # PostgreSQL database name
PG_USER=postgres             # PostgreSQL username
PG_PASSWORD=ontology         # PostgreSQL password
OPENSEARCH_URL=http://localhost:9200  # OpenSearch URL
NODE_ENV=development         # Environment (development/production)
CORS_ORIGIN=*                # CORS allowed origins
LOG_LEVEL=info               # Logging level
```

**Section 9: Running Tests**

```bash
# Run all tests
npm test

# Run specific test suite
node --test src/tests/interfaces.test.js

# Run with verbose output
node --test --test-reporter=spec src/tests/
```

**Section 10: What's Next (Roadmap)**

Table showing the week-by-week plan for building the remaining 41 components on top of this engine. Reference the build plan document located in the project's task planning directory (the `sunday-tasks.md` file and similar files for other days).

## Verification
1. A new developer follows the Quick Start section → the system runs on their machine with no errors
2. Every API endpoint listed in Section 5 matches the actual running system — verify by comparing against `GET /api/v2/docs` output (Task 20). Section 5 lists at least 25 endpoints.
3. Every Palantir documentation URL in Section 6 is valid (not 404). Section 6 contains at least 15 rows.
4. The architecture diagram accurately represents the current system
5. Section 8 lists every environment variable referenced in `db.js`, `opensearch.js`, and `server.js`
6. All bash commands in Section 4 execute without errors on a clean machine with the listed prerequisites installed
