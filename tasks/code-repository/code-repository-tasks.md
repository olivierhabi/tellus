# Tellus — Code Repositories Implementation Spec (v1)

> **Scope.** Production-grade replica of Palantir Foundry Code Repositories sufficient to execute the full Foundry-Function-to-Workshop workflow end-to-end: repo init → resource imports → authoring → live preview → commit → tag → CI build → Functions registry publish → Action Type binding in Ontology Manager → Workshop integration.
>
> **Reference architecture.** Stemma (JGit on AtlasDB-on-Cassandra), Jemma CI, JobSpec model, Functions registry, OSDK generator, OMS, OSv2, Funnel, Compass, Multipass, Conjure RPC. Destination state only — no Phonograph (OSv1), no Code Workbook, no fixed-webhook event model.
>
> **Format conventions.** Each task is an engineering contract: dependencies, purpose, API surface (Conjure-style), owned data (DDL where applicable), concurrency model, error codes, SLOs (P50/P95/P99), Prometheus metric names, edge cases & invariants, acceptance criteria. Tasks are decomposed for delegation to AI agents — no task assumes another's internal implementation, only its public contract.

---

## 0. Dependency DAG

```
                 ┌──────────────────────────────────────────────────┐
                 │  Pre-existing Tellus services (assumed live)     │
                 │  Compass · Multipass · OMS · OSv2 · OSS · Funnel │
                 └──────────────────────────────────────────────────┘
                                       │
                  ┌────────────────────┴───────────────────┐
                  ▼                                        ▼
         B1 Stemma Git Server                  B10 Stemma Event Bus & Branch Protection
                  │                                        │
                  ▼                                        │
         B2 Code Repository Service ◀──────────────────────┘
                  │
       ┌──────────┼──────────────────────────────────────────────┐
       ▼          ▼                                              ▼
   B3 Templates  B4 Resource Imports Svc ──▶ B5 OSDK Code Generator
                                                │
                                                ▼
                                         B6 Jemma CI Worker Pool
                                                │
                                  ┌─────────────┼─────────────┐
                                  ▼             ▼             ▼
                            B7 JobSpec     B8 Functions    B9 Live Preview
                              Publisher      Registry       Execution Svc
                                                │
                                                └──▶ Actions Service (existing)
                                                          ▶ OMS Action Types
                                                          ▶ Workshop variables/columns/charts

Frontend layer (depends on backend contracts only):
  F1 IDE Shell ──▶ F2 File Tree/VFS ──▶ F3 Init Wizard
                                       F4 Branch & Commit Panel
                                       F5 Tag & Release Dialog
                                       F6 Resource Imports Panel
                                       F7 Live Preview / Functions Tab
                                       F8 Checks / Builds Status Panel
                                       F9 PR / Code Review UI
                                       F10 Repo Settings & Admin UI
```

Critical path for the demo workflow: **B1 → B2 → B3 → B4 → B5 → B6 → B8 → B9** (backend) and **F1 → F2 → F3 → F6 → F7 → F4 → F5 → F8** (frontend).

---

## 1. Global Contracts (apply to every task)

### 1.1 RID format
`ri.<service>.<instance>.<type>.<uuid>` — UUIDv4, lowercase, hyphenated. Reserved namespaces for this spec: `stemma`, `code-repos`, `jemma`, `functions`, `osdk`. Repository RID: `ri.stemma.main.repository.<uuid>`. JobSpec RID: `ri.code-repos.main.job-spec.<uuid>`. Function artifact RID: `ri.functions.main.function-version.<uuid>`. CI run RID: `ri.jemma.main.run.<uuid>`.

### 1.2 Authentication & authorization
All RPC carries `Authorization: Bearer <jwt>` minted by Multipass. JWT claims must include `sub`, `jti`, `org`, `markings[]`, `scopes[]`, `exp ≤ 16h`. Service-to-service uses client_credentials grant; user-driven flows use authorization_code+PKCE. Compass mediates resource-level permissions: every read/write checks `Compass.canAct(principal, rid, role)` with `VIEWER | EDITOR | OWNER | DISCOVERER`. **IDOR returns 404, never 403** (do not leak existence).

### 1.3 Error envelope (Conjure-typed)
```json
{
  "errorCode": "INVALID_ARGUMENT" | "PERMISSION_DENIED" | "NOT_FOUND" | "CONFLICT" |
               "FAILED_PRECONDITION" | "RESOURCE_EXHAUSTED" | "INTERNAL" | "UNAVAILABLE" |
               "DEADLINE_EXCEEDED" | "QOS_THROTTLE",
  "errorName": "Stemma:RefUpdateRejected" | "CodeRepos:JobSpecConflict" | "Jemma:BuildFailed" | ...,
  "errorInstanceId": "uuid",
  "parameters": { "<safe arg>": "<value>" }
}
```
HTTP status mapping: 400/403/404/409/412/429/500/503/504. The `errorName` is namespaced per task (defined inline below).

### 1.4 Optimistic concurrency
Every mutable resource exposes `If-Match: "<etag>"` on PUT/PATCH/DELETE. ETag is `W/"<resource_version>"` where `resource_version` is a monotonically increasing integer per row. A missing or stale `If-Match` returns `412 FAILED_PRECONDITION` (`<Service>:StaleEtag`). All collection writes MUST be idempotent via `Idempotency-Key: <uuid>` header — the server stores `(idempotency_key, request_hash)` for 24 h; replays with same hash return the original response, replays with different hash return `409 CONFLICT` (`<Service>:IdempotencyConflict`).

### 1.5 Pagination
Cursor-based: `?pageSize=<1..1000, default=100>&pageToken=<opaque>`. Response: `{ data: [...], nextPageToken: string|null }`. Cursors are opaque base64, must include sort key and last-seen RID, must survive backend restart for ≥30 days. **Never return offset-based pagination.**

### 1.6 Field validation regex
- `apiName` (any user-facing API name): `^[a-z][a-zA-Z0-9]{0,63}$`, reserved words rejected: `ontology, object, property, link, relation, rid, primaryKey, typeId, ontologyObject, branch, repository, function, action`.
- `branchName`: `^[a-zA-Z0-9._/-]{1,255}$`, must not contain `..`, `@{`, `\`, must not start with `-` or `/`, must not end with `.lock` (matches Git ref-format rules).
- `tagName`: same as branchName plus must match `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$` (semver, `v` prefix optional but normalized away).
- `repositoryName` (display): `^[\w][\w \-.()]{0,127}$`, not unique.
- `filePath` inside a repo: must be `< 4096` bytes, must not contain null bytes, must not start with `/`, no `..` segments, must not equal `.git` or live under `.git/`.

### 1.7 Standard SLOs (per endpoint class)
| Class | P50 | P95 | P99 | Timeout | Notes |
|---|---|---|---|---|---|
| Metadata read (single resource) | 30ms | 150ms | 400ms | 5s | Compass-fronted reads |
| Metadata write | 80ms | 400ms | 1s | 10s | excludes Funnel/CI side-effects |
| Git ref/object read | 50ms | 300ms | 800ms | 30s | tail latency dominated by packfile fetch |
| Git push (≤10 MB delta) | 400ms | 2s | 8s | 60s | bounded by AtlasDB stream throughput |
| CI run start latency | 1s | 5s | 15s | 60s | warm pool; cold start +30s |
| Live preview execution | 200ms | 2s | 8s | 30s hard cap | Function CPU budget, not wall clock |
| OSDK generation (≤200 types) | 500ms | 3s | 10s | 60s | scales linearly with type-set shape |

Any endpoint exceeding its P99 by > 2× for a 5-min window must page. Every service exposes `/health` (liveness) and `/readiness` (db connectivity, downstream availability).

### 1.8 Prometheus metrics (mandatory baseline per service)
- `tellus_rpc_requests_total{service, endpoint, code}` (counter)
- `tellus_rpc_request_duration_seconds{service, endpoint, code}` (histogram, buckets: 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s, 30s)
- `tellus_rpc_inflight{service, endpoint}` (gauge)
- `tellus_circuit_breaker_state{service, downstream}` (gauge: 0=closed, 1=open, 2=half-open)
- `tellus_idempotency_replays_total{service, endpoint}` (counter)
- Plus task-specific metrics defined per task below.

### 1.9 Circuit breakers / retries
All cross-service calls use Dialogue-style clients: AIMD client-side concurrency limiter (initial 20, min 1, max 200), exponential backoff with jitter for retriable errors (429, 503, 504, network), max 4 attempts, FIFO request queue per upstream node. Reads are retriable; writes are retriable **only when carrying an Idempotency-Key**. Open the circuit at 50% error rate over 30 windowed seconds; half-open after 30s.

### 1.10 Audit log
Every mutating endpoint writes one row to the `audit.events` Kafka topic (and Postgres mirror) with `(timestamp, principal_sub, principal_jti, service, endpoint, target_rid, action, before_hash, after_hash, request_id, source_ip, user_agent)`. Audit writes are best-effort fan-out but **the response is held until the audit row is durable in Postgres** (synchronous write to local replica, async Kafka publish). Retention: 7 years.

---

## 2. Backend Tasks

### B1 — Stemma Git Server (JGit on KV)

**Depends on:** Compass, Multipass.

**Purpose.** Distributed, stateless Git server speaking Git's HTTP smart protocol over TLS, backed by a transactional KV store. JGit `DfsRepository` extension is the authoritative storage abstraction. Every Tellus repository is one Stemma logical repo.

**Service surface.** Two ports:
1. **Git smart protocol** at `https://<host>/git/<repository_rid>{.git}` — supports `info/refs?service=git-upload-pack|git-receive-pack`, `git-upload-pack`, `git-receive-pack`, `objects/info/packs`, etc. Authentication via Multipass `Authorization: Basic <base64(token:x-oauth-basic)>` OR `Authorization: Bearer <jwt>`. Permissions: clone/fetch requires `VIEWER`, push requires `EDITOR` plus branch-protection check (delegated to B10).
2. **Conjure admin API** `/stemma/api/v1`:
   ```yaml
   StemmaAdminService:
     createRepository: POST   /repositories                        body: {rid, defaultBranchName} → Repository
     deleteRepository: DELETE /repositories/{rid}                  (soft-delete: tombstone; hard purge after 30d)
     listRefs:        GET    /repositories/{rid}/refs             → list<Ref>
     getRef:          GET    /repositories/{rid}/refs/{name}      → Ref
     readBlob:        GET    /repositories/{rid}/blobs/{sha}      → octet-stream
     readTree:        GET    /repositories/{rid}/trees/{sha}      → TreeEntry[]
     readCommit:      GET    /repositories/{rid}/commits/{sha}    → Commit
     readFileAtRef:   GET    /repositories/{rid}/refs/{ref}/files?path=...  → FileContent
     diff:            POST   /repositories/{rid}/diff             body: {fromRef, toRef, paths?} → DiffResult
     gc:              POST   /repositories/{rid}/gc               (admin only; queued)
   ```

