# Architecture — Tellus Ontology Engine

> Generated: 2026-03-13
> Version: 0.1.0

## System Overview

Tellus is a Palantir Foundry-inspired ontology engine built on TypeScript, Express, PostgreSQL, and OpenSearch. It provides a complete data integration and semantic layer for government data management — specifically designed for the Rwanda Revenue Authority (RRA) use case.

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │
│  │ Web UI   │  │ REST API │  │ Swagger  │  │ CLI / Scripts │    │
│  │ (Future) │  │ Clients  │  │   UI     │  │  (tsx/curl)   │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘    │
│       │              │              │               │            │
└───────┼──────────────┼──────────────┼───────────────┼────────────┘
        │              │              │               │
        ▼              ▼              ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     EXPRESS API SERVER                            │
│                      (Port 3000)                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    MIDDLEWARE CHAIN                        │   │
│  │  Helmet → Compression → RateLimit → JSON → CORS → Logger │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                     ROUTE LAYER                           │   │
│  │                                                           │   │
│  │  /health          - Basic health check                    │   │
│  │  /api/v1/health   - Enhanced health (PG + OS)             │   │
│  │  /api/v1/status   - Comprehensive system status           │   │
│  │  /api/v1/ontology       - Ontology CRUD                 │   │
│  │  /api/v1/ontology/:id/objectTypes  - Object Type CRUD   │   │
│  │  /api/v1/ontology/:id/objectTypes/:name/properties      │   │
│  │  /api/v1/ontology/:id/objectTypes/:name/datasource      │   │
│  │  /api/v1/ontology/:id/objectTypes/:name/index           │   │
│  │  /api/v1/ontology/:id/linkTypes    - Link Type CRUD     │   │
│  │  /api/v1/ontology/:id/actionTypes  - Action Type CRUD   │   │
│  │  /api/v1/ontology/:id/actions      - Action Execution   │   │
│  │  /api/v1/objects/:type               - Object Queries     │   │
│  │  /api/v1/datasets                    - Dataset Management │   │
│  │  /api/v1/audit                       - Audit Log          │   │
│  │  /api/docs                            - Swagger UI         │   │
│  │  /api/docs/spec.json                 - OpenAPI JSON       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   SERVICE LAYER                           │   │
│  │                                                           │   │
│  │  ontologyService     - Ontology CRUD + import/export      │   │
│  │  objectTypeService   - Object type management             │   │
│  │  propertyService     - Property CRUD                      │   │
│  │  datasourceService   - Backing datasource management      │   │
│  │  linkResolverService - Link resolution, Search Around     │   │
│  │  queryExecutor       - OpenSearch query execution          │   │
│  │  queryTranslator     - Filter → OpenSearch DSL            │   │
│  │  queryValidator      - Query input validation             │   │
│  │  paginationService   - Cursor-based pagination            │   │
│  │  propertyResolver    - Property metadata cache            │   │
│  │  reindexService      - Reindex pipeline orchestration     │   │
│  │  autoIndexService    - Auto-indexing on data changes      │   │
│  │  uploadService       - File upload handling (multer)      │   │
│  │  fileScannerService  - File metadata extraction           │   │
│  │  mappingSuggestionService - Auto column mapping            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  ACTION ENGINE                            │   │
│  │                                                           │   │
│  │  actionExecutor     - Full 5-stage execution pipeline     │   │
│  │  actionValidator    - Dry-run validation (no edits)       │   │
│  │  ruleCompiler       - Rule definition → executable rules  │   │
│  │  parameterValidator - Parameter type checking             │   │
│  │  propertyValidator  - Property value validation           │   │
│  │  objectChecker      - Object existence verification       │   │
│  │  editApplicator     - Apply edits to ontology_edit table  │   │
│  │  idempotency        - Idempotency key management          │   │
│  │  schemaMigrationValidator - Schema compatibility checks   │   │
│  │                                                           │   │
│  │  Rules:                                                   │   │
│  │    createObjectRule  - Create new objects                  │   │
│  │    modifyObjectRule  - Modify existing objects             │   │
│  │    deleteObjectRule  - Delete objects                      │   │
│  │    linkRules         - Create/delete links                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                 INDEXING ENGINE                            │   │
│  │                                                           │   │
│  │  indexingOrchestrator - Full pipeline orchestration        │   │
│  │  csvReader           - Stream-based CSV parsing            │   │
│  │  rowTransformer      - Row → document transformation      │   │
│  │  typeConverter       - CSV string → typed values           │   │
│  │  primaryKeyValidator - PK uniqueness validation           │   │
│  │  batchDocumentBuilder - Bulk document assembly             │   │
│  │  editMerger          - Overlay edits onto datasource data │   │
│  │  datasourceValidator - Datasource health checks           │   │
│  │  errorCollector      - Error aggregation + reporting      │   │
│  │  progressTracker     - Pipeline progress tracking         │   │
│  │  dataSampler         - Statistical sampling               │   │
│  │  autoCreateHook      - Auto-create properties on index    │   │
│  │  verifier            - Post-index verification            │   │
│  │  propertyChangeHandler - Property schema migrations       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              OPENSEARCH CLIENT LAYER                      │   │
│  │                                                           │   │
│  │  client              - Singleton client + retry logic     │   │
│  │  bulkIndexer         - Bulk indexing with batching         │   │
│  │  indexLifecycleManager - Index create/delete/stats         │   │
│  │  indexMappingGenerator - Property → OS mapping generation │   │
│  │  mappingDiff         - Mapping change detection            │   │
│  │  templateRegistry    - Index template management          │   │
│  │  objectCounter       - Fast count queries                 │   │
│  │  refreshUtil         - Index refresh management           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    MODEL LAYER                            │   │
│  │                                                           │   │
│  │  funnelState         - Pipeline execution state           │   │
│  │  actionType          - Action type CRUD                   │   │
│  │  linkType            - Link type CRUD                     │   │
│  │  ontologyEdit        - Edit record management             │   │
│  │  actionAuditLog      - Audit log entries                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   UTILITY LAYER                           │   │
│  │                                                           │   │
│  │  responseFormatter   - Snake→camel, error formatting      │   │
│  │  appError            - Typed error factory                │   │
│  │  queryErrors         - OntologyError class                │   │
│  │  typeSystem          - Base type definitions              │   │
│  │  typeCoercion        - Value type coercion                │   │
│  │  apiNameValidator    - API name format validation         │   │
│  │  columnMappingValidator - Column mapping validation       │   │
│  │  structValidator     - Struct schema validation           │   │
│  │  schemaDiff          - Schema comparison                  │   │
│  │  constants           - Shared constants + limits          │   │
│  │  fileReader          - File reading utilities             │   │
│  │  generateApiDocs     - API documentation generator        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                   │
                    ▼                 ▼                   ▼