**Owned data.** PostgreSQL (or AtlasDB if available). Required schema:

```sql
-- B1: Stemma storage
CREATE TABLE stemma_repository (
  rid               TEXT PRIMARY KEY,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  state             TEXT NOT NULL CHECK (state IN ('ACTIVE','TOMBSTONED','PURGED')),
  resource_version  BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE stemma_ref (
  repository_rid    TEXT NOT NULL REFERENCES stemma_repository(rid),
  name              TEXT NOT NULL,            -- refs/heads/main, refs/tags/v1.0.0
  target_sha        TEXT NOT NULL,            -- 40-char hex
  peeled_sha        TEXT,                     -- for annotated tags
  is_symbolic       BOOLEAN NOT NULL DEFAULT FALSE,
  symbolic_target   TEXT,                     -- when is_symbolic
  resource_version  BIGINT NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, name)
);
CREATE INDEX stemma_ref_repo_idx ON stemma_ref(repository_rid);

CREATE TABLE stemma_packfile (
  repository_rid    TEXT NOT NULL,
  pack_id           TEXT NOT NULL,            -- ULID
  pack_size_bytes   BIGINT NOT NULL,
  index_size_bytes  BIGINT NOT NULL,
  pack_blob_id      TEXT NOT NULL,            -- pointer to large_object table
  index_blob_id     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, pack_id)
);

CREATE TABLE stemma_loose_object (
  repository_rid    TEXT NOT NULL,
  sha               TEXT NOT NULL,
  obj_type          SMALLINT NOT NULL,        -- 1=commit,2=tree,3=blob,4=tag
  size_bytes        BIGINT NOT NULL,
  content_blob_id   TEXT NOT NULL,            -- delta-compressed acceptable
  PRIMARY KEY (repository_rid, sha)
);

-- Large object backing (use pg_largeobject / S3 / Cassandra blob)
CREATE TABLE stemma_blob (
  blob_id           TEXT PRIMARY KEY,
  storage_uri       TEXT NOT NULL,            -- s3://… or pglo:<oid>
  size_bytes        BIGINT NOT NULL,
  sha256            TEXT NOT NULL
);
```

**Concurrency model.** Ref updates use **CAS** with `(repository_rid, name, expected_old_sha)`; failure returns `Stemma:RefUpdateRejected` (HTTP 409). Receive-pack must hold the row lock on `stemma_ref(repository_rid, name)` for the duration of the atomic ref transaction. Multiple refs in a single push atomically commit (Postgres serializable transaction; if AtlasDB, single transaction across all updated rows). Packfile uploads stream into `stemma_blob` first; only after content-addressable verification does the `stemma_packfile` row insert. **Never accept a push without `git-receive-pack` quarantine + repack.** Nodes are stateless: any node can serve any request.

**Error codes (Stemma:*).**
- `Stemma:RepositoryNotFound` (404)
- `Stemma:RefNotFound` (404)
- `Stemma:RefUpdateRejected` (409) — CAS mismatch, non-fast-forward without force, or branch protection denied
- `Stemma:ProtectedBranchViolation` (403) — pushed by B10 callback
- `Stemma:RepositorySizeExceeded` (413) — > 10 GB total without admin override
- `Stemma:PushBodyTooLarge` (413) — > 1 GB per push
- `Stemma:InvalidPackfile` (400) — failed `git index-pack --strict`
- `Stemma:GcInProgress` (503) — temporary, retry-after 60s

**SLOs.**
- `info/refs` P95 < 200ms.
- `git-upload-pack` (clone): throughput ≥ 50 MB/s sustained per connection.
- `git-receive-pack` (push): commit latency P95 < 2s for ≤ 10 MB delta.
- `gc` (background): packs ≤ 64 MB, ≤ 10 packs per repo before merge.

**Metrics.** `stemma_pushes_total{result}`, `stemma_clones_bytes_total`, `stemma_packfiles{repo}` (gauge), `stemma_ref_update_conflicts_total`, `stemma_repo_size_bytes{repo}`.

**Edge cases & invariants.**
- Force-push requires `EDITOR` + branch is unprotected (B10) + `force=true` flag in receive-pack capability negotiation.
- Tag refs are immutable: any update to `refs/tags/*` returns `Stemma:RefUpdateRejected` unless `force=true` AND principal is `OWNER`.
- Soft-deleted repos return 404 to all callers except admin queries.
- An empty repository is created with a single ref `HEAD → refs/heads/main` (symbolic), no commits — first push initializes the branch.
- Quarantine directory lifecycle: every push gets an isolated quarantine; pre-receive hook (callback to B10) runs before promotion; quarantine is deleted after promotion or rejection.

**Acceptance.**
1. `git clone https://tellus/git/<rid>.git` works against a freshly created repo and can fetch a 1 GB packfile.
2. Concurrent pushes to the same branch from two clients: exactly one succeeds, the other receives `RefUpdateRejected` with the new tip in the error parameters.
3. Killing the Stemma node mid-push results in no partial state — the next clone sees the pre-push state.

---

### B2 — Code Repository Service

**Depends on:** B1, Compass, Multipass.

**Purpose.** The metadata layer above Stemma: CRUD over repository resources, branch metadata cache, repository settings, principal-facing RID issuance, and the bridge between Compass (filesystem) and Stemma (git data). UI and CI talk to this service, not to Stemma directly, for everything except raw git protocol.

**Service surface.** `/code-repos/api/v1`:
```yaml
CodeRepositoryService:
  createRepository:
    POST /repositories
    body: { displayName, parentFolderRid, templateId, templateVersion, defaultBranch?: "main" }
    headers: Idempotency-Key
    returns: Repository           # { rid, displayName, parentFolderRid, templateId, templateVersion, defaultBranch, gitHttpUrl, createdAt, etag }
  getRepository:    GET /repositories/{rid}
  updateRepository: PATCH /repositories/{rid}              # If-Match required; only displayName, defaultBranch, settings
  deleteRepository: DELETE /repositories/{rid}             # If-Match
  listBranches:     GET /repositories/{rid}/branches?protected=true|false
  getBranch:        GET /repositories/{rid}/branches/{name}
  listTags:         GET /repositories/{rid}/tags?pageSize=&pageToken=
  getRepoSettings:  GET /repositories/{rid}/settings       # repoSettings.json materialized
  updateRepoSettings: PUT /repositories/{rid}/settings     # If-Match
  listFiles:        GET /repositories/{rid}/branches/{branch}/tree?path=&depth=
  readFile:         GET /repositories/{rid}/branches/{branch}/files?path=
  search:           GET /repositories?parent=&template=&q=&pageSize=&pageToken=
```

**Owned data.**
```sql
CREATE TABLE code_repository (
  rid                TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  parent_folder_rid  TEXT NOT NULL,                -- Compass folder
  project_rid        TEXT NOT NULL,                -- denormalized from parent walk
  template_id        TEXT NOT NULL,
  template_version   TEXT NOT NULL,
  default_branch     TEXT NOT NULL DEFAULT 'main',
  settings_json      JSONB NOT NULL DEFAULT '{}',
  state              TEXT NOT NULL CHECK (state IN ('ACTIVE','ARCHIVED','TRASHED')),
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resource_version   BIGINT NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX code_repository_parent_name ON code_repository(parent_folder_rid, lower(display_name)) WHERE state='ACTIVE';

CREATE TABLE code_repository_branch_cache (
  repository_rid     TEXT NOT NULL,
  branch_name        TEXT NOT NULL,
  head_sha           TEXT,
  is_protected       BOOLEAN NOT NULL DEFAULT FALSE,
  last_commit_at     TIMESTAMPTZ,
  last_commit_author UUID,
  open_pr_count      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (repository_rid, branch_name)
);
```

`settings_json` schema (materialized to repoSettings.json on the default branch on save):
```jsonc
{
  "tagNameValidation": { "regex": "^v\\d+\\.\\d+\\.\\d+$", "errorMessage": "..." },
  "branchNameValidation": { "regex": "^(main|develop|feature/.+)$" },
  "protectedBranches": ["main", "release/*"],
  "requirePullRequest": true,
  "requiredApprovals": 1,
  "computeProfile": "default" | "warm-pool" | "high-memory",
  "checks": { "lint": true, "unitTests": true, "antipattern": true }
}
```

**Concurrency model.** Resource version on `code_repository` (used in ETag). Branch cache is updated by **B10 event listener** on every Stemma post-receive event — eventual consistency, ≤ 5 s lag P99. Reads from the cache; writes go to Stemma + the cache is updated by the event handler. Renaming a repo (PATCH displayName) holds a row lock and validates uniqueness against the case-insensitive index.

**Error codes (CodeRepos:*).**
- `CodeRepos:NameConflict` (409)
- `CodeRepos:TemplateNotFound` (404) — referenced template_id doesn't exist in B3 registry
- `CodeRepos:TemplateInitFailed` (500) — Stemma push of initial commit failed; repository is marked `INIT_FAILED`, retriable via re-init
- `CodeRepos:ParentFolderNotFound` (404)
- `CodeRepos:InvalidSettings` (400) — bad regex, unknown computeProfile, etc.
- `CodeRepos:RepositoryArchived` (412) — write to archived repo

**SLOs.**
- `createRepository` end-to-end (including initial template push): P95 < 5s.
- `listBranches`: P95 < 200ms (cache).
- `readFile`: P95 < 300ms.

**Metrics.** `code_repos_repositories_total{template, state}` (gauge), `code_repos_branch_cache_lag_seconds` (histogram), `code_repos_create_failures_total{reason}`.

**Edge cases & invariants.**
- Repo creation is a 4-step saga: (1) Compass.createResource → (2) Stemma.createRepository → (3) B3.scaffold → push initial commit → (4) `state = ACTIVE`. Steps 1–3 are compensable; on failure, the saga rolls back via tombstoning. **Idempotency key required.**
- Renaming a repo updates display name only; the RID is permanent; the git URL is permanent.
- Trashing a repo (Compass trash) sets `state = TRASHED` and disables git access (Stemma returns 404). Untrash restores.
- Deleting a repo is a 2-phase: tombstone for 30 days (Stemma already does this), then hard purge.

**Acceptance.**
1. `POST /repositories` with templateId `typescript-functions` → 201 Created with valid RID, repo is clonable, contains template files on `main`.
2. Two concurrent creates with same name in same folder: exactly one returns 201, the other 409 NameConflict.
3. Stemma push updates `head_sha` in branch cache within 5s P99.

---

### B3 — Repository Templates Engine

**Depends on:** B1.

**Purpose.** Renders the initial commit content for each repository type. Templates are versioned, deterministic, and parameterizable. Required templates for v1: `typescript-functions`, `python-functions`, `transforms-python`, `transforms-java`, `transforms-sql`.

**Service surface.** `/templates/api/v1`:
```yaml
TemplateService:
  listTemplates: GET /templates                                       → Template[]
  getTemplate:   GET /templates/{templateId}/versions/{version}       → TemplateManifest
  scaffold:      POST /scaffold
                  body: { templateId, version, repositoryRid, parameters: {…}, principalSub }
                  → ScaffoldResult { commitSha, fileCount, totalBytes }
                  # Internal endpoint, called by B2 saga only.
```

`TemplateManifest`:
```jsonc
{
  "templateId": "typescript-functions",
  "version": "2.4.0",
  "displayName": "TypeScript Functions",
  "language": "typescript",
  "category": "functions",
  "parameters": [
    {"name": "packageName", "regex": "^[a-z][a-z0-9-]{0,63}$", "default": "<derived from repo name>"}
  ],
  "files": [ /* path, content (templated), mode, isBinary */ ]
}
```

**Owned data.** Templates are stored as immutable git tree objects in a system-owned Stemma repo `ri.stemma.main.repository.<system-templates>`, addressed by `templateId@version`. A `templates_index` table caches manifest metadata for listing.

**Concurrency.** Template content is content-addressable (git SHA); reads are cache-friendly. Scaffold is idempotent: same `(templateId, version, repositoryRid, parameters)` → same commit SHA.

**Error codes (Templates:*).**
- `Templates:NotFound` (404)
- `Templates:VersionDeprecated` (410) — admin can mark deprecated; existing repos unaffected, new scaffolds blocked
- `Templates:ParameterValidationFailed` (400)

**Edge cases.**
- `typescript-functions` template MUST include: `package.json`, `tsconfig.json`, `src/index.ts` with `@Function` example, `.gitignore`, `README.md`, `osdk.config.json` placeholder (consumed by B5), and `repoSettings.json`. The package name is derived from the repo display name lowercased + hyphenated.
- `python-functions` template MUST include `pyproject.toml` (Poetry), `src/<package>/__init__.py`, `tests/`, `osdk.config.json`.
- `transforms-python` template MUST include `transforms/` directory with `@transform` example referencing a placeholder dataset RID.
- Template upgrades NEVER auto-apply to existing repos — they are opt-in via a future "Upgrade template" UI action (out of scope for v1).

**Acceptance.**
1. Scaffolding `typescript-functions@2.4.0` for repo `<rid>` produces a deterministic commit SHA across two runs with the same inputs.
2. The scaffolded repo, when cloned, runs `npm ci && npm test` successfully on a fresh node:20 container.

---

### B4 — Resource Imports Service

**Depends on:** B2, OMS, Compass.

**Purpose.** Manages the `resource_imports` panel of a Code Repository — the set of Ontology entities (object types, link types, action types, interfaces, value types) that a repository's code is allowed to reference. Enforces the Compass-scope invariant: **every imported entity must also be imported into the containing Project**.

**Service surface.** `/code-repos/api/v1`:
```yaml
ResourceImportsService:
  listImports:   GET /repositories/{rid}/imports
                  → ImportSet { imports: [{ kind, rid, apiName, importedAt }], etag }
  addImports:    POST /repositories/{rid}/imports
                  body: { adds: [{ kind, rid }], removes: [{ rid }] }
                  headers: If-Match
                  → ImportSet
                  # Atomic; validates against Compass project-import scope.
  preview:       POST /repositories/{rid}/imports:preview
                  body: { adds, removes }
                  → ImpactReport { generatedFilesPreview, breakingReferences[] }
```

**Owned data.**
```sql
CREATE TABLE code_repository_imports (
  repository_rid    TEXT NOT NULL,
  entity_kind       TEXT NOT NULL CHECK (entity_kind IN ('OBJECT_TYPE','LINK_TYPE','ACTION_TYPE','INTERFACE','VALUE_TYPE')),
  entity_rid        TEXT NOT NULL,
  api_name_at_import TEXT NOT NULL,            -- snapshot for codegen stability
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by       UUID NOT NULL,
  PRIMARY KEY (repository_rid, entity_rid)
);

CREATE TABLE code_repository_imports_version (
  repository_rid    TEXT PRIMARY KEY,
  resource_version  BIGINT NOT NULL DEFAULT 1,  -- bumped on every set change → ETag
  generated_at      TIMESTAMPTZ
);
```

**Concurrency.** Atomic add/remove via single transaction; ETag from `resource_version`. After a successful change, **emit `code-repos.imports.changed` event** consumed by B5 to regenerate the OSDK.