┌─────────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│    PostgreSQL 16     │  │  OpenSearch 2.x  │  │   File System    │
│                      │  │                  │  │                  │
│  Tables:             │  │  Indices:        │  │  /data/          │
│   ontology           │  │   ontology-*     │  │   *.csv          │
│   object_type        │  │                  │  │   *.json         │
│   property           │  │  Features:       │  │   *.jsonl        │
│   backing_datasource │  │   Full-text      │  │                  │
│   link_type          │  │   Aggregations   │  │  /data/uploads/  │
│   action_type        │  │   Geo queries    │  │   (uploaded      │
│   ontology_edit      │  │   Pagination     │  │    datasets)     │
│   action_audit_log   │  │                  │  │                  │
│   funnel_state       │  │  Index template: │  │                  │
│   funnel_pipeline_   │  │   ontology-*     │  │                  │
│     state            │  │   (managed)      │  │                  │
│   dataset            │  │                  │  │                  │
│   dataset_transaction│  │                  │  │                  │
│   idempotency_key    │  │                  │  │                  │
│   reindex_history    │  │                  │  │                  │
└─────────────────────┘  └─────────────────┘  └──────────────────┘
```

## Component-to-Palantir Mapping

| Tellus Component | Palantir Foundry Equivalent | Description |
|---|---|---|
| `ontology` table | Ontology | Container for all semantic types |
| `object_type` table | Object Type | Defines an entity class (Employee, Company) |
| `property` table | Property | Typed field on an object type |
| `backing_datasource` | Dataset → Object Type backing | Links a data file to an object type |
| `link_type` table | Link Type | Typed relationship between object types |
| `action_type` table | Action Type | Parameterized mutation definition |
| `ontology_edit` table | Ontology Edit | Recorded property change (pending or indexed) |
| `action_audit_log` | Action Audit Log | Execution trace for compliance |
| `funnel_pipeline_state` | Funnel Pipeline State | Indexing pipeline execution tracking |
| `dataset` + `dataset_transaction` | Dataset + Transaction Log | Versioned data storage |
| OpenSearch index (`ontology-*`) | Object Storage (PhoenixDB) | Queryable object storage |
| `queryExecutor` | Object Set Service | Search, filter, aggregate, paginate |
| `queryTranslator` | Query Translator | Filter expression → OpenSearch DSL |
| `linkResolverService` | Link Resolution Service | Resolve, count, Search Around |
| `actionExecutor` | Action Execution Service | 5-stage pipeline: validate → check → compile → apply → audit |
| `indexingOrchestrator` | Funnel Pipeline | CSV → transform → validate → bulk index |
| `reindexService` | Reindex Pipeline | Full re-index with edit overlay |
| Swagger UI at `/api/docs` | API Documentation | Interactive API explorer |
| `responseFormatter` | API Gateway Formatter | Snake→camel, pagination, error codes |

## Database Schema Reference

### Core Tables

```sql
-- Ontology container
CREATE TABLE ontology (
  ontology_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name   TEXT NOT NULL UNIQUE,
  description    TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  created_by     TEXT DEFAULT 'system'
);