**Error codes (Imports:*).**
- `Imports:EntityNotFound` (404)
- `Imports:NotImportedInProject` (412) — entity not in the repo's project's import scope
- `Imports:KindMismatch` (400)
- `Imports:DuplicateApiName` (409) — two entities share api_name → would break codegen

**Edge cases.**
- Adding an entity that has been **renamed** in OMS since last codegen: the `api_name_at_import` snapshot is updated and a `breakingReferences` warning is returned in `preview`.
- Removing an entity that is referenced in code: the impact report lists files; the actual remove still proceeds (CI will fail the build, which is the correct signal).
- Deleting the repository deletes imports rows.

**Acceptance.**
1. The video workflow `[Gena] Clinic` and `[Gena] Financial` import: both succeed; `osdk.config.json` reflects two object types.
2. Attempting to import an entity not in the project scope returns 412 with the project RID in `parameters`.

---

### B5 — OSDK Code Generator Service

**Depends on:** B4, OMS, B1.

**Purpose.** Generates per-repository typed bindings (TypeScript, Python) from the imported Ontology entities. Pushes the generated files as a system-author commit on a dedicated `__osdk` branch that the user's branches merge into (or as a `.osdk-generated/` directory committed automatically on changes — implementation: the latter, simpler and aligns with Foundry behavior).

**Service surface.** `/osdk-gen/api/v1`:
```yaml
OsdkGeneratorService:
  generate: POST /generate
            body: { repositoryRid, branch, importsEtag }
            headers: Idempotency-Key
            → GenerateResult { commitSha, generatedFiles[], durationMs }
  status:   GET /generate/{runId}
            → { state: PENDING|RUNNING|SUCCEEDED|FAILED, error?, commitSha? }
```

Triggered by the `code-repos.imports.changed` event (B4) and on demand from the IDE.

**Generated layout.**
- TypeScript: `.osdk-generated/index.ts`, `.osdk-generated/objects/<ApiName>.ts`, `.osdk-generated/actions/<ApiName>.ts`, `.osdk-generated/package.json` declaring local module `@osdk/local`. Re-exported from `src/osdk.ts` (template-provided).
- Python: `.osdk-generated/__init__.py`, `.osdk-generated/objects.py`, etc.

**Concurrency.** Generation is serialized per repository (Postgres advisory lock on `repository_rid` hash). Two concurrent triggers coalesce: the second waits for the first; if their `importsEtag` matches, second returns the same result.

**Error codes (Osdk:*).**
- `Osdk:OmsUnavailable` (503)
- `Osdk:UnsupportedPropertyType` (501) — fail loudly; do not silently drop
- `Osdk:GenerationFailed` (500)
- `Osdk:CommitFailed` (500) — Stemma push failed (likely concurrent user push); the generator retries 3× with re-fetch of branch tip

**SLOs.** Generation P95 < 3s for ≤ 200 entities. P99 < 10s.

**Edge cases.**
- A user push that conflicts with the auto-commit: generator detects via Stemma CAS failure, re-fetches HEAD, replays generation, retries push. After 3 failures, surfaces error to UI; user must re-trigger.
- Property types not yet supported (vector, media-reference, struct, geo): emit `// @ts-expect-error TELLUS-OSDK-UNSUPPORTED: <type>` placeholder + log; do not crash.

**Acceptance.**
1. After importing `[Gena] Clinic`, `.osdk-generated/objects/GenaClinic.ts` exists with typed properties matching OMS.
2. Renaming the apiName in OMS, then re-importing, regenerates with new apiName; old name is gone.

---

### B6 — Jemma CI Worker Pool

**Depends on:** B1, B2, B10, Kubernetes.

**Purpose.** Runs CI jobs in ephemeral Kubernetes pods on push, PR, and tag events. Per-language toolchains pre-baked into worker images. Streams logs back to subscribers (B8). Publishes results to B7 (transforms) and B8 (functions).

**Service surface.** `/jemma/api/v1`:
```yaml
JemmaService:
  startRun:    POST /runs
                body: { repositoryRid, ref, commitSha, trigger: PUSH|PR|TAG|MANUAL, triggeringUserSub }
                headers: Idempotency-Key
                → Run { rid, state: QUEUED, queuedAt }
  getRun:      GET /runs/{rid}
  cancelRun:   POST /runs/{rid}:cancel
  listRuns:    GET /runs?repositoryRid=&ref=&pageSize=&pageToken=
  streamLogs:  GET /runs/{rid}/logs (SSE)         server-sent events: { stage, line, ts }
  getLogChunk: GET /runs/{rid}/logs/chunks?stage=&offset=
```

**Owned data.**
```sql
CREATE TABLE jemma_run (
  rid               TEXT PRIMARY KEY,
  repository_rid    TEXT NOT NULL,
  ref               TEXT NOT NULL,
  commit_sha        TEXT NOT NULL,
  trigger_kind      TEXT NOT NULL CHECK (trigger_kind IN ('PUSH','PR','TAG','MANUAL')),
  triggered_by      UUID NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')),
  pod_name          TEXT,
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  exit_code         INT,
  failure_reason    TEXT
);
CREATE INDEX jemma_run_repo_ref_idx ON jemma_run(repository_rid, ref, queued_at DESC);

CREATE TABLE jemma_run_stage (
  run_rid           TEXT NOT NULL REFERENCES jemma_run(rid),
  stage_name        TEXT NOT NULL,            -- 'lint','test','build','publish-artifact','publish-jobspecs'
  state             TEXT NOT NULL,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  log_object_uri    TEXT,                     -- s3://… per-stage log
  PRIMARY KEY (run_rid, stage_name)
);
```

**Concurrency.** Per-(repository_rid, ref) **at most one running job**: a new push while a job is in-flight on the same ref **cancels** the in-flight job (graceful, 30s SIGTERM grace) and starts the new one. Per-repository concurrency cap: 4 concurrent jobs across all branches (configurable). Global pool size: autoscaled, default min 8, max 200 worker nodes.

**Job lifecycle.**
1. `QUEUED` → scheduler picks an available pod from the warm pool (warm = pre-pulled image, 0 idle pods kept warm in dev, configurable in prod).
2. `RUNNING` — pod clones the repo at `commit_sha`, runs stages in order: `setup` → `lint` → `test` → `build` → `publish`. On failure of a non-`publish` stage, subsequent stages are skipped and the run is `FAILED`.
3. Stages execute language-specific toolchains:
   - `typescript-functions`: `npm ci` → `npm run lint` (eslint) → `npm test` (jest) → `npm run build` (tsc) → publish Function artifact (B8).
   - `python-functions`: `poetry install` → `pylint`/`ruff` → `pytest` → publish Function artifact (B8).
   - `transforms-python`: lint + pytest + JobSpec discovery (B7).
   - `transforms-java`: `./gradlew check publish` + JobSpec discovery (B7).
4. **Hard timeout:** 30 minutes total per run; 10 minutes per stage. Exceeding cancels with `TIMED_OUT`.

**Error codes (Jemma:*).**
- `Jemma:RunNotFound` (404)
- `Jemma:RunAlreadyTerminal` (409) — cancel/start on a finished run
- `Jemma:CapacityExceeded` (429) — repo concurrency cap; auto-retried by client
- `Jemma:WorkerImageUnavailable` (503)
- `Jemma:StageFailed` (returned in run.state=FAILED, with `failure_reason`)

**SLOs.** Queue-to-start P95 < 5s with warm pool, < 30s cold. Log streaming latency P95 < 1s.

**Metrics.** `jemma_runs_total{trigger,result}`, `jemma_queue_depth`, `jemma_run_duration_seconds{template,result}`, `jemma_pod_cold_starts_total`.

**Edge cases.**
- Pod OOM-killed: state becomes `FAILED` with `failure_reason='OOM'`; user sees a banner suggesting larger compute profile.
- Stemma fetch fails inside the pod: retry 3× with backoff; then `FAILED` with `failure_reason='stemma-unreachable'`.
- Run cancelled while uploading artifacts to B8: B8 is told to abort the upload; partial artifacts are deleted.

**Acceptance.**
1. Push to `typescript-functions` repo → run is QUEUED in < 1s, RUNNING in < 5s, SUCCEEDED in < 60s for the empty template.
2. Two pushes within 1s to the same branch: first run is cancelled, second runs to completion.

---

### B7 — JobSpec Publisher (transforms repos)

**Depends on:** B6, OMS (for dataset RID resolution), Build orchestrator (existing or stub).

**Purpose.** During the `publish` stage of CI for transform repositories, discovers all `@transform` (Python) / `Transform` (Java) declarations and **publishes one JobSpec per output dataset on the current branch**. Enforces "one JobSpec owner per (output_dataset, branch)" globally.

**Service surface.** `/code-repos/api/v1` (continuation of B2 namespace):
```yaml
JobSpecService:
  publishJobSpecs: POST /repositories/{rid}/branches/{branch}/job-specs
                    body: { commitSha, jobSpecs: [JobSpec] }
                    headers: Idempotency-Key
                    → PublishResult { published[], rejected: [{ outputDatasetRid, reason }] }
                    # Internal — called by Jemma worker
  getJobSpec:      GET /job-specs?outputDatasetRid=&branch=
                    → JobSpec | 404
  listForRepo:     GET /repositories/{rid}/branches/{branch}/job-specs
```

`JobSpec`:
```jsonc
{
  "outputDatasetRid": "ri.foundry.main.dataset.<uuid>",
  "branch": "main",
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "commitSha": "abc123…",
  "sourcePath": "transforms-python/src/my_pkg/datasets/foo.py",
  "entryPoint": "my_pkg.datasets.foo:compute",
  "inputs": [{"datasetRid": "...", "branch": "...", "view": "snapshot"}],
  "parameters": {},
  "computeProfile": "default"
}
```

**Owned data.**
```sql
CREATE TABLE job_spec (
  output_dataset_rid TEXT NOT NULL,
  branch             TEXT NOT NULL,
  repository_rid     TEXT NOT NULL,
  commit_sha         TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  entry_point        TEXT NOT NULL,
  inputs             JSONB NOT NULL,
  parameters         JSONB NOT NULL DEFAULT '{}',
  compute_profile    TEXT NOT NULL DEFAULT 'default',
  published_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resource_version   BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (output_dataset_rid, branch)
);
CREATE INDEX job_spec_repo_branch_idx ON job_spec(repository_rid, branch);
```

**Concurrency.** Per-(output_dataset_rid, branch) **uniqueness invariant**. A second repository attempting to publish a JobSpec for the same key returns `JobSpec:OutputAlreadyOwned` (409). Re-publish from the same `repository_rid` is allowed (atomic upsert). Branch fallback resolution (read path) is owned by the Build orchestrator, not this service.

**Error codes (JobSpec:*).**
- `JobSpec:OutputAlreadyOwned` (409) — different repo registered first
- `JobSpec:CircularDependency` (400) — discovered output appears in inputs (transitive)
- `JobSpec:InvalidEntryPoint` (400)
- `JobSpec:DatasetNotFound` (404)

**Edge cases.**
- A repo whose CI used to own dataset D drops the transform: on next publish, the orphaned JobSpec is deleted (the new publish is a full replacement of all JobSpecs from that `(repository_rid, branch)`).
- A merge that brings in a JobSpec colliding with another repo's: CI fails with `OutputAlreadyOwned`, blocking the merge.

**Acceptance.**
1. Pushing a `transforms-python` repo with two `@transform` decorators publishes exactly two JobSpec rows.
2. Two repos racing to claim the same output: exactly one wins.

---

### B8 — Functions Registry Service

**Depends on:** B6, B5, Multipass.

**Purpose.** Stores tagged Function versions (TypeScript/Python) emitted by the `publish` stage of CI. Versions are immutable, semver-named, branch-aware. Consumers: OMS Action Types (for function-backed actions), Workshop variables/columns/charts, OSDK runtime.

**Service surface.** `/functions/api/v1`:
```yaml
FunctionsRegistryService:
  publishVersion:    POST /functions/{repositoryRid}/versions
                      body: { tagName, semver, branch, commitSha, runtime: NODE_20|PY_311,
                              entryPoints: [{ apiName, signature, inputs[], outputs[] }],
                              artifactBlob: <multipart> }
                      headers: Idempotency-Key
                      → FunctionVersion { rid, semver, branch, isPreview, sha256, createdAt }
                      # Internal — Jemma only
  listVersions:      GET /functions/{repositoryRid}/versions?branch=&pageSize=
  getVersion:        GET /functions/{repositoryRid}/versions/{semver}
  resolveTarget:     GET /functions/{repositoryRid}/resolve?versionTarget=^1.0.0&branch=main
                      → FunctionVersion
  listFunctions:     GET /functions?ontologyRid=&q=
                      → discovery for Workshop/OMS UIs; cross-repo
  downloadArtifact:  GET /functions/{repositoryRid}/versions/{semver}/artifact
```

`FunctionVersion.entryPoints[].signature` is a typed function descriptor:
```jsonc
{
  "apiName": "calculateDaysSalesOutstanding",
  "displayName": "Calculate Days Sales Outstanding",
  "inputs": [{ "name": "clinic", "type": { "kind": "ObjectType", "rid": "ri.ontology.main.object-type.<uuid>" }}],
  "output":  { "kind": "Number" },
  "isQuery": true,
  "isAction": false,
  "memoryMb": 512,
  "cpuTimeoutSec": 30
}
```

**Owned data.**
```sql
CREATE TABLE function_version (
  rid               TEXT PRIMARY KEY,         -- ri.functions.main.function-version.<uuid>
  repository_rid    TEXT NOT NULL,
  branch            TEXT NOT NULL,            -- branch on which it was published
  is_preview        BOOLEAN NOT NULL,         -- true iff branch != repo's default
  semver            TEXT NOT NULL,
  commit_sha        TEXT NOT NULL,
  runtime           TEXT NOT NULL CHECK (runtime IN ('NODE_20','PY_311')),
  artifact_blob_id  TEXT NOT NULL,
  artifact_sha256   TEXT NOT NULL,
  artifact_bytes    BIGINT NOT NULL,
  manifest_json     JSONB NOT NULL,           -- entryPoints[]
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  state             TEXT NOT NULL CHECK (state IN ('AVAILABLE','YANKED'))
);
CREATE UNIQUE INDEX function_version_repo_semver_branch ON function_version(repository_rid, branch, semver);
```

**Concurrency.** Republish of same `(repository_rid, branch, semver)` returns the existing record only if `artifact_sha256` matches; otherwise `409 Functions:VersionImmutable`. Yanking is metadata-only; consumers are notified via event `functions.version.yanked`.

**Version target resolution (`resolveTarget`).** Semver range against AVAILABLE versions on the requested branch, falling back to the default branch if no match. Algorithm:
1. Parse `versionTarget` (npm-semver compatible: `^1.2.0`, `~1.2.0`, `1.2.x`, `=1.2.3`, `>=1.2.3 <2.0.0`).
2. Filter `function_version` rows where `branch=requested OR (branch=default AND is_preview=false)`.
3. Pick the highest semver matching the range.
4. Return 404 if none.

**Error codes (Functions:*).**
- `Functions:VersionImmutable` (409)
- `Functions:VersionNotFound` (404)
- `Functions:VersionTargetUnsatisfied` (404)
- `Functions:RepositoryNotPublishable` (412) — repo template is not a function template
- `Functions:ArtifactCorrupt` (400) — sha256 mismatch on upload

**Edge cases.**
- Branch-aware preview: tagging `1.0.0-beta.1` on a feature branch creates a row with `is_preview=true`. OMS Action Type bound to `^1.0.0` resolves to the latest stable on `main`, NOT to the preview, unless the consumer explicitly requests `branch=feature/foo`.
- Yanking a version still in use by an Action Type: yank succeeds, but a warning is published; OMS shows "yanked function" in the action UI.
- Artifact storage: blob in S3-compatible store, retention forever (until repo deletion).

**SLOs.** `resolveTarget` P95 < 50ms (in-memory cache by `repositoryRid` + invalidation on publish). `publishVersion` P95 < 2s for ≤ 50 MB artifact.

**Acceptance.**
1. Tag `v1.0.0` on `main` → CI publishes → `resolveTarget(^1.0.0, main)` returns it.
2. Same tag pushed on a feature branch → `is_preview=true`, doesn't pollute main resolution.
3. Two CI pods racing on the same tag: idempotency key dedups; second sees first's result.

---

### B9 — Live Preview Execution Service

**Depends on:** B8, OSS, OMS, Multipass.

**Purpose.** Executes a Function's entry point against a live Ontology snapshot for the IDE's "Run" button. Sandboxed, time-boxed, read-only by default (write actions blocked unless the user has explicit Action permissions and confirms). Used in F7.

**Service surface.** `/live-preview/api/v1`:
```yaml
LivePreviewService:
  prepareSession: POST /sessions
                   body: { repositoryRid, branch, commitSha }
                   → Session { rid, expiresAt }
                   # spins up a runtime worker, hot from pool
  invoke:         POST /sessions/{rid}/invoke
                   body: { functionApiName, inputs: { … }, allowMutations: false }
                   → InvokeResult { output, durationMs, logs[] }
  closeSession:   DELETE /sessions/{rid}
```