-- Object type definition
CREATE TABLE object_type (
  object_type_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id               UUID REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  api_name                  TEXT NOT NULL,
  display_name              TEXT NOT NULL,
  description               TEXT,
  icon                      TEXT DEFAULT 'cube',
  icon_color                TEXT DEFAULT '#6B7280',
  status                    TEXT DEFAULT 'active',
  edits_via_actions_only    BOOLEAN DEFAULT false,
  max_properties            INT DEFAULT 2000,
  primary_key_property_id   UUID,
  title_property_id         UUID,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now(),
  UNIQUE(ontology_id, api_name)
);

-- Property definition
CREATE TABLE property (
  property_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id UUID REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  api_name       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  base_type      TEXT NOT NULL,
  description    TEXT,
  struct_schema  JSONB,
  is_required    BOOLEAN DEFAULT false,
  is_array       BOOLEAN DEFAULT false,
  ordinal        INT DEFAULT 0,
  UNIQUE(object_type_id, api_name)
);

-- Backing datasource (CSV/JSON file reference)
CREATE TABLE backing_datasource (
  datasource_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id     UUID UNIQUE REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  dataset_name       TEXT NOT NULL,
  file_path          TEXT NOT NULL,
  file_format        TEXT NOT NULL DEFAULT 'csv',
  column_mapping     JSONB NOT NULL DEFAULT '{}',
  primary_key_column TEXT NOT NULL,
  row_count          INT,
  column_names       JSONB,
  schema_hash        TEXT,
  last_scanned_at    TIMESTAMPTZ,
  registered_at      TIMESTAMPTZ DEFAULT now()
);