**Runtime model.** A live-preview session is a Node 20 (or Python 3.11) container with the user's repo at the requested commit, the OSDK pre-installed, and an OAuth token scoped to the user's permissions on the requested branch. Container is allocated from a per-(runtime, repository_template) warm pool with eviction after 10 minutes idle.

**Resource limits.** Per invocation: 30s CPU, 512 MiB memory (configurable up to 2 GiB), 100 MB egress, 1000 OSDK calls. Limits enforced at runtime via cgroups + interceptor. Exceeding any → `LivePreview:LimitExceeded` and abort.

**Concurrency.** One in-flight invocation per session; subsequent invocations queue in-process. Sessions auto-expire after 30 minutes; closed sessions return 404.

**Error codes (LivePreview:*).**
- `LivePreview:SessionNotFound` (404)
- `LivePreview:InvocationFailed` (500) — user code threw
- `LivePreview:Timeout` (504)
- `LivePreview:LimitExceeded` (429)
- `LivePreview:WriteAttemptDenied` (403) — function tried to mutate; `allowMutations=false`

**Edge cases.**
- The IDE is editing code that hasn't been committed: the session must execute against the **working tree**, not the last commit. Implementation: F7 sends an HTTP `PATCH` of dirty files to the session before invocation; the service snapshots the patched tree.
- Function imports OSDK types removed since last codegen: invocation fails with `LivePreview:OsdkStale` and a hint to regenerate.

**SLOs.** First-invocation latency (cold session) P95 < 5s; warm-session invocation P95 < 2s. P99 hard cap 8s.

**Metrics.** `live_preview_invocations_total{result}`, `live_preview_session_warmup_seconds`, `live_preview_active_sessions`.

**Acceptance.**
1. The video workflow: select `calculateDaysSalesOutstanding`, click Run, see `40.51` returned within 2s warm.
2. A function with `while(true){}` is killed at 30s and returns `Timeout`.

---

### B10 — Stemma Event Bus & Branch Protection

**Depends on:** B1, B2.

**Purpose.** Listens to Stemma's pre/post-receive hooks, enforces branch protection rules from B2's `repoSettings`, and fans out events to subscribers (B6 for CI, B5 for OSDK regen, F8 for live UI updates, audit).

**Hook contract (Stemma → B10).** Pre-receive: synchronous HTTP call from Stemma to B10's `/hooks/pre-receive` with `{repositoryRid, principalSub, refUpdates: [{ref, oldSha, newSha, isCreate, isDelete, isForce}]}`. Response within 5s, otherwise Stemma rejects the push (`Stemma:HookTimeout`). Post-receive: asynchronous event published to Kafka (`stemma.refs.updated`).

**Pre-receive checks (in order, fail-fast).**
1. Validate ref name against `branchNameValidation` / `tagNameValidation` regex from `repoSettings`.
2. If ref is in `protectedBranches`:
   - `isDelete` → reject `BranchProtection:DeleteProtected`.
   - `isForce` → reject `BranchProtection:ForcePushProtected`.
   - Direct push (no PR) and `requirePullRequest=true` → reject `BranchProtection:RequiresPullRequest`.
3. If ref is a tag (`refs/tags/*`):
   - `isDelete` or update → reject (tags are immutable per B1) unless principal is OWNER.
4. Compass permission check: `canAct(principal, repository_rid, EDITOR)` — reject `Compass:PermissionDenied` else.

**Service surface.** `/stemma-events/api/v1`:
```yaml
StemmaEventsService:
  subscribe:    POST /subscriptions
                 body: { eventTypes: [PUSH|MERGE|TAG|PR_OPENED|...], targetUri, secret }
                 → Subscription { rid }
                # Subscribers receive POSTs with HMAC-SHA256 signature.
  listEvents:   GET /events?repositoryRid=&since=&pageSize=&pageToken=
```