-- Link type (relationship definition)
CREATE TABLE link_type (
  link_type_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id           UUID REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  api_name              TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  description           TEXT,
  source_object_type    UUID REFERENCES object_type(object_type_id),
  target_object_type    UUID REFERENCES object_type(object_type_id),
  source_property       UUID REFERENCES property(property_id),
  target_property       UUID REFERENCES property(property_id),
  cardinality           TEXT DEFAULT 'MANY_TO_MANY',
  status                TEXT DEFAULT 'active',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(ontology_id, api_name)
);
```

### Action & Audit Tables

```sql
-- Action type definition
CREATE TABLE action_type (
  action_type_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id      UUID REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  api_name         TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  description      TEXT,
  parameters       JSONB NOT NULL DEFAULT '{}',
  rules            JSONB NOT NULL DEFAULT '[]',
  status           TEXT DEFAULT 'active',
  version          INT DEFAULT 1,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(ontology_id, api_name)
);

-- Ontology edit record
CREATE TABLE ontology_edit (
  edit_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_api_name   TEXT NOT NULL,
  primary_key            TEXT NOT NULL,
  operation              TEXT NOT NULL,  -- 'create', 'modify', 'delete'
  property_values        JSONB DEFAULT '{}',
  link_edits             JSONB DEFAULT '[]',
  action_type_api_name   TEXT,
  execution_id           UUID,
  action_parameters      JSONB DEFAULT '{}',
  executed_by            TEXT DEFAULT 'system',
  executed_at            TIMESTAMPTZ DEFAULT now(),
  indexed                BOOLEAN DEFAULT false,
  indexed_at             TIMESTAMPTZ
);