**Owned data.**
```sql
CREATE TABLE stemma_event (
  rid              TEXT PRIMARY KEY,
  repository_rid   TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  ref              TEXT,
  old_sha          TEXT,
  new_sha          TEXT,
  principal_sub    UUID,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload          JSONB NOT NULL
);
CREATE INDEX stemma_event_repo_time_idx ON stemma_event(repository_rid, occurred_at DESC);

CREATE TABLE stemma_subscription (
  rid              TEXT PRIMARY KEY,
  event_types      TEXT[] NOT NULL,
  repository_rid   TEXT,                     -- nullable = global
  target_uri       TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('ACTIVE','SUSPENDED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Concurrency.** Pre-receive hooks are stateless; multiple Stemma nodes call B10 in parallel; B10 must respond within 2s P99. Post-receive fan-out is async: events published to Kafka with at-least-once semantics; subscribers are responsible for idempotency.

**Error codes (BranchProtection:*).**
- `BranchProtection:DeleteProtected` (403)
- `BranchProtection:ForcePushProtected` (403)
- `BranchProtection:RequiresPullRequest` (403)
- `BranchProtection:InsufficientApprovals` (403) — at PR merge time
- `BranchProtection:RegexViolation` (400)

**Edge cases.**
- `repoSettings.json` modified in the same push: validation uses the **old** settings (settings only take effect from the next push). This avoids the bootstrap problem of someone pushing settings that retroactively reject their own push.
- Subscriber endpoint flaps: 5 consecutive failures → `state=SUSPENDED`, requires manual reactivation.

**Acceptance.**
1. Push to a protected branch without PR: rejected with `RequiresPullRequest`.
2. Force-push to `main` when protected: rejected.
3. Push to feature branch: post-receive event arrives at B6 within 1s P95.

---

## 3. Frontend Tasks

> All frontend tasks consume backend contracts only. Frontend uses TypeScript + React 18 + the existing Tellus design system. Browser storage is **not** used for repo content (large) — server is the source of truth; only ephemeral UI state (cursor positions, expanded folders) persists in IndexedDB scoped per repository RID.

### F1 — Web IDE Shell

**Depends on:** B2.

**Purpose.** The chrome that hosts every other panel: top bar with Commit/Tag/Branch widgets, left rail (file tree, resource imports, branches, problems), bottom drawer (Functions/Tests/Problems/Debugger/Build), main editor area (Monaco, multi-tab).

**Tech.** Monaco Editor (latest, with TS LSP via worker), React, Zustand for IDE state, custom layout primitive (resizable panels with `react-resizable-panels`).

**Routes.**
- `/code/:repositoryRid` → opens repo on default branch
- `/code/:repositoryRid/branches/:branch?path=src/index.ts` → deep link
- `/code/:repositoryRid/branches/:branch/pr/:prRid` → review mode

**Keybindings (mandatory).** `Cmd/Ctrl+S` save, `Cmd/Ctrl+P` quick file open, `Cmd/Ctrl+Shift+P` command palette, `Cmd/Ctrl+Enter` build/run, `Cmd/Ctrl+B` toggle file tree, `Cmd/Ctrl+J` toggle bottom drawer.

**State management contract.** A single `useRepoStore` Zustand slice owns `{repositoryRid, currentBranch, openFiles, dirtyFiles, activeTabPath, terminalLines}`. Network calls go through a typed `apiClient` generated from the Conjure IR (B2 contract).

**Edge cases.**
- Two tabs open on the same repo: editor state is shared via BroadcastChannel; saves synchronize.
- Network loss: editor enters "Offline" mode; saves queue locally and replay when reconnected (with conflict detection — see F4).

**Acceptance.**
1. Opening `/code/<rid>` shows file tree, opens README.md by default if present.
2. Resizing panels persists across reload.
3. The Monaco editor's TypeScript LSP correctly autocompletes against the OSDK-generated types.

---

### F2 — File Tree & VFS Adapter

**Depends on:** B1, B2.

**Purpose.** Renders the repository's file tree on the current branch, supports lazy-load of subdirectories, file open/edit/save, rename, delete, create. Bridges Monaco's text-buffer model to the server.

**API usage.** `B2.listFiles` for tree, `B2.readFile` for content, save via composing a commit (deferred until F4 commit panel). Until commit, edits live in client memory.

**Behavior.**
- Default branch loaded on mount.
- Folder click → expand (single-level lazy fetch).
- File click → fetch content, open Monaco tab.
- Rename / delete in tree → mark in `dirtyFiles`; visible only on commit.
- New file → tree shows pending icon until first save.
- File size limit in editor: 5 MB; larger files render a "binary or large file" placeholder with download.
- Markdown files (.md) get a split preview pane.
- Generated `.osdk-generated/` folder is shown but read-only with a banner explaining it auto-regenerates.

**Search.** Cmd/Ctrl+P quick-open uses `B2.search?repositoryRid=&q=` server-side fuzzy match (path + filename). Cmd/Ctrl+Shift+F is full-text search (uses a future indexer; for v1, falls back to server-side grep with 1000-result cap).

**Edge cases.**
- Two users editing different files on the same branch via different sessions: each commits separately, no conflict. Same file: see F4 conflict handling.
- File contains BOM, CRLF, etc.: preserved on save (Monaco respects EOL of original).

**Acceptance.**
1. The tree matches `git ls-tree -r` of the branch HEAD.
2. Renaming `src/index.ts` to `src/main.ts` and committing produces a single commit with one rename (Stemma-side: tree change with same blob SHA).

---

### F3 — Repository Initialization Wizard

**Depends on:** B2, B3, Compass UI primitives.

**Purpose.** The modal flow that creates a new Code Repository, matching the video walkthrough Phase 2 step 1: user picks repository type (column layout: Transforms / Functions / Models / Libraries), names the repo, picks parent folder, clicks Initialize.

**Steps.**
1. Type picker — 4-column grid, each column lists templates from `B3.listTemplates` filtered by category. Highlight on hover, single-select.
2. Name + location — text input with live regex validation, parent folder picker (Compass folder browser), default-branch selector (default `main`).
3. Optional advanced — compute profile, initial branch protection toggle.
4. Confirm → `B2.createRepository` with Idempotency-Key (UUID v4 generated client-side), display inline progress (saga steps shown).

**On success.** Redirect to `/code/:rid` and show a "Welcome" tour overlay (dismissible, persists in IndexedDB).

**On failure.**
- `CodeRepos:NameConflict` → highlight name field with the existing repo's link.
- `Templates:NotFound` → unrecoverable, show retry.
- Network error / timeout → retry button uses same Idempotency-Key.

**Acceptance.**
1. The video workflow's "TypeScript Functions" + "My First Function Gena" creates a repo at the chosen folder, opens the IDE on `main` with template files visible.
2. Submitting twice rapidly creates exactly one repo.

---

### F4 — Branch Switcher & Commit Panel

**Depends on:** B1, B2, B10.

**Purpose.** Branch dropdown in the top bar (search, create, switch), and the slide-out commit panel triggered by the green "Commit" button.

**Branch dropdown.**
- Lists branches from `B2.listBranches` with HEAD short-sha, last-commit-author avatar, and protection badge.
- "Create branch from <current>" inline action, validates regex, calls Stemma to create ref via `B2.createBranch` (push of zero-commit ref via JGit).
- Switching branch with dirty edits prompts: "You have unsaved changes. Stash, discard, or cancel?"

**Commit panel.**
- Shows `dirtyFiles` with per-file diff preview (Monaco diff editor, split view).
- Required: commit message (subject ≤72 chars + optional body). Pre-filled with template `[<template>] <summary>` if user is on a feature branch.
- "Commit" calls server: `B2.commit({branch, parentSha, message, fileChanges:[{path, op:add|modify|delete|rename, content}]})`. Server constructs tree+commit and pushes via JGit. Note: this endpoint is part of B2's API not yet listed; **add to B2:**
  ```
  commit: POST /repositories/{rid}/branches/{branch}/commits
           body: { parentSha, message, fileChanges: [...] }
           headers: Idempotency-Key, If-Match (parentSha must equal current HEAD)
           → Commit { sha, branch, headerEtag }
  ```
- On `Stemma:RefUpdateRejected` (someone else pushed): UI shows merge prompt with options:
  - **Rebase** — call `B2.rebaseOntoHead` (server-side fast-forward + replay of single commit; if conflict, falls into manual conflict resolution view).
  - **Discard local** — drop edits.
  - **Force-push** (if branch unprotected and user has permission) — explicit confirm.

**Conflict resolution view.** When rebase produces conflicts, show a 3-pane editor (theirs / base / ours) with accept-buttons; on resolve, retry commit.

**Acceptance.**
1. The video workflow: pasting code, clicking Commit, confirming, results in a single commit with one file change (`src/index.ts`).
2. Concurrent commit by another user is detected and the user sees the rebase prompt without losing edits.

---

### F5 — Tag & Release Dialog

**Depends on:** B1, B6, B8.

**Purpose.** The "Tag version" dialog matching video Phase 3 step 4. Used to create a new semver tag, which triggers Jemma → publishes Functions/JobSpecs.

**UI.**
- Modal triggered by tag icon next to Commit button.
- Shows last 10 tags from `B2.listTags` with their dates and CI status badges.
- Radio group: **Major / Minor / Patch** with auto-computed next semver shown (e.g., current `0.4.2` → Major=`1.0.0`, Minor=`0.5.0`, Patch=`0.4.3`).
- Optional pre-release label (`-rc.1` etc.).
- Optional release notes (markdown textarea); stored in tag annotation message.
- "Tag and release" button triggers:
  1. `B2.createTag({branch, sha: HEAD, name, annotation: message})` — server creates annotated tag via JGit, pushes ref `refs/tags/<name>`.
  2. UI immediately switches to **Branches → Tags & releases** subview showing the new tag with a "QUEUED" Jemma run.

**Live status.** Subscribes to `B6.getRun` polling (1s) until terminal state. On SUCCEEDED, shows "Function published as v1.0.0 ✓" with link to the Functions registry view.

**Edge cases.**
- Tag name conflicts: validate against `B1.listRefs` before submit; show error inline.
- Pre-release tags don't bump default-branch resolution (warning shown in UI: "This is a preview release; consumers using `^1.0.0` will not pick this up").
- Tag created on a non-default branch: yellow banner "Preview release on branch <foo>".

**Acceptance.**
1. The video workflow: selecting Major on a fresh repo produces tag `v1.0.0`, CI runs and succeeds, function appears in `B8.listVersions`.

---

### F6 — Resource Imports Panel

**Depends on:** B4, OMS, B5.

**Purpose.** The left-rail panel matching video Phase 2 step 2 — the cube-with-arrow icon. Lets the user search OMS for object types / link types / action types / interfaces, add them, preview impact, save, and observe the auto-generated OSDK files appear in `.osdk-generated/`.

**UI structure.**
- Header: "Resource imports" + Add button.
- List of currently imported entities (icon by kind, apiName, "rename detected" badge if `api_name_at_import` ≠ current OMS apiName).
- Add modal (matching video's "Add → Ontology" → "Search for object and link types" flow):
  - Step 1: pick Ontology (dropdown from OMS).
  - Step 2: search bar with type filter chips (Object Type / Link Type / Action Type / Interface). Results show 50 at a time, paginated.
  - Step 3: multi-select; "Save" calls `B4.addImports`.
- Per-item context menu: "Open in Ontology Manager", "Remove from imports", "View generated SDK".

**Generated-files banner.** After save, a non-blocking toast: "Generating OSDK… (Run #abcd)". On B5 completion event, toast becomes "OSDK updated. New types: GenaClinic, GenaFinancial. Preview." Clicking Preview opens `.osdk-generated/objects/GenaClinic.ts` read-only.

**Edge cases.**
- Project-scope violation (`Imports:NotImportedInProject`): show inline error with "Import to project" button that opens Compass project-imports UI in a new tab.
- Removing an entity referenced in code: show impact summary (files) before confirm; confirmation message includes "CI will fail until references are removed".

**Acceptance.**
1. The video workflow: search "Clinic" → select `[Gena] Clinic`, search "Financial" → select `[Gena] Financial`, Save → both appear, OSDK regenerates within 5s.

---

### F7 — Live Preview / Functions Tab

**Depends on:** B9, B5.

**Purpose.** The bottom-drawer tab matching video Phase 3 step 3. Discovers all functions in the current working tree, lets the user pick one, fill inputs, run, see the result, and re-run on edit.

**Function discovery.** Static analysis of the working tree (TypeScript: AST walk for `@Function`-decorated exports; Python: equivalent). Done in a Web Worker for responsiveness. Re-runs on every Monaco buffer change (debounced 300 ms). Surfaces the function list in the left panel of the drawer.

**Inputs panel.** For each function input parameter, render a typed input widget:
- Object type input → autocomplete that calls **OSS** to search instances by title (`OSS.searchObjects(rid, query)` returns top 20 with primary key).
- Primitive types → typed inputs.
- Object set input → object set picker (fetch existing sets) or build inline.
- Optional types → "use default" toggle.

**Run.**
- "Run" button calls `B9.invoke` with the selected function api name, inputs, and `allowMutations=false` (default) — checkbox to opt in to mutation visible only if function signature is an Action.
- Result tab shows: typed output (rendered per type — number with separators, ObjectInstance with title + RID link, etc.), execution time, log output, and inputs echo.
- "Auto-run on save" toggle: re-invokes on every successful save.

**Streaming logs.** SSE from `B9.invoke` — each log line streams as it appears.

**Edge cases.**
- Code has a TS compile error: Run is disabled with tooltip pointing to the first error.
- Function name conflicts (two functions with same apiName): show ambiguity warning.
- Mutation attempt without checkbox: show error inline + checkbox to retry with mutations.

**Acceptance.**
1. Video workflow: selecting `calculateDaysSalesOutstanding`, clicking Run, sees `40.51` in Result tab within 2s warm.
2. Editing the function and saving auto-reruns and shows new result.

---

### F8 — Checks / Builds Status Panel

**Depends on:** B6, B7, B8, B10.

**Purpose.** A unified live view of all CI activity for the current repo: per-branch run history, per-run stage breakdown, log streaming, jump-to-line on errors.

**UI structure.**
- Tab in the bottom drawer named "Checks".
- Header: branch filter (current branch by default), trigger filter (push/PR/tag/manual), state filter.
- Run list: each row shows `[icon-status] <commit-sha7> <commit-message> · <branch> · <duration> · <triggered-by>`. Clicking expands into stage list.
- Stage detail: per-stage state, duration, log button.
- Log viewer: terminal-themed (xterm.js or ANSI-aware React component), connects to `B6.streamLogs` SSE for live runs, paginates `B6.getLogChunk` for finished runs. Search-in-log (Cmd/Ctrl+F).

**Error → editor jump.** ESLint/pyright/pytest failures parsed for `<path>:<line>:<col>` and rendered as clickable links that open Monaco at that position.

**Top-bar status badge.** Always visible green/yellow/red dot reflecting the latest run on the current branch. Tooltip: last run time, who triggered.

**Edge cases.**
- A run cancelled mid-stream: SSE stream closes with terminating event; UI shows "Cancelled at <stage>".
- Logs > 100 MB: viewer paginates; download-full-log button for offline analysis.
- A run for a deleted branch: still navigable, shows "Branch deleted" banner.

**Acceptance.**
1. Pushing a commit shows the run appearing in < 1s with state QUEUED → RUNNING → SUCCEEDED.
2. A test failure in `src/index.test.ts:42:5` is clickable and opens the editor at that location.

---

### F9 — Pull Request / Code Review UI

**Depends on:** B2, B10, B6.

**Purpose.** Create, review, and merge PRs. Required because branch-protected branches reject direct pushes per B10.

**Required B2 endpoints (add to B2's contract):**
```
createPullRequest: POST   /repositories/{rid}/pull-requests
                    body: { sourceBranch, targetBranch, title, description }
                    → PullRequest { rid, state: OPEN, ... }