-- Action audit log
CREATE TABLE action_audit_log (
  audit_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id                UUID NOT NULL,
  ontology_id                 UUID,
  action_type_api_name        TEXT NOT NULL,
  action_type_display_name    TEXT,
  parameters                  JSONB DEFAULT '{}',
  result                      TEXT NOT NULL,  -- 'success' or 'failure'
  failure_type                TEXT,
  error_message               TEXT,
  affected_objects             JSONB DEFAULT '[]',
  duration_ms                 INT,
  executed_by                 TEXT DEFAULT 'system',
  executed_at                 TIMESTAMPTZ DEFAULT now(),
  source_ip                   TEXT,
  branch_id                   TEXT
);
```

### Pipeline & Dataset Tables

```sql
-- Pipeline execution state
CREATE TABLE funnel_pipeline_state (
  object_type_api_name  TEXT PRIMARY KEY,
  status                TEXT DEFAULT 'idle',
  last_indexed_at       TIMESTAMPTZ,
  objects_indexed        INT,
  duration_ms           INT,
  datasource_version    TEXT,
  error_message         TEXT,
  retry_count           INT DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Lightweight UI-facing funnel state
CREATE TABLE funnel_state (
  object_type_id   UUID PRIMARY KEY REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  status           TEXT DEFAULT 'not_indexed',
  objects_indexed  INT DEFAULT 0,
  objects_failed   INT DEFAULT 0,
  edits_pending    INT DEFAULT 0,
  last_indexed_at  TIMESTAMPTZ,
  last_index_duration_ms INT,
  error_message    TEXT,
  index_name       TEXT
);

-- Dataset management
CREATE TABLE dataset (
  dataset_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL UNIQUE,
  description    TEXT,
  file_format    TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Dataset transaction log
CREATE TABLE dataset_transaction (
  transaction_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id       UUID REFERENCES dataset(dataset_id) ON DELETE CASCADE,
  type             TEXT NOT NULL,  -- 'SNAPSHOT', 'APPEND'
  file_path        TEXT NOT NULL,
  file_size_bytes  BIGINT,
  row_count        INT,
  column_names     JSONB,
  schema_hash      TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Idempotency key storage
CREATE TABLE idempotency_key (
  key_hash        TEXT PRIMARY KEY,
  action_type     TEXT NOT NULL,
  execution_id    UUID NOT NULL,
  response        JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

-- Reindex history
CREATE TABLE reindex_history (
  reindex_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id     UUID REFERENCES object_type(object_type_id),
  api_name           TEXT NOT NULL,
  status             TEXT NOT NULL,
  started_at         TIMESTAMPTZ DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  duration_ms        INT,
  objects_indexed    INT DEFAULT 0,
  objects_failed     INT DEFAULT 0,
  error_message      TEXT,
  datasource_version TEXT,
  triggered_by       TEXT DEFAULT 'manual'
);
```

## API Reference Summary

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | GET | `/health` | Basic health check |
| 2 | GET | `/api/v1/health` | Enhanced health check (PG + OS) |
| 3 | GET | `/api/v1/status` | Comprehensive system status |
| 4 | POST | `/api/v1/ontology` | Create ontology |
| 5 | GET | `/api/v1/ontology` | List ontologies |
| 6 | GET | `/api/v1/ontology/:id` | Get ontology |
| 7 | PUT | `/api/v1/ontology/:id` | Update ontology |
| 8 | DELETE | `/api/v1/ontology/:id` | Delete ontology |
| 9 | GET | `/api/v1/ontology/:id/export` | Export ontology |
| 10 | POST | `/api/v1/ontology/import` | Import ontology |
| 11 | POST | `/api/v1/ontology/:id/objectTypes` | Create object type |
| 12 | GET | `/api/v1/ontology/:id/objectTypes` | List object types |
| 13 | GET | `/api/v1/ontology/:id/objectTypes/:name` | Get object type |
| 14 | PUT | `/api/v1/ontology/:id/objectTypes/:name` | Update object type |
| 15 | DELETE | `/api/v1/ontology/:id/objectTypes/:name` | Delete object type |
| 16 | POST | `/api/v1/.../properties` | Create property |
| 17 | GET | `/api/v1/.../properties` | List properties |
| 18 | PUT | `/api/v1/.../properties/:prop` | Update property |
| 19 | DELETE | `/api/v1/.../properties/:prop` | Delete property |
| 20 | PUT | `/api/v1/.../primaryKey` | Set primary key |
| 21 | PUT | `/api/v1/.../titleProperty` | Set title property |
| 22 | POST | `/api/v1/.../datasource` | Register datasource |
| 23 | GET | `/api/v1/.../datasource` | Get datasource |
| 24 | DELETE | `/api/v1/.../datasource` | Unregister datasource |
| 25 | POST | `/api/v1/.../datasource/scan` | Re-scan datasource |
| 26 | POST | `/api/v1/.../index` | Trigger indexing |
| 27 | GET | `/api/v1/.../index/status` | Get indexing status |
| 28 | DELETE | `/api/v1/.../index` | Delete index |
| 29 | GET | `/api/v1/objects/:type` | List objects |
| 30 | GET | `/api/v1/objects/:type/:pk` | Get object |
| 31 | POST | `/api/v1/objects/:type/search` | Search objects |
| 32 | POST | `/api/v1/objects/:type/searchFullText` | Full-text search |
| 33 | POST | `/api/v1/objects/:type/aggregate` | Aggregations |
| 34 | POST | `/api/v1/objects/:type/searchAround` | Search Around |
| 35 | GET | `/api/v1/objects/:type/:pk/links/:lt` | Resolve links |
| 36 | GET | `/api/v1/objects/:type/:pk/links/:lt/count` | Count links |
| 37 | GET | `/api/v1/objects/:type/:pk/editHistory` | Edit history |
| 38 | POST | `/api/v1/.../linkTypes` | Create link type |
| 39 | GET | `/api/v1/.../linkTypes` | List link types |
| 40 | GET | `/api/v1/.../linkTypes/:name` | Get link type |
| 41 | DELETE | `/api/v1/.../linkTypes/:name` | Delete link type |
| 42 | POST | `/api/v1/.../actionTypes` | Create action type |
| 43 | GET | `/api/v1/.../actionTypes` | List action types |
| 44 | GET | `/api/v1/.../actionTypes/:name` | Get action type |
| 45 | PUT | `/api/v1/.../actionTypes/:name` | Update action type |
| 46 | DELETE | `/api/v1/.../actionTypes/:name` | Delete action type |
| 47 | POST | `/api/v1/.../actionTypes/:name/clone` | Clone action type |
| 48 | GET | `/api/v1/.../actionTypes/:name/impact` | Impact analysis |
| 49 | POST | `/api/v1/.../actions/:name/apply` | Execute action |
| 50 | POST | `/api/v1/.../actions/:name/validate` | Validate action |
| 51 | POST | `/api/v1/.../actions/:name/applyBatch` | Batch actions |
| 52 | POST | `/api/v1/actions/:name/applyBulk` | Bulk actions |
| 53 | GET | `/api/v1/.../actions/:name/audit` | Action audit |
| 54 | GET | `/api/v1/audit/log` | Global audit log |
| 55 | GET | `/api/v1/audit/log/:id` | Audit entry |
| 56 | GET | `/api/v1/audit/stats` | Audit stats |
| 57 | GET | `/api/v1/.../edits` | List edits |
| 58 | GET | `/api/v1/.../edits/diff/:pk` | Edit diff |
| 59 | POST | `/api/v1/datasets/upload` | Upload dataset |
| 60 | GET | `/api/v1/datasets` | List datasets |
| 61 | GET | `/api/v1/datasets/:id` | Get dataset |
| 62 | DELETE | `/api/v1/datasets/:id` | Delete dataset |
| 63 | POST | `/api/v1/datasets/:id/transactions` | Add transaction |
| 64 | GET | `/api/v1/datasets/:id/transactions` | List transactions |
| 65 | GET | `/api/v1/datasets/:id/preview` | Preview dataset |
| 66 | POST | `/api/v1/.../reindex` | Trigger reindex |
| 67 | GET | `/api/v1/.../reindex/status` | Reindex status |
| 68 | GET | `/api/v1/.../reindex/history` | Reindex history |
| 69 | GET | `/api/docs/spec.json` | OpenAPI spec |
| 70 | GET | `/api/docs` | Swagger UI |

## Data Flow

### Indexing Pipeline

```
  CSV File                    PostgreSQL                    OpenSearch
  ┌──────┐                    ┌──────────┐                 ┌─────────────┐
  │ data │ ──csvReader──────► │ Validate │ ──bulkIndex──►  │ ontology-*  │
  │ .csv │    (streaming)     │ Transform│    (batched)     │   index     │
  └──────┘                    │ Type-cast│                  └─────────────┘
                              │ PK check │
                              └──────────┘
                                   │
                              ontology_edit
                              (edit overlay)
```

### Action Execution Pipeline (5 Stages)

```
  Stage 1          Stage 2          Stage 3         Stage 4         Stage 5
 ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
 │ Validate │──►│ Check    │──►│ Compile  │──►│ Apply    │──►│ Audit    │
 │ params   │   │ objects  │   │ rules    │   │ edits    │   │ log      │
 │          │   │ exist    │   │ ─►edits  │   │ to PG    │   │ entry    │
 └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

## Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20+ |
| Language | TypeScript | 5.9+ |
| HTTP Framework | Express | 4.x |
| Metadata Store | PostgreSQL | 16+ |
| Object Store | OpenSearch | 2.x |
| Process Manager | Docker Compose | 2.x |
| Package Manager | pnpm / npm | - |
| Test Framework | Vitest + inline self-tests | - |
| API Docs | Swagger UI + OpenAPI 3.0 | - |

## Key Design Decisions

1. **Dual storage**: PostgreSQL for metadata/schema (ACID), OpenSearch for object queries (full-text, geo, aggregations)
2. **Edit overlay**: Edits are stored in PostgreSQL and merged during reindex — never modify OpenSearch directly
3. **Inline self-tests**: Every utility module has `if (require.main === module)` tests — runs without DB/OS
4. **Dependency injection**: Services accept injected query functions for testability
5. **Snake-to-camel**: All API responses are camelCase; all DB columns are snake_case
6. **Cursor pagination**: Page tokens are base64-encoded offsets — no offset-based pagination
7. **Idempotency**: Action execution supports Idempotency-Key headers for safe retries
8. **Optimistic concurrency**: Actions support `$expectedVersion` for conflict detection
9. **Rate limiting**: Global and per-endpoint rate limits (configurable via env vars)
10. **Audit trail**: Every action execution is logged — legally required for tax authority systems