listPullRequests:  GET    /repositories/{rid}/pull-requests?state=&pageSize=
getPullRequest:    GET    /pull-requests/{prRid}
addReview:         POST   /pull-requests/{prRid}/reviews
                    body: { decision: APPROVE|REQUEST_CHANGES|COMMENT, comments: [...] }
addComment:        POST   /pull-requests/{prRid}/comments
                    body: { path, line, body, threadId? }
mergePullRequest:  POST   /pull-requests/{prRid}:merge
                    body: { strategy: MERGE|SQUASH|REBASE, message? }
                    headers: If-Match
```

**UI views.**
- **PR list** — sortable by date, state, author. Each row: title, branches, CI status badge, approval count.
- **PR detail** — three tabs:
  1. **Overview** — description, commits list, CI status, approvals, merge button (disabled until checks pass and approvals met).
  2. **Files changed** — split or unified diff (Monaco diff editor), inline-comment threads.
  3. **Conversation** — chronological event log: comments, review submissions, force-pushes, CI events.

**Merge UX.**
- Strategy picker (Merge commit / Squash / Rebase). Defaults to `MERGE` unless repo settings override.
- Pre-flight check: re-fetches CI status, latest sha, `mergeable` state. Disabled with reason when blocked.
- On click → calls merge endpoint with `If-Match: <latestSha>` to prevent merging stale state.

**Edge cases.**
- Source branch updated after review approval — approvals are reset only if `repoSettings.dismissStaleApprovals=true`; UI surfaces this state.
- Conflict: merge is disabled, "Resolve conflicts" button opens a guided UI similar to F4 conflict resolution but applied to the PR's working merge.

**Acceptance.**
1. Creating a PR from `feature/x` to `main` (when main is protected) is the only path to land changes, and the merge button enables only when CI passes and 1 approval is in.

---

### F10 — Repo Settings & Admin UI

**Depends on:** B2.

**Purpose.** A settings page for repo-level config: branch protection, tag validation regex, compute profile, secrets, webhooks. Persists to `repoSettings.json` on the default branch via B2.

**Sections.**
- **General** — display name, default branch, archive/unarchive, transfer ownership (changes parent folder via Compass).
- **Branches** — protected branches (multi-select with glob support), required PR, required approvals, dismiss-stale-approvals toggle, branch name regex.
- **Tags** — tag name regex, "tags require admin to delete" toggle.
- **Build** — compute profile (default / warm-pool / high-memory), enabled checks (lint / unit tests / antipattern), build env vars (encrypted at rest).
- **Webhooks** — list/create/edit/delete `B10` subscriptions for this repo.
- **Danger zone** — delete repository.

**Save model.** Each section has its own form with local state; Save calls `B2.updateRepoSettings` with `If-Match`. On success, the settings file in the default branch is updated by the server in a system commit (`chore: update repoSettings.json (UI)`). On stale-etag conflict (someone else changed settings), prompt to reload.

**Validation.**
- Regex fields are tested live with a sample input ("Test against name…").
- Glob patterns for protected branches are validated against canonical glob syntax.
- Webhook target URLs must be HTTPS in non-dev environments.

**Edge cases.**
- Removing a protected-branch entry: confirm dialog warns about side effects (open PRs may now allow direct push).
- Archiving a repo: blocks pushes but leaves CI history readable.
- Deletion: type-the-name confirmation, irreversible after 30 days (matches B1 tombstone window).

**Acceptance.**
1. Setting `main` as protected blocks direct push (verified via Stemma).
2. Setting tag regex `^v\d+\.\d+\.\d+$` rejects `release-1` push and accepts `v1.0.0`.

---

## 4. Cross-cutting Acceptance: End-to-End Demo Flow

The 20 tasks are demo-complete when the following sequence executes without manual intervention beyond UI clicks:

1. **F3** create repo `My First Function Gena` (template: `typescript-functions`).
2. **F6** add imports `[Gena] Clinic` and `[Gena] Financial` → **B4** validates project scope → **B5** generates OSDK → files appear in `.osdk-generated/`.
3. **F2** open `src/index.ts`, paste user code, fix imports to `GenaClinic` / `GenaFinancial`.
4. **F7** select `calculateDaysSalesOutstanding`, Run → **B9** returns `40.51`.
5. **F4** Commit → **B2** creates commit on `main` → **B10** post-receive event → **B6** Jemma run starts.
6. **F5** Tag version Major → **B1** creates `v1.0.0` annotated tag → **B6** Jemma run on tag → **B8** publishes Function version.
7. **F8** observes the run move QUEUED → RUNNING → SUCCEEDED in real time.
8. (Outside this spec but unblocked by it): Ontology Manager binds the published function as a function-backed action; Workshop binds it as a function-backed variable; the metric card displays `40.51 Days`.

If every step works on a clean cluster on first try and is observable in metrics/audit, the spec is met.

---

## 5. Out of Scope for v1 (track for v2)

- Code Workspaces (JupyterLab/RStudio/VS Code in browser) — separate spec.
- Multi-region replication of Stemma — Postgres synchronous replication is sufficient for v1.
- Git LFS — large files via the AtlasDB stream API (current B1) is the only supported path; no separate LFS service.
- Repository templates marketplace UI (admin uploads) — v1 ships with hardcoded templates; admin upload is v2.
- Advanced PR review features: review threading at code-block level, suggested edits, reaction emoji.
- IDE collaborative editing (multiple cursors) — Monaco supports it, but server-side OT/CRDT is v2.
- Code search beyond filename — full-text indexer (zoekt-equivalent) is v2.

---

## 6. Definition of Done (per task)

A task is DONE when:
1. All endpoints implement the contract above and pass typed contract tests (Conjure-generated client tests).
2. All listed error codes are emitted under the documented conditions, verified by integration tests.
3. SLOs are measured under load (k6 or similar) and met for two consecutive 30-min windows on a 3-node cluster.
4. Prometheus metrics are emitted, dashboards exist, alerts are wired for SLO violations.
5. Audit events are emitted for every mutating action, verified end-to-end.
6. Idempotency is verified by replay tests for every POST.
7. Concurrent-action invariants (one writer per branch, one JobSpec owner per output, etc.) are verified by chaos tests.
8. Documentation: a `docs/<task-id>.md` covers the contract, runbooks (common alerts + remediation), and ADRs for any non-obvious choice.
9. Code review by at least one reviewer outside the implementing AI agent's session; CI green.

End of spec.